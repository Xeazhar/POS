import db from './db'
import { isStockAffectingType, newClientId, QUEUE_STATUS } from './queueTypes'

/** Enqueue an offline action. Never silently drops data. */
export async function enqueue(type, payload, { branchId, clientId } = {}) {
  const row = {
    clientId: clientId || newClientId(type),
    branchId: branchId || payload.branchId || null,
    type,
    payload,
    status: QUEUE_STATUS.PENDING,
    attempts: 0,
    lastError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  const id = await db.syncQueue.add(row)
  return { ...row, id }
}

/**
 * How many times one queue item may fail before it is quarantined.
 *
 * WITHOUT this cap the queue is a poison pill: pushQueue stops at the first failure to
 * preserve order, the failed row stays PENDING/FAILED, and every later sync retries that
 * same row first — forever. One permanently-unpushable op (a CHECK constraint rejection,
 * an FK to a deleted product, a schema mismatch after a partial deploy) therefore blocks
 * EVERY subsequent sale from ever reaching Supabase, silently and indefinitely, while the
 * branch keeps selling. For a POS whose queue holds fiscal records that is the worst
 * failure mode in the system. `attempts` was being written but never read, so no cap existed.
 */
export const MAX_SYNC_ATTEMPTS = 5

export async function listPending(branchId = null) {
  let rows = await db.syncQueue
    .where('status')
    .anyOf(QUEUE_STATUS.PENDING, QUEUE_STATUS.FAILED, QUEUE_STATUS.SYNCING)
    .sortBy('createdAt')
  if (branchId) rows = rows.filter((row) => row.branchId === branchId)
  return rows
}

/**
 * Quarantined items. Never auto-deleted — each one is a real sale/void/adjustment that did
 * NOT reach the server, so it has to stay recoverable and stay visible until a human acts.
 */
export async function listBlocked(branchId = null) {
  let rows = await db.syncQueue.where('status').equals(QUEUE_STATUS.BLOCKED).sortBy('createdAt')
  if (branchId) rows = rows.filter((row) => row.branchId === branchId)
  return rows
}

export async function countBlocked(branchId = null) {
  return (await listBlocked(branchId)).length
}

/** Put quarantined items back in line (after the underlying cause has been fixed). */
export async function retryBlocked(branchId = null) {
  const rows = await listBlocked(branchId)
  await Promise.all(
    rows.map((row) =>
      db.syncQueue.update(row.id, {
        status: QUEUE_STATUS.PENDING,
        attempts: 0,
        updatedAt: new Date().toISOString(),
      }),
    ),
  )
  return rows.length
}

export async function countPending(branchId = null) {
  const rows = await listPending(branchId)
  return rows.length
}

export async function hasPendingStockOps(branchId) {
  const rows = await listPending(branchId)
  return rows.some((row) => isStockAffectingType(row.type))
}

export async function markSyncing(id) {
  await db.syncQueue.update(id, {
    status: QUEUE_STATUS.SYNCING,
    updatedAt: new Date().toISOString(),
  })
}

export async function markDone(id) {
  // Keep a short success record then purge — data already applied remotely.
  // Prefer purge so queue stays small; only done after remote ACK.
  await db.syncQueue.delete(id)
}

/**
 * Record a push failure. Past MAX_SYNC_ATTEMPTS the item is quarantined (BLOCKED) so it
 * stops holding up everything queued behind it — see the constant's comment. Returns
 * whether the item was quarantined so the caller can decide to keep draining the queue.
 */
export async function markFailed(id, errorMessage) {
  const row = await db.syncQueue.get(id)
  const attempts = (row?.attempts || 0) + 1
  const blocked = attempts >= MAX_SYNC_ATTEMPTS
  await db.syncQueue.update(id, {
    status: blocked ? QUEUE_STATUS.BLOCKED : QUEUE_STATUS.FAILED,
    attempts,
    lastError: String(errorMessage || 'Sync failed').slice(0, 500),
    updatedAt: new Date().toISOString(),
  })
  return { blocked, attempts }
}

export async function resetStuckSyncing() {
  const stuck = await db.syncQueue.where('status').equals(QUEUE_STATUS.SYNCING).toArray()
  await Promise.all(
    stuck.map((row) =>
      db.syncQueue.update(row.id, {
        status: QUEUE_STATUS.PENDING,
        updatedAt: new Date().toISOString(),
      }),
    ),
  )
}
