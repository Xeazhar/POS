import { localDateKey } from './format'

function startOfDay(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function toDateKey(date) {
  return localDateKey(date)
}

function formatHourShort(hour) {
  const suffix = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display} ${suffix}`
}

function formatShort(label) {
  const d = new Date(`${label}T12:00:00`)
  if (Number.isNaN(d.getTime())) return label
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function txnMoment(item) {
  if (item.createdAt) {
    const d = new Date(item.createdAt)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (item.date) {
    const d = new Date(`${String(item.date).slice(0, 10)}T12:00:00`)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

/** Build RevenueChart points — shared by supervisor Dashboard and manager branch view. */
export function buildRevenueChartPoints(transactions, period) {
  if (period === 'Today') {
    const now = new Date()
    const todayKey = toDateKey(now)
    const endHour = now.getHours()
    const buckets = new Map()
    const orderBuckets = new Map()
    for (let hour = 0; hour <= endHour; hour += 1) {
      buckets.set(hour, 0)
      orderBuckets.set(hour, 0)
    }

    transactions.forEach((item) => {
      const when = txnMoment(item)
      if (!when) {
        buckets.set(endHour, (buckets.get(endHour) || 0) + Number(item.total || 0))
        orderBuckets.set(endHour, (orderBuckets.get(endHour) || 0) + 1)
        return
      }
      if (toDateKey(when) !== todayKey) return
      const hour = when.getHours()
      if (!buckets.has(hour)) return
      buckets.set(hour, buckets.get(hour) + Number(item.total || 0))
      orderBuckets.set(hour, (orderBuckets.get(hour) || 0) + 1)
    })

    return [...buckets.entries()].map(([hour, total]) => {
      const suffix = hour < 12 ? 'AM' : 'PM'
      const display = hour % 12 === 0 ? 12 : hour % 12
      const showShort = hour === endHour || hour % 3 === 0
      return {
        label: `${String(hour).padStart(2, '0')}:00`,
        short: showShort ? formatHourShort(hour) : '',
        full: `${display}:00 ${suffix}`,
        total,
        orders: orderBuckets.get(hour) || 0,
      }
    })
  }

  const buckets = new Map()
  const orderBuckets = new Map()
  const today = startOfDay(new Date())
  const span = period === 'Week' ? 7 : 30
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(today)
    day.setDate(today.getDate() - offset)
    const key = toDateKey(day)
    buckets.set(key, 0)
    orderBuckets.set(key, 0)
  }
  transactions.forEach((item) => {
    const key = item.date || (item.createdAt ? toDateKey(new Date(item.createdAt)) : null)
    if (!key || !buckets.has(key)) return
    buckets.set(key, buckets.get(key) + Number(item.total || 0))
    orderBuckets.set(key, (orderBuckets.get(key) || 0) + 1)
  })
  let entries = [...buckets.entries()]
  if (period === 'Month') {
    entries = entries.filter(([label], index) => {
      const hasSales = buckets.get(label) > 0
      return hasSales || index === 0 || index === entries.length - 1 || index % 3 === 0
    })
  }
  return entries.map(([label, total]) => ({
    label,
    short: formatShort(label),
    full: new Date(`${label}T12:00:00`).toLocaleDateString([], {
      weekday: 'short',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }),
    total,
    orders: orderBuckets.get(label) || 0,
  }))
}

export function revenueChartPeriodDays(period) {
  if (period === 'Today') return 1
  if (period === 'Week') return 7
  return 30
}

export function inRevenueChartPeriod(dateKey, cutoff) {
  return startOfDay(new Date(`${dateKey}T00:00:00`)) >= cutoff
}
