/** True when value is a Postgres UUID (synced remote transaction id). */
export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ''),
  )
}

/** Build detail payload from a locally stored / queued sale (has itemsList). */
export function detailFromLocalTxn(item, lines = null) {
  const sourceLines = lines || item.itemsList || item.lines || []
  return {
    ...item,
    lines: sourceLines.map((line, index) => {
      if (line.lineTotal != null && (line.unitPrice != null || line.price != null) && line.quantity != null && line.weight == null) {
        return {
          id: line.id || `${item.id}-${index}`,
          name: line.name || 'Item',
          sku: line.sku || '',
          pricingMode: line.pricingMode === 'kg' || line.pricingMode === 'per_kg' ? 'kg' : 'pc',
          quantity: Number(line.quantity ?? 0),
          unitPrice: Number(line.unitPrice ?? line.price ?? 0),
          lineTotal: Number(line.lineTotal ?? 0),
          promoGroupId: line.promoGroupId || null,
          promoGroupName: line.promoGroupName || null,
        }
      }
      const quantity = line.pricingMode === 'kg' ? Number(line.weight || line.quantity || 0) : Number(line.quantity || 0)
      const unitPrice = Number(line.price || line.unitPrice || 0)
      return {
        id: line.id || `${item.id}-${index}`,
        name: line.name || 'Item',
        sku: line.sku || '',
        pricingMode: line.pricingMode === 'kg' ? 'kg' : 'pc',
        quantity,
        unitPrice,
        lineTotal: line.lineTotal != null ? Number(line.lineTotal) : unitPrice * quantity,
        promoGroupId: line.promoGroupId || null,
        promoGroupName: line.promoGroupName || null,
      }
    }),
  }
}
