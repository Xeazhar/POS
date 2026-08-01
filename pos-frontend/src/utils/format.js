export const money = (value) =>
  `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const qty = (value, unit) => {
  const amount = Number(value || 0).toFixed(2)
  return unit ? `${amount} ${unit}` : amount
}

export const today = () => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const localDateKey = (value) => {
  if (!value) return today()
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const formatDate = (value) => {
  if (!value) return '—'
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

export function stockTone(product) {
  const stock = Number(product.stock)
  const lowAt = Number(product.lowStockAt ?? 5)
  if (Number.isNaN(stock) || Number.isNaN(lowAt)) return 'good'
  if (stock <= lowAt) return 'low'
  if (stock <= lowAt * 2) return 'fair'
  return 'good'
}
