import { supabase } from '../supabase'
import { isRestaurantBranchType, normalizeBranchType } from '../../utils/features'
import { fetchAllRows, localDayBoundsIso, staffNameById, withCashierName } from './shared.js'
import { CASH_DRAWER_COLS, withCashDrawerTable, mapPettyCashRow, fetchPettyCash } from './cash.js'
import { BOOTSTRAP_DAY_END_COLS } from './catalog.js'
import { fetchShiftAdjustments } from './shifts.js'
import { fetchSaleEvents, fetchAuditEvents } from './audit.js'

export async function branchSummary(branchId, { days = 1 } = {}) {
  // LOCAL midnight, not toISOString(). In UTC+8 `toISOString().slice(0,10)` on a
  // day=1 window resolves to the previous local calendar day for any time before 08:00,
  // so the "Today" figure quietly included part of yesterday.
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (Math.max(1, days) - 1))
  const startIso = start.toISOString()

  const { data: branch } = await supabase
    .from('branches')
    .select('branch_type')
    .eq('id', branchId)
    .maybeSingle()
  const isRestaurant = isRestaurantBranchType(branch?.branch_type)

  // Paged. This feeds the headline Revenue/Orders KPI on the manager Overview, so a
  // truncation here understates the biggest number on the dashboard while the chart
  // directly beneath it — which is paged — shows the full figure.
  const { data: txs, error: txErr } = await fetchAllRows((from, to) =>
    supabase
      .from('transactions')
      .select('total_amount, discount_amount, refunded_amount, status')
      .eq('branch_id', branchId)
      .gte('created_at', startIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (txErr) throw txErr
  const paid = (txs || []).filter((t) => t.status === 'completed')
  const voided = (txs || []).filter((t) => t.status === 'voided')
  // Same reductions terminalReports.js uses for the X/Z reading — Gross/Net/Discounts/
  // Refunds/Voided must read the same everywhere or the dashboard and the printed reading
  // will disagree over the same sales.
  const grossSales = paid.reduce(
    (sum, t) => sum + Number(t.total_amount || 0) + Number(t.discount_amount || 0),
    0,
  )
  const netSales = paid.reduce(
    (sum, t) => sum + Number(t.total_amount || 0) - Number(t.refunded_amount || 0),
    0,
  )
  const discounts = paid.reduce((sum, t) => sum + Number(t.discount_amount || 0), 0)
  const refunds = paid.reduce((sum, t) => sum + Number(t.refunded_amount || 0), 0)
  const voidedSales = voided.reduce((sum, t) => sum + Number(t.total_amount || 0), 0)

  let lowStock = 0
  let menuOn = 0
  let menuOff = 0
  if (isRestaurant) {
    const { data: products } = await fetchAllRows((from, to) =>
      supabase
        .from('products')
        .select('available_today, is_active, id')
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
    )
    ;(products || []).forEach((p) => {
      if (p.available_today !== false) menuOn += 1
      else menuOff += 1
    })
  } else {
    const { data: inv } = await fetchAllRows((from, to) =>
      supabase
        .from('branch_inventory')
        .select('quantity_on_hand, product_id, products(low_stock_threshold)')
        .eq('branch_id', branchId)
        .order('product_id', { ascending: true })
        .range(from, to),
    )
    lowStock = (inv || []).filter(
      (row) => Number(row.quantity_on_hand) <= Number(row.products?.low_stock_threshold ?? 5),
    ).length
  }

  return {
    // Net of refunds — matches BranchDashboard.jsx's own "Revenue today"/"Net sales" figure
    // (same netTotal = total - refunded convention). This used to be raw total_amount, which
    // overstated the manager Overview headline by however much had been refunded back.
    revenue: Number(netSales.toFixed(2)),
    orders: paid.length,
    lowStock,
    menuOn,
    menuOff,
    branchType: isRestaurant ? 'restaurant' : 'retail',
    grossSales: Number(grossSales.toFixed(2)),
    netSales: Number(netSales.toFixed(2)),
    discounts: Number(discounts.toFixed(2)),
    refunds: Number(refunds.toFixed(2)),
    voidedSales: Number(voidedSales.toFixed(2)),
  }
}

/**
 * One round-trip for Manager Overview: per-branch sales KPIs + today's cash impact.
 * Requires migrate_network_manager_overview.sql. Falls back to N× branchSummary + cash
 * impact if the RPC is missing.
 */
export async function fetchManagerOverviewMetrics({ days = 1 } = {}) {
  const { data, error } = await supabase.rpc('manager_overview_metrics', {
    p_days: Math.max(1, days),
  })
  if (error) throw error
  const payload = data || {}
  const branches = payload.branches || {}
  const cashImpact = payload.cashImpact || {
    cashSales: 0,
    cardSales: 0,
    ewalletSales: 0,
    cashRefunds: 0,
    changeFund: 0,
    pickup: 0,
    paidOut: 0,
    expectedCash: 0,
  }
  // Normalize numeric fields (jsonb may arrive as strings)
  const summaries = {}
  for (const [id, row] of Object.entries(branches)) {
    summaries[id] = {
      revenue: Number(row.revenue || 0),
      orders: Number(row.orders || 0),
      lowStock: Number(row.lowStock || 0),
      menuOn: Number(row.menuOn || 0),
      menuOff: Number(row.menuOff || 0),
      branchType: normalizeBranchType(row.branchType),
      grossSales: Number(row.grossSales || 0),
      netSales: Number(row.netSales || 0),
      discounts: Number(row.discounts || 0),
      refunds: Number(row.refunds || 0),
      voidedSales: Number(row.voidedSales || 0),
    }
  }
  return {
    summaries,
    cashImpact: {
      cashSales: Number(cashImpact.cashSales || 0),
      cardSales: Number(cashImpact.cardSales || 0),
      ewalletSales: Number(cashImpact.ewalletSales || 0),
      cashRefunds: Number(cashImpact.cashRefunds || 0),
      changeFund: Number(cashImpact.changeFund || 0),
      pickup: Number(cashImpact.pickup || 0),
      paidOut: Number(cashImpact.paidOut || 0),
      expectedCash: Number(cashImpact.expectedCash || 0),
    },
  }
}

/** period: 'day' | 'week' | 'month' | 'year' */
/**
 * Revenue and order count for the current period AND the one immediately before it,
 * so the dashboard can show "up 12% on last week" rather than a bare number.
 *
 * One query, not two: it reads the whole span from the start of the PREVIOUS window to
 * now and splits it client-side on the boundary. Two round trips would be no more
 * accurate and twice as slow on a page that already fans out per branch.
 *
 * The comparison window always matches the selected period — day vs. yesterday, week vs.
 * the week before, year vs. last year — because comparing a week against a month is not
 * a trend, it is a mistake with an arrow drawn on it.
 *
 * Branch scoping: pass `branchId` to scope to one branch (BranchDashboard's "vs. yesterday"
 * badge); omitted, RLS alone limits a manager to the branches they may see, same as
 * fetchNetworkDashboard.
 *
 * Revenue here is NET of refunds (total_amount - refunded_amount), same convention as
 * BranchDashboard.jsx's own "Revenue today"/"Net sales" and branchSummary's `netSales` — a
 * void/refund-heavy period must not look identical to a clean one just because the gross
 * total_amount was the same.
 */
export async function fetchPeriodComparison(period = 'week', branchId = null) {
  const days = period === 'day' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365
  const currentStart = new Date()
  currentStart.setHours(0, 0, 0, 0)
  currentStart.setDate(currentStart.getDate() - (days - 1))
  const previousStart = new Date(currentStart)
  previousStart.setDate(previousStart.getDate() - days)

  const { data, error } = await fetchAllRows((from, to) => {
    let q = supabase
      .from('transactions')
      .select('total_amount, refunded_amount, created_at')
      .eq('status', 'completed')
      .gte('created_at', previousStart.toISOString())
    if (branchId) q = q.eq('branch_id', branchId)
    return q.order('created_at', { ascending: true }).range(from, to)
  })
  if (error) throw error

  const boundary = currentStart.getTime()
  const current = { revenue: 0, orders: 0 }
  const previous = { revenue: 0, orders: 0 }
  ;(data || []).forEach((row) => {
    const when = new Date(row.created_at).getTime()
    const bucket = when >= boundary ? current : previous
    bucket.revenue += Number(row.total_amount || 0) - Number(row.refunded_amount || 0)
    bucket.orders += 1
  })

  return {
    period,
    days,
    current,
    previous,
    // `true` only when the previous window genuinely had activity. A brand-new shop has
    // no prior period, and 0 → anything is not a percentage — it is a first week. The UI
    // uses this to show "New" instead of a meaningless +∞.
    hasPrevious: previous.orders > 0,
  }
}

export async function fetchNetworkDashboard(periodOrDays = 'week') {
  const period =
    typeof periodOrDays === 'number'
      ? periodOrDays <= 1
        ? 'day'
        : periodOrDays <= 7
          ? 'week'
          : periodOrDays <= 31
            ? 'month'
            : 'year'
      : periodOrDays
  const days = period === 'day' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const startIso = start.toISOString()
  // Paged. Unpaged this stopped at PostgREST's 1000-row cap with no error, which on the
  // Year view means the whole dashboard — revenue, branch split, payment mix — silently
  // under-reports by however much got cut off, while still looking like a real figure.
  const txQuery = (cols) => (from, to) =>
    supabase
      .from('transactions')
      .select(cols)
      .eq('status', 'completed')
      .gte('created_at', startIso)
      .order('created_at', { ascending: true })
      .range(from, to)

  let { data: txs, error: txError } = await fetchAllRows(
    txQuery(
      'total_amount, discount_amount, refunded_amount, status, created_at, branch_id, payment_method, branches(name)',
    ),
  )
  if (txError && /payment_method|schema cache/i.test(String(txError.message || ''))) {
    ;({ data: txs, error: txError } = await fetchAllRows(
      txQuery('total_amount, discount_amount, refunded_amount, status, created_at, branch_id, branches(name)'),
    ))
  }
  if (txError) throw txError
  txs = txs || []

  // Voided sales, same window, bucketed separately — kept out of the main `txQuery` above
  // (which stays `status.eq.completed` so it never risks a voided sale slipping into
  // revenue/orders/payment mix) but still needed per-bucket so a clicked chart point can
  // show Sales performance's Voided figure for that bucket, same as the whole-period one on
  // `branchSummary`.
  const { data: voidedTxs, error: voidedError } = await fetchAllRows((from, to) =>
    supabase
      .from('transactions')
      .select('total_amount, created_at')
      .eq('status', 'voided')
      .gte('created_at', startIso)
      .order('created_at', { ascending: true })
      .range(from, to),
  )
  if (voidedError) throw voidedError

  const localKey = (value) => {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const byBucket = {}
  const byBranch = {}
  const byPay = { cash: 0, card: 0, ewallet: 0 }
  if (period === 'year') {
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      byBucket[key] = 0
    }
  } else if (period === 'day') {
    const now = new Date()
    for (let hour = 0; hour <= now.getHours(); hour += 1) {
      byBucket[String(hour).padStart(2, '0')] = 0
    }
  } else {
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      byBucket[localKey(d)] = 0
    }
  }

  const todayKey = localKey(new Date())
  // Shared by the tx loop and the item-line loop below so a clicked chart point can look
  // up the exact same bucket in both breakdowns — resolveBucketKey is the one place that
  // decides which bucket a timestamp belongs to.
  const resolveBucketKey = (createdAt) => {
    const when = new Date(createdAt)
    const dayKey = localKey(when)
    if (period === 'year') return dayKey.slice(0, 7)
    if (period === 'day') return dayKey === todayKey ? String(when.getHours()).padStart(2, '0') : null
    return dayKey
  }

  // Network-wide top products / top categories (by revenue) for the same window, bucketed
  // by date too so selecting a point on Revenue over time can show that bucket's own
  // breakdown instead of the whole-period one (see pointBreakdowns below).
  const byProductNet = {}
  const byCategoryNet = {}
  const productByBucket = {}
  const categoryByBucket = {}
  try {
    const { data: itemRows, error: itemsErr } = await fetchAllRows((from, to) =>
      supabase
        .from('transaction_items')
        .select(
          'quantity, line_total, product_id, products(name, categories(name)), transactions!inner(created_at, status)',
        )
        .gte('transactions.created_at', startIso)
        .eq('transactions.status', 'completed')
        .order('product_id', { ascending: true })
        .range(from, to),
    )
    if (itemsErr) throw itemsErr
    for (const row of itemRows || []) {
      const revenue = Number(row.line_total || 0)
      const name = row.products?.name || 'Product'
      const category = row.products?.categories?.name || 'Other'
      const key = row.product_id || name
      if (!byProductNet[key]) byProductNet[key] = { id: key, name, category, revenue: 0, qty: 0 }
      byProductNet[key].revenue += revenue
      byProductNet[key].qty += Number(row.quantity || 0)
      byCategoryNet[category] = (byCategoryNet[category] || 0) + revenue

      const bucketKey = resolveBucketKey(row.transactions?.created_at)
      if (bucketKey != null) {
        const bucketProducts = (productByBucket[bucketKey] ||= {})
        const bucketCategories = (categoryByBucket[bucketKey] ||= {})
        if (!bucketProducts[key]) bucketProducts[key] = { id: key, name, revenue: 0, qty: 0 }
        bucketProducts[key].revenue += revenue
        bucketProducts[key].qty += Number(row.quantity || 0)
        bucketCategories[category] = (bucketCategories[category] || 0) + revenue
      }
    }
  } catch {
    // Product/category breakdown is a nice-to-have on this dashboard — a schema
    // hiccup here shouldn't take down the revenue/branch/payment charts above.
  }

  // Order COUNT per bucket, alongside revenue. The line chart's tooltip needs it: ₱8,400
  // means something quite different from 4 orders than from 90, and revenue alone cannot
  // distinguish "a quiet day" from "a few big baskets".
  const ordersByBucket = {}
  Object.keys(byBucket).forEach((key) => {
    ordersByBucket[key] = 0
  })
  const payByBucket = {}
  const branchByBucket = {}
  // Same reductions branchSummary()/terminalReports.js use for Gross/Discounts/Refunds, so
  // a clicked chart point's Sales performance card reads the same as the whole-period one.
  const grossByBucket = {}
  const discountsByBucket = {}
  const refundsByBucket = {}
  txs.forEach((row) => {
    const bucketKey = resolveBucketKey(row.created_at)
    const amount = Number(row.total_amount) || 0
    const discountAmount = Number(row.discount_amount) || 0
    const refundedAmount = Number(row.refunded_amount) || 0
    // Revenue over time must read the same as the headline Revenue KPI (Gross − Discounts
    // − Refunds): total_amount is already net of discount, so subtract refunded_amount here
    // too, not just the gross sale total.
    const netAmount = amount - refundedAmount
    const name = row.branches?.name || 'Branch'
    const method = String(row.payment_method || 'cash').toLowerCase()
    if (bucketKey != null && byBucket[bucketKey] != null) {
      byBucket[bucketKey] += netAmount
      ordersByBucket[bucketKey] += 1
      grossByBucket[bucketKey] = (grossByBucket[bucketKey] || 0) + amount + discountAmount
      discountsByBucket[bucketKey] = (discountsByBucket[bucketKey] || 0) + discountAmount
      refundsByBucket[bucketKey] = (refundsByBucket[bucketKey] || 0) + refundedAmount
      const bucketPay = (payByBucket[bucketKey] ||= { cash: 0, card: 0, ewallet: 0 })
      const bucketBranch = (branchByBucket[bucketKey] ||= {})
      if (method === 'card') bucketPay.card += amount
      else if (method === 'ewallet' || method === 'e-wallet' || method === 'gcash' || method === 'maya') {
        bucketPay.ewallet += amount
      } else bucketPay.cash += amount
      bucketBranch[name] = (bucketBranch[name] || 0) + amount
    }
    byBranch[name] = (byBranch[name] || 0) + amount
    if (method === 'card') byPay.card += amount
    else if (method === 'ewallet' || method === 'e-wallet' || method === 'gcash' || method === 'maya') {
      byPay.ewallet += amount
    } else byPay.cash += amount
  })

  const voidedByBucket = {}
  ;(voidedTxs || []).forEach((row) => {
    const bucketKey = resolveBucketKey(row.created_at)
    if (bucketKey == null || byBucket[bucketKey] == null) return
    voidedByBucket[bucketKey] = (voidedByBucket[bucketKey] || 0) + (Number(row.total_amount) || 0)
  })

  // Per-bucket breakdown so the manager Overview chart can cross-filter Top products/
  // categories/Payment methods/branch split/Sales performance to whichever point is
  // selected, without a second round-trip — everything needed is already bucketed above.
  const pointBreakdowns = {}
  Object.keys(byBucket).forEach((bucketKey) => {
    const bp = payByBucket[bucketKey] || { cash: 0, card: 0, ewallet: 0 }
    const bProd = productByBucket[bucketKey] || {}
    const bCat = categoryByBucket[bucketKey] || {}
    pointBreakdowns[bucketKey] = {
      orders: ordersByBucket[bucketKey] || 0,
      netSales: Number((byBucket[bucketKey] || 0).toFixed(2)),
      grossSales: Number((grossByBucket[bucketKey] || 0).toFixed(2)),
      discounts: Number((discountsByBucket[bucketKey] || 0).toFixed(2)),
      refunds: Number((refundsByBucket[bucketKey] || 0).toFixed(2)),
      voidedSales: Number((voidedByBucket[bucketKey] || 0).toFixed(2)),
      branchBars: Object.entries(branchByBucket[bucketKey] || {}).map(([category, value]) => ({
        category,
        value,
      })),
      paymentMix: [
        { id: 'cash', label: 'Cash', value: bp.cash },
        { id: 'card', label: 'Card', value: bp.card },
        { id: 'ewallet', label: 'E-wallet', value: bp.ewallet },
      ],
      topProducts: Object.values(bProd)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 5)
        .map((p) => ({ category: p.name, value: Number(p.revenue.toFixed(2)) })),
      topCategories: Object.entries(bCat)
        .map(([category, value]) => ({ category, value: Number(value.toFixed(2)) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 5),
    }
  })

  return {
    period,
    days,
    linePoints: (() => {
      let entries = Object.entries(byBucket).map(([label, total]) => {
        const orders = ordersByBucket[label] || 0
        if (period === 'day') {
          const hour = Number(label)
          const suffix = hour < 12 ? 'AM' : 'PM'
          const display = hour % 12 === 0 ? 12 : hour % 12
          // Same axis thinning as supervisor Dashboard Today chart — label every 3rd hour
          // (plus the current hour) so a busy day doesn't smear labels together.
          const endHour = new Date().getHours()
          const showShort = hour === endHour || hour % 3 === 0
          return {
            label: `${label}:00`,
            bucketKey: label,
            short: showShort ? `${display} ${suffix}` : '',
            total,
            orders,
            full: `${display}:00 ${suffix}`,
          }
        }
        const asDate =
          period === 'year'
            ? new Date(`${label}-01T00:00:00`)
            : new Date(`${label}T00:00:00`)
        return {
          label,
          bucketKey: label,
          short:
            period === 'year'
              ? asDate.toLocaleDateString([], { month: 'short', year: '2-digit' })
              : asDate.toLocaleDateString([], { month: 'short', day: 'numeric' }),
          full:
            period === 'year'
              ? asDate.toLocaleDateString([], { month: 'long', year: 'numeric' })
              : asDate.toLocaleDateString([], {
                  weekday: 'short',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                }),
          total,
          orders,
        }
      })
      // Month view: keep days with sales + bookends + every 3rd day — mirrors
      // Dashboard.jsx buildChartPoints so the network chart auto-thins like the branch one.
      if (period === 'month' && entries.length > 14) {
        entries = entries.filter((row, index) => {
          const hasSales = Number(row.total) > 0
          return hasSales || index === 0 || index === entries.length - 1 || index % 3 === 0
        })
      }
      return entries
    })(),
    // Keyed by each linePoint's `bucketKey` — selecting a point swaps these four cards to
    // that bucket's own breakdown; the headline KPIs above the chart stay whole-period.
    pointBreakdowns,
    branchBars: Object.entries(byBranch).map(([category, value]) => ({ category, value })),
    paymentMix: [
      { id: 'cash', label: 'Cash', value: byPay.cash },
      { id: 'card', label: 'Card', value: byPay.card },
      { id: 'ewallet', label: 'E-wallet', value: byPay.ewallet },
    ],
    topProducts: Object.values(byProductNet)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
      .map((p) => ({ category: p.name, value: Number(p.revenue.toFixed(2)) })),
    topCategories: Object.entries(byCategoryNet)
      .map(([category, value]) => ({ category, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5),
  }
}

/**
 * Raw (unaggregated) sold line items in a date range — the source for a branch's Top
 * Products/Categories (Dashboard.jsx) and DayEnd's sales report (dayEndReport.js).
 * Deliberately NOT `stock_movements`: that log survives a debug transaction reset (by
 * design — see debug_reset_all_transactions.sql) and would keep counting deleted test
 * sales as "today's sales" forever. Deliberately NOT priced from the product's current
 * price either — `line_total` is what was actually charged, immune to a later price edit.
 * Mirrors fetchNetworkDashboard's `itemsRes` query above, minus the branch_id column
 * (callers already have their own branch's `products` list loaded to resolve
 * name/category/pricingMode, same as the code that used to read stock_movements did).
 * Callers bucket these rows themselves — by calendar day (Dashboard) or business day via
 * rowBusinessDate (DayEnd) — same fetch-a-buffered-window-then-narrow-client-side split
 * fetchBranchCashImpact already uses.
 */
export async function fetchSoldLineItems({ branchId, startIso, endIso, includeVoided = false }) {
  const build = (from, to) => {
    let q = supabase
      .from('transaction_items')
      .select('quantity, line_total, product_id, transactions!inner(created_at, status, branch_id)')
      .gte('transactions.created_at', startIso)
      .lt('transactions.created_at', endIso)
      .range(from, to)
    if (!includeVoided) q = q.eq('transactions.status', 'completed')
    if (branchId) q = q.eq('transactions.branch_id', branchId)
    return q
  }
  // Paged — see fetchNetworkDashboard's 1000-row PostgREST cap comment above.
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return (data || []).map((row) => ({
    productId: row.product_id,
    quantity: Number(row.quantity || 0),
    revenue: Number(row.line_total || 0),
    createdAt: row.transactions?.created_at || null,
  }))
}

/**
 * Sale lines in range, the source for every line-level report.
 *
 * Paged via fetchAllRows because PostgREST caps a response at db-max-rows (1000) and
 * returns the truncated page with NO error. Unpaged, a report over any busy month would
 * quietly stop partway and still print a total — the worst possible failure for a document
 * someone files. Always page anything that can exceed 1000 rows.
 */
export async function fetchReportSalesDetail({ start, end, branchId, includeVoided = false }) {
  // BOTH column sets have to vary in the fallback. An earlier version held the product
  // columns constant, so the retry re-sent the identical `unit_cost` selection that had
  // just failed — meaning the fallback for a missing unit_cost could never actually
  // recover, and every line-level report hard-failed on schemas where it used to work.
  const PRODUCT_FULL = 'products(id, product_no, name, sku, unit_cost, category_id, categories(name))'
  const PRODUCT_MIN = 'products(id, product_no, name, sku, category_id, categories(name))'
  const TXN_FULL =
    'id, invoice_number, created_at, status, void_reason, voided_at, branch_id, staff_id, amount_tendered, total_amount, order_type, ulam_combo, payment_method, payment_reference'
  const TXN_MIN =
    'id, invoice_number, created_at, status, void_reason, voided_at, branch_id, staff_id, amount_tendered, total_amount, order_type, ulam_combo'

  const { startIso: detailStartIso, endIso: detailEndIso } = localDayBoundsIso(start, end)
  const build = (productCols, txnCols) => (from, to) => {
    let q = supabase
      .from('transaction_items')
      .select(`*, ${productCols}, transactions!inner(${txnCols})`)
      .gte('transactions.created_at', detailStartIso)
      .lte('transactions.created_at', detailEndIso)
      .order('id', { ascending: true })
      .range(from, to)
    if (!includeVoided) q = q.eq('transactions.status', 'completed')
    if (branchId) q = q.eq('transactions.branch_id', branchId)
    return q
  }

  let { data, error } = await fetchAllRows(build(PRODUCT_FULL, TXN_FULL))
  if (error && /payment_method|payment_reference|unit_cost|schema cache|column/i.test(String(error.message || ''))) {
    // Older schemas without payment and/or cost columns — drop both optional sets.
    ;({ data, error } = await fetchAllRows(build(PRODUCT_MIN, TXN_MIN)))
  }
  if (error) throw error
  const rows = data || []
  const staffNames = await staffNameById(rows.map((row) => row.transactions?.staff_id))
  return rows.map((row) => ({
    ...row,
    transactions: withCashierName(row.transactions, staffNames),
  }))
}

export async function fetchDailyReading({ date, branchId }) {
  const VAT_COLS =
    'id, invoice_number, status, total_amount, void_reason, created_at, staff_id, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, discount_amount'
  // Paged: a busy branch can clear 1000 sales in a day, and PostgREST would truncate to
  // exactly that with no error — producing a day's total that is short by an unknown
  // amount and looks entirely plausible.
  const { startIso: readingStartIso, endIso: readingEndIso } = localDayBoundsIso(date, date)
  const build = (cols) => (from, to) => {
    let q = supabase
      .from('transactions')
      .select(cols)
      .gte('created_at', readingStartIso)
      .lte('created_at', readingEndIso)
      .order('created_at', { ascending: true })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    return q
  }
  let { data, error } = await fetchAllRows(build(VAT_COLS))
  if (error && /vat_|sc_pwd_discount|discount_amount|schema cache|column/i.test(String(error.message || ''))) {
    // Pre-migrate_vat_breakdown database: still produce the operational figures rather
    // than failing the whole report. The VAT columns simply read as zero.
    ;({ data, error } = await fetchAllRows(
      build('id, invoice_number, status, total_amount, void_reason, created_at, staff_id'),
    ))
  }
  if (error) throw error
  const rows = data || []
  const staffNames = await staffNameById(rows.map((r) => r.staff_id))
  const completed = rows.filter((r) => r.status === 'completed')
  const voided = rows.filter((r) => r.status === 'voided')
  const sum = (list, key) => list.reduce((acc, r) => acc + Number(r[key] || 0), 0)
  const salesTotal = sum(completed, 'total_amount')
  const voidTotal = sum(voided, 'total_amount')
  const invoiceNumbers = rows.map((r) => r.invoice_number).filter(Boolean)
  return {
    date,
    branchId: branchId || null,
    transactionCount: completed.length,
    voidCount: voided.length,
    salesTotal,
    voidTotal,
    netSales: salesTotal,
    // BIR breakdown — all four must be reported separately, never merged.
    vatableSales: sum(completed, 'vatable_sales'),
    vatAmount: sum(completed, 'vat_amount'),
    vatExemptSales: sum(completed, 'vat_exempt_sales'),
    zeroRatedSales: sum(completed, 'zero_rated_sales'),
    scPwdDiscount: sum(completed, 'sc_pwd_discount'),
    discountTotal: sum(completed, 'discount_amount'),
    // "Gross sales" for BIR is the pre-discount figure: what was rung up before any
    // deduction. total_amount is already net of discounts, so add them back.
    grossSales: salesTotal + sum(completed, 'discount_amount'),
    invoiceFrom: invoiceNumbers[0] || null,
    invoiceTo: invoiceNumbers[invoiceNumbers.length - 1] || null,
    rows: rows.map((r) => ({
      invoice_number: r.invoice_number,
      status: r.status,
      total: Number(r.total_amount),
      cashier: staffNames[r.staff_id] || null,
      time: r.created_at,
      void_reason: r.void_reason,
    })),
  }
}

/**
 * Transactions in range with the fiscal columns, paged past PostgREST's 1000-row cap.
 * Shared source for the SC/PWD, Discount, Tender and Electronic Journal reports so they
 * can never disagree with each other about what a day contained.
 */
async function fetchFiscalTransactions({ start, end, branchId, includeVoided = true }) {
  const FULL =
    'id, invoice_number, status, total_amount, amount_tendered, change_given, created_at, staff_id, branch_id, payment_method, payment_reference, discount_amount, discount_type, discount_id_note, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, vat_rate_applied, void_reason, refunded_amount'
  const { startIso: dayStart, endIso: dayEnd } = localDayBoundsIso(start, end)
  const build = (cols) => (from, to) => {
    let q = supabase
      .from('transactions')
      .select(cols)
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd)
      // created_at is NOT unique — several sales can share a timestamp, and a bulk write
      // inside one transaction gives them an identical now(). Ordering on it alone leaves
      // ties in arbitrary order, so a row straddling a 1000-row page boundary can appear
      // twice or vanish. `id` breaks the tie deterministically. An Electronic Journal that
      // duplicates or drops an invoice number is worthless as evidence.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    if (!includeVoided) q = q.eq('status', 'completed')
    return q
  }
  let { data, error } = await fetchAllRows(build(FULL))
  if (error && /vat_|sc_pwd|discount_|payment_|refunded_amount|schema cache|column/i.test(String(error.message || ''))) {
    // The reduced set KEEPS payment_method. Dropping it made fetchTenderSummary bucket
    // every sale as cash — so a manager reconciling the drawer would be handed a "cash"
    // figure that silently included every card and e-wallet sale, with nothing on screen
    // saying the data was degraded. A wrong number presented confidently is worse than a
    // failed query. Only the genuinely newer VAT/discount columns are dropped here.
    ;({ data, error } = await fetchAllRows(
      build(
        'id, invoice_number, status, total_amount, amount_tendered, created_at, staff_id, branch_id, void_reason, payment_method',
      ),
    ))
  }
  if (error && /payment_method/i.test(String(error.message || ''))) {
    // Only if payment_method itself is what is missing does the tender split become
    // impossible. Flagged on every row so the report can say so rather than imply cash.
    const bare = await fetchAllRows(
      build('id, invoice_number, status, total_amount, amount_tendered, created_at, staff_id, branch_id, void_reason'),
    )
    if (bare.error) throw bare.error
    data = (bare.data || []).map((r) => ({ ...r, payment_method: null, paymentMethodUnavailable: true }))
    error = null
  }
  if (error) throw error
  const rows = data || []
  const staffNames = await staffNameById(rows.map((r) => r.staff_id))
  return rows.map((r) => ({ ...r, cashier: staffNames[r.staff_id] || null }))
}

/**
 * Per-day BIR breakdown across a whole range, from ONE ranged query bucketed client-side.
 *
 * Replaces a per-day loop. Sequentially that was 365 round trips for a year; run through
 * Promise.all instead it became 365 *concurrent* paged fetches, which the browser queues
 * six at a time against Supabase and which rate-limiting will start refusing — and since
 * one rejection fails the whole batch, a manager got an error instead of a report. The
 * "All records" preset makes that range unbounded, so neither shape was survivable.
 *
 * Every figure still comes from the columns frozen at time of sale; only the fetch shape
 * changed.
 */
export async function fetchBirDailyBreakdown({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: true })

  const byDay = new Map()
  const dayOf = (iso) => String(iso || '').slice(0, 10)
  // Seed every calendar day in range so days with no trading still appear as a zero row —
  // a gap in a filed summary looks like a missing record rather than a closed day.
  const cursor = new Date(`${start}T12:00:00`)
  const last = new Date(`${end}T12:00:00`)
  while (cursor <= last) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
      cursor.getDate(),
    ).padStart(2, '0')}`
    byDay.set(key, {
      date: key,
      invoiceNumbers: [],
      transactionCount: 0,
      voidCount: 0,
      salesTotal: 0,
      voidTotal: 0,
      discountTotal: 0,
      vatableSales: 0,
      vatAmount: 0,
      vatExemptSales: 0,
      zeroRatedSales: 0,
      scPwdDiscount: 0,
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  rows.forEach((r) => {
    const day = byDay.get(dayOf(r.created_at))
    if (!day) return
    if (r.invoice_number) day.invoiceNumbers.push(r.invoice_number)
    if (r.status === 'voided') {
      day.voidCount += 1
      day.voidTotal += Number(r.total_amount || 0)
      return
    }
    day.transactionCount += 1
    day.salesTotal += Number(r.total_amount || 0)
    day.discountTotal += Number(r.discount_amount || 0)
    day.vatableSales += Number(r.vatable_sales || 0)
    day.vatAmount += Number(r.vat_amount || 0)
    day.vatExemptSales += Number(r.vat_exempt_sales || 0)
    day.zeroRatedSales += Number(r.zero_rated_sales || 0)
    day.scPwdDiscount += Number(r.sc_pwd_discount || 0)
  })

  return [...byDay.values()].map((day) => ({
    ...day,
    netSales: day.salesTotal,
    // BIR "gross sales" is the pre-discount figure; total_amount is already net of them.
    grossSales: day.salesTotal + day.discountTotal,
    invoiceFrom: day.invoiceNumbers[0] || null,
    invoiceTo: day.invoiceNumbers[day.invoiceNumbers.length - 1] || null,
  }))
}

/**
 * Senior Citizen / PWD discount register (RA 9994 / RA 10754).
 *
 * This is a statutory record, not a convenience: the 20% discount is claimable by the
 * business as a deduction from gross income, and BIR will only allow it against a register
 * showing, per sale, the customer's ID number, the VAT-exempt amount, and the discount
 * given. A total alone is not substantiation.
 *
 * Rows with no ID number recorded are still listed — deliberately. Hiding them would make
 * the register look clean while the exposure (a discount that cannot be substantiated on
 * audit) stays exactly the same. Seeing them is the point.
 */
export async function fetchScPwdReport({ start, end, branchId }) {
  // Completed sales only. A voided sale never happened, so listing it in the register
  // invites someone summing the discount column to claim a deduction for a sale that was
  // cancelled — and it would also be counted in the "no ID number recorded" warning,
  // making the register look worse than it is. Voids belong in the Electronic Journal and
  // the Void / Refund Log, both of which show them.
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: false })
  const register = rows
    .filter((r) => {
      const type = String(r.discount_type || '').toLowerCase()
      return Number(r.sc_pwd_discount || 0) > 0 || type.includes('pwd') || type.includes('senior')
    })
    .map((r) => ({
      date: String(r.created_at || '').slice(0, 10),
      invoice_number: r.invoice_number || r.id,
      discount_type: r.discount_type || '—',
      id_number: r.discount_id_note || '(NOT RECORDED)',
      gross_amount: Number(r.total_amount || 0) + Number(r.discount_amount || 0),
      vat_exempt_sales: Number(r.vat_exempt_sales || 0),
      sc_pwd_discount: Number(r.sc_pwd_discount || 0),
      net_amount: Number(r.total_amount || 0),
      cashier: r.cashier || '—',
    }))

  // The claimed total belongs on the document. Without it the deduction is worked out by
  // hand off a printout, which is exactly where a filing error gets introduced.
  if (register.length > 1) {
    const sum = (key) => Number(register.reduce((n, r) => n + Number(r[key] || 0), 0).toFixed(2))
    register.push({
      date: 'TOTAL',
      invoice_number: '',
      discount_type: `${register.length} sale(s)`,
      id_number: '',
      gross_amount: sum('gross_amount'),
      vat_exempt_sales: sum('vat_exempt_sales'),
      sc_pwd_discount: sum('sc_pwd_discount'),
      net_amount: sum('net_amount'),
      cashier: '',
    })
  }
  return register
}

/**
 * Every discount granted in range, of any kind — SC/PWD, promo, manual override.
 * Separate from the SC/PWD register because the audiences differ: this one answers
 * "where is margin leaking", the register answers "prove this deduction".
 */
export async function fetchDiscountReport({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: false })
  return rows
    .filter((r) => Number(r.discount_amount || 0) > 0 || Number(r.sc_pwd_discount || 0) > 0)
    .map((r) => {
      const scPwd = Number(r.sc_pwd_discount || 0)
      const total = Number(r.discount_amount || 0)
      const gross = Number(r.total_amount || 0) + total
      return {
        date: String(r.created_at || '').slice(0, 10),
        invoice_number: r.invoice_number || r.id,
        discount_type: r.discount_type || 'Unlabelled',
        gross_amount: gross,
        // Promo and SC/PWD are reported apart: only the SC/PWD half is a statutory
        // deduction, the promo half is an ordinary price reduction.
        promo_discount: Number(Math.max(0, total - scPwd).toFixed(2)),
        sc_pwd_discount: scPwd,
        total_discount: total,
        discount_pct: gross > 0 ? Number(((total / gross) * 100).toFixed(2)) : 0,
        net_amount: Number(r.total_amount || 0),
        cashier: r.cashier || '—',
      }
    })
}

/**
 * Tender / payment-method summary — the figure a day's cash count is reconciled against.
 * Voided sales are excluded; refunds are shown so the drawer maths still balances.
 */
export async function fetchTenderSummary({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: false })
  const byMethod = {}
  rows.forEach((r) => {
    // "unrecorded", not "cash", when the column is missing entirely — see
    // fetchFiscalTransactions. Defaulting to cash would produce a reconciliation figure
    // that looks authoritative and is wrong by the value of every card sale.
    const method = r.paymentMethodUnavailable
      ? 'unrecorded (database needs updating)'
      : String(r.payment_method || 'cash').toLowerCase()
    if (!byMethod[method]) {
      byMethod[method] = { payment_method: method, transactions: 0, gross_sales: 0, refunds: 0, net_sales: 0 }
    }
    const bucket = byMethod[method]
    bucket.transactions += 1
    bucket.gross_sales += Number(r.total_amount || 0)
    bucket.refunds += Number(r.refunded_amount || 0)
    bucket.net_sales += Number(r.total_amount || 0) - Number(r.refunded_amount || 0)
  })
  return Object.values(byMethod)
    .map((row) => ({
      ...row,
      gross_sales: Number(row.gross_sales.toFixed(2)),
      refunds: Number(row.refunds.toFixed(2)),
      net_sales: Number(row.net_sales.toFixed(2)),
    }))
    .sort((a, b) => b.net_sales - a.net_sales)
}

/**
 * Electronic Journal — the chronological, unabridged record of every transaction the
 * terminal issued, including voids. BIR requires a CRM/POS to keep an EJ and to be able
 * to produce it on demand; the summarised reports do not satisfy that on their own
 * because they cannot show a specific sale as it was rung.
 *
 * Voided sales are included and labelled rather than dropped — an EJ with the voids
 * removed is precisely the shape a tampered journal takes, so it would be worthless as
 * evidence that nothing was removed.
 */
export async function fetchElectronicJournal({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: true })
  return rows.map((r) => ({
    datetime: r.created_at,
    invoice_number: r.invoice_number || r.id,
    status: r.status === 'voided' ? 'VOIDED' : 'COMPLETED',
    cashier: r.cashier || '—',
    payment_method: r.payment_method || 'cash',
    payment_reference: r.payment_reference || '',
    gross_amount: Number(r.total_amount || 0) + Number(r.discount_amount || 0),
    discount_amount: Number(r.discount_amount || 0),
    discount_type: r.discount_type || '',
    vatable_sales: Number(r.vatable_sales || 0),
    vat_amount: Number(r.vat_amount || 0),
    vat_exempt_sales: Number(r.vat_exempt_sales || 0),
    zero_rated_sales: Number(r.zero_rated_sales || 0),
    sc_pwd_discount: Number(r.sc_pwd_discount || 0),
    total_amount: Number(r.total_amount || 0),
    amount_tendered: Number(r.amount_tendered || 0),
    change_given: Number(r.change_given || 0),
    void_reason: r.void_reason || '',
  }))
}

/**
 * Gross margin by product — revenue less cost of goods sold.
 *
 * Cost is read from the product's CURRENT unit_cost, not a cost frozen at sale time,
 * because the schema has no per-line cost column. That makes this report reliable for
 * "which lines earn" and unreliable for restating a closed period after a supplier price
 * change. Stated here so nobody files it as audited COGS; it is a management report.
 */
export async function fetchGrossMarginReport({ start, end, branchId }) {
  const detail = await fetchReportSalesDetail({ start, end, branchId, includeVoided: false })
  const byProduct = {}
  detail.forEach((row) => {
    const product = row.products || {}
    const key = product.id || row.product_id
    if (!byProduct[key]) {
      byProduct[key] = {
        product: product.name || 'Unknown',
        sku: product.sku || '',
        category: product.categories?.name || '—',
        qty_sold: 0,
        revenue: 0,
        cost: 0,
      }
    }
    const qty = Number(row.quantity || 0)
    byProduct[key].qty_sold += qty
    byProduct[key].revenue += Number(row.line_total || 0)
    byProduct[key].cost += Number(product.unit_cost || 0) * qty
  })
  return Object.values(byProduct)
    .map((row) => {
      const revenue = Number(row.revenue.toFixed(2))
      const cost = Number(row.cost.toFixed(2))
      const margin = Number((revenue - cost).toFixed(2))
      return {
        ...row,
        qty_sold: Number(row.qty_sold.toFixed(2)),
        revenue,
        cost,
        margin,
        margin_pct: revenue > 0 ? Number(((margin / revenue) * 100).toFixed(1)) : 0,
      }
    })
    .sort((a, b) => b.margin - a.margin)
}

/**
 * Stock movement ledger — every in/out with the running balance it produced.
 * The inventory counterpart to the sales audit trail: it is what turns "the count is
 * wrong" into "the count went wrong here, by this person, on this date".
 */
export async function fetchStockMovementReport({ start, end, branchId, movementTypes = null }) {
  const { startIso: reportStartIso, endIso: reportEndIso } = localDayBoundsIso(start, end)
  const build = (from, to) => {
    let q = supabase
      .from('stock_movements')
      .select('*, products(name, sku, categories(name)), staff(full_name), branches(name)')
      .gte('created_at', reportStartIso)
      .lte('created_at', reportEndIso)
      // `id` tiebreaker: a bulk import writes every row with the same now(), so ordering
      // on created_at alone leaves ties unordered and a row on a page boundary can be
      // duplicated or dropped. A ledger that loses a movement is not a ledger.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    // Filter server-side when the caller only wants certain kinds. Pulling every movement
    // across an all-records range and discarding 99% of it client-side is tens of
    // thousands of rows over the wire for a handful of results.
    if (movementTypes?.length) q = q.in('movement_type', movementTypes)
    return q
  }
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return (data || []).map((row) => ({
    when: row.created_at,
    branch: row.branches?.name || '—',
    product: row.products?.name || '—',
    sku: row.products?.sku || '',
    category: row.products?.categories?.name || '—',
    movement: row.movement_type,
    qty_in: Number(row.quantity_in || 0),
    qty_out: Number(row.quantity_out || 0),
    balance_after: Number(row.quantity_on_hand_after || 0),
    old_price: row.old_price != null ? Number(row.old_price) : '',
    new_price: row.new_price != null ? Number(row.new_price) : '',
    detail: row.detail || '',
    staff: row.staff?.full_name || '—',
  }))
}

/**
 * Peso value of shrinkage (waste) movements in a date range — quantity_out on each
 * `shrinkage` movement times the product's CURRENT selling price. `unit_cost` would be the
 * textbook basis, but it's an optional field most branches never fill in (a product with no
 * cost recorded would silently value its own waste at ₱0), so `price` — always populated,
 * since a product can't be sold without one — is used instead (same caveat as
 * fetchGrossMarginReport re: no per-line price column, so a price change restates older
 * rows). Omit `branchId` for network-wide (manager RLS: is_manager()).
 */
export async function fetchShrinkageValue({ start, end, branchId } = {}) {
  const { startIso: shrinkStartIso, endIso: shrinkEndIso } = localDayBoundsIso(start, end)
  const build = (from, to) => {
    let q = supabase
      .from('stock_movements')
      .select('quantity_out, products(price)')
      .eq('movement_type', 'shrinkage')
      .gte('created_at', shrinkStartIso)
      .lte('created_at', shrinkEndIso)
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    return q
  }
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return (data || []).reduce(
    (sum, row) => sum + Number(row.quantity_out || 0) * Number(row.products?.price || 0),
    0,
  )
}

/**
 * Line-level shrinkage/waste report — every `shrinkage` stock movement in range with the
 * peso value lost, priced at the product's CURRENT selling price (same basis as
 * fetchShrinkageValue, and the same caveat: unit_cost is optional and unset on every
 * product today, price is guaranteed since a product can't be sold without one — a price
 * change restates older rows). Line-level counterpart to fetchShrinkageValue's
 * network-wide total, sharing the same query shape so the two can never disagree about
 * what a period's loss adds up to.
 */
export async function fetchShrinkageReport({ start, end, branchId } = {}) {
  const { startIso: shrinkStartIso, endIso: shrinkEndIso } = localDayBoundsIso(start, end)
  const build = (from, to) => {
    let q = supabase
      .from('stock_movements')
      .select(
        'created_at, quantity_out, quantity_on_hand_after, products(name, sku, price, categories(name)), staff(full_name), branches(name)',
      )
      .eq('movement_type', 'shrinkage')
      .gte('created_at', shrinkStartIso)
      .lte('created_at', shrinkEndIso)
      .order('created_at', { ascending: false })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    return q
  }
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return (data || []).map((row) => {
    const qty = Number(row.quantity_out || 0)
    const price = Number(row.products?.price || 0)
    return {
      when: row.created_at,
      branch: row.branches?.name || '—',
      product: row.products?.name || '—',
      sku: row.products?.sku || '',
      category: row.products?.categories?.name || '—',
      qty_lost: qty,
      unit_price: price,
      loss_amount: Number((qty * price).toFixed(2)),
      balance_after: Number(row.quantity_on_hand_after || 0),
      staff: row.staff?.full_name || '—',
    }
  })
}

/**
 * Price change register — every price the branch has changed, and who changed it.
 * Kept distinct from the general stock ledger because this is the report that answers a
 * price-tampering question, and it should not require scrolling past thousands of sales.
 */
export async function fetchPriceChangeReport({ start, end, branchId }) {
  // Narrowed in the query, not after the fact. `update` is included because older rows
  // recorded a price edit under that type while still filling old_price/new_price; the
  // client-side check below keeps only the ones that actually carry a price change.
  const movements = await fetchStockMovementReport({
    start,
    end,
    branchId,
    movementTypes: ['price_change', 'update'],
  })
  return movements
    .filter((row) => row.movement === 'price_change' || (row.old_price !== '' && row.new_price !== ''))
    .map((row) => ({
      when: row.when,
      branch: row.branch,
      product: row.product,
      sku: row.sku,
      old_price: row.old_price,
      new_price: row.new_price,
      change:
        row.old_price !== '' && row.new_price !== ''
          ? Number((Number(row.new_price) - Number(row.old_price)).toFixed(2))
          : '',
      changed_by: row.staff,
      detail: row.detail,
    }))
}

/**
 * Cash custody trail across both handoff legs in one report:
 *   - Cashier → supervisor: per drawer shift. `ending_cash` is only ever set once a
 *     supervisor has already run Confirm received handoff at Day End (see
 *     BranchHandoffs.jsx), so every row here is received by construction.
 *   - Supervisor → manager: per closed day, confirmed via confirm_day_end_handoff
 *     (migrate_day_end_cash_handoff.sql) — non-blocking, so a row can sit Pending
 *     indefinitely until a manager physically receives the cash.
 */
export async function fetchCashHandoffReport({ start, end, branchId }) {
  const buildShifts = (from, to) => {
    let q = supabase
      .from('staff_shifts')
      .select('id, branch_id, business_date, clock_out, ending_cash, staff:staff_id(full_name), branches(name)')
      .eq('holds_drawer', true)
      .not('ending_cash', 'is', null)
      .gte('business_date', start)
      .lte('business_date', end)
      .order('business_date', { ascending: false })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    return q
  }
  const { data: shiftRows, error: shiftError } = await fetchAllRows(buildShifts)
  if (shiftError) throw shiftError

  const shiftIds = (shiftRows || []).map((row) => row.id)
  const adjustments = await fetchShiftAdjustments(shiftIds)
  const receivedByShiftId = new Map()
  for (const row of adjustments) {
    if (row.field !== 'ending_cash') continue
    if (!receivedByShiftId.has(row.shiftId)) receivedByShiftId.set(row.shiftId, row)
  }

  const shiftHandoffRows = (shiftRows || []).map((row) => {
    const received = receivedByShiftId.get(row.id)
    return {
      leg: 'Cashier → Supervisor',
      date: row.business_date,
      branch: row.branches?.name || '—',
      amount: Number(row.ending_cash || 0),
      handed_by: row.staff?.full_name || '—',
      handed_at: row.clock_out ? new Date(row.clock_out).toLocaleString() : '',
      received_by: received?.adjustedByName || '—',
      received_at: received?.createdAt ? new Date(received.createdAt).toLocaleString() : '',
      status: 'Received',
    }
  })

  const buildDayEnds = (from, to) => {
    let q = supabase
      .from('day_ends')
      .select(
        'id, branch_id, business_date, status, cash_on_hand, staff!staff_id(full_name), branches(name), handoff_confirmed_at, confirmer:staff!handoff_confirmed_by(full_name)',
      )
      .eq('status', 'closed')
      .gte('business_date', start)
      .lte('business_date', end)
      .order('business_date', { ascending: false })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    return q
  }
  const { data: dayRows, error: dayError } = await fetchAllRows(buildDayEnds)
  if (dayError) throw dayError

  const dayHandoffRows = (dayRows || []).map((row) => ({
    leg: 'Supervisor → Manager',
    date: row.business_date,
    branch: row.branches?.name || '—',
    amount: Number(row.cash_on_hand || 0),
    handed_by: row.staff?.full_name || '—',
    handed_at: row.business_date,
    received_by: row.confirmer?.full_name || '—',
    received_at: row.handoff_confirmed_at ? new Date(row.handoff_confirmed_at).toLocaleString() : '',
    status: row.handoff_confirmed_at ? 'Received' : 'Pending',
  }))

  return [...shiftHandoffRows, ...dayHandoffRows].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

/**
 * Source bundle for Terminal / Cashier / Department / PLU reports (one fetch).
 */
export async function fetchTerminalReportSource({ date, endDate, branchId, staffId = null }) {
  if (!supabase) throw new Error('Supabase not connected')
  const start = date
  const end = endDate || date
  const { startIso: reportStartIso, endIso: reportEndIso } = localDayBoundsIso(start, end)

  let branch = null
  if (branchId) {
    const { data, error } = await supabase
      .from('branches')
      .select(
        'id, name, address, business_name, tin, serial_number, invoice_prefix, terminal_id, receipt_footer_official, receipt_footer_thanks, receipt_footer_contact, receipt_footer_tagline, contact_phone, vat_rate, branch_type',
      )
      .eq('id', branchId)
      .maybeSingle()
    if (error) {
      // Older schemas may lack receipt footer / fiscal columns
      const fallback = await supabase.from('branches').select('*').eq('id', branchId).maybeSingle()
      if (fallback.error) throw error
      branch = fallback.data
    } else {
      branch = data
    }
  }

  // A busy branch/date range can exceed PostgREST's 1000-row page cap, which returns a
  // truncated set with NO error — same silent-truncation bug fetchAllRows already exists
  // to close for products (see its doc comment above). A report is exactly the kind of
  // query that must never silently drop rows.
  const buildTxnQuery = (from, to) => {
    let q = supabase
      .from('transactions')
      .select(
        'id, invoice_number, status, total_amount, refunded_amount, amount_tendered, created_at, staff_id, branch_id, payment_method, payment_reference, discount_amount, discount_type, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, order_type, void_reason',
      )
      .gte('created_at', reportStartIso)
      .lte('created_at', reportEndIso)
      .order('created_at', { ascending: true })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    if (staffId) q = q.eq('staff_id', staffId)
    return q
  }

  let { data: transactions, error: txnError } = await fetchAllRows(buildTxnQuery)
  if (
    txnError &&
    /refunded_amount|payment_method|discount_amount|vat_amount|vat_exempt_sales|schema cache|column/i.test(
      String(txnError.message || ''),
    )
  ) {
    const buildFallbackTxnQuery = (from, to) => {
      let q = supabase
        .from('transactions')
        .select('id, invoice_number, status, total_amount, created_at, staff_id, branch_id, void_reason')
        .gte('created_at', reportStartIso)
        .lte('created_at', reportEndIso)
        .order('created_at', { ascending: true })
        .range(from, to)
      if (branchId) q = q.eq('branch_id', branchId)
      if (staffId) q = q.eq('staff_id', staffId)
      return q
    }
    ;({ data: transactions, error: txnError } = await fetchAllRows(buildFallbackTxnQuery))
  }
  if (txnError) throw txnError

  const staffNames = await staffNameById((transactions || []).map((r) => r.staff_id))
  const txns = (transactions || []).map((row) => withCashierName(row, staffNames))

  let lineItems = []
  try {
    lineItems = await fetchReportSalesDetail({
      start,
      end,
      branchId: branchId || null,
      includeVoided: false,
    })
    if (staffId) {
      lineItems = lineItems.filter((row) => row.transactions?.staff_id === staffId)
    }
  } catch {
    lineItems = []
  }

  let pettyCash = []
  if (branchId) {
    try {
      const { data: pettyRows, error: pettyErr } = await withCashDrawerTable((table) =>
        supabase
          .from(table)
          .select(CASH_DRAWER_COLS)
          .eq('branch_id', branchId)
          .gte('business_date', start)
          .lte('business_date', end)
          .order('created_at', { ascending: false }),
      )
      if (pettyErr) {
        pettyCash = await fetchPettyCash(branchId, start).catch(() => [])
      } else {
        pettyCash = (pettyRows || []).map(mapPettyCashRow)
      }
    } catch {
      pettyCash = []
    }
  }

  let dayEnd = null
  if (branchId) {
    const { data } = await supabase
      .from('day_ends')
      .select(BOOTSTRAP_DAY_END_COLS)
      .eq('branch_id', branchId)
      .eq('business_date', start)
      .maybeSingle()
    dayEnd = data
  }

  // Lifetime completed sales before report start (OLD GRAND TOTAL). A server-side SUM —
  // the old client-side version pulled every completed transaction in the branch's entire
  // history to add two columns, which only gets slower/heavier as the branch ages. Falls
  // back to that row-pulling query only if the RPC isn't deployed yet
  // (migrate_terminal_report_old_grand_total_rpc.sql).
  let oldGrandTotal = 0
  try {
    const { data, error } = await supabase.rpc('sum_completed_sales_before', {
      p_branch_id: branchId || null,
      p_before: reportStartIso,
    })
    if (error) throw error
    oldGrandTotal = Number(data || 0)
  } catch {
    // Falls back on ANY rpc failure, not just a missing function — this figure has always
    // degraded gracefully rather than failing the whole report, and that's worth keeping.
    let grandQuery = supabase
      .from('transactions')
      .select('total_amount, refunded_amount')
      .eq('status', 'completed')
      .lt('created_at', reportStartIso)
    if (branchId) grandQuery = grandQuery.eq('branch_id', branchId)
    const { data: prior, error: priorErr } = await grandQuery
    if (!priorErr && prior) {
      oldGrandTotal = prior.reduce(
        (s, r) => s + Number(r.total_amount || 0) - Number(r.refunded_amount || 0),
        0,
      )
    } else if (priorErr) {
      let q2 = supabase
        .from('transactions')
        .select('total_amount')
        .eq('status', 'completed')
        .lt('created_at', reportStartIso)
      if (branchId) q2 = q2.eq('branch_id', branchId)
      const { data: prior2 } = await q2
      oldGrandTotal = (prior2 || []).reduce((s, r) => s + Number(r.total_amount || 0), 0)
    }
  }

  const cashiers = Object.entries(staffNames).map(([id, name]) => ({ id, name }))

  return {
    branch,
    transactions: txns,
    lineItems,
    pettyCash,
    dayEnd,
    oldGrandTotal: Number(oldGrandTotal.toFixed(2)),
    cashiers,
    staffNames,
  }
}

/** Fiscal backup pack for a date range (JSON download from UI). */
export async function fetchFiscalBackup({ start, end, branchId }) {
  // A fiscal backup must never silently drop rows past PostgREST's 1000-row page cap —
  // see fetchAllRows's doc comment.
  const { startIso: backupStartIso, endIso: backupEndIso } = localDayBoundsIso(start, end)
  const buildFiscalTxnQuery = (from, to) => {
    let q = supabase
      .from('transactions')
      .select('*, transaction_items(*, products(id, product_no, name, sku))')
      .gte('created_at', backupStartIso)
      .lte('created_at', backupEndIso)
      .order('created_at', { ascending: true })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    return q
  }
  const { data: transactions, error: txnError } = await fetchAllRows(buildFiscalTxnQuery)
  if (txnError) throw txnError

  const staffNames = await staffNameById((transactions || []).map((row) => row.staff_id))
  const txnsWithStaff = (transactions || []).map((row) => withCashierName(row, staffNames))

  let dayQuery = supabase
    .from('day_ends')
    .select(BOOTSTRAP_DAY_END_COLS)
    .gte('business_date', start)
    .lte('business_date', end)
  if (branchId) dayQuery = dayQuery.eq('branch_id', branchId)
  const { data: dayEnds, error: dayError } = await dayQuery
  if (dayError) throw dayError

  const [events, audits] = await Promise.all([
    fetchSaleEvents({ start, end, branchId, limit: 5000 }).catch(() => []),
    fetchAuditEvents({ start, end, branchId, limit: 5000 }).catch(() => []),
  ])

  return {
    exportedAt: new Date().toISOString(),
    range: { start, end, branchId: branchId || null },
    transactions: txnsWithStaff,
    saleEvents: events,
    auditEvents: audits,
    dayEnds: dayEnds || [],
  }
}

/** Sum completed branch sales (net of refunds) for a calendar date range (YYYY-MM-DD). */
export async function fetchBranchSalesTotal({ branchId, from = null, to = null }) {
  if (!branchId) return 0
  const { startIso: totalStartIso, endIso: totalEndIso } = localDayBoundsIso(from, to)
  const build = (fromIdx, toIdx) => {
    let q = supabase
      .from('transactions')
      .select('total_amount, refunded_amount')
      .eq('branch_id', branchId)
      .eq('status', 'completed')
    if (totalStartIso) q = q.gte('created_at', totalStartIso)
    if (totalEndIso) q = q.lte('created_at', totalEndIso)
    return q.order('created_at', { ascending: true }).range(fromIdx, toIdx)
  }
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return Number(
    (data || [])
      .reduce((sum, t) => sum + Number(t.total_amount || 0) - Number(t.refunded_amount || 0), 0)
      .toFixed(2),
  )
}

/** Network-wide sales total across branches (optional branch filter + date range). */
export async function fetchNetworkSalesTotal({ branchIds = null, from = null, to = null } = {}) {
  const { startIso: totalStartIso, endIso: totalEndIso } = localDayBoundsIso(from, to)
  const build = (fromIdx, toIdx) => {
    let q = supabase
      .from('transactions')
      .select('total_amount, refunded_amount, branch_id')
      .eq('status', 'completed')
    if (branchIds?.length) q = q.in('branch_id', branchIds)
    if (totalStartIso) q = q.gte('created_at', totalStartIso)
    if (totalEndIso) q = q.lte('created_at', totalEndIso)
    return q.order('created_at', { ascending: true }).range(fromIdx, toIdx)
  }
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return Number(
    (data || [])
      .reduce((sum, t) => sum + Number(t.total_amount || 0) - Number(t.refunded_amount || 0), 0)
      .toFixed(2),
  )
}
