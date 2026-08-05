import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import PaymentMethodPie from '../../components/dashboard/PaymentMethodPie'
import RevenueChart from '../../components/dashboard/RevenueChart'
import SalesMixBar from '../../components/dashboard/SalesMixBar'
import { PageHeader, TableCard } from '../../components/ui'
import { branchSummary, fetchBranches, fetchNetworkDashboard, hasSupabase } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { greetingFor, money } from '../../utils/format'

const PERIODS = [
  { id: 'day', label: 'Day', days: 1 },
  { id: 'week', label: 'Week', days: 7 },
  { id: 'month', label: 'Month', days: 30 },
  { id: 'year', label: 'Year', days: 365 },
]

function ManagerOverview() {
  const user = useAuthStore((state) => state.user)
  const [period, setPeriod] = useState('week')
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [linePoints, setLinePoints] = useState([])
  const [branchBars, setBranchBars] = useState([])
  const [paymentMix, setPaymentMix] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
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
        const charts = await fetchNetworkDashboard(period)
        if (!active) return
        setSummaries(next)
        setLinePoints(charts.linePoints)
        setBranchBars(
          charts.branchBars.length
            ? charts.branchBars
            : rows.map((b) => ({ category: b.name, value: next[b.id]?.revenue || 0 })),
        )
        setPaymentMix(charts.paymentMix || [])
      })
      .catch((err) => {
        if (active) setError(err.message)
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
  const hasRestaurant = branches.some((b) => b.branch_type === 'restaurant')

  return (
    <div>
      <PageHeader eyebrow="ALL BRANCHES" title={greetingFor(user)}>
        <div className="flex flex-wrap gap-1.5 max-[700px]:w-full">
          {PERIODS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`rounded-[5px] border px-3 py-2 text-xs font-bold max-[700px]:flex-1 max-[700px]:px-1.5 max-[700px]:py-1.5 max-[700px]:text-[10px] ${
                period === item.id
                  ? 'border-brand-dark bg-brand-dark text-white'
                  : 'border-brand-border bg-white text-[#606662]'
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
      <div className="mb-4 grid grid-cols-3 gap-3.5 max-[700px]:grid-cols-1">
        {[
          [`Revenue - ${periodLabel}`, money(totals.revenue)],
          [`Orders - ${periodLabel}`, totals.orders],
          [
            hasRestaurant ? 'Menu items on today' : 'Low-stock items',
            hasRestaurant ? totals.menuOn : totals.lowStock,
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[9px] bg-brand-dark p-4 text-white">
            <span className="block text-[11px] text-[#abb1ad]">{label}</span>
            <strong className="mt-2 block text-[26px] text-brand-gold">{value}</strong>
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-[minmax(0,1.4fr)_minmax(200px,0.75fr)_minmax(220px,0.9fr)] items-stretch gap-3.5 max-[1100px]:grid-cols-1">
        <RevenueChart points={linePoints} period={`Network - ${periodLabel}`} />
        <PaymentMethodPie mix={paymentMix} subtitle={`${periodLabel} · PHP`} />
        <SalesMixBar mix={branchBars} title="Revenue by branch" subtitle={`${periodLabel} - PHP`} />
      </div>

      <TableCard>
        <div className="grid grid-cols-[minmax(0,1.6fr)_5.5rem_6.5rem_4.5rem_5rem_4.5rem] items-center gap-3 bg-brand-dark px-5 py-3 text-[9px] font-bold tracking-[1px] text-[#c8ceca] uppercase max-[700px]:grid-cols-[minmax(0,1fr)_4.5rem]">
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
              className="grid grid-cols-[minmax(0,1.6fr)_5.5rem_6.5rem_4.5rem_5rem_4.5rem] items-center gap-3 border-t border-brand-softline px-5 py-3 text-xs max-[700px]:grid-cols-[minmax(0,1fr)_4.5rem]"
            >
              <div className="min-w-0">
                <strong className="block truncate text-brand-ink">{branch.name}</strong>
                <small className="block truncate text-[10px] text-brand-subtle">{branch.address || '—'}</small>
              </div>
              <span className="max-[700px]:hidden text-[11px]">
                {restaurant ? 'Restaurant' : 'Retail'}
              </span>
              <strong className="text-right tabular-nums text-brand-gold max-[700px]:hidden">
                {money(summary.revenue)}
              </strong>
              <span className="text-right tabular-nums max-[700px]:hidden">{summary.orders}</span>
              <span
                className={`text-right tabular-nums max-[700px]:hidden ${
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
