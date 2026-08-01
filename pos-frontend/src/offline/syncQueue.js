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

export async function listPending(branchId = null) {
  let rows = await db.syncQueue
    .where('status')
    .anyOf(QUEUE_STATUS.PENDING, QUEUE_STATUS.FAILED, QUEUE_STATUS.SYNCING)
    .sortBy('createdAt')
  if (branchId) rows = rows.filter((row) => row.branchId === branchId)
  return rows
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

export async function markFailed(id, errorMessage) {
  const row = await db.syncQueue.get(id)
  await db.syncQueue.update(id, {
    status: QUEUE_STATUS.FAILED,
    attempts: (row?.attempts || 0) + 1,
    lastError: String(errorMessage || 'Sync failed').slice(0, 500),
    updatedAt: new Date().toISOString(),
  })
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
