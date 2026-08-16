import { create } from 'zustand'
import * as api from '../lib/api'
import {
  closeLocalShift,
  enqueue,
  getLastClosedShiftForStaffOnDrawer,
  getLastClosedShiftOnDrawer,
  getLocalOpenShift,
  getLocalShift,
  isOnline,
  markShiftSynced,
  newShiftClientId,
  QUEUE_TYPES,
  resolveShiftServerId,
  saveLocalShift,
  syncBranch,
} from '../offline'
import db from '../offline/db'
import { drawerIdentity } from '../utils/drawer'
import { appError } from '../utils/errors'
import { businessDate } from '../utils/format'
import { withTimeout } from '../utils/withTimeout'
import { useSyncStore } from './syncStore'

/**
 * The cash shift this terminal is currently working under.
 *
 * The opening float is still counted once per shift. Ending a shift is a plain clock-out —
 * no count, no supervisor witness — because cash counting now happens once per BUSINESS DAY,
 * at Day End, not once per shift boundary. Signing out — deliberately or by accident — does
 * not end a shift, so signing back in resumes it (on ANY terminal — see `drawerIdentity`)
 * and never asks for the float again.
 *
 * `gate` is what the UI acts on:
 *   ready       — a shift is open and sales may proceed
 *   start       — no open shift for this cashier; count the change fund
 *   ended       — this cashier just clocked out on THIS session; sign out before anyone
 *                 else touches the terminal (see endShift)
 *   checking    — still resolving
 *
 * There is deliberately no `busy` gate: a stale open shift left under someone else never
 * blocks the next cashier — starting a shift auto-closes it server-side (see
 * open_staff_shift() in migrate_day_end_request_no_shift_count.sql), no count required.
 */
