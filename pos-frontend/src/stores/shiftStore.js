import { create } from 'zustand'
import * as api from '../lib/api'
import {
  closeLocalShift,
  enqueue,
  getLastClosedShiftOnDrawer,
  getLocalOpenShift,
  getLocalOpenShiftOnDrawer,
  isOnline,
  markShiftSynced,
  newShiftClientId,
  QUEUE_TYPES,
  saveLocalShift,
  syncBranch,
} from '../offline'
import db from '../offline/db'
import { drawerIdentity } from '../utils/drawer'
import { appError } from '../utils/errors'
import { businessDate } from '../utils/format'
import { useSyncStore } from './syncStore'

/**
 * The cash shift this terminal is currently working under.
 *
 * The rule this store exists to enforce: a change fund is counted ONCE per shift, not once
 * per sign-in. Signing out — deliberately or by accident — does not end a shift, so signing
 * back in on the same drawer resumes it and never asks for the float again. Only a genuine
 * cash-out ends a shift, and only then does the next person count cash in.
 *
 * `gate` is what the UI acts on:
 *   ready       — a shift is open and sales may proceed
 *   start       — no shift for this cashier on this drawer; count the change fund
 *   busy        — someone else holds this drawer; they must cash out first
 *   moved       — this cashier is open on a DIFFERENT drawer (see below)
 *   checking    — still resolving
 *
 * `moved` is deliberately not auto-resolved. Same cashier, different terminal means a
 * different pile of cash: resuming would hand them a drawer they never counted, and
 * silently opening a second one would leave the first drawer unaccounted for. Someone with
 * authority has to say which it is.
 */
