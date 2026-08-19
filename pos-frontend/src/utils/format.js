export const PESO = '\u20B1'

/** Use with money displays: className={MONEY_CLASS} (alias of ui moneyClass). */
export const MONEY_CLASS = 'tabular-nums'

/** Unicode minus for negatives: −₱1.00 (not ASCII hyphen / locale minus). */
export const money = (value) => {
  const n = Number(value || 0)
  const abs = Math.abs(n).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return n < 0 ? `\u2212${PESO}${abs}` : `${PESO}${abs}`
}

/** Whole-peso label for quick-cash buttons (no decimals). */
export const pesoWhole = (value) =>
  `${PESO}${Number(value || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 })}`

/** Time-of-day greeting with optional first name: "Good morning, Ana" */
export function greetingFor(user) {
  const hour = new Date().getHours()
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const full = String(user?.name || user?.full_name || '').trim()
  const first = full.split(/\s+/)[0]
  return first ? `${part}, ${first}` : part
}

/** Formats a shift timestamp as a localized abbreviated date and time, or `—` if missing/invalid. */
export function formatShiftWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** AM/PM shift label from clock-in hour ("AM shift" / "PM shift"), or `—` if missing/invalid. */
export function formatShiftPeriod(clockIn) {
  if (!clockIn) return '—'
  const d = new Date(clockIn)
  if (Number.isNaN(d.getTime())) return '—'
  return d.getHours() < 12 ? 'AM shift' : 'PM shift'
}

/** Elapsed time between shift start and end (or now), as "45m" / "2h 05m", or `—` if missing/invalid/reversed. */
export function formatShiftDuration(clockIn, clockOut = null, nowMs = Date.now()) {
  if (!clockIn) return '—'
  const start = new Date(clockIn).getTime()
  const end = clockOut ? new Date(clockOut).getTime() : nowMs
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const mins = Math.round((end - start) / 60000)
  const h = Math.floor(mins / 60)
  return h <= 0 ? `${mins}m` : `${h}h ${String(mins % 60).padStart(2, '0')}m`
}

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

/**
 * The BUSINESS date a transaction / stock movement belongs to.
 *
 * A row's `date` is the CALENDAR date (`localDateKey(created_at)`) — it knows nothing about
 * the branch's open hour, so it must never be compared against a `businessDate()` key
 * directly. A business day runs open-hour to open-hour, so anything rung between midnight
 * and `openHour` carries the NEXT calendar date while still belonging to the CURRENT
 * business day. Comparing the two keys drops those sales from the day's totals and pulls in
 * the previous day's early-hours sales instead — wrong in both directions, on money.
 *
 * Derived from `createdAt` (the actual instant) when present. Without it there is nothing
 * better than the calendar date the row already carries, so that is returned unchanged
 * rather than re-deriving a business date from a bare date string, which would roll a
 * midnight-parsed value back a day for any branch opening after 08:00.
 */
export const rowBusinessDate = (row, openHour = DEFAULT_OPEN_HOUR) =>
  row?.createdAt ? businessDate(row.createdAt, openHour) : row?.date || null

/**
 * Assigns a priority score to a day-end entry for selection.
 * @param {Object} entry - The day-end entry to rank.
 * @returns {number} A priority score, where lower values indicate higher priority.
 */
function dayEndEntryRank(entry) {
  const syncRank = entry.syncStatus === 'pending' || entry.syncStatus === 'local' ? 0 : 10
  const statusRank =
    {
      reopened: 5,
      requested: 4,
      rejected: 3,
      submitted: 2,
      closed: 1,
    }[entry.status] ?? 0
  return syncRank + statusRank
}

/**
 * Selects the highest-priority day-end entry for a business date.
 * @param {Array<Object>} dayEnds - The day-end entries to search.
 * @param {string} date - The business date to match.
 * @return {Object|null} The highest-priority matching entry, or `null` when no entry matches.
 */
export function dayEndForBusinessDate(dayEnds, date) {
  const matches = (dayEnds || []).filter((item) => item.date === date)
  if (!matches.length) return null
  if (matches.length === 1) return matches[0]
  return matches.reduce((best, item) =>
    dayEndEntryRank(item) > dayEndEntryRank(best) ? item : best,
  )
}

/** Till is locked when current business day is submitted (awaiting approval) or closed. */
export function isTillClosed(dayEnds, openHour = DEFAULT_OPEN_HOUR) {
  const date = businessDate(new Date(), openHour)
  return isBusinessDayLocked(dayEnds, date)
}

export function isDaySubmitted(dayEnds, openHour = DEFAULT_OPEN_HOUR) {
  const date = businessDate(new Date(), openHour)
  const entry = dayEndForBusinessDate(dayEnds, date)
  return entry?.status === 'submitted'
}

export function isDayFullyClosed(dayEnds, openHour = DEFAULT_OPEN_HOUR) {
  const date = businessDate(new Date(), openHour)
  const entry = dayEndForBusinessDate(dayEnds, date)
  return entry?.status === 'closed'
}

/** True when voids/refunds should be blocked for a given business date. */
export function isBusinessDayLocked(dayEnds, date, _openHour = DEFAULT_OPEN_HOUR) {
  const entry = dayEndForBusinessDate(dayEnds, date)
  return entry?.status === 'submitted' || entry?.status === 'closed'
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

/** Soft nudge window: last 2h before typical close (open+14h), or after 8pm, or after 10pm on an overnight-close schedule. */
export function shouldNudgeDayEnd(dayOpenHour) {
  const hour = new Date().getHours()
  const open = Number(dayOpenHour ?? 7)
  const closeHour = (open + 14) % 24
  if (hour >= 20) return true
  if (closeHour > open) return hour >= closeHour - 2
  return hour >= 22
}

export function dayEndNudgeMessage(dayOpenHour) {
  const open = Number(dayOpenHour ?? 7)
  const closeHour = (open + 14) % 24
  const closeLabel = formatOpenHourLabel(closeHour)
  const now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `It's ${now}. Typical day-end is around ${closeLabel} (or after 8:00 PM). Close the till when you're ready.`
}

export function stockTone(product) {
  const stock = Number(product.stock)
  const lowAt = Number(product.lowStockAt ?? 5)
  if (Number.isNaN(stock) || Number.isNaN(lowAt)) return 'good'
  if (stock <= lowAt) return 'low'
  if (stock <= lowAt * 2) return 'fair'
  return 'good'
}

/** New stock level after a signed restock/adjustment/shrinkage delta, rounded to 2 decimals. */
export function applyStockDelta(currentStock, signedAmount) {
  return Number((Number(currentStock || 0) + Number(signedAmount || 0)).toFixed(2))
}

/** Sale total minus what's been refunded off it, floored at 0. */
export function netAfterRefund(total, refundedAmount) {
  return Math.max(0, Number((Number(total || 0) - Number(refundedAmount || 0)).toFixed(2)))
}
