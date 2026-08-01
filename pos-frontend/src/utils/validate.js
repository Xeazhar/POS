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
  return products.find((product) => {
    if (product.id === excludeId) return false
    return (
      norm(product.name) === norm(name) ||
      norm(product.sku) === norm(sku) ||
      String(product.barcode) === String(barcode)
    )
  })
}

export const duplicateField = (existing, draft) => {
  if (!existing) return null
  if (sanitizeText(existing.name).toLowerCase() === sanitizeText(draft.name).toLowerCase()) return 'name'
  if (sanitizeText(existing.sku).toLowerCase() === sanitizeText(draft.sku).toLowerCase()) return 'SKU'
  if (String(existing.barcode) === String(draft.barcode)) return 'barcode'
  return 'field'
}
