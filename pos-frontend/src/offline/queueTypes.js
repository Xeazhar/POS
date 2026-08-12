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
  REJECT_DAY_REQUEST: 'reject_day_request',
  CREATE_PRODUCT: 'create_product',
  UPDATE_PRODUCT: 'update_product',
  PRICE_CHANGE: 'price_change',
  OPEN_SHIFT: 'open_shift',
  CLOSE_SHIFT: 'close_shift',
  CASH_MOVEMENT_APPROVED: 'cash_movement_approved',
  CASH_MOVEMENT_PENDING: 'cash_movement_pending',
  CASH_MOVEMENT_PIN_APPROVE: 'cash_movement_pin_approve',
  CASH_MOVEMENT_SELF_RECORD: 'cash_movement_self_record',
  LOG_APPROVAL_EVENT: 'log_approval_event',
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

/** Bare UUID for Postgres `uuid` columns (e.g. cash_movements.client_id). */
export function newUuidClientId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Coerce a local client id to a UUID for RPCs that take `uuid`.
 * Accepts bare UUIDs or `prefix_<uuid>` (from newClientId).
 */
export function asUuidClientId(value) {
  const raw = String(value || '').trim()
  if (!raw) return null
  if (UUID_RE.test(raw)) return raw
  const idx = raw.lastIndexOf('_')
  if (idx >= 0) {
    const tail = raw.slice(idx + 1)
    if (UUID_RE.test(tail)) return tail
  }
  return null
}
