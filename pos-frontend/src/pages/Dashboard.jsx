import { useEffect, useState } from 'react'
import RevenueChart from '../components/dashboard/RevenueChart'
import SalesMixBar from '../components/dashboard/SalesMixBar'
import { PageHeader, TableCard } from '../components/ui'
import { hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { money, qty, stockTone } from '../utils/format'

function startOfDay(date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function toDateKey(value) {
  return value.toISOString().slice(0, 10)
}

function formatShort(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`)
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function buildChartPoints(transactions, period) {
  const buckets = new Map()
  const today = startOfDay(new Date())
  const span = period === 'Today' ? 1 : period === 'Week' ? 7 : 30
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(today)
    day.setDate(today.getDate() - offset)
    buckets.set(toDateKey(day), 0)
  }
  transactions.forEach((item) => {
    if (!buckets.has(item.date)) return
    buckets.set(item.date, buckets.get(item.date) + item.total)
  })
  let entries = [...buckets.entries()]
  if (period === 'Month') {
    entries = entries.filter(([label], index) => {
      const hasSales = buckets.get(label) > 0
      return hasSales || index === 0 || index === entries.length - 1 || index % 3 === 0
    })
  }
  return entries.map(([label, total]) => ({ label, short: formatShort(label), total }))
}

function inPeriod(dateKey, cutoff) {
  return startOfDay(new Date(`${dateKey}T00:00:00`)) >= cutoff
}

function buildSalesFromMovements(movements, products, cutoff) {
  const byProduct = new Map()
  const byCategory = new Map()

  movements
    .filter((item) => item.type === 'Sale' && inPeriod(item.date, cutoff))
    .forEach((item) => {
      const product = products.find((row) => row.id === item.productId)
      const qtySold = Math.abs(Number(item.quantityChange) || 0)
      const price = Number(product?.price || 0)
      const revenue = qtySold * price
      const category = product?.category || 'Other'
      const name = product?.name || item.product || 'Product'

      const prev = byProduct.get(item.productId) || {
        id: item.productId,
        name,
        category,
        pricingMode: product?.pricingMode || 'pc',
        revenue: 0,
        qty: 0,
      }
      prev.revenue += revenue
      prev.qty += qtySold
      byProduct.set(item.productId, prev)

      byCategory.set(category, (byCategory.get(category) || 0) + revenue)
    })

  const top = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5)
  const mix = [...byCategory.entries()]
    .map(([category, value]) => ({ category, value }))
    .sort((a, b) => b.value - a.value)

  return { top, mix }
}

function Dashboard({ branchId: scopedBranchId, branchName } = {}) {
  const user = useAuthStore((state) => state.user)
  const storeProducts = useProductStore((state) => state.products)
  const storeTransactions = useInventoryStore((state) => state.transactions)
  const storeMovements = useInventoryStore((state) => state.movements)
  const [period, setPeriod] = useState('Today')
  const loadBranch = useProductStore((state) => state.loadBranch)
  const hydrate = useInventoryStore((state) => state.hydrate)

  useEffect(() => {
    if (!hasSupabase) return
    const branchId = scopedBranchId || user?.branchId
    if (!branchId) return
    loadBranch(branchId).then((data) => {
      if (data) hydrate(data)
    }).catch(() => {})
  }, [scopedBranchId, user?.branchId, loadBranch, hydrate])

  const products = storeProducts
  const transactions = storeTransactions
  const movements = storeMovements
  const days = period === 'Today' ? 1 : period === 'Week' ? 7 : 30
  const cutoff = startOfDay(new Date())
  cutoff.setDate(cutoff.getDate() - days + 1)
  const filtered = transactions.filter(
    (item) => item.status === 'Paid' && inPeriod(item.date, cutoff),
  )
  const revenue = filtered.reduce((sum, item) => sum + item.total, 0)
  const shrink = movements
    .filter((item) => item.type === 'Shrinkage' && inPeriod(item.date, cutoff))
    .reduce(
      (sum, item) =>
        sum + Math.abs(item.quantityChange) * (products.find((p) => p.id === item.productId)?.price || 0),
      0,
    )
  const low = products.filter((product) => stockTone(product) === 'low')
  const { top, mix } = buildSalesFromMovements(movements, products, cutoff)

  return (
    <div className="overflow-auto pt-2.5 pb-[18px]">
      <PageHeader
        className="mb-2.5"
        eyebrow="OVERVIEW"
        title={branchName || user?.branchName ? `Good morning` : 'Good morning'}
      >
        <div className="flex flex-col items-end gap-2">
          {(branchName || scopedBranchId) && (
            <span className="text-xs text-brand-subtle">{branchName || 'Branch dashboard'}</span>
          )}
          <div className="flex gap-[5px] rounded-md bg-brand-tab p-1">
            {['Today', 'Week', 'Month'].map((item) => (
              <button
                key={item}
                type="button"
                className={`rounded border-0 px-3 py-2 text-[11px] ${
                  period === item ? 'bg-brand-dark text-white' : 'bg-transparent text-[#737975]'
                }`}
                onClick={() => setPeriod(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>
      <div className="mb-3.5 grid grid-cols-3 gap-3.5 max-[700px]:gap-1.5">
        {[
          [`Revenue · ${period}`, money(revenue), `${filtered.length} paid transactions`],
          [`Orders · ${period}`, filtered.length, 'Completed sales'],
          [`Reseko loss · ${period}`, money(shrink), 'Recorded shrinkage'],
        ].map(([label, value, note]) => (
          <div key={label} className="rounded-[9px] bg-brand-dark p-[14px] text-white max-[700px]:p-2">
            <span className="block text-[11px] text-[#abb1ad] max-[700px]:text-[9px]">{label}</span>
            <strong className="my-3 block text-[28px] text-brand-gold max-[700px]:my-1 max-[700px]:text-[19px]">
              {value}
            </strong>
            <small className="block text-[11px] text-[#abb1ad] max-[700px]:text-[9px]">{note}</small>
          </div>
        ))}
      </div>
      <div className="mb-3.5 grid grid-cols-[minmax(0,1.6fr)_minmax(220px,0.9fr)] items-stretch gap-3.5 max-[900px]:grid-cols-1">
        <RevenueChart points={buildChartPoints(filtered, period)} period={period} />
        <SalesMixBar mix={mix} />
      </div>
      <div className="grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1">
        <TableCard className="max-h-none p-4">
          <div className="flex items-center justify-between pb-3">
            <h2 className="m-0 text-lg capitalize">Low stock alert</h2>
            <span className="text-[11px] text-brand-subtle">{low.length} products</span>
          </div>
          {low.length === 0 ? (
            <div className="border-t border-brand-softline py-2.5 text-xs">
              <strong className="block">All stocked up</strong>
              <small className="mt-1 block text-[10px] text-brand-subtle">No items below reorder level</small>
            </div>
          ) : (
            low.map((product) => (
              <div key={product.id} className="flex items-center justify-between border-t border-brand-softline py-2.5 text-xs">
                <div>
                  <strong className="block">{product.name}</strong>
                  <small className="mt-1 block text-[10px] text-brand-subtle">{product.category}</small>
                </div>
                <strong className="text-brand-danger">
                  {qty(product.stock, product.pricingMode === 'kg' ? 'kg' : 'pc')}
                </strong>
              </div>
            ))
          )}
        </TableCard>
        <TableCard className="max-h-none p-4">
          <div className="flex items-center justify-between pb-3">
            <h2 className="m-0 text-lg capitalize">Top products</h2>
            <span className="text-[11px] text-brand-subtle">By sales · {period}</span>
          </div>
          {top.length === 0 ? (
            <div className="border-t border-brand-softline py-2.5 text-xs text-brand-subtle">
              No sales in this period yet.
            </div>
          ) : (
            top.map((product, index) => (
              <div key={product.id} className="flex items-center justify-between border-t border-brand-softline py-2.5 text-xs">
                <div>
                  <strong className="block">
                    {index + 1}. {product.name}
                  </strong>
                  <small className="mt-1 block text-[10px] text-brand-subtle">
                    {product.category} · {qty(product.qty, product.pricingMode === 'kg' ? 'kg' : 'pc')}
                  </small>
                </div>
                <strong>{money(product.revenue)}</strong>
              </div>
            ))
          )}
        </TableCard>
      </div>
    </div>
  )
}

export default Dashboard
