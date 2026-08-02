import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import RevenueChart from '../components/dashboard/RevenueChart'
import SalesMixBar from '../components/dashboard/SalesMixBar'
import { PageHeader, PrimaryButton, TableCard } from '../components/ui'
import { hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { greetingFor, money, qty, stockTone } from '../utils/format'

function startOfDay(date) {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function toDateKey(value) {
  // Local calendar date — never use toISOString() (UTC) or PH "today" misses sales.
  const d = value instanceof Date ? value : new Date(value)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatShort(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`)
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function formatHourShort(hour) {
  const suffix = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display} ${suffix}`
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

function buildChartPoints(transactions, period) {
  if (period === 'Today') {
    const now = new Date()
    const todayKey = toDateKey(now)
    const endHour = now.getHours()
    const buckets = new Map()
    for (let hour = 0; hour <= endHour; hour += 1) buckets.set(hour, 0)

    transactions.forEach((item) => {
      const when = txnMoment(item)
      if (!when) {
        buckets.set(endHour, (buckets.get(endHour) || 0) + Number(item.total || 0))
        return
      }
      if (toDateKey(when) !== todayKey) return
      const hour = when.getHours()
      if (!buckets.has(hour)) return
      buckets.set(hour, buckets.get(hour) + Number(item.total || 0))
    })

    return [...buckets.entries()].map(([hour, total]) => ({
      label: `${String(hour).padStart(2, '0')}:00`,
      short: hour === endHour || hour % 3 === 0 ? formatHourShort(hour) : '',
      total,
    }))
  }

  const buckets = new Map()
  const today = startOfDay(new Date())
  const span = period === 'Week' ? 7 : 30
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(today)
    day.setDate(today.getDate() - offset)
    buckets.set(toDateKey(day), 0)
  }
  transactions.forEach((item) => {
    const key = item.date || (item.createdAt ? toDateKey(new Date(item.createdAt)) : null)
    if (!key || !buckets.has(key)) return
    buckets.set(key, buckets.get(key) + Number(item.total || 0))
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

/** Restaurant sales come from cart lines, not stock movements. */
function buildSalesFromTransactions(transactions, products, cutoff) {
  const byProduct = new Map()
  const byCategory = new Map()

  transactions
    .filter((item) => item.status === 'Paid' && inPeriod(item.date, cutoff))
    .forEach((txn) => {
      ;(txn.itemsList || []).forEach((line) => {
        const product = products.find((row) => row.id === line.id)
        const qtySold =
          line.pricingMode === 'kg' ? Number(line.weight || 0) : Number(line.quantity || 0)
        const revenue = Number(line.price || 0) * qtySold
        const category = product?.category || line.menuKind || 'Menu'
        const name = product?.name || line.name || 'Item'
        const key = line.id || name

        const prev = byProduct.get(key) || {
          id: key,
          name,
          category,
          pricingMode: line.pricingMode || 'pc',
          revenue: 0,
          qty: 0,
        }
        prev.revenue += revenue
        prev.qty += qtySold
        byProduct.set(key, prev)
        byCategory.set(category, (byCategory.get(category) || 0) + revenue)
      })
    })

  const top = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5)
  const mix = [...byCategory.entries()]
    .map(([category, value]) => ({ category, value }))
    .sort((a, b) => b.value - a.value)

  return { top, mix }
}

function Dashboard({ branchId: scopedBranchId, branchName } = {}) {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
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
    loadBranch(branchId)
      .then((data) => {
        if (data) hydrate(data)
      })
      .catch(() => {})
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
  const menuOn = products.filter((p) => p.availableToday !== false)
  const menuOff = products.filter((p) => p.availableToday === false)

  const { top, mix } = useMemo(
    () =>
      isRestaurant
        ? buildSalesFromTransactions(filtered, products, cutoff)
        : buildSalesFromMovements(movements, products, cutoff),
    [isRestaurant, filtered, products, movements, cutoff],
  )

  const greeting = greetingFor(user)

  return (
    <div className="overflow-auto pt-2.5 pb-[18px]">
      <PageHeader className="mb-2.5" eyebrow="OVERVIEW" title={greeting}>
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

      {isRestaurant && menuOn.length === 0 && products.length > 0 && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-[#e8d4a8] bg-[#fff8ea] px-4 py-3">
          <div>
            <strong className="block text-sm text-[#6a5520]">Set today&apos;s potahe first</strong>
            <p className="m-0 mt-1 text-xs text-[#6a5520]">
              Mark which ulam / dishes you are serving before taking orders.
            </p>
          </div>
          <Link to="/pos?menu=1">
            <PrimaryButton compact type="button">
              Choose today&apos;s menu
            </PrimaryButton>
          </Link>
        </div>
      )}

      <div className="mb-3.5 grid grid-cols-3 gap-3.5 max-[700px]:gap-1.5">
        {(isRestaurant
          ? [
              [`Revenue · ${period}`, money(revenue), `${filtered.length} paid orders`],
              [`Orders · ${period}`, filtered.length, 'Completed sales'],
              ['Serving today', menuOn.length, `${menuOff.length} marked off`],
            ]
          : [
              [`Revenue · ${period}`, money(revenue), `${filtered.length} paid transactions`],
              [`Orders · ${period}`, filtered.length, 'Completed sales'],
              [`Reseko loss · ${period}`, money(shrink), 'Recorded shrinkage'],
            ]
        ).map(([label, value, note]) => (
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
        {isRestaurant ? (
          <TableCard className="max-h-none p-4">
            <div className="flex items-center justify-between gap-2 pb-3">
              <h2 className="m-0 text-lg">Today&apos;s potahe</h2>
              <Link to="/pos?menu=1" className="text-[11px] font-bold text-brand-ink no-underline hover:underline">
                Edit menu
              </Link>
            </div>
            <div className="mb-2 flex gap-2 text-[11px]">
              <span className="rounded bg-[#eef6ea] px-2 py-1 font-bold text-brand-success">
                Serving {menuOn.length}
              </span>
              <span className="rounded bg-[#f3f3f0] px-2 py-1 font-bold text-brand-muted">
                Off {menuOff.length}
              </span>
            </div>
            {products.length === 0 ? (
              <div className="border-t border-brand-softline py-2.5 text-xs text-brand-subtle">
                No menu items yet. Ask a manager to import potahe.
              </div>
            ) : (
              products.slice(0, 8).map((product) => {
                const on = product.availableToday !== false
                return (
                  <div
                    key={product.id}
                    className="flex items-center justify-between border-t border-brand-softline py-2.5 text-xs"
                  >
                    <div>
                      <strong className="block">{product.name}</strong>
                      <small className="mt-1 block text-[10px] text-brand-subtle">
                        {product.category}
                        {product.productCode ? ` · ${product.productCode}` : ''}
                      </small>
                    </div>
                    <strong className={on ? 'text-brand-success' : 'text-brand-muted'}>
                      {on ? 'Serving' : 'Off'}
                    </strong>
                  </div>
                )
              })
            )}
          </TableCard>
        ) : (
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
                <div
                  key={product.id}
                  className="flex items-center justify-between border-t border-brand-softline py-2.5 text-xs"
                >
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
        )}
        <TableCard className="max-h-none p-4">
          <div className="flex items-center justify-between pb-3">
            <h2 className="m-0 text-lg capitalize">{isRestaurant ? 'Top dishes' : 'Top products'}</h2>
            <span className="text-[11px] text-brand-subtle">By sales · {period}</span>
          </div>
          {top.length === 0 ? (
            <div className="border-t border-brand-softline py-2.5 text-xs text-brand-subtle">
              No sales in this period yet.
            </div>
          ) : (
            top.map((product, index) => (
              <div
                key={product.id}
                className="flex items-center justify-between border-t border-brand-softline py-2.5 text-xs"
              >
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
