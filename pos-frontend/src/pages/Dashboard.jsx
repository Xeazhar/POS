import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AnnouncementsCard from '../components/dashboard/AnnouncementsCard'
import AuditSummary from '../components/dashboard/AuditSummary'
import StatTiles from '../components/dashboard/StatTiles'
import { DayEndReportPanels } from '../components/dayend/DayEndReportPanels'
import {
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SectionHeading,
  TableCard,
  moneyClass,
} from '../components/ui'
import { fetchBranchCashImpact, fetchSaleEvents, hasSupabase } from '../lib/api'
import { useLiveData } from '../hooks/useLiveData'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { liveRestockReport, previousDayRestockReport } from '../utils/dayEndReport'
import { businessDate, greetingFor, money, stockTone } from '../utils/format'
import { canAccessModule } from '../utils/roles'

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
  // Net of refunds — headline KPI is labelled "Net sales" (gross−refunds for paid sales).
  const revenue = filtered.reduce((sum, item) => sum + item.total - Number(item.refundedAmount || 0), 0)

  // Cash impact is always TODAY's business day, regardless of the Today/Week/Month toggle
  // above — an "expected cash" figure is a once-per-day drawer count (see DayEnd.jsx), not
  // something that means anything summed over a week. Audit follows the same toggle as
  // Sales performance. Both are kept live the same way transactions already are elsewhere
  // (Shell's useBranchOperationsLive) — broadcast on pos:branch:<id>:operations, 15s poll
  // fallback — instead of the previous fetch-once-on-mount effects, which never refreshed
  // after the initial load.
  useLiveData({
    enabled: hasSupabase && Boolean(branchIdForFetch),
    fetch: async () => {
      // Buffered a day on each side, then re-bucketed by calendar date client-side to match
      // filtered/voidedInPeriod above exactly — mapTransaction sets a transaction's `.date`
      // to localDateKey(created_at) (the plain CALENDAR date), not a business_date column,
      // so bucketing this fetch by business date (open-hour-shifted) would disagree with
      // those tiles instead of agreeing with them. The buffer only exists to counter
      // DST-adjacent edge cases in the raw Supabase range; the real bucketing happens below.
      const bufferStart = new Date(cutoff)
      bufferStart.setDate(bufferStart.getDate() - 1)
      const bufferEnd = new Date()
      bufferEnd.setDate(bufferEnd.getDate() + 1)
      const [cashRow, events] = await Promise.all([
        fetchBranchCashImpact(branchIdForFetch, businessDate(new Date(), dayOpenHour), dayOpenHour).catch(
          () => null,
        ),
        fetchSaleEvents({
          branchId: branchIdForFetch,
          start: toDateKey(bufferStart),
          end: toDateKey(bufferEnd),
        }).catch(() => []),
      ])
      setCashImpact(cashRow)
      setAuditEvents(
        (events || []).filter(
          (e) =>
            (e.event_type === 'void' || e.event_type === 'refund') &&
            inPeriod(toDateKey(new Date(e.created_at)), cutoff),
        ),
      )
    },
    broadcasts: branchIdForFetch
      ? [{ topic: `pos:branch:${branchIdForFetch}:operations`, events: ['OPERATIONS_CHANGED'] }]
      : [],
    pollMs: 15_000,
  })

  const low = products.filter((product) => stockTone(product) === 'low')
  const menuOn = products.filter((p) => p.availableToday !== false)
  const menuOff = products.filter((p) => p.availableToday === false)

  const greeting = greetingFor(user)
  const todayKey = businessDate(new Date(), dayOpenHour)
  // Prefer yesterday's closed-day snapshot (carries sold-qty context); fall back to a live
  // read of current stock so the card is never blank just because no day has closed yet
  // (new branch) or nothing low happened to sell on the last closed day.
  const priorRestockEntry = !isRestaurant ? previousDayRestockReport(dayEnds, todayKey) : null
  const restockReport = priorRestockEntry?.dayReport || (!isRestaurant ? liveRestockReport(products) : null)

  // Same reductions terminalReports.js uses for the X/Z reading — reused rather than
  // re-derived so this row and a printed reading for the same range can never disagree.
  // Lead item (first) is the number that matters most — StatTiles renders it larger.
  const salesPerformanceItems = [
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
  // (never affect Expected cash) — shown so this card doubles as "how today was paid for".
  const cashImpactItems = cashImpact
    ? [
        { label: 'Expected cash', value: money(cashImpact.expectedCash) },
        { label: 'Cash sales', value: money(cashImpact.cashSales) },
        { label: 'Card sales', value: money(cashImpact.cardSales) },
        { label: 'E-wallet sales', value: money(cashImpact.ewalletSales) },
        { label: 'Change fund in', value: money(cashImpact.changeFund) },
        { label: 'Petty cash out', value: money(cashImpact.paidOut), tone: 'danger', hint: 'Expense' },
        { label: 'Cash pickup', value: money(cashImpact.pickup), hint: 'To safe, not an expense' },
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
              }}
            >
              {item}
            </button>
          ))}
        </div>
      </PageHeader>

      <div className="mb-4 grid grid-cols-3 items-stretch gap-3.5 max-[900px]:grid-cols-2 max-[540px]:grid-cols-1">
        {(isRestaurant
          ? [
              [`Net sales · ${period}`, money(revenue), `${filtered.length} paid orders`],
              [`Orders · ${period}`, filtered.length, 'Completed sales'],
              ['Serving today', menuOn.length, `${menuOff.length} marked off`],
            ]
          : [
              [`Net sales · ${period}`, money(revenue), `${filtered.length} paid transactions`],
              [`Orders · ${period}`, filtered.length, 'Completed sales'],
              ['Low-stock items', low.length, 'This branch'],
            ]
        ).map(([label, value, note]) => (
          <div key={label} className="flex h-full flex-col rounded-[10px] border border-brand-gold/50 bg-brand-dark p-4">
            <span className="block text-[11px] font-semibold tracking-wide text-brand-ondark-dim uppercase">{label}</span>
            <div className="mt-2 flex flex-wrap items-baseline gap-2">
              <strong className={`block text-[26px] text-brand-gold ${moneyClass}`}>{value}</strong>
            </div>
            {note && <span className="mt-1 block text-[10px] text-brand-ondark-dim">{note}</span>}
          </div>
        ))}
      </div>

      <div className="mb-3.5 grid grid-cols-2 items-stretch gap-3.5 max-[900px]:grid-cols-1">
        <StatTiles
          title="Payment & cash impact"
          subtitle={todayKey}
          items={cashImpactItems}
          todayBadge
        />
        <StatTiles
          title="Sales performance"
          subtitle={period}
          items={salesPerformanceItems}
        />
      </div>

      <div className="mb-3.5 grid grid-cols-2 items-stretch gap-3.5 max-[900px]:grid-cols-1">
        {restockReport ? (
          <DayEndReportPanels
            report={restockReport}
            showSold={false}
            showRestock
            compact
            alert
            fromDate={priorRestockEntry?.date || null}
            restockSubtitle={priorRestockEntry ? null : 'Low on hand right now'}
            inventoryHref="/inventory"
          />
        ) : (
          <div />
        )}
        <AnnouncementsCard />
      </div>

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

      <AuditSummary
        events={auditEvents}
        linkHref={canOpenReports ? '/manager/reports' : null}
        subtitle={period}
      />
    </div>
  )
}

export default Dashboard
