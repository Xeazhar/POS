/** Queue action types the sync engine knows how to push. */
export const QUEUE_TYPES = {
  COMPLETE_SALE: 'complete_sale',
  VOID_SALE: 'void_sale',
  ADJUST_STOCK: 'adjust_stock',
  SET_INVENTORY: 'set_inventory',
  CLOSE_DAY: 'close_day',
  REOPEN_DAY: 'reopen_day',
  CREATE_PRODUCT: 'create_product',
  UPDATE_PRODUCT: 'update_product',
  PRICE_CHANGE: 'price_change',
}

export const QUEUE_STATUS = {
  PENDING: 'pending',
  SYNCING: 'syncing',
  FAILED: 'failed',
  DONE: 'done',
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
