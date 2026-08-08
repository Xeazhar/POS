import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import RevenueChart from '../../components/dashboard/RevenueChart'
import SalesMixBar from '../../components/dashboard/SalesMixBar'
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
  fetchBranches,
  fetchNetworkDashboard,
  fetchPeriodComparison,
  hasSupabase,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { greetingFor, money } from '../../utils/format'

const PERIODS = [
  { id: 'day', label: 'Day', days: 1 },
  { id: 'week', label: 'Week', days: 7 },
  { id: 'month', label: 'Month', days: 30 },
  { id: 'year', label: 'Year', days: 365 },
]

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
  const [branchBars, setBranchBars] = useState([])
  const [paymentMix, setPaymentMix] = useState([])
  const [topProducts, setTopProducts] = useState([])
  const [topCategories, setTopCategories] = useState([])
  const [comparison, setComparison] = useState(null)
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
          setBranchBars([{ category: 'Bayombong Branch #001', value: 86 }])
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
        const [charts, periodComparison] = await Promise.all([
          fetchNetworkDashboard(period),
          fetchPeriodComparison(period).catch(() => null),
        ])
        if (!active) return
        setComparison(periodComparison)
        setSummaries(next)
        setLinePoints(charts.linePoints)
        setBranchBars(
          charts.branchBars.length
            ? charts.branchBars
            : rows.map((b) => ({ category: b.name, value: next[b.id]?.revenue || 0 })),
        )
        setPaymentMix(charts.paymentMix || [])
        setTopProducts(charts.topProducts || [])
        setTopCategories(charts.topCategories || [])
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
    }),
    { revenue: 0, orders: 0, lowStock: 0, menuOn: 0 },
  )

  const periodLabel = PERIODS.find((p) => p.id === period)?.label || 'Week'

  // One branch means "Revenue by branch" is a single bar restating the KPI above it.
  const showBranchPanel = branches.length > 1

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

  const kpiCards = [
    {
      label: `Revenue - ${periodLabel}`,
      value: money(totals.revenue),
      delta: deltaFor('revenue'),
      note: comparison ? comparisonNote : null,
    },
    {
      label: `Orders - ${periodLabel}`,
      value: totals.orders,
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
      <div className={`mb-4 grid gap-3.5 max-[700px]:grid-cols-1 ${kpiCards.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
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

      {/* Revenue by branch is meaningless with one branch — it is a bar chart of a single
          bar restating the KPI above it. Dropped from the grid entirely rather than
          hidden in place, so the remaining panels widen instead of leaving a gap. */}
      <div
        className={`mb-4 grid items-stretch gap-3.5 max-[1100px]:grid-cols-1 ${
          showBranchPanel
            ? 'grid-cols-[minmax(0,1.4fr)_minmax(200px,0.75fr)_minmax(220px,0.9fr)]'
            : 'grid-cols-[minmax(0,1.6fr)_minmax(240px,0.9fr)]'
        }`}
      >
        <RevenueChart points={linePoints} period={`Network - ${periodLabel}`} />
        <SalesMixBar
          mix={paymentMixBars}
          title="Payment methods"
          subtitle={`${periodLabel} · PHP`}
          showShare
          barClassFor={(item) => PAYMENT_BAR_CLASS[item.category] || 'bg-brand-gold'}
          emptyMessage="No payments taken in this period yet."
        />
        {showBranchPanel && (
          <SalesMixBar mix={branchBars} title="Revenue by branch" subtitle={`${periodLabel} - PHP`} />
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 items-stretch gap-3.5 max-[900px]:grid-cols-1">
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
      </div>

      <TableCard>
        <div className="grid grid-cols-[minmax(0,1.6fr)_5.5rem_6.5rem_4.5rem_5rem_4.5rem] items-center gap-3 bg-brand-dark px-5 py-3 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[minmax(0,1fr)_4.5rem]">
          <span>Branch</span>
          <span className="max-[700px]:hidden">Type</span>
          <span className="text-right max-[700px]:hidden">Revenue</span>
          <span className="text-right max-[700px]:hidden">Orders</span>
          <span className="text-right max-[700px]:hidden">Focus</span>
          <span className="text-right"> </span>
        </div>
        {branches.map((branch) => {
          const summary = summaries[branch.id] || { revenue: 0, orders: 0, lowStock: 0, menuOn: 0 }
          const restaurant = branch.branch_type === 'restaurant'
          return (
            <div
              key={branch.id}
              className={`grid grid-cols-[minmax(0,1.6fr)_5.5rem_6.5rem_4.5rem_5rem_4.5rem] items-center gap-3 px-5 py-3 text-xs max-[700px]:grid-cols-[minmax(0,1fr)_4.5rem] ${tableRowClass}`}
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
              <Link
                to={`/manager/branches/${branch.id}`}
                className="justify-self-end text-right text-[11px] font-bold whitespace-nowrap text-brand-dark no-underline"
              >
                Open <span aria-hidden>{'\u2192'}</span>
              </Link>
            </div>
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
