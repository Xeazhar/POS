import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AuditSummary from '../../components/dashboard/AuditSummary'
import RevenueChart from '../../components/dashboard/RevenueChart'
import SalesMixBar from '../../components/dashboard/SalesMixBar'
import StatTiles from '../../components/dashboard/StatTiles'
import {
  DeltaBadge,
  PageHeader,
  PageSkeleton,
  TableCard,
  moneyClass,
  tableRowClass,
} from '../../components/ui'
import {
  branchSummary,
  fetchBranchCashImpact,
  fetchBranches,
  fetchNetworkDashboard,
  fetchPeriodComparison,
  fetchSaleEvents,
  hasSupabase,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
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

function ManagerOverview() {
  const user = useAuthStore((state) => state.user)
  const [period, setPeriod] = useState('week')
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [linePoints, setLinePoints] = useState([])
  const [paymentMix, setPaymentMix] = useState([])
  const [topProducts, setTopProducts] = useState([])
  const [topCategories, setTopCategories] = useState([])
  const [comparison, setComparison] = useState(null)
  const [cashImpactTotals, setCashImpactTotals] = useState(null)
  const [auditEvents, setAuditEvents] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    const meta = PERIODS.find((p) => p.id === period) || PERIODS[1]
    Promise.resolve()
      .then(async () => {
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
          setLoading(false)
          return
        }
        const rows = await fetchBranches()
        if (!active) return
        setBranches(rows)
        const next = {}
        await Promise.all(
          rows.map(async (branch) => {
            next[branch.id] = await branchSummary(branch.id, { days: meta.days })
          }),
        )
        // Fetched alongside the charts, not after them — the comparison is one extra
        // query and serialising it would add a round trip to every period switch.
        // It must never take the dashboard down: a missing delta badge is a far smaller
        // problem than a blank page, so a failure here degrades to no badge.
        const periodStart = new Date()
        periodStart.setHours(0, 0, 0, 0)
        periodStart.setDate(periodStart.getDate() - (meta.days - 1))
        const [charts, periodComparison, cashRows, events] = await Promise.all([
          fetchNetworkDashboard(period),
          fetchPeriodComparison(period).catch(() => null),
          // Cash impact is always TODAY per branch (a drawer is counted once a day, not
          // summed over a period), summed across every branch a manager can see.
          Promise.all(
            rows.map((branch) => {
              const openHour = Number(branch.day_open_hour ?? 7)
              return fetchBranchCashImpact(branch.id, businessDate(new Date(), openHour), openHour).catch(
                () => null,
              )
            }),
          ),
          // No branchId — RLS already scopes a manager to branches they can see, same
          // pattern fetchNetworkDashboard/fetchPeriodComparison rely on.
          fetchSaleEvents({ start: dateKey(periodStart), end: dateKey(new Date()) }).catch(() => []),
        ])
        if (!active) return
        setComparison(periodComparison)
        setSummaries(next)
        setLinePoints(charts.linePoints)
        setPaymentMix(charts.paymentMix || [])
        setTopProducts(charts.topProducts || [])
        setTopCategories(charts.topCategories || [])
        setCashImpactTotals(
          cashRows.reduce(
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
        )
        setAuditEvents((events || []).filter((e) => e.event_type === 'void' || e.event_type === 'refund'))
        setLoading(false)
      })
      .catch((err) => {
        if (active) {
          setError(err.message)
          setLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [period])

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

  // Lead item (first) is the number that matters most — StatTiles renders it larger.
  const salesPerformanceItems = [
    { label: 'Net sales', value: money(totals.netSales) },
    { label: 'Gross sales', value: money(totals.grossSales) },
    { label: 'Discounts', value: money(totals.discounts), tone: 'danger' },
    { label: 'Refunds', value: money(totals.refunds), tone: 'danger' },
    { label: 'Voided sales', value: money(totals.voidedSales), tone: 'danger' },
  ]
  // Expected cash leads — the one figure that's actually actionable network-wide. Card/
  // E-wallet sales are informational only (never part of Expected cash) — always TODAY,
  // network-wide, distinct from the period-scoped "Payment methods" mix card below.
  const cashImpactItems = cashImpactTotals
    ? [
        { label: 'Expected cash', value: money(cashImpactTotals.expectedCash) },
        { label: 'Cash sales', value: money(cashImpactTotals.cashSales) },
        { label: 'Card sales', value: money(cashImpactTotals.cardSales) },
        { label: 'E-wallet sales', value: money(cashImpactTotals.ewalletSales) },
        {
          label: 'Cash in / out',
          value: money(cashImpactTotals.changeFund - cashImpactTotals.pickup - cashImpactTotals.paidOut),
          hint: `${money(cashImpactTotals.changeFund)} in · ${money(cashImpactTotals.pickup + cashImpactTotals.paidOut)} out`,
        },
      ]
    : []

  // Payment mix reuses the shared bar list. Zero-value methods are dropped: a shop that
  // takes no cards should not carry a permanent empty "Card" row implying it does.
  const paymentMixBars = (paymentMix || [])
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

  const kpiCards = [
    {
      label: `Revenue - ${periodLabel}`,
      value: money(revenueValue),
      delta: deltaFor('revenue'),
      note: comparison ? comparisonNote : null,
    },
    {
      label: `Orders - ${periodLabel}`,
      value: ordersValue,
      delta: deltaFor('orders'),
      note: comparison ? comparisonNote : null,
    },
    { label: 'Low-stock items', value: totals.lowStock, delta: null, note: null },
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
    <div>
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
                  ? 'border-brand-dark bg-brand-dark text-white'
                  : 'border-brand-border bg-white text-brand-n700'
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
      {/* KPI row. `Menu items on today` is restaurant-only and this build is focused on
          retail/meat, so it is not rendered — totals.menuOn and branchSummary's menu
          counting are left intact so re-enabling it is a one-line change, not a rebuild. */}
      <div className="mb-4 grid grid-cols-3 gap-3.5 max-[700px]:grid-cols-1">
        {kpiCards.map(({ label, value, delta, note }) => (
          <div key={label} className="rounded-[10px] bg-brand-dark p-4 text-white">
            <span className="block text-[11px] text-brand-n500">{label}</span>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <strong className={`block text-[26px] text-brand-gold ${moneyClass}`}>{value}</strong>
              {delta}
            </div>
            {note && <span className="mt-1 block text-[10px] text-brand-n500">{note}</span>}
          </div>
        ))}
      </div>

      {/* Revenue chart leads — it's the primary "how's the network doing" read. Sales
          performance / Cash impact / Audit stack beside it rather than above it, so the
          chart isn't pushed down the page by supporting numbers. Chart height is raised
          to roughly match that 3-card stack instead of the default (a 2-card stack's) height. */}
      <div className="mb-3.5 grid grid-cols-[minmax(0,1.6fr)_minmax(240px,0.9fr)] items-stretch gap-3.5 max-[1100px]:grid-cols-1">
        <RevenueChart points={linePoints} period={`Network - ${periodLabel}`} height={300} />
        <div className="flex flex-col gap-2.5">
          <StatTiles title="Sales performance" subtitle={periodLabel} items={salesPerformanceItems} />
          <StatTiles
            title="Payment & cash impact"
            subtitle={`${businessDate(new Date())} · today, network-wide`}
            items={cashImpactItems}
          />
          <AuditSummary
            events={auditEvents}
            linkHref="/manager/reports"
            subtitle={`Network-wide · ${periodLabel}`}
          />
        </div>
      </div>

      {/* Top products, Top categories, Payment methods — one row of supporting detail,
          same visual weight, so none reads as more important than another. */}
      <div className="mb-4 grid grid-cols-3 items-start gap-3.5 max-[900px]:grid-cols-1">
        <SalesMixBar
          mix={topProducts}
          title="Top products"
          subtitle={`Network-wide · ${periodLabel} · PHP`}
        />
        <SalesMixBar
          mix={topCategories}
          title="Top categories"
          subtitle={`Network-wide · ${periodLabel} · PHP`}
        />
        <SalesMixBar
          mix={paymentMixBars}
          title="Payment methods"
          subtitle={`${periodLabel} · PHP`}
          showShare
          barClassFor={(item) => PAYMENT_BAR_CLASS[item.category] || 'bg-brand-gold'}
          emptyMessage="No payments taken in this period yet."
        />
      </div>

      <TableCard>
        <div className="grid grid-cols-[minmax(0,1.6fr)_5.5rem_6.5rem_4.5rem_5rem] items-center gap-3 bg-brand-dark px-5 py-3 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[minmax(0,1fr)]">
          <span>Branch</span>
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
              <strong className={`text-right text-brand-gold max-[700px]:hidden ${moneyClass}`}>
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
