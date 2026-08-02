import { categoryForMenuKind, normalizeMenuKind } from './ulam'

export async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function normalizeImportRow(raw, { restaurant = false } = {}) {
  const name = String(raw.name || '').trim().replace(/[<>]/g, '')
  const sku = String(raw.sku || '').trim().replace(/[<>]/g, '')
  const barcode = String(raw.barcode || '').replace(/\D/g, '')
  const rawCategory = String(
    raw.category || (restaurant ? 'Meat' : 'Groceries'),
  ).trim() || (restaurant ? 'Meat' : 'Groceries')
  const menuKind = restaurant
    ? normalizeMenuKind(raw.menuKind || raw.menu_kind, rawCategory)
    : null
  const category = restaurant ? categoryForMenuKind(menuKind, rawCategory) : rawCategory
  const pricingMode =
    restaurant
      ? 'pc'
      : raw.pricingMode === 'kg' || raw.pricingMode === 'per_kg'
        ? 'kg'
        : 'pc'
  const price = Number(raw.price ?? raw.regular_price ?? raw.regularPrice ?? 0)
  const budgetRaw = raw.budgetPrice ?? raw.budget_price
  const budgetPrice =
    restaurant && budgetRaw !== undefined && budgetRaw !== null && String(budgetRaw).trim() !== ''
      ? Number(budgetRaw)
      : null
  const stock = restaurant ? 0 : Number(raw.stock || 0)
  const lowStockAt = Number(raw.lowStockAt || 5)
  const availableToday =
    raw.availableToday === false ||
    raw.available_today === false ||
    String(raw.availableToday || raw.available_today || 'true').toLowerCase() === 'false'
      ? false
      : true
  return {
    name,
    sku,
    barcode,
    category,
    menuKind,
    pricingMode,
    price,
    budgetPrice: budgetPrice != null && !Number.isNaN(budgetPrice) ? budgetPrice : null,
    stock,
    lowStockAt,
    availableToday,
  }
}

export function buildImportPreview(rawRows, existingProducts, { restaurant = false } = {}) {
  const seen = new Set()
  const creates = []
  const updates = []
  const skipped = []

  rawRows.forEach((raw, index) => {
    const values = normalizeImportRow(raw, { restaurant })
    if (!values.name || !values.sku) {
      skipped.push({ index, reason: 'Missing name or SKU', values })
      return
    }
    if (!restaurant && !values.barcode) {
      skipped.push({ index, reason: 'Missing name, SKU, or barcode', values })
      return
    }
    if (Number.isNaN(values.price) || values.price < 0) {
      skipped.push({ index, reason: 'Invalid price', values })
      return
    }
    if (
      restaurant &&
      values.budgetPrice != null &&
      (Number.isNaN(values.budgetPrice) || values.budgetPrice < 0)
    ) {
      skipped.push({ index, reason: 'Invalid budget price', values })
      return
    }
    if (!restaurant && Number.isNaN(values.stock)) {
      skipped.push({ index, reason: 'Invalid price or stock', values })
      return
    }

    const key = values.barcode
      ? `${values.sku.toLowerCase()}|${values.barcode}`
      : values.sku.toLowerCase()
    if (seen.has(key)) {
      skipped.push({ index, reason: 'Duplicate row in file', values })
      return
    }
    seen.add(key)

    const existing = existingProducts.find(
      (item) =>
        item.sku.toLowerCase() === values.sku.toLowerCase() ||
        (values.barcode && String(item.barcode) === values.barcode),
    )

    if (existing) {
      const nextStock = restaurant
        ? Number(existing.stock || 0)
        : Number((Number(existing.stock) + values.stock).toFixed(2))
      updates.push({
        index,
        action: restaurant ? 'update' : 'restock',
        values,
        existing,
        quantityAdded: restaurant ? 0 : values.stock,
        currentStock: Number(existing.stock),
        nextStock,
      })
    } else {
      creates.push({
        index,
        action: 'create',
        values,
        quantityAdded: restaurant ? 0 : values.stock,
        currentStock: 0,
        nextStock: restaurant ? 0 : values.stock,
      })
    }
  })

  return {
    creates,
    updates,
    skipped,
    rowCount: rawRows.length,
    createCount: creates.length,
    updateCount: updates.length,
    skippedCount: skipped.length,
    lines: [...creates, ...updates],
  }
}
