import * as api from '../lib/api'
import { withTimeout } from '../utils/withTimeout'
import db, { META_KEYS } from './db'
import { canSyncWithBackend, isDeviceOnline } from './reachability'
import { QUEUE_STATUS, QUEUE_TYPES, asUuidClientId } from './queueTypes'
import {
  countBlocked,
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
  saveBranchFiscalHeader,
} from './repository'
import { seedOrCounter } from './orNumber'
import { putSupervisorVerifiers } from './supervisorPin'
import {
  closeLocalShift,
  markShiftSynced,
  pruneLocalShifts,
  putRemoteShifts,
  resolveShiftServerId,
} from './shifts'

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
  return isDeviceOnline()
}

/** Device online AND backend responded to a recent ping. */
export async function isBackendReachable(force = false) {
  return canSyncWithBackend(force)
}

/**
 * Pull remote catalog/txns into IndexedDB.
 * Never overwrites local inventory counts while stock-affecting queue items exist —
 * those counts are owned by local sales until pushed.
 */
export async function pullFromRemote(branchId) {
  if (!api.hasSupabase || !branchId || !(await canSyncWithBackend())) {
    return readBranchSnapshot(branchId)
  }

  const remote = await withTimeout(
    api.bootstrapBranchData(branchId),
    20000,
    'Branch bootstrap',
  ).catch(async () => readBranchSnapshot(branchId))
  if (!remote?.products) return readBranchSnapshot(branchId)
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
    orPrefix: remote.orPrefix,
    orNext: remote.orNext,
    updatedAt: new Date().toISOString(),
  })

  if (remote.orPrefix != null || remote.orNext != null) {
    await seedOrCounter(branchId, { orPrefix: remote.orPrefix, orNext: remote.orNext })
  }
  if (remote.fiscalHeader) {
    await saveBranchFiscalHeader(branchId, remote.fiscalHeader)
  }

  try {
    const verifiers = await api.fetchSupervisorPinVerifiers(branchId)
    if (verifiers?.length) await putSupervisorVerifiers(branchId, verifiers)
  } catch {
    /* migrate_offline_supervisor_pin.sql may not be applied yet */
  }

  // Shifts that are open somewhere on this branch right now. Pulled so a terminal knows
  // another device already holds a drawer before its cashier counts cash into it —
  // otherwise the clash only surfaces server-side, after the count.
  try {
    const openShifts = await api.fetchOpenShiftsForBranch(branchId)
    await putRemoteShifts(branchId, openShifts)
    await pruneLocalShifts(branchId)
  } catch {
    /* shift schema not applied yet — the rest of the pull is still valid */
  }

  await db.meta.put({ key: META_KEYS.lastPullAt, value: new Date().toISOString() })

  const snapshot = await readBranchSnapshot(branchId)
  return {
    ...snapshot,
    products,
    categories: remote.categories || [],
    dayOpenHour: Number(remote.dayOpenHour ?? 7),
  }
}

/**
 * Server uuid for a shift the payload only knows by its device-generated clientId.
 *
 * Normally the OPEN_SHIFT sits ahead of this item in the FIFO queue, so throwing keeps
 * this item in line until the open lands. Dropping the attribution eagerly would produce
 * sales belonging to no shift — the accountability gap this feature exists to close.
 *
 * The exception is a shift open that is BLOCKED (quarantined after MAX_SYNC_ATTEMPTS).
 * It is never going to land, and holding completed SALES hostage to it would put fiscal
 * records at risk to protect a reporting field. In that case the sale is pushed
 * unattributed — a sale on the server with a missing shift beats a sale that only exists
 * on one device.
 */
async function requireShiftServerId(clientId) {
  const serverId = await resolveShiftServerId(clientId)
  if (serverId) return serverId
  const openOp = await db.syncQueue.where('clientId').equals(clientId).first()
  if (openOp && openOp.status !== QUEUE_STATUS.BLOCKED) {
    throw new Error(`Shift ${clientId} has not synced yet — retrying after it does.`)
  }
  return null
}

