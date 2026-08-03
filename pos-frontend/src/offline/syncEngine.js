import * as api from '../lib/api'
import db, { META_KEYS } from './db'
import { QUEUE_TYPES } from './queueTypes'
import {
  countPending,
  hasPendingStockOps,
  listPending,
  markDone,
  markFailed,
  markSyncing,
  resetStuckSyncing,
} from './syncQueue'
import {
  mergeProductsFromRemote,
  putDayEnds,
  putMovements,
  putTransactions,
  readBranchSnapshot,
} from './repository'

let syncing = false
const listeners = new Set()

export function subscribeSync(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(state) {
  listeners.forEach((fn) => {
    try {
      fn(state)
    } catch {
      /* ignore */
    }
  })
}

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

/**
 * Pull remote catalog/txns into IndexedDB.
 * Never overwrites local inventory counts while stock-affecting queue items exist —
 * those counts are owned by local sales until pushed.
 */
export async function pullFromRemote(branchId) {
  if (!api.hasSupabase || !branchId || !isOnline()) {
    return readBranchSnapshot(branchId)
  }

  const remote = await api.bootstrapBranchData(branchId)
  const preserveStock = await hasPendingStockOps(branchId)

  const products = await mergeProductsFromRemote(branchId, remote.products, { preserveStock })
  await putTransactions(branchId, remote.transactions)
  await putMovements(branchId, remote.movements)
  await putDayEnds(branchId, remote.dayEnds)

  if (remote.categories?.length) {
    await db.categories.clear()
    await db.categories.bulkPut(
      remote.categories.map((c) =>
        typeof c === 'string' ? { id: c, name: c } : { id: c.id || c.name, name: c.name || c },
      ),
    )
  }

  await db.branchMeta.put({
    branchId,
    name: remote.branchName || '',
    dayOpenHour: Number(remote.dayOpenHour ?? 7),
    updatedAt: new Date().toISOString(),
  })

  await db.meta.put({ key: META_KEYS.lastPullAt, value: new Date().toISOString() })

  const snapshot = await readBranchSnapshot(branchId)
  return {
    ...snapshot,
    products,
    categories: remote.categories || [],
    dayOpenHour: Number(remote.dayOpenHour ?? 7),
  }
}

async function pushOne(item) {
  const { type, payload } = item
  switch (type) {
    case QUEUE_TYPES.COMPLETE_SALE: {
      await api.completeSale({
        ...payload,
        clientId: payload.clientId || payload.localTransactionId || null,
      })
      // Drop local pending txn; next pull will bring server row
      if (payload.localTransactionId) {
        await db.transactions.delete(payload.localTransactionId)
      }
      return
    }
    case QUEUE_TYPES.VOID_SALE: {
      await api.voidSale(payload.id, payload.reason, payload.staffId || null, payload.approvedBy || null)
      return
    }
    case QUEUE_TYPES.ADJUST_STOCK: {
      await api.adjustStock(payload)
      return
    }
    case QUEUE_TYPES.SET_INVENTORY: {
      await api.setInventoryStock(payload)
      return
    }
    case QUEUE_TYPES.CLOSE_DAY: {
      await api.closeDayEnd(payload)
      if (payload.entry?.localId) await db.dayEnds.delete(payload.entry.localId)
      return
    }
    case QUEUE_TYPES.REOPEN_DAY: {
      await api.reopenDayEnd(payload)
      return
    }
    case QUEUE_TYPES.CREATE_PRODUCT: {
      await api.createProduct(payload)
      return
    }
    case QUEUE_TYPES.UPDATE_PRODUCT: {
      const { id, values, inventory, previousPrice, branchId, staffId } = payload
      await api.updateProductRow(id, values, {
        branchId: branchId || payload.branchId,
        staffId: staffId || payload.staffId,
        previousPrice,
      })
      if (inventory) await api.setInventoryStock(inventory)
      return
    }
    case QUEUE_TYPES.PRICE_CHANGE: {
      await api.updateProductPrice(payload.productId, payload.newPrice, {
        branchId: payload.branchId,
        staffId: payload.staffId,
        previousPrice: payload.oldPrice,
        productName: payload.detail,
      })
      return
    }
    default:
      throw new Error(`Unknown queue type: ${type}`)
  }
}

/** Push pending queue items FIFO. Stops on first hard failure (keeps order). */
export async function pushQueue(branchId = null) {
  if (!api.hasSupabase || !isOnline()) {
    return { pushed: 0, remaining: await countPending(branchId), error: null }
  }

  await resetStuckSyncing()
  const pending = await listPending(branchId)
  let pushed = 0
  let error = null

  for (const item of pending) {
    try {
      await markSyncing(item.id)
      await pushOne(item)
      await markDone(item.id)
      pushed += 1
    } catch (err) {
      error = err.message || String(err)
      await markFailed(item.id, error)
      break
    }
  }

  if (pushed > 0) {
    await db.meta.put({ key: META_KEYS.lastPushAt, value: new Date().toISOString() })
  }

  return { pushed, remaining: await countPending(branchId), error }
}

/**
 * Full sync cycle: push local ops first (so sales land), then pull.
 * Reads always from IndexedDB after this.
 */
export async function syncBranch(branchId) {
  if (!branchId) return null
  if (syncing) {
    return readBranchSnapshot(branchId)
  }

  syncing = true
  emit({ status: 'syncing', online: isOnline(), pending: await countPending(branchId) })
  try {
    if (isOnline() && api.hasSupabase) {
      const pushResult = await pushQueue(branchId)
      emit({
        status: 'syncing',
        pending: pushResult.remaining,
        online: true,
        lastError: pushResult.error,
      })
      const data = await pullFromRemote(branchId)
      emit({
        status: pushResult.error ? 'error' : 'idle',
        online: true,
        pending: pushResult.remaining,
        lastError: pushResult.error,
      })
      return data
    }
    const local = await readBranchSnapshot(branchId)
    emit({ status: 'offline', online: false, pending: await countPending(branchId) })
    return local
  } catch (err) {
    emit({ status: 'error', online: isOnline(), lastError: err.message, pending: await countPending(branchId) })
    // Fall back to whatever is on disk — never wipe local
    return readBranchSnapshot(branchId)
  } finally {
    syncing = false
  }
}

export async function getSyncStatus(branchId = null) {
  return {
    online: isOnline(),
    pending: await countPending(branchId),
    lastPullAt: (await db.meta.get(META_KEYS.lastPullAt))?.value || null,
    lastPushAt: (await db.meta.get(META_KEYS.lastPushAt))?.value || null,
  }
}