export const useShiftStore = create((set, get) => ({
  shift: null,
  gate: 'checking',
  /** The open shift blocking this drawer (gate 'busy') or held elsewhere (gate 'moved'). */
  blocker: null,
  /** Previous shift on this drawer whose ending count pre-fills a handoff. */
  handoff: null,
  drawerId: null,
  drawerLabel: '',
  checking: false,
  error: '',

  /**
   * Work out whether this user may sell, and if not, why not. Local state first, server
   * only as a refinement — the answer has to exist offline, and "cannot reach the server"
   * must never be mistaken for "no open shift" (that would ask for a second change fund
   * on a drawer already counted).
   */
  resolve: async (user, { holdsDrawer = true } = {}) => {
    if (!user?.id || !user?.branchId) {
      set({ shift: null, gate: 'checking', blocker: null })
      return { gate: 'checking' }
    }
    const { drawerId, drawerLabel } = drawerIdentity()
    set({ checking: true, error: '', drawerId, drawerLabel })

    try {
      let local = await getLocalOpenShift({
        branchId: user.branchId,
        staffId: user.id,
        drawerId,
      })

      // Online: let the server correct the local picture. It is the only place that knows
      // a supervisor force-closed the shift, or that another terminal took the drawer.
      if (api.hasSupabase && isOnline()) {
        const remote = await api.fetchOpenShift(user.id, { drawerId }).catch(() => undefined)
        if (remote !== undefined) {
          if (remote?.id) {
            local = await upsertFromRemote(remote, local)
          } else if (local?.serverId) {
            // Was open here, is closed on the server — someone else ended it.
            local = await closeLocalShift(local.clientId, {
              clockOut: new Date().toISOString(),
              syncStatus: 'synced',
            })
            local = null
          }
        }
      }

      if (local && local.status === 'open') {
        set({ shift: local, gate: 'ready', blocker: null, handoff: null, checking: false })
        return { gate: 'ready', shift: local }
      }

      // Floor shifts (supervisor) do not hold a drawer, so neither the drawer-busy check
      // nor the handoff pre-fill applies to them.
      if (!holdsDrawer) {
        set({ shift: null, gate: 'start', blocker: null, handoff: null, checking: false })
        return { gate: 'start' }
      }

      const blocker = await findDrawerBlocker(user, drawerId)
      if (blocker) {
        set({ shift: null, gate: 'busy', blocker, handoff: null, checking: false })
        return { gate: 'busy', blocker }
      }

      const elsewhere = await findShiftOnAnotherDrawer(user, drawerId)
      if (elsewhere) {
        set({ shift: null, gate: 'moved', blocker: elsewhere, handoff: null, checking: false })
        return { gate: 'moved', blocker: elsewhere }
      }

      const handoff = await findHandoff(user, drawerId)
      set({ shift: null, gate: 'start', blocker: null, handoff, checking: false })
      return { gate: 'start', handoff }
    } catch (err) {
      set({ checking: false, error: err?.message || 'Could not check shift status.' })
      // Fail closed: an unknown shift state must not let sales through unattributed.
      set({ gate: 'start' })
      return { gate: 'start' }
    }
  },

  /**
   * Start a shift with a counted change fund. Written locally first and queued, so a
   * cashier can open a drawer and start selling with no network at all.
   */
  startShift: async (user, { startingCash, shiftPeriod, carriedFrom = null, holdsDrawer = true }) => {
    if (!user?.id || !user?.branchId) throw appError('SHIFT01')
    const amount = Number(startingCash || 0)
    if (holdsDrawer && (!Number.isFinite(amount) || amount < 0)) throw appError('SHIFT03')

    const { drawerId, drawerLabel } = drawerIdentity()
    const clientId = newShiftClientId()
    const bizDate = businessDate(new Date(), user.dayOpenHour ?? 7)

    const local = await saveLocalShift({
      clientId,
      serverId: null,
      branchId: user.branchId,
      staffId: user.id,
      staffName: user.name || 'Staff',
      staffRole: user.role || '',
      drawerId,
      drawerLabel,
      holdsDrawer,
      businessDate: bizDate,
      shiftPeriod: shiftPeriod === 'pm' ? 'pm' : 'am',
      clockIn: new Date().toISOString(),
      clockOut: null,
      startingCash: holdsDrawer ? amount : 0,
      carriedFromShiftId: carriedFrom?.id || carriedFrom?.serverId || null,
      carriedAmount: carriedFrom?.endingCash ?? null,
      endingCash: null,
      expectedCash: null,
      variance: null,
      status: 'open',
      syncStatus: 'pending',
    })

    if (api.hasSupabase) {
      await enqueue(
        QUEUE_TYPES.OPEN_SHIFT,
        {
          clientId,
          branchId: user.branchId,
          staffId: user.id,
          drawerId,
          drawerLabel,
          holdsDrawer,
          startingCash: local.startingCash,
          shiftPeriod: local.shiftPeriod,
          carriedFromShiftId: local.carriedFromShiftId,
          carriedAmount: local.carriedAmount,
          businessDate: bizDate,
        },
        { branchId: user.branchId, clientId },
      )
      useSyncStore.getState().refresh(user.branchId)
      if (isOnline()) void syncBranch(user.branchId).catch(() => {})
    }

    set({ shift: local, gate: 'ready', blocker: null, handoff: null, error: '' })
    return local
  },

  /** What the drawer should hold right now, for the cash-out screen. */
  cashPosition: async () => {
    const shift = get().shift
    if (!shift) return null
    if (api.hasSupabase && isOnline() && shift.serverId) {
      const remote = await api.fetchShiftCashSummary(shift.serverId).catch(() => null)
      if (remote) return { ...remote, source: 'server' }
    }
    return { ...(await localCashPosition(shift)), source: 'local' }
  },

  /**
   * Cash out and end the shift. This — not signing out — is what closes a shift, so the
   * next cashier is asked to count in.
   */
  endShift: async (user, { endingCash, note = '' }) => {
    const shift = get().shift
    if (!shift) return null
    const amount = Number(endingCash || 0)
    if (shift.holdsDrawer !== false && (!Number.isFinite(amount) || amount < 0)) {
      throw appError('SHIFT03')
    }

    const position = await get().cashPosition()
    const expected = position ? Number(position.expectedCash || 0) : null
    const closed = await closeLocalShift(shift.clientId, {
      endingCash: shift.holdsDrawer === false ? null : amount,
      expectedCash: expected,
      variance: expected == null || shift.holdsDrawer === false ? null : Number((amount - expected).toFixed(2)),
      closeNote: note,
      clockOut: new Date().toISOString(),
      syncStatus: 'pending',
    })

    if (api.hasSupabase) {
      await enqueue(
        QUEUE_TYPES.CLOSE_SHIFT,
        {
          clientId: shift.clientId,
          shiftId: shift.serverId || null,
          branchId: shift.branchId,
          endingCash: amount,
          note,
          closedBy: user?.id || null,
        },
        { branchId: shift.branchId, clientId: `close_${shift.clientId}` },
      )
      useSyncStore.getState().refresh(shift.branchId)
      if (isOnline()) void syncBranch(shift.branchId).catch(() => {})
    }

    set({ shift: null, gate: 'start', blocker: null, handoff: closed })
    return closed
  },

  /** Forget the in-memory pointer on sign-out. The LOCAL SHIFT RECORD IS NOT TOUCHED —
   *  that is what lets a re-login resume instead of asking for the float again. */
  forget: () => set({ shift: null, gate: 'checking', blocker: null, handoff: null, error: '' }),
}))

