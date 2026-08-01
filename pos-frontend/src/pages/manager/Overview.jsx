import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import RevenueChart from '../../components/dashboard/RevenueChart'
import SalesMixBar from '../../components/dashboard/SalesMixBar'
import { PageHeader, TableCard } from '../../components/ui'
import { branchSummary, fetchBranches, fetchNetworkDashboard, hasSupabase } from '../../lib/api'
import { money } from '../../utils/format'

function ManagerOverview() {
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [linePoints, setLinePoints] = useState([])
  const [branchBars, setBranchBars] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    Promise.resolve()
      .then(async () => {
        if (!hasSupabase) {
          if (!active) return
          setBranches([{ id: 'demo-main-branch', name: 'Bayombong Branch #001', is_active: true, address: 'Bayombong' }])
          setSummaries({ 'demo-main-branch': { revenue: 86, orders: 2, lowStock: 2 } })
          const demoLine = Array.from({ length: 7 }, (_, index) => {
            const d = new Date()
            d.setDate(d.getDate() - (6 - index))
            const label = d.toISOString().slice(0, 10)
            return {
              label,
              short: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
              total: [42, 55, 38, 70, 61, 48, 86][index],
            }
          })
          setLinePoints(demoLine)
          setBranchBars([{ category: 'Bayombong Branch #001', value: 86 }])
          return
        }
        const rows = await fetchBranches()
        if (!active) return
        setBranches(rows)
        const next = {}
        await Promise.all(rows.map(async (branch) => {
          next[branch.id] = await branchSummary(branch.id)
        }))
        const charts = await fetchNetworkDashboard(7)
        if (!active) return
        setSummaries(next)
        setLinePoints(charts.linePoints)
        setBranchBars(charts.branchBars.length ? charts.branchBars : rows.map((b) => ({ category: b.name, value: next[b.id]?.revenue || 0 })))
      })
      .catch((err) => {
        if (active) setError(err.message)
      })
    return () => {
      active = false
    }
  }, [])

  const totals = Object.values(summaries).reduce(
    (acc, row) => ({
      revenue: acc.revenue + (row.revenue || 0),
      orders: acc.orders + (row.orders || 0),
      lowStock: acc.lowStock + (row.lowStock || 0),
    }),
    { revenue: 0, orders: 0, lowStock: 0 },
  )

  return (
    <div>
      <PageHeader eyebrow="ALL BRANCHES" title="Manager overview" />
      {error && <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>}
      <div className="mb-4 grid grid-cols-3 gap-3.5 max-[700px]:grid-cols-1">
        {[
          ['Revenue today', money(totals.revenue)],
          ['Orders today', totals.orders],
          ['Low-stock items', totals.lowStock],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[9px] bg-brand-dark p-4 text-white">
            <span className="block text-[11px] text-[#abb1ad]">{label}</span>
            <strong className="mt-2 block text-[26px] text-brand-gold">{value}</strong>
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-[minmax(0,1.6fr)_minmax(220px,0.9fr)] items-stretch gap-3.5 max-[900px]:grid-cols-1">
        <RevenueChart points={linePoints} period="Network · 7 days" />
        <SalesMixBar mix={branchBars} title="Revenue by branch" subtitle="Today · PHP" />
      </div>

      <TableCard>
        <div className="grid grid-cols-[1.5fr_1fr_0.8fr_0.8fr_0.8fr_auto] gap-3 bg-[#f7f7f4] px-5 py-3 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[700px]:grid-cols-[1fr_auto]">
          <span>Branch</span>
          <span className="max-[700px]:hidden">Status</span>
          <span className="max-[700px]:hidden">Revenue</span>
          <span className="max-[700px]:hidden">Orders</span>
          <span className="max-[700px]:hidden">Low stock</span>
          <span />
        </div>
        {branches.map((branch) => {
          const summary = summaries[branch.id] || { revenue: 0, orders: 0, lowStock: 0 }
          return (
            <div
              key={branch.id}
              className="grid grid-cols-[1.5fr_1fr_0.8fr_0.8fr_0.8fr_auto] items-center gap-3 border-t border-brand-softline px-5 py-3 text-xs max-[700px]:grid-cols-[1fr_auto]"
            >
              <div>
                <strong className="block text-brand-ink">{branch.name}</strong>
                <small className="text-[10px] text-brand-subtle">{branch.address || '—'}</small>
              </div>
              <span className={`max-[700px]:hidden ${branch.is_active ? 'text-brand-success' : 'text-brand-danger'}`}>
                {branch.is_active ? 'Active' : 'Inactive'}
              </span>
              <strong className="max-[700px]:hidden text-brand-gold">{money(summary.revenue)}</strong>
              <span className="max-[700px]:hidden">{summary.orders}</span>
              <span className="max-[700px]:hidden text-brand-danger">{summary.lowStock}</span>
              <Link
                to={`/manager/branches/${branch.id}`}
                className="justify-self-end text-[11px] font-bold text-brand-dark no-underline"
              >
                Open →
              </Link>
            </div>
          )
        })}
      </TableCard>
      <div className="mt-4">
        <Link to="/manager/reports" className="text-xs font-bold text-brand-dark no-underline">
          Open full reports suite →
        </Link>
      </div>
    </div>
  )
}

export default ManagerOverview
