import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import AuditSummary from '../components/dashboard/AuditSummary'
import RevenueChart from '../components/dashboard/RevenueChart'
import SalesMixBar from '../components/dashboard/SalesMixBar'
import StatTiles from '../components/dashboard/StatTiles'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import {
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  SectionHeading,
  TableCard,
  moneyClass,
} from '../components/ui'
import { fetchBranchCashImpact, fetchSaleEvents, fetchSoldLineItems, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { previousDayRestockReport } from '../utils/dayEndReport'
import { businessDate, greetingFor, money, stockTone } from '../utils/format'
import { canAccessModule } from '../utils/roles'
import {
  buildRevenueChartBreakdowns,
  buildRevenueChartPoints,
  resolveRevenueChartBucketLabel,
} from '../utils/revenueChartPoints'

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

function inPeriod(dateKey, cutoff) {
  return startOfDay(new Date(`${dateKey}T00:00:00`)) >= cutoff
}

/**
 * Aggregate raw sold-line rows (fetchSoldLineItems) into Top Products (top 5 by revenue)
 * and Top Categories, resolving name/category/pricingMode from the branch's already-loaded
 * `products` list. `revenue` on each row is `line_total` — what was actually charged, not
 * today's live product price — so a later price edit can't retroactively distort history.
 */
function aggregateSoldLines(rows, products) {
  const byProductId = new Map(products.map((p) => [p.id, p]))
  const byProduct = new Map()
  const byCategory = new Map()

  rows.forEach((row) => {
    const product = byProductId.get(row.productId)
    const category = product?.category || 'Other'
    const name = product?.name || 'Product'

    const prev = byProduct.get(row.productId) || {
      id: row.productId,
      name,
      category,
      pricingMode: product?.pricingMode || 'pc',
      revenue: 0,
      qty: 0,
    }
    prev.revenue += row.revenue
    prev.qty += row.quantity
    byProduct.set(row.productId, prev)

    byCategory.set(category, (byCategory.get(category) || 0) + row.revenue)
  })

  const top = [...byProduct.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5)
  const mix = [...byCategory.entries()]
    .map(([category, value]) => ({ category, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)

  return { top, mix }
}

/**
 * Render the branch sales and operations dashboard.
 * @param {Object} [options] - Optional dashboard scope settings.
 * @param {string} [options.branchId] - Branch identifier used to scope dashboard data.
 * @param {string} [options.branchName] - Branch name displayed in the dashboard header.
 * @return {JSX.Element} The dashboard view.
 */
function Dashboard({ branchId: scopedBranchId, branchName } = {}) {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const storeProducts = useProductStore((state) => state.products)
  const productsLoading = useProductStore((state) => state.loading)
  const storeTransactions = useInventoryStore((state) => state.transactions)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const [period, setPeriod] = useState('Today')
  const [bootingPage, setBootingPage] = useState(Boolean(hasSupabase))
  const [cashImpact, setCashImpact] = useState(null)
  const [auditEvents, setAuditEvents] = useState([])
  const [productMix, setProductMix] = useState({ top: [], mix: [] })
  // Raw sold-line rows behind `productMix` — kept alongside the aggregate so a clicked
  // chart point can re-aggregate just that bucket's rows client-side, no second fetch.
  const [soldLineRows, setSoldLineRows] = useState([])
  const [selectedPointIndex, setSelectedPointIndex] = useState(null)
  const loadBranch = useProductStore((state) => state.loadBranch)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const branchIdForFetch = scopedBranchId || user?.branchId

  // Only do a real network bootstrap when the store is genuinely empty (a cold load —
  // e.g. a hard refresh landing directly on "/"). App.jsx already loads this branch at
  // boot/session-restore and Login.jsx at sign-in, so re-running the full
  // bootstrapBranchData round-trip (products + 200 transactions + 500 movements +
  // day_ends + categories + staff-name/approver lookups) every time a user merely
  // navigates back to Home was the main cause of "everything feels slow" — it blocked
  // the page behind a full skeleton for data that was already fresh. Freshness after the
  // first load is kept by the sale/shift flows' own background `syncBranch` calls and the
  // manual Refresh control in the header, not by re-fetching here.
  useEffect(() => {
    if (!hasSupabase) {
      setBootingPage(false)
      return
    }
    const branchId = scopedBranchId || user?.branchId
    if (!branchId || storeProducts.length > 0) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-run on branch change, not on every storeProducts update
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
  const days = period === 'Today' ? 1 : period === 'Week' ? 7 : 30
  const cutoff = startOfDay(new Date())
  cutoff.setDate(cutoff.getDate() - days + 1)
  const filtered = transactions.filter(
    (item) => item.status === 'Paid' && inPeriod(item.date, cutoff),
  )
  const voidedInPeriod = transactions.filter(
    (item) => item.status === 'Voided' && inPeriod(item.date, cutoff),
  )
  // Net of refunds — headline KPI is labelled "Revenue" (gross−refunds for paid sales).
  // Keep "Net sales" for the Sales performance tile on manager Overview, where Gross/Net
  // are shown side by side; here a single KPI saying "Net sales" confused staff.
  const revenue = filtered.reduce((sum, item) => sum + item.total - Number(item.refundedAmount || 0), 0)

  // Clicking a point on Revenue over time cross-filters Revenue/Orders, Sales performance,
  // Top products/categories, Payment methods and Audit to that single bucket — everything
  // needed is already loaded client-side (filtered/voidedInPeriod/soldLineRows/auditEvents),
  // so this is a pure client-side re-bucket, no second fetch. Cash impact and Low-stock stay
  // whole/current on purpose: cash impact is a "today" drawer snapshot regardless of period
  // (see the effect above), and Low-stock is live inventory, not a time series.
  const chartPoints = useMemo(() => buildRevenueChartPoints(filtered, period), [filtered, period])
  const chartBreakdowns = useMemo(
    () => buildRevenueChartBreakdowns(filtered, voidedInPeriod, period),
    [filtered, voidedInPeriod, period],
  )
  const selectedPoint = selectedPointIndex != null ? chartPoints[selectedPointIndex] : null
  const selectedBreakdown = selectedPoint ? chartBreakdowns[selectedPoint.label] : null
  const filterSubtitleSuffix = selectedPoint ? ` · ${selectedPoint.full || selectedPoint.short}` : ''

  // Audit follows the same Today/Week/Month toggle as Sales performance.
  useEffect(() => {
    if (!hasSupabase || !branchIdForFetch) return undefined
    let active = true
    // Buffered a day on each side, then re-bucketed by calendar date client-side to match
    // filtered/voidedInPeriod above exactly — mapTransaction sets a transaction's `.date` to
    // localDateKey(created_at) (the plain CALENDAR date), not a business_date column, so
    // bucketing this fetch by business date (open-hour-shifted) would disagree with those
    // tiles instead of agreeing with them. The buffer only exists to counter DST-adjacent
    // edge cases in the raw Supabase range; the real bucketing happens in this filter.
    const bufferStart = new Date(cutoff)
    bufferStart.setDate(bufferStart.getDate() - 1)
    const bufferEnd = new Date()
    bufferEnd.setDate(bufferEnd.getDate() + 1)
    fetchSaleEvents({
      branchId: branchIdForFetch,
      start: toDateKey(bufferStart),
      end: toDateKey(bufferEnd),
    })
      .then((rows) => {
        if (!active) return
        setAuditEvents(
          (rows || []).filter(
            (e) =>
              (e.event_type === 'void' || e.event_type === 'refund') &&
              inPeriod(toDateKey(new Date(e.created_at)), cutoff),
          ),
        )
      })
      .catch(() => {
        if (active) setAuditEvents([])
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchIdForFetch, period])

  // Top products / Top categories — same buffer-then-rebucket shape as the audit effect
  // above, reading transaction_items (line_total, the price actually charged) rather than
  // stock_movements: that log survives a debug transaction reset and would keep counting
  // deleted test sales, and it has no historical price at all so it can only ever use
  // today's live product price. Kept in state (not useMemo) since it's a fetch.
  useEffect(() => {
    if (!hasSupabase || !branchIdForFetch) return undefined
    let active = true
    const bufferStart = new Date(cutoff)
    bufferStart.setDate(bufferStart.getDate() - 1)
    const bufferEnd = new Date()
    bufferEnd.setDate(bufferEnd.getDate() + 1)
    fetchSoldLineItems({
      branchId: branchIdForFetch,
      startIso: bufferStart.toISOString(),
      endIso: bufferEnd.toISOString(),
    })
      .then((rows) => {
        if (!active) return
        const inWindow = rows.filter((row) => inPeriod(toDateKey(new Date(row.createdAt)), cutoff))
        setProductMix(aggregateSoldLines(inWindow, products))
        setSoldLineRows(inWindow)
      })
      .catch(() => {
        // Keep last-good state — same graceful degradation as cashImpact/auditEvents above.
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchIdForFetch, period, products])

  const low = products.filter((product) => stockTone(product) === 'low')
  const menuOn = products.filter((p) => p.availableToday !== false)
  const menuOff = products.filter((p) => p.availableToday === false)

  const { top, mix } = productMix
  const effectiveProductMix = useMemo(() => {
    if (!selectedPoint) return { top, mix }
    const rowsInBucket = soldLineRows.filter(
      (row) => resolveRevenueChartBucketLabel({ createdAt: row.createdAt }, period) === selectedPoint.label,
    )
    return aggregateSoldLines(rowsInBucket, products)
  }, [selectedPoint, soldLineRows, period, products, top, mix])
  const effectiveTop = effectiveProductMix.top
  const effectiveMix = effectiveProductMix.mix

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
  const paymentMethodsByBucket = useMemo(() => {
    const acc = {}
    filtered.forEach((item) => {
      const label = resolveRevenueChartBucketLabel(item, period)
      if (!label) return
      const bucket = (acc[label] ||= new Map())
      const method = String(item.paymentMethod || 'cash').toLowerCase()
      const prev = bucket.get(method) || { method, amount: 0, count: 0 }
      prev.amount += Number(item.total || 0)
      prev.count += 1
      bucket.set(method, prev)
    })
    return acc
  }, [filtered, period])
  const effectivePaymentMethods = selectedPoint
    ? [...(paymentMethodsByBucket[selectedPoint.label]?.values() || [])].sort((a, b) => b.amount - a.amount)
    : paymentMethods
  const effectiveAuditEvents = selectedPoint
    ? auditEvents.filter(
        (e) => resolveRevenueChartBucketLabel({ createdAt: e.created_at }, period) === selectedPoint.label,
      )
    : auditEvents

  const greeting = greetingFor(user)
  const todayKey = businessDate(new Date(), dayOpenHour)
  const restockEntry = !isRestaurant ? previousDayRestockReport(dayEnds, todayKey) : null

  // Same reductions terminalReports.js uses for the X/Z reading — reused rather than
  // re-derived so this row and a printed reading for the same range can never disagree.
  // Lead item (first) is the number that matters most — StatTiles renders it larger.
  const salesPerformanceItems = selectedBreakdown
    ? [
        { label: 'Gross sales', value: money(selectedBreakdown.grossSales) },
        { label: 'Discounts', value: money(selectedBreakdown.discounts), tone: 'danger' },
        { label: 'Refunds', value: money(selectedBreakdown.refunds), tone: 'danger' },
        { label: 'Voided sales', value: money(selectedBreakdown.voidedSales), tone: 'danger' },
      ]
    : [
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
  // match"); the rest is how it was arrived at. Card/E-wallet sales are informational only
  // (never affect Expected cash) — shown so this card doubles as "how today was paid for"
  // without repeating the period-scoped "Payment methods" card below it (that one ranks by
  // %/period; these three are always TODAY's absolute pesos, for drawer context).
  const cashImpactItems = cashImpact
    ? [
        { label: 'Expected cash', value: money(cashImpact.expectedCash) },
        { label: 'Cash sales', value: money(cashImpact.cashSales) },
        { label: 'Card sales', value: money(cashImpact.cardSales) },
        { label: 'E-wallet sales', value: money(cashImpact.ewalletSales) },
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
      <PageHeader eyebrow="OVERVIEW" title={greeting}>
        <div className="flex flex-wrap items-center gap-1.5 max-[700px]:w-full">
          {(branchName || scopedBranchId) && (
            <span className="mr-1 text-xs text-brand-muted">{branchName || 'Branch dashboard'}</span>
          )}
          {['Today', 'Week', 'Month'].map((item) => (
            <button
              key={item}
              type="button"
              className={`rounded-[5px] border px-3 py-2 text-xs font-bold max-[700px]:flex-1 max-[700px]:px-1.5 max-[700px]:py-1.5 max-[700px]:text-[10px] ${
                period === item
                  ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                  : 'border-brand-border bg-brand-card text-brand-n700'
              }`}
              onClick={() => {
                setPeriod(item)
                setSelectedPointIndex(null)
              }}
            >
              {item}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="mb-4 grid grid-cols-3 gap-3.5 max-[700px]:grid-cols-1">
        {(isRestaurant
          ? [
              [
                selectedPoint ? `Revenue${filterSubtitleSuffix}` : `Revenue · ${period}`,
                money(selectedPoint ? selectedPoint.total : revenue),
                selectedPoint
                  ? `${selectedPoint.orders || 0} paid orders`
                  : `${filtered.length} paid orders`,
              ],
              [
                selectedPoint ? `Orders${filterSubtitleSuffix}` : `Orders · ${period}`,
                selectedPoint ? selectedPoint.orders || 0 : filtered.length,
                'Completed sales',
              ],
              ['Serving today', menuOn.length, `${menuOff.length} marked off`],
            ]
          : [
              [
                selectedPoint ? `Revenue${filterSubtitleSuffix}` : `Revenue · ${period}`,
                money(selectedPoint ? selectedPoint.total : revenue),
                selectedPoint
                  ? `${selectedPoint.orders || 0} paid transactions`
                  : `${filtered.length} paid transactions`,
              ],
              [
                selectedPoint ? `Orders${filterSubtitleSuffix}` : `Orders · ${period}`,
                selectedPoint ? selectedPoint.orders || 0 : filtered.length,
                'Completed sales',
              ],
              ['Low-stock items', low.length, 'This branch'],
            ]
        ).map(([label, value, note]) => (
          <div key={label} className="rounded-[10px] border border-brand-line bg-brand-card p-4">
            <span className="block text-[11px] font-semibold tracking-wide text-brand-subtle uppercase">{label}</span>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <strong className={`block text-[26px] text-brand-ink ${moneyClass}`}>{value}</strong>
            </div>
            {note && <span className="mt-1 block text-[10px] text-brand-subtle">{note}</span>}
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

      {selectedPoint && (
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-brand-gold/40 bg-brand-gold/10 px-3.5 py-2 text-xs">
          <span className="text-brand-ink">
            Showing <strong>{selectedPoint.full || selectedPoint.short}</strong> — Revenue, Orders,
            Sales performance, Top products/categories, Payment methods and Audit are all
            filtered to this point. Payment & cash impact and Low-stock always show today.
          </span>
          <SecondaryButton compact type="button" onClick={() => setSelectedPointIndex(null)}>
            Clear selection
          </SecondaryButton>
        </div>
      )}
      <div className="mb-3.5 grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.9fr)] items-stretch gap-3.5 max-[1100px]:grid-cols-1">
        <div className="min-h-0 min-w-0 w-full">
          <RevenueChart
            points={chartPoints}
            period={period}
            fill
            selectedIndex={selectedPointIndex}
            onSelectIndex={setSelectedPointIndex}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2.5">
          <StatTiles
            title="Sales performance"
            subtitle={`${period}${filterSubtitleSuffix}`}
            items={salesPerformanceItems}
          />
          <StatTiles title="Payment & cash impact" subtitle={`${todayKey} · today`} items={cashImpactItems} />
          <AuditSummary
            events={effectiveAuditEvents}
            linkHref={canOpenReports ? '/manager/reports' : null}
            subtitle={`${period}${filterSubtitleSuffix}`}
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
              <span className="rounded border border-brand-line bg-brand-card px-2 py-1 font-bold text-brand-muted">
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
          mix={effectiveTop.map((product) => ({ category: product.name, value: product.revenue }))}
          title={isRestaurant ? 'Top dishes' : 'Top products'}
          subtitle={`By sales · ${period}${filterSubtitleSuffix}`}
        />
        <SalesMixBar
          mix={effectiveMix}
          title="Top categories"
          subtitle={`By sales · ${period}${filterSubtitleSuffix}`}
        />
        <SalesMixBar
          mix={effectivePaymentMethods.map((row) => ({
            category: paymentMethodLabels[row.method] || row.method,
            value: row.amount,
          }))}
          title="Payment methods"
          subtitle={`By tender · ${period}${filterSubtitleSuffix}`}
          showShare
          barClassFor={(item) => PAYMENT_BAR_CLASS[item.category] || 'bg-brand-gold'}
          emptyMessage="No sales in this period yet."
        />
      </div>
    </div>
  )
}

export default Dashboard
