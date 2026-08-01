export async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export function normalizeImportRow(raw) {
  const name = String(raw.name || '').trim().replace(/[<>]/g, '')
  const sku = String(raw.sku || '').trim().replace(/[<>]/g, '')
  const barcode = String(raw.barcode || '').replace(/\D/g, '')
  const category = String(raw.category || 'Groceries').trim() || 'Groceries'
  const pricingMode =
    raw.pricingMode === 'kg' || raw.pricingMode === 'per_kg' ? 'kg' : 'pc'
  const price = Number(raw.price || 0)
  const stock = Number(raw.stock || 0)
  const lowStockAt = Number(raw.lowStockAt || 5)
  return { name, sku, barcode, category, pricingMode, price, stock, lowStockAt }
}

export function buildImportPreview(rawRows, existingProducts) {
  const seen = new Set()
  const creates = []
  const updates = []
  const skipped = []

  rawRows.forEach((raw, index) => {
    const values = normalizeImportRow(raw)
    if (!values.name || !values.sku || !values.barcode) {
      skipped.push({ index, reason: 'Missing name, SKU, or barcode', values })
      return
    }
    if (Number.isNaN(values.price) || values.price < 0 || Number.isNaN(values.stock)) {
      skipped.push({ index, reason: 'Invalid price or stock', values })
      return
    }

    const key = `${values.sku.toLowerCase()}|${values.barcode}`
    if (seen.has(key)) {
      skipped.push({ index, reason: 'Duplicate row in file', values })
      return
    }
    seen.add(key)

    const existing = existingProducts.find(
      (item) =>
        item.sku.toLowerCase() === values.sku.toLowerCase() || String(item.barcode) === values.barcode,
    )

    if (existing) {
      const nextStock = Number((Number(existing.stock) + values.stock).toFixed(2))
      updates.push({
        index,
        action: 'restock',
        values,
        existing,
        quantityAdded: values.stock,
        currentStock: Number(existing.stock),
        nextStock,
      })
    } else {
      creates.push({
        index,
        action: 'create',
        values,
        quantityAdded: values.stock,
        currentStock: 0,
        nextStock: values.stock,
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
