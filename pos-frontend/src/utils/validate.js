const DANGEROUS = /[<>]/g

export const sanitizeText = (value) =>
  String(value || '')
    .replace(DANGEROUS, '')
    .replace(/\s+/g, ' ')
    .trim()

export const digitsOnly = (value) => String(value || '').replace(/\D/g, '')

export const decimalOnly = (value) => {
  const cleaned = String(value || '').replace(/[^\d.]/g, '')
  const [whole, ...rest] = cleaned.split('.')
  return rest.length ? `${whole}.${rest.join('').slice(0, 2)}` : whole
}

/** Pads a peso amount to 2 decimals once the field is left (e.g. "200" -> "200.00").
 *  Leaves typing itself untouched — only call this from onBlur, not onChange. */
export const formatMoneyOnBlur = (value) => {
  if (value === '' || value == null) return value
  const n = Number(value)
  return Number.isFinite(n) ? n.toFixed(2) : value
}

export const findProductDuplicate = (products, { name, sku, barcode }, excludeId) => {
  const norm = (value) => sanitizeText(value).toLowerCase()
  const code = String(barcode || '')
  return products.find((product) => {
    if (product.id === excludeId) return false
    if (norm(product.name) === norm(name) || norm(product.sku) === norm(sku)) return true
    if (code && String(product.barcode || '') === code) return true
    return false
  })
}

export const duplicateField = (existing, draft) => {
  if (!existing) return null
  if (sanitizeText(existing.name).toLowerCase() === sanitizeText(draft.name).toLowerCase()) return 'name'
  if (sanitizeText(existing.sku).toLowerCase() === sanitizeText(draft.sku).toLowerCase()) return 'SKU'
  if (draft.barcode && String(existing.barcode || '') === String(draft.barcode)) return 'barcode'
  return 'field'
}

export const isValidPriceOverride = (value) => Number.isFinite(Number(value)) && Number(value) >= 0

/**
 * Field-shape validation shared by the branch product form (Products.jsx) and the network
 * catalog form (ManagerNetworkCatalog.jsx). Does NOT check for duplicates — the two callers
 * check against different lists (branch products vs network catalog) and the caller is
 * responsible for that check itself.
 */
export const validateProductDraft = (
  { name, sku, barcode, price, budgetPrice, stock },
  { isRestaurant = false, requireStock = true } = {},
) => {
  const cleanName = sanitizeText(name)
  const cleanSku = sanitizeText(sku)
  const cleanBarcode = digitsOnly(barcode)
  if (!cleanName || !cleanSku) return 'Name and SKU are required.'
  if (!isRestaurant && !cleanBarcode) return 'Name, SKU, and barcode are required.'
  if (cleanBarcode && !/^\d+$/.test(cleanBarcode)) return 'Barcode must contain numbers only.'
  if (price === '' || Number(price) < 0) return 'Enter a valid price.'
  if (
    isRestaurant &&
    budgetPrice !== '' &&
    budgetPrice != null &&
    (Number.isNaN(Number(budgetPrice)) || Number(budgetPrice) < 0)
  ) {
    return 'Enter a valid budget price (or leave blank).'
  }
  if (requireStock && !isRestaurant && (stock === '' || Number.isNaN(Number(stock)))) {
    return 'Enter a valid stock amount.'
  }
  return null
}

/** Next cart-line quantity for a +/- tap: 0.1kg steps for weighed items, whole units otherwise. shouldRemove is true when the step would take the line to zero or below. */
export const nextCartQuantity = (item, delta) => {
  if (item?.pricingMode === 'kg') {
    const next = Number((Number(item.weight || 0) + Number(delta) * 0.1).toFixed(3))
    return { next, shouldRemove: next <= 0 }
  }
  const next = Number(item?.quantity || 0) + Number(delta)
  return { next, shouldRemove: next <= 0 }
}
