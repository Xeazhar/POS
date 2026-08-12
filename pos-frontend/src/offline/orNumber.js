import db from './db'

/** Same shape as `allocate_or_number` in migrate_bir_pos_compliance.sql */
export function formatOrNumber(prefix, seq) {
  const p = String(prefix || 'OR').trim() || 'OR'
  const n = Math.max(1, Math.floor(Number(seq) || 1))
  return `${p}-${String(n).padStart(8, '0')}`
}

/** Trailing numeric segment — matches Postgres backfill regexp. */
export function parseOrSequence(orNumber) {
  if (!orNumber) return null
  const match = String(orNumber).match(/(\d+)\s*$/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) && n >= 1 ? n : null
}

async function maxAssignedSequence(branchId) {
  const txns = await db.transactions.where('branchId').equals(branchId).toArray()
  let max = 0
  for (const txn of txns) {
    const seq = parseOrSequence(txn.orNumber || txn.or_number)
    if (seq != null && seq > max) max = seq
  }
  return max
}

/**
 * Align local counter with server `branches.or_next` and any pending local sales.
 * Each branch keeps its own sequence in `branchMeta`.
 */
export async function seedOrCounter(branchId, { orPrefix, orNext } = {}) {
  if (!branchId) return
  const localMax = await maxAssignedSequence(branchId)
  await db.transaction('rw', db.branchMeta, async () => {
    const existing = (await db.branchMeta.get(branchId)) || { branchId }
    const serverNext = Number(orNext)
    const next = Math.max(
      Number.isFinite(serverNext) && serverNext >= 1 ? serverNext : 1,
      localMax + 1,
      Number(existing.orNext) || 1,
    )
    await db.branchMeta.put({
      ...existing,
      branchId,
      orPrefix: orPrefix ?? existing.orPrefix ?? 'OR',
      orNext: next,
      updatedAt: new Date().toISOString(),
    })
  })
}

/**
 * Allocate the next invoice/OR number for a branch (offline-safe, Dexie-atomic).
 * Call at sale commit so receipts can print immediately.
 */
export async function allocateLocalOrNumber(branchId, { orPrefix } = {}) {
  if (!branchId) throw new Error('Branch id required for OR allocation')

  return db.transaction('rw', db.branchMeta, async () => {
    let meta = await db.branchMeta.get(branchId)
    if (!meta?.orNext) {
      const localMax = await maxAssignedSequence(branchId)
      meta = {
        branchId,
        orPrefix: orPrefix || meta?.orPrefix || 'OR',
        orNext: Math.max(localMax + 1, 1),
      }
    } else if (orPrefix && meta.orPrefix !== orPrefix) {
      meta = { ...meta, orPrefix }
    }

    const orNumber = formatOrNumber(meta.orPrefix, meta.orNext)
    await db.branchMeta.put({
      ...meta,
      branchId,
      orNext: Number(meta.orNext) + 1,
      updatedAt: new Date().toISOString(),
    })
    return orNumber
  })
}
