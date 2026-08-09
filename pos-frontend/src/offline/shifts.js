import db from './db'
import { newClientId } from './queueTypes'

/**
 * Local cash-shift state.
 *
 * Everything the "does this cashier already have an open shift on this drawer?" decision
 * needs lives here, so the answer is available with no network. That matters more than it
 * looks: the alternative — asking the server — means an offline re-login after an
 * accidental sign-out cannot tell "shift still open" from "cannot reach the server", and
 * the safe-looking default (ask for a change fund again) is the wrong one. It opens a
 * second shift against a drawer that was already counted.
 */

export function newShiftClientId() {
  return newClientId('shift')
}

function normalize(shift) {
  return {
    ...shift,
    startingCash: Number(shift.startingCash || 0),
    endingCash: shift.endingCash == null ? null : Number(shift.endingCash),
    expectedCash: shift.expectedCash == null ? null : Number(shift.expectedCash),
    variance: shift.variance == null ? null : Number(shift.variance),
    status: shift.clockOut ? 'closed' : 'open',
  }
}

export async function saveLocalShift(shift) {
  const row = normalize(shift)
  await db.shifts.put(row)
  return row
}

export async function getLocalShift(clientId) {
  if (!clientId) return null
  return (await db.shifts.get(clientId)) || null
}

/** The open shift for this exact cashier + drawer, if there is one. */
export async function getLocalOpenShift({ branchId, staffId, drawerId }) {
  if (!branchId || !staffId || !drawerId) return null
  const rows = await db.shifts.where('status').equals('open').toArray()
  return (
    rows.find(
      (row) =>
        row.branchId === branchId && row.staffId === staffId && row.drawerId === drawerId,
    ) || null
  )
}

/**
 * Any open shift on this drawer, whoever it belongs to. Used to refuse a second cashier
 * opening the same physical drawer before the first has cashed out.
 */
export async function getLocalOpenShiftOnDrawer({ branchId, drawerId }) {
  if (!branchId || !drawerId) return null
  const rows = await db.shifts.where('status').equals('open').toArray()
  return rows.find((row) => row.branchId === branchId && row.drawerId === drawerId) || null
}

/** Most recently closed shift on this drawer — its ending count pre-fills a handoff. */
export async function getLastClosedShiftOnDrawer({ branchId, drawerId }) {
  if (!branchId || !drawerId) return null
  const rows = await db.shifts
    .where('drawerId')
    .equals(drawerId)
    .filter((row) => row.branchId === branchId && row.status === 'closed' && row.clockOut)
    .toArray()
  rows.sort((a, b) => String(b.clockOut).localeCompare(String(a.clockOut)))
  return rows[0] || null
}

/**
 * Server uuid for a shift the app only knows by clientId. Null while the open is still
 * queued — callers must treat that as "retry later", never as "no shift".
 */
export async function resolveShiftServerId(clientId) {
  if (!clientId) return null
  const row = await db.shifts.get(clientId)
  return row?.serverId || null
}

/** Stamp the server row onto the local record once the open has been pushed. */
export async function markShiftSynced(clientId, serverShift) {
  const local = await db.shifts.get(clientId)
  if (!local) return null
  const merged = normalize({
    ...local,
    ...serverShift,
    clientId,
    serverId: serverShift?.id || local.serverId || null,
    syncStatus: 'synced',
  })
  await db.shifts.put(merged)
  return merged
}

export async function closeLocalShift(clientId, patch = {}) {
  const local = await db.shifts.get(clientId)
  if (!local) return null
  const merged = normalize({
    ...local,
    ...patch,
    clockOut: patch.clockOut || new Date().toISOString(),
  })
  await db.shifts.put(merged)
  return merged
}

export async function listLocalShifts({ branchId, businessDate = null } = {}) {
  if (!branchId) return []
  const rows = await db.shifts.where('branchId').equals(branchId).toArray()
  const filtered = businessDate ? rows.filter((row) => row.businessDate === businessDate) : rows
  return filtered.sort((a, b) => String(b.clockIn).localeCompare(String(a.clockIn)))
}

/**
 * Merge shifts pulled from the server. Local rows that have not been pushed yet are kept
 * as-is — the server has never seen them, so it cannot be the authority on them.
 */
export async function putRemoteShifts(branchId, shifts) {
  if (!branchId) return
  const incoming = shifts || []
  const local = await db.shifts.where('branchId').equals(branchId).toArray()
  const byServerId = new Map(local.filter((row) => row.serverId).map((row) => [row.serverId, row]))

  const merged = incoming.map((remote) => {
    const prev = byServerId.get(remote.id)
    return normalize({
      ...(prev || {}),
      ...remote,
      clientId: prev?.clientId || remote.clientId || remote.id,
      serverId: remote.id,
      branchId,
      syncStatus: 'synced',
    })
  })

  // Deliberately upsert-only. The pull is scoped (open shifts + the current business day),
  // so "absent from this response" does not mean "deleted on the server" — pruning on that
  // basis would wipe every older shift from the device. Age-based pruning below instead.
  await db.shifts.bulkPut(merged)
}

const LOCAL_SHIFT_RETENTION_DAYS = 30

/** Drop synced, closed shifts older than the retention window. Unsynced rows are kept. */
export async function pruneLocalShifts(branchId) {
  if (!branchId) return 0
  const cutoff = new Date(Date.now() - LOCAL_SHIFT_RETENTION_DAYS * 86400000).toISOString()
  const rows = await db.shifts.where('branchId').equals(branchId).toArray()
  const old = rows.filter(
    (row) =>
      row.syncStatus === 'synced' &&
      row.status === 'closed' &&
      row.clockOut &&
      String(row.clockOut) < cutoff,
  )
  if (old.length) await db.shifts.bulkDelete(old.map((row) => row.clientId))
  return old.length
}