export const useShiftStore = create((set, get) => ({
  shift: null,
  gate: 'checking',
  /** Previous shift whose ending count pre-fills a handoff. */
  handoff: null,
  /** This cashier's own last-ended shift — set only to trigger the "start shift again?"
   *  prompt instead of silently auto-starting (see resolve()). */
  restartPrompt: null,
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
      set({ shift: null, gate: 'checking' })
      return { gate: 'checking' }
    }
    const { drawerId, drawerLabel } = drawerIdentity()
    set({ checking: true, error: '', drawerId, drawerLabel })

    try {
      let local = await getLocalOpenShift({
        branchId: user.branchId,
        staffId: user.id,
      })

      // Online: let the server correct the local picture. It is the only place that knows
      // a supervisor force-closed the shift.
      if (api.hasSupabase && isOnline()) {
        // Bounded: a slow/flaky connection must fail the same way a network error already
        // does (skip the server refinement, trust local) instead of holding the "Checking
        // shift…" overlay hostage to a stalled request.
        const remote = await withTimeout(api.fetchOpenShift(user.id), 6000, 'Shift check')
          .catch(() => undefined)
        if (remote !== undefined) {
          if (remote?.id) {
            // fetchOpenShift filters on the SERVER's clock_out, so a close made on this
            // device that has not pushed yet (still sitting in the outbox) still reads back
            // as open here — the server genuinely does not know about it yet. Trust our own
            // unsynced close over that stale read; otherwise ending a shift and re-resolving
            // shortly after (e.g. signing back in before CLOSE_SHIFT has synced) silently
            // resurrects the shift as open, and the cashier has to end it a second time.
            const knownLocal = remote.clientId ? await getLocalShift(remote.clientId) : null
            const closedPendingLocally =
              knownLocal?.status === 'closed' && knownLocal.syncStatus === 'pending'
            if (!closedPendingLocally) {
              local = await upsertFromRemote(remote, local)
            }
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
        set({
          shift: local,
          gate: 'ready',
          handoff: null,
          restartPrompt: null,
          checking: false,
        })
        return { gate: 'ready', shift: local }
      }

      // Floor shifts (supervisor) do not hold a drawer, so the handoff pre-fill and the
      // "start again?" prompt (both drawer-cash concepts) do not apply to them.
      if (!holdsDrawer) {
        set({
          shift: null,
          gate: 'start',
          handoff: null,
          restartPrompt: null,
          checking: false,
        })
        return { gate: 'start' }
      }

      const handoff = await findHandoff(user, drawerId)
      // This cashier's own last shift, if it was them who ended it — the signal to ask
      // "start shift again?" instead of silently reopening one. Stays null (silent
      // auto-start) for a genuinely first-ever shift.
      const restartPrompt = await getLastClosedShiftForStaffOnDrawer({
        branchId: user.branchId,
        staffId: user.id,
        drawerId,
      })
      set({ shift: null, gate: 'start', handoff, restartPrompt, checking: false })
      return { gate: 'start', handoff, restartPrompt }
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

    set({ shift: local, gate: 'ready', handoff: null, error: '' })
    return local
  },

  /**
   * Freshen `shift.serverId` from IndexedDB, where the sync engine stamps it once the
   * OPEN_SHIFT push completes (`markShiftSynced`, `offline/shifts.js`). The in-memory
   * `shift` object is otherwise never touched again after `startShift()` sets it — so a
   * shift that was still mid-sync at that moment reads `serverId: null` for the rest of
   * the session, even minutes later once it has long since synced. Anything that gates on
   * "has this shift synced" (cashPosition's server branch, a petty-cash request's shiftId)
   * must go through this first rather than read `shift.serverId` off the store directly.
   * A no-op once it has resolved once.
   */
  syncShiftServerId: async () => {
    const shift = get().shift
    if (!shift) return null
    if (shift.serverId) return shift.serverId
    const serverId = await resolveShiftServerId(shift.clientId).catch(() => null)
    if (serverId) {
      set((state) => (state.shift ? { shift: { ...state.shift, serverId } } : {}))
    }
    return serverId
  },

  /**
   * What the drawer should hold right now, for the cash-out screen.
   *
   * The server RPC only knows about a sale once it has synced — a sale just rung up is
   * written locally first and pushed in the background, so trusting the RPC alone left a
   * real window where a just-made sale read as ₱0.00. `pendingLocalDelta` covers that gap:
   * whatever this device has rung up but not yet synced gets added on top of the server's
   * (multi-terminal-aware) figure, and naturally stops double-counting once syncStatus
   * flips to 'synced' and the RPC picks it up itself.
   */
  cashPosition: async () => {
    await get().syncShiftServerId()
    const shift = get().shift
    if (!shift) return null
    const delta = await pendingLocalDelta(shift)
    if (api.hasSupabase && isOnline() && shift.serverId) {
      const remote = await api.fetchShiftCashSummary(shift.serverId).catch(() => null)
      if (remote) {
        const cashSales = Number((remote.cashSales + delta.sales).toFixed(2))
        const cashRefunds = Number((remote.cashRefunds + delta.refunds).toFixed(2))
        const expectedCash = Number(
          (
            remote.expectedCash +
            delta.sales -
            delta.refunds
          ).toFixed(2),
        )
        return {
          ...remote,
          cashSales,
          cashRefunds,
          expectedCash,
          source: delta.sales || delta.refunds ? 'server+pending' : 'server',
        }
      }
    }
    return { ...(await localCashPosition(shift)), source: 'local', reasonOffline: !isOnline() }
  },

  /**
   * A master account never goes through ShiftGate — Shell's `worksShifts` only covers
   * cashier/supervisor, deliberately, since a master signing in to check Reports should not
   * be forced through a shift lifecycle. But Open Drawer and selling are both fundamentally
   * shift-scoped (cash_movements/transactions both require a shift_id), so master needs one
   * lazily, created the moment they actually do either — never on sign-in, never just from
   * opening the POS page. Callers: `addTransaction` (posStore.js, first sale) and POS.jsx's
   * Open Drawer button (before the modal opens). No-op for every other role — they already
   * have a shift by the time either of those can run, via the normal ShiftGate flow.
   */
  ensureMasterShift: async (user) => {
    if (user?.role !== 'master') return get().shift
    if (get().shift) return get().shift
    const result = await get().resolve(user, { holdsDrawer: true })
    if (result?.gate === 'ready') return get().shift
    return get().startShift(user, {
      startingCash: 0,
      shiftPeriod: new Date().getHours() < 12 ? 'am' : 'pm',
      holdsDrawer: true,
    })
  },

  /**
   * End the shift: a plain clock-out. No cash count, no supervisor witness — counting
   * happens once per business day at Day End now, not once per shift boundary.
   *
   * Lands on gate 'ended', not 'start'. Falling straight through to a new "count your
   * change fund" screen would let whoever is standing at the till open the NEXT shift under
   * this cashier's still-open session. The terminal must go back to a sign-in before anyone
   * starts a new shift here.
   */
  endShift: async (user, { note = '' } = {}) => {
    const shift = get().shift
    if (!shift) return null

    const closed = await closeLocalShift(shift.clientId, {
      endingCash: null,
      expectedCash: null,
      variance: null,
      closeNote: note,
      closedBy: user.id,
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
          note,
          closedBy: user.id,
        },
        { branchId: shift.branchId, clientId: `close_${shift.clientId}` },
      )
      useSyncStore.getState().refresh(shift.branchId)
      if (isOnline()) void syncBranch(shift.branchId).catch(() => {})
    }

    set({ shift: null, gate: 'ended', handoff: closed })
    return closed
  },

  /** Forget the in-memory pointer on sign-out. The LOCAL SHIFT RECORD IS NOT TOUCHED —
   *  that is what lets a re-login resume instead of asking for the float again. */
  forget: () =>
    set({
      shift: null,
      gate: 'checking',
      handoff: null,
      restartPrompt: null,
      error: '',
    }),
}))