/**
 * Server uuid for a sale voided before its own COMPLETE_SALE had synced.
 *
 * `voidTransaction()` (posStore.js) enqueues VOID_SALE with whatever `id` the sale had on
 * the device at that moment — for a sale rung offline (or just before its push completed),
 * that is still the client-generated `txn_...` id, not a real uuid. Passing that straight to
 * `void_sale_secure`'s `p_transaction_id uuid` parameter fails hard with "invalid input
 * syntax for type uuid" — the sale's own COMPLETE_SALE resolves its shift the same way
 * (`requireShiftServerId`) but nothing resolved the sale's OWN id before this was found.
 *
 * Same shape as `requireShiftServerId`: throw to keep this item first in the FIFO queue
 * until the COMPLETE_SALE ahead of it lands (`loadTransactionByClientId` finds it once
 * `transactions.client_id` is set), or return null once that COMPLETE_SALE is BLOCKED and
 * will never land — nothing to void against, this item is dropped rather than retried
 * forever.
 */
async function requireTransactionServerId(clientId, branchId) {
  const txn = await api.loadTransactionByClientId(branchId, clientId).catch(() => null)
  if (txn?.id) return txn.id
  const saleOp = await db.syncQueue.where('clientId').equals(clientId).first()
  if (saleOp && saleOp.status !== QUEUE_STATUS.BLOCKED) {
    throw new Error(`Sale ${clientId} has not synced yet — retrying after it does.`)
  }
  return null
}

function isLocalTransactionId(id) {
  return typeof id === 'string' && id.startsWith('txn_')
}

