import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AuditSummary from '../../components/dashboard/AuditSummary'
import RevenueChart from '../../components/dashboard/RevenueChart'
import SalesMixBar from '../../components/dashboard/SalesMixBar'
import StatTiles from '../../components/dashboard/StatTiles'
import {
  DeltaBadge,
  PageHeader,
  PageSkeleton,
  SecondaryButton,
  TableCard,
  moneyClass,
  tableRowClass,
} from '../../components/ui'
import {
  fetchManagerOverviewMetrics,
  fetchBranches,
  fetchNetworkDashboard,
  fetchPeriodComparison,
  fetchSaleEvents,
  fetchShrinkageValue,
  hasSupabase,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { isOnline, readBranchesCache } from '../../offline'
import { NETWORK_OPERATIONS_TOPIC } from '../../offline/realtime'
import { useLiveData } from '../../hooks/useLiveData'
import { withTimeout } from '../../utils/withTimeout'
import { mapLimit } from '../../utils/mapLimit'
import { businessDate, greetingFor, money } from '../../utils/format'

const PERIODS = [
  { id: 'day', label: 'Day', days: 1 },
  { id: 'week', label: 'Week', days: 7 },
  { id: 'month', label: 'Month', days: 30 },
  { id: 'year', label: 'Year', days: 365 },
]

// LOCAL calendar date, not toISOString() (UTC) — see the same note on branchSummary's
// `start` above.
function dateKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// A selected chart point's `bucketKey` matches fetchNetworkDashboard's own bucketing
// convention exactly (see resolveBucketKey in api.js) — year → "YYYY-MM", day → hour
// "HH", otherwise the plain calendar date — so the Audit card can be cross-filtered to
// the same bucket without a second fetch.
function eventMatchesBucket(event, period, bucketKey) {
  if (!event.created_at) return false
  const when = new Date(event.created_at)
  if (Number.isNaN(when.getTime())) return false
  if (period === 'year') return dateKey(when).slice(0, 7) === bucketKey
  if (period === 'day') {
    return dateKey(when) === dateKey(new Date()) && String(when.getHours()).padStart(2, '0') === bucketKey
  }
  return dateKey(when) === bucketKey
}

/** What each period is being compared against, spelled out under the KPI. */
const COMPARISON_LABEL = {
  day: 'vs. yesterday',
  week: 'vs. previous 7 days',
  month: 'vs. previous 30 days',
  year: 'vs. previous year',
}

/**
 * Payment methods keep their own colours — unlike the ranking panels, these are genuinely
 * different categories rather than one measure ranked, so colour carries meaning here.
 */
const PAYMENT_BAR_CLASS = {
  Cash: 'bg-brand-success',
  Card: 'bg-brand-info',
  'E-wallet': 'bg-brand-gold',
}

/**
 * Display network-wide manager metrics and branch performance for the selected period.
 */
function ManagerOverview() {
  const user = useAuthStore((state) => state.user)
  const [period, setPeriod] = useState('day')
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [linePoints, setLinePoints] = useState([])
  const [pointBreakdowns, setPointBreakdowns] = useState({})
  const [selectedPointIndex, setSelectedPointIndex] = useState(null)
  const [paymentMix, setPaymentMix] = useState([])
  const [topProducts, setTopProducts] = useState([])
  const [topCategories, setTopCategories] = useState([])
  const [comparison, setComparison] = useState(null)
  const [cashImpactTotals, setCashImpactTotals] = useState(null)
  const [auditEvents, setAuditEvents] = useState([])
  const [shrinkageValue, setShrinkageValue] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  // Guards against a live-refresh (broadcast/poll) response landing after the user has
  // already switched period — only apply results that still match the period they're on.
  const periodRef = useRef(period)
  useEffect(() => {
    periodRef.current = period
  }, [period])

  // `silent`: a background live-refresh (broadcast/poll) — keep whatever's on screen
  // (no skeleton flash, don't clear the chart-point drill-down) and just swap the
  // numbers in once the refetch resolves. A real period change resets both.
  const loadMetrics = async ({ silent = false } = {}) => {
    const meta = PERIODS.find((p) => p.id === period) || PERIODS[1]
    if (!silent) {
      setLoading(true)
      setSelectedPointIndex(null)
    }
    await Promise.resolve()
      .then(async () => {
        const active = periodRef.current === meta.id
        if (!hasSupabase) {
          if (!active) return
          setBranches([
            {
              id: 'demo-main-branch',
              name: 'Bayombong Branch #001',
              is_active: true,
              address: 'Bayombong',
              branch_type: 'retail',
            },
          ])
          setSummaries({
            'demo-main-branch': { revenue: 86, orders: 2, lowStock: 2, branchType: 'retail' },
          })
          const span = Math.min(meta.days, 12)
          const demoLine = Array.from({ length: span }, (_, index) => {
            const d = new Date()
            d.setDate(d.getDate() - (span - 1 - index))
            const label = d.toISOString().slice(0, 10)
            return {
              label,
              short: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
              total: [42, 55, 38, 70, 61, 48, 86, 52, 64, 71, 58, 90][index % 12],
            }
          })
          setLinePoints(demoLine)
          setPaymentMix([
            { id: 'cash', label: 'Cash', value: 48 },
            { id: 'card', label: 'Card', value: 22 },
            { id: 'ewallet', label: 'E-wallet', value: 16 },
          ])
          setTopProducts([
            { category: 'Bangus (kg)', value: 34 },
            { category: 'Iced Tea', value: 22 },
          ])
          setTopCategories([
            { category: 'Meat', value: 40 },
            { category: 'Drinks', value: 22 },
            { category: 'Groceries', value: 18 },
          ])
          setComparison({
            current: { revenue: 86, orders: 2 },
            previous: { revenue: 74, orders: 2 },
            hasPrevious: true,
          })
          setCashImpactTotals(null)
          setAuditEvents([])
          setShrinkageValue(18)
          setLoading(false)
          return
        }
        if (!isOnline()) {
          const rows = (await readBranchesCache()) || []
          if (!active) return
          setBranches(rows)
          setSummaries({})
          setLinePoints([])
          setPaymentMix([])
          setTopProducts([])
          setTopCategories([])
          setComparison(null)
          setCashImpactTotals(null)
          setAuditEvents([])
          setShrinkageValue(0)
          setError('Offline — connect to refresh network-wide metrics.')
          setLoading(false)
          return
        }
        // Branches and the metrics wave don't depend on each other (the metrics fallback
        // below is the only thing that needs `rows`, and it awaits the same promise) — run
        // them concurrently instead of one round trip after another.
        const branchesPromise = withTimeout(fetchBranches(), 15000, 'Branches')
        const periodStart = new Date()
        periodStart.setHours(0, 0, 0, 0)
        periodStart.setDate(periodStart.getDate() - (meta.days - 1))
        const [rows, overviewMetrics, charts, periodComparison, events, shrinkage] = await Promise.all([
          branchesPromise,
          fetchManagerOverviewMetrics({ days: meta.days }).catch(async () => {
            // RPC not deployed yet — fall back to per-branch fan-out (pre-overhaul path).
            const { branchSummary, fetchBranchCashImpact } = await import('../../lib/api')
            const rows = await branchesPromise
            const summaryRows = await mapLimit(rows, 4, async (branch) => {
              const summary = await branchSummary(branch.id, { days: meta.days })
              return [branch.id, summary]
            })
            const next = Object.fromEntries(summaryRows)
            const cashRows = await mapLimit(rows, 4, async (branch) => {
              const openHour = Number(branch.day_open_hour ?? 7)
              return fetchBranchCashImpact(branch.id, businessDate(new Date(), openHour), openHour).catch(
                () => null,
              )
            })
            return {
              summaries: next,
              cashImpact: cashRows.reduce(
                (acc, row) => ({
                  cashSales: acc.cashSales + (row?.cashSales || 0),
                  cardSales: acc.cardSales + (row?.cardSales || 0),
                  ewalletSales: acc.ewalletSales + (row?.ewalletSales || 0),
                  cashRefunds: acc.cashRefunds + (row?.cashRefunds || 0),
                  changeFund: acc.changeFund + (row?.changeFund || 0),
                  pickup: acc.pickup + (row?.pickup || 0),
                  paidOut: acc.paidOut + (row?.paidOut || 0),
                  expectedCash: acc.expectedCash + (row?.expectedCash || 0),
                }),
                {
                  cashSales: 0,
                  cardSales: 0,
                  ewalletSales: 0,
                  cashRefunds: 0,
                  changeFund: 0,
                  pickup: 0,
                  paidOut: 0,
                  expectedCash: 0,
                },
              ),
            }
          }),
          fetchNetworkDashboard(period),
          fetchPeriodComparison(period).catch(() => null),
          fetchSaleEvents({ start: dateKey(periodStart), end: dateKey(new Date()) }).catch(() => []),
          fetchShrinkageValue({ start: dateKey(periodStart), end: dateKey(new Date()) }).catch(() => 0),
        ])
        if (!active) return
        setBranches(rows)
        setComparison(periodComparison)
        setSummaries(overviewMetrics.summaries || {})
        setLinePoints(charts.linePoints)
        setPointBreakdowns(charts.pointBreakdowns || {})
        setPaymentMix(charts.paymentMix || [])
        setTopProducts(charts.topProducts || [])
        setTopCategories(charts.topCategories || [])
        setCashImpactTotals(overviewMetrics.cashImpact || null)
        setAuditEvents((events || []).filter((e) => e.event_type === 'void' || e.event_type === 'refund'))
        setShrinkageValue(shrinkage || 0)
        setLoading(false)
      })
      .catch((err) => {
        if (periodRef.current === meta.id) {
          setError(err.message)
          setLoading(false)
        }
      })
  }

  useEffect(() => {
    void loadMetrics({ silent: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadMetrics closes over `period` itself
  }, [period])

  // Broadcast (pos:network:operations, pushed on every branch's sale/void/refund/cash-drawer/
  // day-end change — see broadcast_pos_event) + poll fallback. Silent: swaps numbers in
  // without the loading skeleton or resetting the chart-point drill-down.
  useLiveData({
    enabled: hasSupabase && isOnline(),
    fetch: () => loadMetrics({ silent: true }),
    broadcasts: [{ topic: NETWORK_OPERATIONS_TOPIC, events: ['OPERATIONS_CHANGED'] }],
    pollMs: 15_000,
  })

  const totals = Object.values(summaries).reduce(
    (acc, row) => ({
      revenue: acc.revenue + (row.revenue || 0),
      orders: acc.orders + (row.orders || 0),
      lowStock: acc.lowStock + (row.lowStock || 0),
      menuOn: acc.menuOn + (row.menuOn || 0),
      grossSales: acc.grossSales + (row.grossSales || 0),
      netSales: acc.netSales + (row.netSales || 0),
      discounts: acc.discounts + (row.discounts || 0),
      refunds: acc.refunds + (row.refunds || 0),
      voidedSales: acc.voidedSales + (row.voidedSales || 0),
    }),
    {
      revenue: 0,
      orders: 0,
      lowStock: 0,
      menuOn: 0,
      grossSales: 0,
      netSales: 0,
      discounts: 0,
      refunds: 0,
      voidedSales: 0,
    },
  )

  const periodLabel = PERIODS.find((p) => p.id === period)?.label || 'Week'

  // Clicking a point on Revenue over time cross-filters every card below to that single
  // bucket — everything needed came back bucketed already (pointBreakdowns, keyed by the
  // point's own bucketKey), so this is a pure client-side swap, no second fetch. Reseko
  // loss and Payment & cash impact are deliberately exempt: shrinkage has no per-bucket
  // fetch and cash impact is a "today, network-wide" drawer snapshot, neither means
  // anything re-read as a historical bucket, so both always show their whole-period/today
  // figure.
  const selectedPoint = selectedPointIndex != null ? linePoints[selectedPointIndex] : null
  const selectedBreakdown = selectedPoint ? pointBreakdowns[selectedPoint.bucketKey] : null

  // Lead item (first) is the number that matters most — StatTiles renders it larger.
  // Same shape as Dashboard.jsx's supervisor-view salesPerformanceItems (Gross sales,
  // Discounts, Refunds, Voided sales) — Net sales already leads the KPI row above, so it
  // does not need to repeat here too.
  const salesPerformanceItems = selectedBreakdown
    ? [
        { label: 'Gross sales', value: money(selectedBreakdown.grossSales) },
        { label: 'Discounts', value: money(selectedBreakdown.discounts), tone: 'danger' },
        { label: 'Refunds', value: money(selectedBreakdown.refunds), tone: 'danger' },
        { label: 'Voided sales', value: money(selectedBreakdown.voidedSales), tone: 'danger' },
      ]
    : [
        { label: 'Gross sales', value: money(totals.grossSales) },
        { label: 'Discounts', value: money(totals.discounts), tone: 'danger' },
        { label: 'Refunds', value: money(totals.refunds), tone: 'danger' },
        { label: 'Voided sales', value: money(totals.voidedSales), tone: 'danger' },
      ]
  // Expected cash leads — the one figure that's actually actionable network-wide. Card/
  // E-wallet sales are informational only (never part of Expected cash) — always TODAY,
  // network-wide, distinct from the period-scoped "Payment methods" mix card below, and
  // never cross-filtered by a chart point selection (see comment above selectedPoint).
  const cashImpactItems = cashImpactTotals
    ? [
        { label: 'Expected cash', value: money(cashImpactTotals.expectedCash) },
        { label: 'Cash sales', value: money(cashImpactTotals.cashSales) },
        { label: 'Card sales', value: money(cashImpactTotals.cardSales) },
        { label: 'E-wallet sales', value: money(cashImpactTotals.ewalletSales) },
        { label: 'Change fund in', value: money(cashImpactTotals.changeFund) },
        { label: 'Petty cash out', value: money(cashImpactTotals.paidOut), tone: 'danger', hint: 'Expense' },
        { label: 'Cash pickup', value: money(cashImpactTotals.pickup), hint: 'To safe, not an expense' },
      ]
    : []

  const effectiveTopProducts = selectedBreakdown ? selectedBreakdown.topProducts : topProducts
  const effectiveTopCategories = selectedBreakdown ? selectedBreakdown.topCategories : topCategories
  const effectivePaymentMix = selectedBreakdown ? selectedBreakdown.paymentMix : paymentMix
  const effectiveAuditEvents = selectedPoint
    ? auditEvents.filter((e) => eventMatchesBucket(e, period, selectedPoint.bucketKey))
    : auditEvents
  const filterSubtitleSuffix = selectedPoint ? ` · ${selectedPoint.full || selectedPoint.short}` : ''

  // Payment mix reuses the shared bar list. Zero-value methods are dropped: a shop that
  // takes no cards should not carry a permanent empty "Card" row implying it does.
  const paymentMixBars = (effectivePaymentMix || [])
    .map((row) => ({ category: row.label, value: Number(row.value) || 0 }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)

  const comparisonNote = COMPARISON_LABEL[period] || 'vs. previous period'
  const deltaFor = (key) =>
    comparison ? (
      <DeltaBadge
        current={comparison.current?.[key]}
        previous={comparison.previous?.[key]}
        hasPrevious={comparison.hasPrevious}
      />
    ) : null

  // The displayed figure and its badge MUST come from one source. Previously the number
  // was the sum of per-branch branchSummary calls while the percentage was computed inside
  // fetchPeriodComparison — two different queries with different date maths — so the card
  // could show one total with an arrow describing a different one. When the comparison
  // loaded, it is authoritative for both; otherwise fall back to the per-branch sum and
  // show no badge, rather than pairing a number with a percentage it does not belong to.
  const revenueValue = comparison ? comparison.current.revenue : totals.revenue
  const ordersValue = comparison ? comparison.current.orders : totals.orders

  // A selected point swaps Net sales/Orders to that single bucket's own figures — the delta
  // badge and comparison note stop applying (they describe the whole period against a
  // whole prior period, not one bucket), so both drop while a point is selected.
  const kpiCards = [
    {
      label: selectedPoint ? `Net sales${filterSubtitleSuffix}` : `Net sales - ${periodLabel}`,
      value: money(selectedPoint ? selectedPoint.total : revenueValue),
      delta: selectedPoint ? null : deltaFor('revenue'),
      note: selectedPoint ? null : comparison ? comparisonNote : null,
    },
    {
      label: selectedPoint ? `Orders${filterSubtitleSuffix}` : `Orders - ${periodLabel}`,
      value: selectedPoint ? selectedPoint.orders || 0 : ordersValue,
      delta: selectedPoint ? null : deltaFor('orders'),
      note: selectedPoint ? null : comparison ? comparisonNote : null,
    },
    {
      label: `Reseko loss - ${periodLabel}`,
      value: money(shrinkageValue),
      delta: null,
      note: 'Shrinkage value, network-wide',
    },
  ]

  // Skeleton only when there is genuinely nothing to show. Switching period used to flip
  // `loading` and blank the entire dashboard back to grey boxes even though the previous
  // numbers were still perfectly good — that reads as slow even when the fetch is fast.
  // Now the old figures stay put and a quiet "Updating…" marks them as in-flight.
  const hasAnyData = branches.length > 0
  if (loading && !hasAnyData) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div className="overflow-auto pt-2.5 pb-[18px]">
      <PageHeader eyebrow="ALL BRANCHES" title={greetingFor(user)}>
        <div className="flex flex-wrap items-center gap-1.5 max-[700px]:w-full">
          {loading && (
            <span className="mr-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
              Updating…
            </span>
          )}
          {PERIODS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rounded-[5px] border px-3 py-2 text-xs font-bold max-[700px]:flex-1 max-[700px]:px-1.5 max-[700px]:py-1.5 max-[700px]:text-[10px] ${
                period === item.id
                  ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                  : 'border-brand-border bg-brand-card text-brand-n700'
              }`}
              onClick={() => setPeriod(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </PageHeader>
      {error && (
        <p className="mb-4 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>
      )}
      {/* Clicking a point on Revenue over time cross-filters the KPI row below, Sales
          performance, Top products, Top categories, Payment methods, and Audit to that
          single bucket; Clear returns them to the whole period. */}
      {selectedPoint && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-brand-gold/40 bg-brand-gold/10 px-3.5 py-2 text-xs">
          <span className="text-brand-ink">
            Showing <strong>{selectedPoint.full || selectedPoint.short}</strong> — Net sales, Orders,
            Sales performance, Top products, Top categories, Payment methods and Audit are all
            filtered to this point. Reseko loss and Payment & cash impact always show their
            whole-period/today figure.
          </span>
          <SecondaryButton compact type="button" onClick={() => setSelectedPointIndex(null)}>
            Clear selection
          </SecondaryButton>
        </div>
      )}
      {/* KPI row. `Menu items on today` is restaurant-only and this build is focused on
          retail/meat, so it is not rendered — totals.menuOn and branchSummary's menu
          counting are left intact so re-enabling it is a one-line change, not a rebuild. */}
      <div className="mb-4 grid grid-cols-3 items-stretch gap-3.5 max-[900px]:grid-cols-1">
        {kpiCards.map(({ label, value, delta, note }) => (
          <div key={label} className="flex h-full flex-col rounded-[10px] border border-brand-gold/50 bg-brand-dark p-4">
            <span className="block text-[11px] font-semibold tracking-wide text-brand-ondark-dim uppercase">{label}</span>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <strong className={`block text-[26px] text-brand-gold ${moneyClass}`}>{value}</strong>
              {delta}
            </div>
            {note && <span className="mt-1 block text-[10px] text-brand-ondark-dim">{note}</span>}
          </div>
        ))}
      </div>

      <div className="mb-3.5 grid grid-cols-2 items-stretch gap-3.5 max-[1550px]:grid-cols-1">
        <StatTiles
          title="Payment & cash impact"
          subtitle={`${businessDate(new Date())} · today, network-wide`}
          items={cashImpactItems}
          todayBadge
        />
        <StatTiles
          title="Sales performance"
          subtitle={`${periodLabel}${filterSubtitleSuffix}`}
          items={salesPerformanceItems}
        />
      </div>

      <div className="mb-3.5 grid grid-cols-2 items-stretch gap-3.5 max-[1100px]:grid-cols-1">
        <div className="min-h-0 min-w-0 w-full">
          <RevenueChart
            points={linePoints}
            period={`Network · ${periodLabel}`}
            fill
            selectedIndex={selectedPointIndex}
            onSelectIndex={setSelectedPointIndex}
          />
        </div>
        <AuditSummary
          events={effectiveAuditEvents}
          showBranch
          linkHref="/manager/reports"
          subtitle={`Network-wide · ${periodLabel}${filterSubtitleSuffix}`}
          fill
        />
      </div>

      {/* Top products, Top categories, Payment methods — one row of supporting detail,
          same visual weight, so none reads as more important than another. Cross-filter
          notice for these lives above the KPI row now — see selectedPoint banner there. */}
      <div className="mb-4 grid grid-cols-3 items-start gap-3.5 max-[900px]:grid-cols-1">
        <SalesMixBar
          mix={effectiveTopProducts}
          title="Top products"
          subtitle={`Network-wide · ${periodLabel}${filterSubtitleSuffix} · PHP`}
        />
        <SalesMixBar
          mix={effectiveTopCategories}
          title="Top categories"
          subtitle={`Network-wide · ${periodLabel}${filterSubtitleSuffix} · PHP`}
        />
        <SalesMixBar
          mix={paymentMixBars}
          title="Payment methods"
          subtitle={`${periodLabel}${filterSubtitleSuffix} · PHP`}
          showShare
          barClassFor={(item) => PAYMENT_BAR_CLASS[item.category] || 'bg-brand-gold'}
          emptyMessage="No payments taken in this period yet."
        />
      </div>

      <TableCard>
        <div className="grid grid-cols-[minmax(0,1.6fr)_5.5rem_6.5rem_4.5rem_5rem] items-center gap-3 bg-brand-dark px-5 py-3 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[minmax(0,1fr)]">
          <span>Branches</span>
          <span className="max-[700px]:hidden">Type</span>
          <span className="text-right max-[700px]:hidden">Revenue</span>
          <span className="text-right max-[700px]:hidden">Orders</span>
          <span className="text-right max-[700px]:hidden">Focus</span>
        </div>
        {branches.map((branch) => {
          const summary = summaries[branch.id] || { revenue: 0, orders: 0, lowStock: 0, menuOn: 0 }
          const restaurant = branch.branch_type === 'restaurant'
          return (
            // Whole row navigates — a trailing "Open" action column was one more click than
            // the row itself needed, and the row has no other click target to conflict with.
            <Link
              key={branch.id}
              to={`/manager/branches/${branch.id}`}
              className={`grid grid-cols-[minmax(0,1.6fr)_5.5rem_6.5rem_4.5rem_5rem] items-center gap-3 px-5 py-3 text-xs no-underline max-[700px]:grid-cols-[minmax(0,1fr)] ${tableRowClass}`}
            >
              <div className="min-w-0">
                <strong className="block truncate text-brand-ink">{branch.name}</strong>
                <small className="block truncate text-[10px] text-brand-subtle">{branch.address || '—'}</small>
              </div>
              <span className="max-[700px]:hidden text-[11px]">
                {restaurant ? 'Restaurant' : 'Retail'}
              </span>
              <strong className={`text-right text-brand-ink max-[700px]:hidden ${moneyClass}`}>
                {money(summary.revenue)}
              </strong>
              <span className={`text-right max-[700px]:hidden ${moneyClass}`}>{summary.orders}</span>
              <span
                className={`text-right max-[700px]:hidden ${moneyClass} ${
                  restaurant ? 'text-brand-success' : 'text-brand-danger'
                }`}
              >
                {restaurant ? `${summary.menuOn || 0} on` : summary.lowStock}
              </span>
            </Link>
          )
        })}
      </TableCard>
      <div className="mt-4">
        <Link to="/manager/reports" className="text-xs font-bold text-brand-dark no-underline">
          Open full reports suite <span aria-hidden>{'\u2192'}</span>
        </Link>
      </div>
    </div>
  )
}

export default ManagerOverview
