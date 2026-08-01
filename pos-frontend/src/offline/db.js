import Dexie from 'dexie'

/**
 * Local-first store for CalePOS.
 * All UI reads should come from here after sync/hydrate.
 * Unsynced ops live in `syncQueue` until pushed to Supabase.
 */
export const db = new Dexie('calepos-offline-v1')

db.version(1).stores({
  meta: 'key',
  products: 'id, branchId, sku, barcode, updatedAt',
  transactions: 'id, branchId, date, createdAt, syncStatus',
  transactionItems: 'id, transactionId, productId',
  movements: 'id, branchId, productId, createdAt',
  dayEnds: 'id, branchId, date, status',
  categories: 'id, name',
  branchMeta: 'branchId',
  /** Durable offline action queue — never delete until successfully synced */
  syncQueue: '++id, clientId, branchId, type, status, createdAt',
  deviceSettings: 'id',
})

export const META_KEYS = {
  lastPullAt: 'lastPullAt',
  lastPushAt: 'lastPushAt',
  schemaVersion: 'schemaVersion',
}

export default db
