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

/**
 * v2 — cash shifts.
 *
 * Keyed by the device-generated `clientId`, not the server uuid, because a shift can be
 * opened with no network at all: the cashier counts the drawer, starts selling, and the
 * server row only exists later. Sales queued in between reference the clientId, and
 * syncEngine swaps in `serverId` when the open pushes.
 *
 * This table is also what makes a re-login offline still find the open shift — the
 * "do I need a change fund?" question is answered from here, never from a round-trip.
 */
db.version(2).stores({
  shifts: 'clientId, serverId, branchId, staffId, drawerId, status, businessDate',
})

export const META_KEYS = {
  lastPullAt: 'lastPullAt',
  lastPushAt: 'lastPushAt',
  schemaVersion: 'schemaVersion',
}

export default db
