import db from './db'

export async function getLocalBranchFiscalHeader(branchId) {
  if (!branchId) return null
  const meta = await db.branchMeta.get(branchId)
  return meta?.fiscalHeader || null
}

/** Persist branch identity block for offline receipt printing. */
export async function saveBranchFiscalHeader(branchId, fiscalHeader) {
  if (!branchId || !fiscalHeader) return
  const existing = (await db.branchMeta.get(branchId)) || { branchId }
  await db.branchMeta.put({
    ...existing,
    branchId,
    fiscalHeader,
    updatedAt: new Date().toISOString(),
  })
}

export async function readBranchSnapshot(branchId) {
  const [products, transactions, movements, dayEnds, categories, branch] = await Promise.all([
    db.products.where('branchId').equals(branchId).toArray(),
    db.transactions.where('branchId').equals(branchId).reverse().sortBy('createdAt'),
    db.movements.where('branchId').equals(branchId).reverse().sortBy('createdAt'),
    db.dayEnds.where('branchId').equals(branchId).reverse().sortBy('date'),
    db.categories.toArray(),
    db.branchMeta.get(branchId),
  ])

  return {
    products: products.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    transactions: (transactions || []).slice(0, 200),
    movements: (movements || []).slice(0, 500),
    dayEnds: dayEnds || [],
    categories: categories || [],
    dayOpenHour: Number(branch?.dayOpenHour ?? 7),
    branchName: branch?.name || '',
  }
}

export async function replaceCatalog(branchId, { products, categories, dayOpenHour, branchName }) {
  await db.transaction('rw', db.products, db.categories, db.branchMeta, async () => {
    const existing = await db.products.where('branchId').equals(branchId).toArray()
    const keepStock = new Map(existing.map((p) => [p.id, p.stock]))
    await db.products.where('branchId').equals(branchId).delete()
    await db.products.bulkPut(
      (products || []).map((p) => ({
        ...p,
        branchId,
        // Caller decides whether stock comes from remote or preserved local
        stock: p.stock,
        _preservedHint: keepStock.has(p.id),
      })),
    )
    if (categories?.length) {
      await db.categories.clear()
      await db.categories.bulkPut(categories.map((c) => (typeof c === 'string' ? { id: c, name: c } : c)))
    }
    await db.branchMeta.put({
      branchId,
      name: branchName || '',
      dayOpenHour: Number(dayOpenHour ?? 7),
      updatedAt: new Date().toISOString(),
    })
  })
}

/** Merge product metadata from server; optionally preserve local stock counts. */
export async function mergeProductsFromRemote(branchId, remoteProducts, { preserveStock }) {
  const local = await db.products.where('branchId').equals(branchId).toArray()
  const localById = Object.fromEntries(local.map((p) => [p.id, p]))

  const merged = remoteProducts.map((remote) => {
    const prev = localById[remote.id]
    if (preserveStock && prev) {
      return { ...remote, branchId, stock: Number(prev.stock) }
    }
    return { ...remote, branchId }
  })

  await db.transaction('rw', db.products, async () => {
    await db.products.where('branchId').equals(branchId).delete()
    await db.products.bulkPut(merged)
  })
  return merged
}

export async function putTransactions(branchId, transactions) {
  await db.transaction('rw', db.transactions, async () => {
    // Keep local-only (unsynced) rows
    const localOnly = await db.transactions
      .where('branchId')
      .equals(branchId)
      .filter((t) => t.syncStatus === 'pending' || t.syncStatus === 'local')
      .toArray()
    const remoteIds = new Set((transactions || []).map((t) => t.id))
    await db.transactions
      .where('branchId')
      .equals(branchId)
      .filter((t) => t.syncStatus !== 'pending' && t.syncStatus !== 'local')
      .delete()
    await db.transactions.bulkPut(
      (transactions || []).map((t) => ({
        ...t,
        branchId,
        syncStatus: 'synced',
        createdAt: t.createdAt || new Date().toISOString(),
      })),
    )
    // Re-add local pending that aren't already on remote
    const toKeep = localOnly.filter((t) => !remoteIds.has(t.id))
    if (toKeep.length) await db.transactions.bulkPut(toKeep)
  })
}

export async function putMovements(branchId, movements) {
  await db.transaction('rw', db.movements, async () => {
    const localOnly = await db.movements
      .where('branchId')
      .equals(branchId)
      .filter((m) => m.syncStatus === 'pending' || m.syncStatus === 'local')
      .toArray()
    await db.movements
      .where('branchId')
      .equals(branchId)
      .filter((m) => m.syncStatus !== 'pending' && m.syncStatus !== 'local')
      .delete()
    await db.movements.bulkPut(
      (movements || []).map((m) => ({
        ...m,
        branchId,
        syncStatus: 'synced',
        createdAt: m.createdAt || m.date || new Date().toISOString(),
      })),
    )
    if (localOnly.length) await db.movements.bulkPut(localOnly)
  })
}

/**
 * Synchronize branch day-end records while preserving local records for dates absent from the server response.
 * @param {string} branchId - The branch whose day-end records are synchronized.
 * @param {Array<Object>} dayEnds - Day-end records received from the server.
 */
export async function putDayEnds(branchId, dayEnds) {
  await db.transaction('rw', db.dayEnds, async () => {
    const serverDates = new Set((dayEnds || []).map((d) => d.date))
    const localOnly = (await db.dayEnds
      .where('branchId')
      .equals(branchId)
      .filter((d) => d.syncStatus === 'pending' || d.syncStatus === 'local')
      .toArray())
      // Server row for a business date wins — a stale local "closed" copy must not
      // survive a manager reopen and block ShiftGate after re-login.
      .filter((d) => !serverDates.has(d.date))
    await db.dayEnds
      .where('branchId')
      .equals(branchId)
      .filter((d) => d.syncStatus !== 'pending' && d.syncStatus !== 'local')
      .delete()
    await db.dayEnds.bulkPut(
      (dayEnds || []).map((d) => ({
        ...d,
        branchId,
        syncStatus: 'synced',
      })),
    )
    if (localOnly.length) await db.dayEnds.bulkPut(localOnly)
  })
}

