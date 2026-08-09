/** Queue action types the sync engine knows how to push. */
export const QUEUE_TYPES = {
  COMPLETE_SALE: 'complete_sale',
  VOID_SALE: 'void_sale',
  ADJUST_STOCK: 'adjust_stock',
  SET_INVENTORY: 'set_inventory',
  SUBMIT_DAY: 'submit_day',
  APPROVE_DAY: 'approve_day',
  CLOSE_DAY: 'close_day',
  REOPEN_DAY: 'reopen_day',
  REQUEST_DAY_END: 'request_day_end',
  CREATE_PRODUCT: 'create_product',
  UPDATE_PRODUCT: 'update_product',
  PRICE_CHANGE: 'price_change',
  OPEN_SHIFT: 'open_shift',
  CLOSE_SHIFT: 'close_shift',
}

export const QUEUE_STATUS = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  FAILED: 'failed',
  DONE: 'done',
  /**
   * Quarantined after MAX_SYNC_ATTEMPTS (see syncQueue.js). Excluded from the push loop so
   * one unpushable op can't block every sale behind it, but never deleted — it is a fiscal
   * record that did not reach the server and needs a human to resolve it.
   */
  BLOCKED: 'blocked',
}

const STOCK_AFFECTING = new Set([
  QUEUE_TYPES.COMPLETE_SALE,
  QUEUE_TYPES.VOID_SALE,
  QUEUE_TYPES.ADJUST_STOCK,
  QUEUE_TYPES.SET_INVENTORY,
  QUEUE_TYPES.CREATE_PRODUCT,
])

export function isStockAffectingType(type) {
  return STOCK_AFFECTING.has(type)
}

export function newClientId(prefix = 'op') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}
