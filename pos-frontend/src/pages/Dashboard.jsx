import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AuditSummary from '../components/dashboard/AuditSummary'
import RevenueChart from '../components/dashboard/RevenueChart'
import SalesMixBar from '../components/dashboard/SalesMixBar'
import StatTiles from '../components/dashboard/StatTiles'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import { PageHeader, PageSkeleton, PrimaryButton, SectionHeading, TableCard, moneyClass } from '../components/ui'
import { fetchBranchCashImpact, fetchSaleEvents, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { previousDayRestockReport } from '../utils/dayEndReport'
import { businessDate, greetingFor, money, stockTone } from '../utils/format'
import { canAccessModule } from '../utils/roles'

/** Payment mix keeps its own colours — cash / card / e-wallet are genuinely distinct
 * categories, unlike the ranking panels where colour would just be noise. */
const PAYMENT_BAR_CLASS = {
  Cash: 'bg-brand-success',
  Card: 'bg-brand-info',
  'E-wallet': 'bg-brand-gold',
}

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
  const productsLoading = useProductStore((state) => state.loading)
  const storeTransactions = useInventoryStore((state) => state.transactions)
  const storeMovements = useInventoryStore((state) => state.movements)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const [period, setPeriod] = useState('Today')
  const [bootingPage, setBootingPage] = useState(Boolean(hasSupabase))
  const [cashImpact, setCashImpact] = useState(null)
  const [auditEvents, setAuditEvents] = useState([])
  const loadBranch = useProductStore((state) => state.loadBranch)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const branchIdForFetch = scopedBranchId || user?.branchId

  useEffect(() => {
    if (!hasSupabase) {
      setBootingPage(false)
      return
    }
    const branchId = scopedBranchId || user?.branchId
    if (!branchId) {
      setBootingPage(false)
      return
    }
    setBootingPage(true)
    loadBranch(branchId)
      .then((data) => {
        if (data) hydrate(data)
      })
      .catch(() => {})
      .finally(() => setBootingPage(false))
  }, [scopedBranchId, user?.branchId, loadBranch, hydrate])

  // Cash impact is always TODAY's business day, regardless of the Today/Week/Month toggle
  // above — an "expected cash" figure is a once-per-day drawer count (see DayEnd.jsx), not
  // something that means anything summed over a week.
  useEffect(() => {
    if (!hasSupabase || !branchIdForFetch) return undefined
    let active = true
    fetchBranchCashImpact(branchIdForFetch, businessDate(new Date(), dayOpenHour), dayOpenHour)
      .then((row) => {
        if (active) setCashImpact(row)
      })
      .catch(() => {
        if (active) setCashImpact(null)
      })
    return () => {
      active = false
    }
  }, [branchIdForFetch, dayOpenHour])

  const products = storeProducts
  const transactions = storeTransactions
  const movements = storeMovements
  const days = period === 'Today' ? 1 : period === 'Week' ? 7 : 30
  const cutoff = startOfDay(new Date())
  cutoff.setDate(cutoff.getDate() - days + 1)
  const filtered = transactions.filter(
    (item) => item.status === 'Paid' && inPeriod(item.date, cutoff),
  )
  const voidedInPeriod = transactions.filter(
    (item) => item.status === 'Voided' && inPeriod(item.date, cutoff),
  )
  const revenue = filtered.reduce((sum, item) => sum + item.total, 0)

  // Audit follows the same Today/Week/Month toggle as Sales performance.
  useEffect(() => {
    if (!hasSupabase || !branchIdForFetch) return undefined
    let active = true
    fetchSaleEvents({ branchId: branchIdForFetch, start: toDateKey(cutoff), end: toDateKey(new Date()) })
      .then((rows) => {
        if (active) setAuditEvents((rows || []).filter((e) => e.event_type === 'void' || e.event_type === 'refund'))
      })
      .catch(() => {
        if (active) setAuditEvents([])
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchIdForFetch, period])
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

  const paymentMethodLabels = { cash: 'Cash', card: 'Card', ewallet: 'E-wallet' }
  const paymentMethods = useMemo(() => {
    const byMethod = new Map()
    filtered.forEach((item) => {
      const method = String(item.paymentMethod || 'cash').toLowerCase()
      const prev = byMethod.get(method) || { method, amount: 0, count: 0 }
      prev.amount += Number(item.total || 0)
      prev.count += 1
      byMethod.set(method, prev)
    })
    return [...byMethod.values()].sort((a, b) => b.amount - a.amount)
  }, [filtered])

  const greeting = greetingFor(user)
  const todayKey = businessDate(new Date(), dayOpenHour)
  const restockEntry = !isRestaurant ? previousDayRestockReport(dayEnds, todayKey) : null

  // Same reductions terminalReports.js uses for the X/Z reading — reused rather than
  // re-derived so this row and a printed reading for the same range can never disagree.
  // Lead item (first) is the number that matters most — StatTiles renders it larger.
  const salesPerformanceItems = [
    {
      label: 'Net sales',
      value: money(filtered.reduce((sum, t) => sum + Number(t.total || 0) - Number(t.refundedAmount || 0), 0)),
    },
    {
      label: 'Gross sales',
      value: money(filtered.reduce((sum, t) => sum + Number(t.total || 0) + Number(t.discountAmount || 0), 0)),
    },
    {
      label: 'Discounts',
      value: money(filtered.reduce((sum, t) => sum + Number(t.discountAmount || 0), 0)),
      tone: 'danger',
    },
    {
      label: 'Refunds',
      value: money(filtered.reduce((sum, t) => sum + Number(t.refundedAmount || 0), 0)),
      tone: 'danger',
    },
    {
      label: 'Voided sales',
      value: money(voidedInPeriod.reduce((sum, t) => sum + Number(t.total || 0), 0)),
      tone: 'danger',
    },
  ]
  // Expected cash leads — the one figure that's actually actionable ("does the drawer
  // match"); the rest is how it was arrived at.
  const cashImpactItems = cashImpact
    ? [
        { label: 'Expected cash', value: money(cashImpact.expectedCash) },
        { label: 'Cash sales', value: money(cashImpact.cashSales) },
        { label: 'Cash refunds', value: money(cashImpact.cashRefunds), tone: 'danger' },
        {
          label: 'Cash in / out',
          value: money(cashImpact.changeFund - cashImpact.pickup - cashImpact.paidOut),
          hint: `${money(cashImpact.changeFund)} in · ${money(cashImpact.pickup + cashImpact.paidOut)} out`,
        },
      ]
    : []
  const canOpenReports = canAccessModule(user, 'manager_reports')

  if (bootingPage || (productsLoading && !products.length)) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div className="overflow-auto pt-2.5 pb-[18px]">
      <PageHeader className="mb-4" eyebrow="OVERVIEW" title={greeting}>
        <div className="flex flex-col items-end gap-2 max-[700px]:items-stretch">
          {(branchName || scopedBranchId) && (
            <span className="text-xs text-brand-muted">{branchName || 'Branch dashboard'}</span>
          )}
          <div className="flex gap-0.5 rounded-md bg-brand-tab p-0.5 max-[700px]:w-full max-[700px]:justify-stretch">
            {['Today', 'Week', 'Month'].map((item) => (
              <button
                key={item}
                type="button"
                className={`rounded border-0 px-3 py-2 text-[11px] max-[700px]:flex-1 max-[700px]:px-1.5 max-[700px]:py-1.5 max-[700px]:text-[10px] ${
                  period === item ? 'bg-brand-dark text-white' : 'bg-transparent text-brand-slate'
                }`}
                onClick={() => setPeriod(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      <div className="mb-3.5 grid grid-cols-3 gap-3.5 max-[700px]:grid-cols-1 max-[700px]:gap-2">
        {(isRestaurant
          ? [
              [`Revenue · ${period}`, money(revenue), `${filtered.length} paid orders`],
              [`Orders · ${period}`, filtered.length, 'Completed sales'],
              ['Serving today', menuOn.length, `${menuOff.length} marked off`],
            ]
          : [
              [`Revenue · ${period}`, money(revenue), `${filtered.length} paid transactions`],
              [`Orders · ${period}`, filtered.length, 'Completed sales'],
              ['Low-stock items', low.length, 'This branch'],
            ]
        ).map(([label, value, note]) => (
          <div
            key={label}
            className="rounded-[10px] bg-brand-dark p-[14px] text-white max-[700px]:flex max-[700px]:items-center max-[700px]:justify-between max-[700px]:gap-3 max-[700px]:p-3.5"
          >
            <div className="min-w-0">
              <span className="block text-[11px] text-brand-n500 max-[700px]:text-[10px]">{label}</span>
              <small className="mt-1 hidden text-[10px] text-brand-n500 max-[700px]:block">{note}</small>
            </div>
            <strong className={`mt-2 block text-[28px] text-brand-gold max-[700px]:mt-0 max-[700px]:shrink-0 max-[700px]:text-[22px] ${moneyClass}`}>
              {value}
            </strong>
            <small className="block text-[11px] text-brand-n500 max-[700px]:hidden">{note}</small>
          </div>
        ))}
      </div>

      {restockEntry && (
        <DayEndReportPanels
          report={restockEntry.dayReport}
          title="Sold"
          showRestock
          compact
          alert
          fromDate={restockEntry.date}
          inventoryHref="/inventory"
        />
      )}

      {isRestaurant && menuOn.length === 0 && products.length > 0 && (
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-brand-warn-line bg-brand-warn-surface px-4 py-3 max-[700px]:px-3">
          <div className="min-w-0">
            <strong className="block text-sm text-brand-warn">Set today&apos;s potahe first</strong>
            <p className="m-0 mt-1 text-xs text-brand-warn">
              Mark which ulam / dishes you are serving before taking orders.
            </p>
          </div>
          <Link to="/pos?menu=1" className="shrink-0">
            <PrimaryButton compact type="button">
              Set menu
            </PrimaryButton>
          </Link>
        </div>
      )}

      {/* Revenue chart leads — it's the primary read on this page. Sales performance /
          Cash impact / Audit stack beside it rather than above it, so the chart isn't
          pushed down the page by supporting numbers. Chart height is raised to roughly
          match that 3-card stack instead of the default (a 2-card stack's) height. */}
      <div className="mb-3.5 grid grid-cols-[minmax(0,1.6fr)_minmax(220px,0.9fr)] items-stretch gap-3.5 max-[900px]:grid-cols-1">
        <RevenueChart points={buildChartPoints(filtered, period)} period={period} height={300} />
        <div className="flex flex-col gap-2.5">
          <StatTiles title="Sales performance" subtitle={period} items={salesPerformanceItems} />
          <StatTiles title="Cash impact" subtitle={`${todayKey} · today`} items={cashImpactItems} />
          <AuditSummary
            events={auditEvents}
            linkHref={canOpenReports ? '/manager/reports' : null}
            subtitle={period}
          />
        </div>
      </div>

      {isRestaurant && (
        <TableCard className="mb-3.5 max-h-none overflow-hidden p-0">
          <SectionHeading
            title="Today's potahe"
            meta={
              <Link to="/pos?menu=1" className="text-xs font-bold text-brand-ink no-underline hover:underline">
                Edit menu
              </Link>
            }
          />
          <div className="px-4 py-3">
            <div className="mb-2 flex gap-2 text-[11px]">
              <span className="rounded bg-brand-success-bg px-2 py-1 font-bold text-brand-success-text">
                Serving {menuOn.length}
              </span>
              <span className="rounded border border-brand-line bg-white px-2 py-1 font-bold text-brand-muted">
                Off {menuOff.length}
              </span>
            </div>
            {products.length === 0 ? (
              <div className="border-t border-brand-softline py-2.5 text-xs text-brand-muted">
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
                      <strong className="block text-brand-ink">{product.name}</strong>
                      <small className="mt-1 block text-[10px] text-brand-muted">
                        {product.category}
                        {product.productCode ? ` · ${product.productCode}` : ''}
                      </small>
                    </div>
                    <strong className={on ? 'text-brand-success-text' : 'text-brand-muted'}>
                      {on ? 'Serving' : 'Off'}
                    </strong>
                  </div>
                )
              })
            )}
          </div>
        </TableCard>
      )}

      {/* Top products, Top categories, Payment methods — one row of supporting detail,
          same visual weight, so none of these reads as more important than another. */}
      <div className="mb-4 grid grid-cols-3 items-start gap-3.5 max-[900px]:grid-cols-1">
        <SalesMixBar
          mix={top.map((product) => ({ category: product.name, value: product.revenue }))}
          title={isRestaurant ? 'Top dishes' : 'Top products'}
          subtitle={`By sales · ${period}`}
        />
        <SalesMixBar mix={mix} title="Top categories" subtitle={`By sales · ${period}`} />
        <SalesMixBar
          mix={paymentMethods.map((row) => ({
            category: paymentMethodLabels[row.method] || row.method,
            value: row.amount,
          }))}
          title="Payment methods"
          subtitle={`By tender · ${period}`}
          showShare
          barClassFor={(item) => PAYMENT_BAR_CLASS[item.category] || 'bg-brand-gold'}
          emptyMessage="No sales in this period yet."
        />
      </div>
    </div>
  )
}

export default Dashboard