export async function upsertLocalSale({ transaction, movements, products, lines }) {
  const discountType = transaction.discountType || transaction.discount_type || null
  const discountPct = discountType === 'pwd' || discountType === 'senior' ? 0.2 : 0
  const lineRows = (lines || transaction.itemsList || []).map((line, index) => {
    const quantity = line.pricingMode === 'kg' ? Number(line.weight || 0) : Number(line.quantity || 0)
    const unitPrice = Number(line.price || line.unitPrice || 0)
    const lineTotal = unitPrice * quantity
    const discountEligible = line.discountEligible === true
    const passedDiscountAmount = Number(line.discountAmount ?? 0)
    const computedDiscountAmount = discountPct > 0 && discountEligible ? Number((lineTotal * discountPct).toFixed(2)) : 0
    const discountAmount = passedDiscountAmount > 0 ? passedDiscountAmount : computedDiscountAmount
    return {
      id: `${transaction.id}-line-${index}`,
      transactionId: transaction.id,
      productId: line.id || line.productId || null,
      name: line.name || 'Item',
      sku: line.sku || '',
      pricingMode: line.pricingMode === 'kg' ? 'kg' : 'pc',
      quantity,
      unitPrice,
      lineTotal,
      discountEligible,
      discountAmount,
    }
  })

  await db.transaction('rw', db.transactions, db.movements, db.products, db.transactionItems, async () => {
    await db.transactions.put({
      ...transaction,
      itemsList: transaction.itemsList || lines || [],
    })
    await db.transactionItems.where('transactionId').equals(transaction.id).delete()
    if (lineRows.length) await db.transactionItems.bulkPut(lineRows)
    if (movements?.length) await db.movements.bulkPut(movements)
    if (products?.length) await db.products.bulkPut(products)
  })
}

export async function getLocalTransactionDetail(id) {
  const txn = await db.transactions.get(id)
  if (!txn) return null
  const lines = await db.transactionItems.where('transactionId').equals(id).toArray()
  return { transaction: txn, lines: lines.length ? lines : txn.itemsList || [] }
}

export async function patchLocalTransaction(id, patch) {
  const txn = await db.transactions.get(id)
  if (!txn) return null
  const next = { ...txn, ...patch }
  await db.transactions.put(next)
  return next
}

export async function putLocalMovement(movement) {
  if (!movement?.id) return
  await db.movements.put({
    ...movement,
    syncStatus: movement.syncStatus || 'pending',
    createdAt: movement.createdAt || new Date().toISOString(),
  })
}

export async function putLocalDayEnd(dayEnd) {
  if (!dayEnd?.id) return
  await db.dayEnds.put({
    ...dayEnd,
    syncStatus: dayEnd.syncStatus || 'pending',
  })
}

export async function putLocalCashMovement(movement) {
  if (!movement?.clientId) return
  await db.cashMovements.put({
    ...movement,
    syncStatus: movement.syncStatus || 'pending',
    requestedAt: movement.requestedAt || new Date().toISOString(),
  })
}

export async function updateLocalProducts(products) {
  if (!products?.length) return
  await db.products.bulkPut(products)
}

/** Cash movements mirrored locally for offline drawer / day-end views. */
export async function listLocalCashMovements({
  branchId,
  date = null,
  staffId = null,
  shiftIds = null,
} = {}) {
  if (!branchId) return []
  let rows = await db.cashMovements.where('branchId').equals(branchId).toArray()
  if (date) {
    rows = rows.filter((row) => String(row.requestedAt || row.businessDate || '').slice(0, 10) === date)
  }
  if (staffId) rows = rows.filter((row) => row.requestedBy === staffId)
  if (shiftIds?.length) {
    const ids = new Set(shiftIds.filter(Boolean))
    rows = rows.filter((row) => ids.has(row.shiftId) || ids.has(row.shiftClientId))
  }
  return rows.sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')))
}

async function readMetaCache(key) {
  const row = await db.meta.get(key)
  return row?.value ?? null
}

async function writeMetaCache(key, value) {
  await db.meta.put({ key, value, savedAt: new Date().toISOString() })
}

export function promoCacheKey(branchId) {
  return `promoCache:${branchId}`
}

export function catalogCacheKey(branchType) {
  return `catalogCache:${branchType || 'retail'}`
}

export function staffCacheKey(branchId) {
  return `staffCache:${branchId || 'all'}`
}

export function branchesCacheKey() {
  return 'branchesCache'
}

export async function readPromoCache(branchId) {
  return readMetaCache(promoCacheKey(branchId))
}

export async function writePromoCache(branchId, payload) {
  if (!branchId) return
  await writeMetaCache(promoCacheKey(branchId), payload)
}

export async function readCatalogCache(branchType) {
  return readMetaCache(catalogCacheKey(branchType))
}

export async function writeCatalogCache(branchType, rows) {
  await writeMetaCache(catalogCacheKey(branchType), rows || [])
}

export async function readStaffCache(branchId) {
  return readMetaCache(staffCacheKey(branchId))
}

export async function writeStaffCache(branchId, rows) {
  await writeMetaCache(staffCacheKey(branchId), rows || [])
}

export async function readBranchesCache() {
  return readMetaCache(branchesCacheKey())
}

export async function writeBranchesCache(rows) {
  await writeMetaCache(branchesCacheKey(), rows || [])
}

