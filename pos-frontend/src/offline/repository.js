import db from './db'

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

export async function putDayEnds(branchId, dayEnds) {
  await db.transaction('rw', db.dayEnds, async () => {
    const localOnly = await db.dayEnds
      .where('branchId')
      .equals(branchId)
      .filter((d) => d.syncStatus === 'pending' || d.syncStatus === 'local')
      .toArray()
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
  const lineRows = (lines || transaction.itemsList || []).map((line, index) => {
    const quantity = line.pricingMode === 'kg' ? Number(line.weight || 0) : Number(line.quantity || 0)
    const unitPrice = Number(line.price || line.unitPrice || 0)
    return {
      id: `${transaction.id}-line-${index}`,
      transactionId: transaction.id,
      productId: line.id || line.productId || null,
      name: line.name || 'Item',
      sku: line.sku || '',
      pricingMode: line.pricingMode === 'kg' ? 'kg' : 'pc',
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
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

export async function updateLocalProducts(products) {
  if (!products?.length) return
  await db.products.bulkPut(products)
}