/**
 * Copy + tone for the banner under a cash position figure, keyed off `source`/`reasonOffline`
 * from `cashPosition()`. Shared by ShiftCashOut and CashierEndShift so the two screens never
 * drift into saying different things about the same figure.
 */
export function cashPositionNotice(position) {
  if (!position) return null
  if (position.source === 'local') {
    const lead = position.reasonOffline ? 'Offline' : 'Estimate'
    return {
      tone: 'warn',
      text: `${lead} — this total covers sales made on this device only. Paid-out and pickup activity is not included.`,
    }
  }
  if (position.source === 'server+pending') {
    return {
      tone: 'muted',
      text: "Includes sale(s) made on this device that haven't finished syncing yet.",
    }
  }
  return null
}

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

/**
 * Ending count of the last shift on this drawer, to pre-fill a handoff.
 *
 * `undefined` means the fetch itself failed (offline, network blip) — fall back to the
 * local cache. A resolved value of `null` means the server was reached and definitively
 * has no closed shift on this drawer; that
 * must return immediately, not fall through to IndexedDB, which can hold a stale closed-
 * shift row the server no longer has (its `staff_shifts` row was deleted, corrected, or
 * this device just never learned it's gone). Falling through there handed a new shift's
 * `carriedFromShiftId` an id that no longer exists server-side — `insert or update on
 * table "staff_shifts" violates foreign key constraint "staff_shifts_carried_from_shift_id_fkey"`
 * on the very next start-shift.
 */
async function findHandoff(user, drawerId) {
  if (api.hasSupabase && isOnline()) {
    const remote = await api
      .fetchLastClosedShiftOnDrawer({ branchId: user.branchId, drawerId })
      .catch(() => undefined)
    if (remote !== undefined) return remote
  }
  return getLastClosedShiftOnDrawer({ branchId: user.branchId, drawerId })
}

/** This shift's cash transactions recorded on this device, regardless of sync state. */
async function shiftCashRows(shift) {
  const rows = await db.transactions.where('branchId').equals(shift.branchId).toArray()
  return rows.filter(
    (row) =>
      (row.shiftClientId && row.shiftClientId === shift.clientId) ||
      (shift.serverId && row.shiftId === shift.serverId),
  )
}

/**
 * A voided sale nets to zero — whatever cash it put in the drawer, the void takes back out,
 * so it must contribute nothing to either `sales` or `refunds`. Adding its total to `refunds`
 * (as this used to) double-subtracted cash that was already excluded from `sales`, making the
 * shift read short by every voided sale's amount. Mirrors the server-side fix in
 * migrate_shift_cash_void_fix.sql — keep both in sync.
 */
function sumCash(rows) {
  let sales = 0
  let refunds = 0
  for (const row of rows) {
    if ((row.paymentMethod || 'cash') !== 'cash') continue
    if (row.status === 'Voided') continue
    sales += Number(row.total || 0)
    refunds += Number(row.refundedAmount || 0)
  }
  return { sales: Number(sales.toFixed(2)), refunds: Number(refunds.toFixed(2)) }
}

/**
 * Sales/refunds this device knows about that the server does NOT yet — i.e. still
 * `syncStatus: 'pending'` or `'local'`. Added on top of the server's own figure in
 * `cashPosition()` so a just-rung sale shows up before it has finished syncing. Once a row
 * syncs (`syncStatus` flips to `'synced'`), it drops out of this delta and the server figure
 * already includes it — no double count.
 */
async function pendingLocalDelta(shift) {
  const rows = (await shiftCashRows(shift)).filter(
    (row) => row.syncStatus === 'pending' || row.syncStatus === 'local',
  )
  return sumCash(rows)
}

/**
 * Offline estimate of the drawer's expected contents, from what this device knows.
 * Marked `source: 'local'` by the caller so the UI can say the count may be incomplete —
 * a sale rung on another terminal against this shift is not in here. Paid-out/pickups are
 * always 0 here: petty cash is not mirrored to IndexedDB, so this device has no way to know
 * about it while offline.
 */
async function localCashPosition(shift) {
  const mine = await shiftCashRows(shift)
  const { sales, refunds } = sumCash(mine)
  const startingCash = Number(shift.startingCash || 0)
  return {
    startingCash,
    cashSales: sales,
    cashRefunds: refunds,
    cashPaidOut: 0,
    cashPickups: 0,
    expectedCash: Number((startingCash + sales - refunds).toFixed(2)),
    saleCount: mine.filter((row) => row.status !== 'Voided').length,
  }
}