async function pushOne(item) {
  const { type, payload, branchId } = item
  switch (type) {
    case QUEUE_TYPES.OPEN_SHIFT: {
      const shift = await api.openShift(payload)
      await markShiftSynced(payload.clientId, shift)
      return
    }
    case QUEUE_TYPES.CLOSE_SHIFT: {
      const shiftId = payload.shiftId || (await requireShiftServerId(payload.clientId))
      // The open never reached the server and never will (quarantined). There is no remote
      // row to close; the local record already shows it ended.
      if (!shiftId) return
      const closed = await api.closeShift({
        shiftId,
        endingCash: payload.endingCash,
        note: payload.note,
        closedBy: payload.closedBy,
      })
      // Take the server's expected/variance — it derives them from the sales record, and
      // the offline estimate the device showed at cash-out can be short a sale that
      // synced from another terminal.
      if (closed) {
        await closeLocalShift(payload.clientId, {
          serverId: closed.id,
          endingCash: closed.endingCash,
          expectedCash: closed.expectedCash,
          variance: closed.variance,
          cashSales: closed.cashSales,
          cashRefunds: closed.cashRefunds,
          cashPaidOut: closed.cashPaidOut,
          cashPickups: closed.cashPickups,
          clockOut: closed.clockOut,
          syncStatus: 'synced',
        })
      }
      return
    }
    case QUEUE_TYPES.CASH_MOVEMENT_APPROVED: {
      const shiftId = payload.shiftId || (await requireShiftServerId(payload.shiftClientId))
      if (!shiftId) throw new Error('Shift not synced yet — cannot push cash movement.')
      // cash_movements.client_id is uuid — strip `cash_` prefixes from older queue rows.
      const serverClientId = asUuidClientId(payload.clientId)
      if (payload.selfRecorded && !payload.serverId && !payload.id) {
        const pending = await api.createCashMovementPending({
          shiftId,
          branchId: payload.branchId,
          drawerId: payload.drawerId,
          drawerLabel: payload.drawerLabel,
          type: payload.type,
          amount: payload.amount,
          reason: payload.reason,
          requestedBy: payload.requestedBy,
          clientId: serverClientId,
          createdOffline: payload.createdOffline === true,
        })
        await api.selfRecordCashMovement({
          id: pending.id,
          staffId: payload.requestedBy,
          ack: payload.ack !== false,
        })
        if (payload.clientId && pending?.id) {
          await db.cashMovements.update(payload.clientId, {
            serverId: pending.id,
            status: 'self_recorded',
            syncStatus: 'synced',
          })
        }
        return
      }
      const row = await api.createCashMovementApproved({
        ...payload,
        shiftId,
        clientId: serverClientId,
      })
      if (payload.clientId && row?.id) {
        await db.cashMovements.update(payload.clientId, {
          serverId: row.id,
          status: row.status,
          syncStatus: 'synced',
        })
      }
      return
    }
    case QUEUE_TYPES.CASH_MOVEMENT_PENDING: {
      const shiftId = payload.shiftId || (await requireShiftServerId(payload.shiftClientId))
      if (!shiftId) throw new Error('Shift not synced yet — cannot push cash movement.')
      const row = await api.createCashMovementPending({
        ...payload,
        shiftId,
        clientId: asUuidClientId(payload.clientId),
      })
      if (payload.clientId && row?.id) {
        await db.cashMovements.update(payload.clientId, {
          serverId: row.id,
          status: row.status,
          syncStatus: 'synced',
        })
      }
      return
    }
    case QUEUE_TYPES.CASH_MOVEMENT_PIN_APPROVE: {
      const id = payload.id || payload.serverId
      if (!id) throw new Error('Cash movement id missing.')
      await api.approveCashMovementPin({ id, approvedBy: payload.approvedBy })
      return
    }
    case QUEUE_TYPES.CASH_MOVEMENT_SELF_RECORD: {
      const id = payload.id || payload.serverId
      if (!id) throw new Error('Cash movement id missing.')
      await api.selfRecordCashMovement({
        id,
        staffId: payload.staffId,
        ack: payload.ack !== false,
      })
      return
    }
    case QUEUE_TYPES.COMPLETE_SALE: {
      const shiftId = payload.shiftClientId
        ? await requireShiftServerId(payload.shiftClientId)
        : payload.shiftId || null
      await api.completeSale({
        ...payload,
        shiftId,
        clientId: payload.clientId || payload.localTransactionId || null,
      })
      // Drop local pending txn; next pull will bring server row
      if (payload.localTransactionId) {
        await db.transactions.delete(payload.localTransactionId)
      }
      return
    }
    case QUEUE_TYPES.VOID_SALE: {
      const transactionId = isLocalTransactionId(payload.id)
        ? await requireTransactionServerId(payload.id, branchId)
        : payload.id
      // The sale never reached the server and never will (quarantined) — nothing to void.
      if (!transactionId) return
      await api.voidSale(transactionId, payload.reason, payload.staffId || null, payload.approvedBy || null)
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
    case QUEUE_TYPES.SUBMIT_DAY:
    case QUEUE_TYPES.CLOSE_DAY: {
      await api.submitDayEnd(payload)
      if (payload.entry?.localId) await db.dayEnds.delete(payload.entry.localId)
      return
    }
    case QUEUE_TYPES.APPROVE_DAY: {
      await api.approveDayEnd(payload)
      return
    }
    case QUEUE_TYPES.REOPEN_DAY: {
      await api.reopenDayEnd(payload)
      return
    }
    case QUEUE_TYPES.REJECT_DAY_REQUEST: {
      await api.rejectDayEndRequest(payload)
      return
    }
    case QUEUE_TYPES.REQUEST_DAY_END: {
      const row = await api.requestDayEnd(payload)
      if (payload.localId) await db.dayEnds.delete(payload.localId)
      return row
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
    case QUEUE_TYPES.LOG_APPROVAL_EVENT: {
      await api.logApprovalEventRemote(payload)
      const { markOfflineAuditSynced } = await import('./offlineAudit')
      if (payload.clientId) await markOfflineAuditSynced(payload.clientId)
      return
    }
    default:
      throw new Error(`Unknown queue type: ${type}`)
  }
}

/** Max queue items per push tick — keeps checkout/UI responsive after large offline bursts. */
export const PUSH_BATCH_SIZE = 8

let drainingQueue = false
let pushInFlight = false

/** Push pending queue items FIFO. Stops on first hard failure (keeps order). */
export async function pushQueue(branchId = null, { maxItems = PUSH_BATCH_SIZE } = {}) {
  if (!api.hasSupabase || !(await canSyncWithBackend())) {
    return { pushed: 0, remaining: await countPending(branchId), blocked: await countBlocked(branchId), error: null }
  }
  if (pushInFlight) {
    return {
      pushed: 0,
      remaining: await countPending(branchId),
      blocked: await countBlocked(branchId),
      error: null,
    }
  }

  pushInFlight = true
  try {
  await resetStuckSyncing()
  const pending = await listPending(branchId)
  let pushed = 0
  let error = null

  for (const item of pending) {
    if (maxItems != null && pushed >= maxItems) break
    try {
      await markSyncing(item.id)
      await pushOne(item)
      await markDone(item.id)
      pushed += 1
    } catch (err) {
      error = err.message || String(err)
      const { blocked } = await markFailed(item.id, error)
      // Stop on a normal failure so FIFO order is preserved for the retry (stock ops depend
      // on it). But once an item is quarantined it is out of the queue for good, so keep
      // draining — otherwise everything behind a permanently-bad op never syncs at all.
      if (!blocked) break
    }
  }

  if (pushed > 0) {
    await db.meta.put({ key: META_KEYS.lastPushAt, value: new Date().toISOString() })
  }

  const remaining = await countPending(branchId)
  return {
    pushed,
    remaining,
    blocked: await countBlocked(branchId),
    error,
  }
  } finally {
    pushInFlight = false
  }
}

/**
 * Drain the outbox in the background without blocking checkout.
 * Yields between batches so a large offline backlog cannot freeze the UI.
 */
export async function drainQueueInBackground(branchId) {
  if (!branchId || !api.hasSupabase || drainingQueue) return null
  if (!(await canSyncWithBackend())) return null

  drainingQueue = true
  emit({
    status: 'syncing',
    online: isOnline(),
    backendReachable: true,
    pending: await countPending(branchId),
  })
  try {
    let lastPush = { pushed: 0, remaining: await countPending(branchId), error: null }
    while ((await canSyncWithBackend()) && lastPush.remaining > 0) {
      lastPush = await pushQueue(branchId, { maxItems: PUSH_BATCH_SIZE })
      emit({
        status: 'syncing',
        online: true,
        backendReachable: true,
        pending: lastPush.remaining,
        lastError: lastPush.error,
      })
      if (lastPush.error && lastPush.pushed === 0) break
      if (lastPush.remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    let data = null
    if ((await canSyncWithBackend()) && !lastPush.error) {
      data = await pullFromRemote(branchId).catch(() => readBranchSnapshot(branchId))
    }
    emit({
      status: lastPush.error ? 'error' : 'idle',
      online: isOnline(),
      backendReachable: await canSyncWithBackend(),
      pending: await countPending(branchId),
      blocked: await countBlocked(branchId),
      lastError: lastPush.error,
    })
    return data
  } catch (err) {
    emit({
      status: 'error',
      online: isOnline(),
      backendReachable: await canSyncWithBackend(),
      lastError: err.message,
      pending: await countPending(branchId),
    })
    return readBranchSnapshot(branchId)
  } finally {
    drainingQueue = false
  }
}

/**
 * Synchronizes a branch by pushing pending local operations before retrieving remote data.
 * Falls back to the local snapshot when synchronization is unavailable or fails.
 * @param {string} branchId - The branch identifier.
 * @return {Promise<Object|null>} The synchronized or locally stored branch snapshot.
 */
export async function syncBranch(branchId) {
  if (!branchId) return null
  if (syncing) {
    return readBranchSnapshot(branchId)
  }

  syncing = true
  const reachable = await canSyncWithBackend()
  emit({ status: 'syncing', online: isOnline(), backendReachable: reachable, pending: await countPending(branchId) })
  try {
    if (reachable && api.hasSupabase) {
      const pushResult = await pushQueue(branchId, { maxItems: PUSH_BATCH_SIZE })
      emit({
        status: 'syncing',
        pending: pushResult.remaining,
        online: true,
        lastError: pushResult.error,
      })
      // Large backlog keeps draining in the background — don't block this caller on all N sales.
      if (pushResult.remaining > 0 && !pushResult.error) {
        queueMicrotask(() => {
          void drainQueueInBackground(branchId)
        })
      }
      let data
      if (pushResult.remaining === 0 && !pushResult.error) {
        data = await pullFromRemote(branchId)
      } else {
        // Pending sales must not block day-end refresh — manager reopen has to reach
        // ShiftGate on re-login even while the outbox still holds local sales.
        const { refreshBranchActivity } = await import('../hooks/useBranchOperationsLive')
        await refreshBranchActivity(branchId).catch(() => {})
        data = await readBranchSnapshot(branchId)
      }
      emit({
        status: pushResult.error ? 'error' : 'idle',
        online: true,
        pending: pushResult.remaining,
        blocked: pushResult.blocked,
        lastError: pushResult.error,
      })
      return data
    }
    const local = await readBranchSnapshot(branchId)
    emit({ status: 'offline', online: isOnline(), backendReachable: false, pending: await countPending(branchId) })
    return local
  } catch (err) {
    emit({ status: 'error', online: isOnline(), backendReachable: await canSyncWithBackend(), lastError: err.message, pending: await countPending(branchId) })
    // Fall back to whatever is on disk — never wipe local
    return readBranchSnapshot(branchId)
  } finally {
    syncing = false
  }
}

export async function getSyncStatus(branchId = null) {
  const reachable = await canSyncWithBackend()
  return {
    online: isOnline(),
    backendReachable: reachable,
    pending: await countPending(branchId),
    blocked: await countBlocked(branchId),
    lastPullAt: (await db.meta.get(META_KEYS.lastPullAt))?.value || null,
    lastPushAt: (await db.meta.get(META_KEYS.lastPushAt))?.value || null,
  }
}
