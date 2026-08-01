export const money = (value) =>
  `₱${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export const qty = (value, unit) => {
  const amount = Number(value || 0).toFixed(2)
  return unit ? `${amount} ${unit}` : amount
}

/** Default till open hour when branch setting is missing. */
export const DEFAULT_OPEN_HOUR = 7
/** @deprecated use DEFAULT_OPEN_HOUR or branch dayOpenHour */
export const OPEN_HOUR = DEFAULT_OPEN_HOUR

export function normalizeOpenHour(openHour) {
  const hour = Number(openHour)
  if (!Number.isFinite(hour)) return DEFAULT_OPEN_HOUR
  return Math.min(23, Math.max(0, Math.trunc(hour)))
}

const toDateKey = (d) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Calendar date (midnight boundary). */
export const calendarToday = () => toDateKey(new Date())

/**
 * Business date rolls at openHour local (PH shops).
 * Before openHour counts as previous day.
 */
export const businessDate = (value = new Date(), openHour = DEFAULT_OPEN_HOUR) => {
  const d = value instanceof Date ? new Date(value) : new Date(value)
  const rollAt = normalizeOpenHour(openHour)
  if (d.getHours() < rollAt) d.setDate(d.getDate() - 1)
  return toDateKey(d)
}

/** Alias used by day-end / till — business date. */
export const today = (openHour) => businessDate(new Date(), openHour ?? DEFAULT_OPEN_HOUR)

export function dayEndForBusinessDate(dayEnds, date) {
  return (dayEnds || []).find((item) => item.date === date) || null
}

/** Till is locked only when current business day has status = closed. */
export function isTillClosed(dayEnds, openHour = DEFAULT_OPEN_HOUR) {
  const date = businessDate(new Date(), openHour)
  const entry = dayEndForBusinessDate(dayEnds, date)
  return entry?.status === 'closed'
}

export const localDateKey = (value) => {
  if (!value) return calendarToday()
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10)
  return toDateKey(d)
}

export const formatDate = (value) => {
  if (!value) return '—'
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

export function formatOpenHourLabel(openHour) {
  const hour = normalizeOpenHour(openHour)
  const suffix = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display}:00 ${suffix}`
}

export function stockTone(product) {
  const stock = Number(product.stock)
  const lowAt = Number(product.lowStockAt ?? 5)
  if (Number.isNaN(stock) || Number.isNaN(lowAt)) return 'good'
  if (stock <= lowAt) return 'low'
  if (stock <= lowAt * 2) return 'fair'
  return 'good'
}