async function upsertFromRemote(remote, local) {
  if (local?.clientId) {
    return markShiftSynced(local.clientId, remote)
  }
  return saveLocalShift({
    clientId: remote.clientId || remote.id,
    serverId: remote.id,
    branchId: remote.branchId,
    staffId: remote.staffId,
    staffName: remote.staffName || '',
    drawerId: remote.drawerId,
    drawerLabel: remote.drawerLabel || '',
    holdsDrawer: remote.holdsDrawer !== false,
    businessDate: remote.businessDate,
    shiftPeriod: remote.shiftPeriod,
    clockIn: remote.clockIn,
    clockOut: remote.clockOut,
    startingCash: remote.startingCash ?? 0,
    carriedFromShiftId: remote.carriedFromShiftId,
    carriedAmount: remote.carriedAmount,
    endingCash: remote.endingCash,
    expectedCash: remote.expectedCash,
    variance: remote.variance,
    status: remote.clockOut ? 'closed' : 'open',
    syncStatus: 'synced',
  })
}

/** Another cashier still holding this drawer. Server wins when reachable. */
async function findDrawerBlocker(user, drawerId) {
  if (api.hasSupabase && isOnline()) {
    const remote = await api
      .fetchOpenShiftOnDrawer({ branchId: user.branchId, drawerId })
      .catch(() => null)
    if (remote && remote.staffId !== user.id) return remote
    if (remote) return null
  }
  const local = await getLocalOpenShiftOnDrawer({ branchId: user.branchId, drawerId })
  if (local && local.staffId !== user.id) return local
  return null
}

/** This cashier open on a different terminal — the "moved drawer" case. */
async function findShiftOnAnotherDrawer(user, drawerId) {
  if (api.hasSupabase && isOnline()) {
    const remote = await api.fetchOpenShift(user.id).catch(() => null)
    if (remote?.id && remote.drawerId !== drawerId && remote.holdsDrawer !== false) return remote
    if (remote?.id) return null
  }
  const rows = await db.shifts.where('status').equals('open').toArray()
  return (
    rows.find(
      (row) =>
        row.branchId === user.branchId &&
        row.staffId === user.id &&
        row.drawerId !== drawerId &&
        row.holdsDrawer !== false,
    ) || null
  )
}

/** Ending count of the last shift on this drawer, to pre-fill a handoff. */
async function findHandoff(user, drawerId) {
  if (api.hasSupabase && isOnline()) {
    const remote = await api
      .fetchLastClosedShiftOnDrawer({ branchId: user.branchId, drawerId })
      .catch(() => null)
    if (remote) return remote
  }
  return getLastClosedShiftOnDrawer({ branchId: user.branchId, drawerId })
}

/**
 * Offline estimate of the drawer's expected contents, from what this device knows.
 * Marked `source: 'local'` by the caller so the UI can say the count may be incomplete —
 * a sale rung on another terminal against this shift is not in here.
 */
async function localCashPosition(shift) {
  const rows = await db.transactions.where('branchId').equals(shift.branchId).toArray()
  const mine = rows.filter(
    (row) =>
      (row.shiftClientId && row.shiftClientId === shift.clientId) ||
      (shift.serverId && row.shiftId === shift.serverId),
  )
  let sales = 0
  let refunds = 0
  for (const row of mine) {
    if ((row.paymentMethod || 'cash') !== 'cash') continue
    if (row.status === 'Voided') {
      refunds += Number(row.total || 0)
      continue
    }
    sales += Number(row.total || 0)
    refunds += Number(row.refundedAmount || 0)
  }
  const startingCash = Number(shift.startingCash || 0)
  return {
    startingCash,
    cashSales: Number(sales.toFixed(2)),
    cashRefunds: Number(refunds.toFixed(2)),
    cashPaidOut: 0,
    cashPickups: 0,
    expectedCash: Number((startingCash + sales - refunds).toFixed(2)),
    saleCount: mine.filter((row) => row.status !== 'Voided').length,
  }
}
