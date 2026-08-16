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

/**
 * Build RevenueChart points — shared by supervisor Dashboard and manager branch view.
 * Bucket total is Revenue (Gross − Discounts − Refunds), same convention as the headline
 * Revenue KPI: `item.total` is already net of discount, so refundedAmount is subtracted
 * here too, not just the gross sale total — otherwise the chart and the KPI card disagree
 * over the same period.
 */
export function buildRevenueChartPoints(transactions, period) {
  const net = (item) => Number(item.total || 0) - Number(item.refundedAmount || 0)
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
        buckets.set(endHour, (buckets.get(endHour) || 0) + net(item))
        orderBuckets.set(endHour, (orderBuckets.get(endHour) || 0) + 1)
        return
      }
      if (toDateKey(when) !== todayKey) return
      const hour = when.getHours()
      if (!buckets.has(hour)) return
      buckets.set(hour, buckets.get(hour) + net(item))
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
    buckets.set(key, buckets.get(key) + net(item))
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

/** Same bucket a transaction (or any `{ createdAt }`/`{ date }` shaped row — a sold line,
 *  an audit event) falls into on the chart built by `buildRevenueChartPoints` above — the
 *  two must stay in lockstep or a clicked point's `label` would not match a key in
 *  `buildRevenueChartBreakdowns`'s output, or a caller's own bucketed lookup. Exported so
 *  Dashboard.jsx can bucket Payment methods / Top products / Audit the same way without
 *  duplicating this logic. */
export function resolveRevenueChartBucketLabel(item, period) {
  if (period === 'Today') {
    const now = new Date()
    const when = txnMoment(item)
    if (!when || toDateKey(when) !== toDateKey(now)) {
      // Mirrors buildRevenueChartPoints: a transaction with no resolvable moment (or one
      // that already rolled past midnight) is folded into the current hour rather than
      // dropped, so the two never disagree on a total for the same period.
      return when ? null : `${String(now.getHours()).padStart(2, '0')}:00`
    }
    return `${String(when.getHours()).padStart(2, '0')}:00`
  }
  const key = item.date || (item.createdAt ? toDateKey(new Date(item.createdAt)) : null)
  return key || null
}

/**
 * Per-bucket Sales performance breakdown for the same points `buildRevenueChartPoints`
 * returns — keyed by each point's own `label`, so clicking a chart point can show that
 * bucket's Revenue/Gross/Discounts/Refunds/Voided instead of the branch's today-only
 * figures. `paidTransactions` and `voidedTransactions` are separate lists (mirroring
 * BranchDashboard/Dashboard's own today-only split) since a void drops out of the
 * Paid-only list `buildRevenueChartPoints` is fed.
 */
export function buildRevenueChartBreakdowns(paidTransactions, voidedTransactions, period) {
  const acc = {}
  const bump = (label, patch) => {
    if (!label) return
    const row = (acc[label] ||= {
      netSales: 0,
      grossSales: 0,
      discounts: 0,
      refunds: 0,
      voidedSales: 0,
      orders: 0,
    })
    row.netSales += patch.netSales || 0
    row.grossSales += patch.grossSales || 0
    row.discounts += patch.discounts || 0
    row.refunds += patch.refunds || 0
    row.voidedSales += patch.voidedSales || 0
    row.orders += patch.orders || 0
  }
  paidTransactions.forEach((item) => {
    const label = resolveRevenueChartBucketLabel(item, period)
    const total = Number(item.total || 0)
    const discountAmount = Number(item.discountAmount || 0)
    const refundedAmount = Number(item.refundedAmount || 0)
    bump(label, {
      netSales: total - refundedAmount,
      grossSales: total + discountAmount,
      discounts: discountAmount,
      refunds: refundedAmount,
      orders: 1,
    })
  })
  voidedTransactions.forEach((item) => {
    bump(resolveRevenueChartBucketLabel(item, period), { voidedSales: Number(item.total || 0) })
  })
  return acc
}

export function revenueChartPeriodDays(period) {
  if (period === 'Today') return 1
  if (period === 'Week') return 7
  return 30
}

export function inRevenueChartPeriod(dateKey, cutoff) {
  return startOfDay(new Date(`${dateKey}T00:00:00`)) >= cutoff
}
