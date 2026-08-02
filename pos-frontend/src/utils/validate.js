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
