import { useEffect, useMemo, useState } from 'react'
import { FiBarChart2, FiShoppingBag, FiTrendingUp, FiWifi, FiWifiOff } from 'react-icons/fi'
import AnnouncementsCard from '../components/dashboard/AnnouncementsCard'
import SalesMixBar from '../components/dashboard/SalesMixBar'
import StatTiles from '../components/dashboard/StatTiles'
import { PageHeader, PageSkeleton, moneyClass } from '../components/ui'
import { hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { useShiftStore } from '../stores/shiftStore'
import { useSyncStore } from '../stores/syncStore'
import { formatShiftDuration, formatShiftPeriod, formatShiftWhen, greetingFor, money } from '../utils/format'
import { syncCopy, syncToneDot, syncToneText } from '../utils/syncStatus'

const PAYMENT_BAR_CLASS = {
  Cash: 'bg-brand-success',
  Card: 'bg-brand-info',
  'E-wallet': 'bg-brand-gold',
}
const PAYMENT_LABELS = { cash: 'Cash', card: 'Card', ewallet: 'E-wallet' }

/** Rows belonging to the cashier's currently open shift — same match OwnShiftSoFar uses. */
function rowsForShift(transactions, shift) {
  if (!shift) return []
  return transactions.filter(
    (row) =>
      (row.shiftClientId && row.shiftClientId === shift.clientId) ||
      (shift.serverId && row.shiftId === shift.serverId),
  )
}

/** One KPI tile — icon badge top-right, big figure, small supporting note. */
function KpiTile({ label, value, note, icon, iconBg, iconColor }) {
  return (
    <div className="rounded-[10px] border border-brand-line bg-brand-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-brand-subtle uppercase">{label}</span>
        <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${iconBg}`}>
          {icon({ size: 14, className: iconColor })}
        </span>
      </div>
      <strong className={`mt-2 block text-[26px] text-brand-ink ${moneyClass}`}>{value}</strong>
      {note && <span className="mt-1 block text-[10px] text-brand-subtle">{note}</span>}
    </div>
  )
}

/**
 * Operational, own-shift-only dashboard for cashiers — sales total, transaction count,
 * average sale, sync status, current shift timing and payment mix. Deliberately excludes
 * branch-wide revenue, manager analytics and transaction history; see the branch
 * `Dashboard.jsx` for that view (supervisor+ only, module `dashboard`), and `/transactions`
 * for full history.
 */
function CashierDashboard() {
  const user = useAuthStore((state) => state.user)
  const storeProducts = useProductStore((state) => state.products)
  const storeTransactions = useInventoryStore((state) => state.transactions)
  const loadBranch = useProductStore((state) => state.loadBranch)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const shift = useShiftStore((state) => state.shift)
  const sync = useSyncStore()
  const [bootingPage, setBootingPage] = useState(Boolean(hasSupabase))

  // Same cold-load guard as the branch Dashboard: only bootstrap when the store is
  // genuinely empty (a hard refresh landing directly on this route) — Shell already loads
  // this branch at sign-in/session-restore otherwise. bootingPage (not storeProducts.length)
  // gates the skeleton below so a branch with a genuinely empty catalog (no-data demo) still
  // clears the skeleton once the load settles, instead of being stuck forever.
  useEffect(() => {
    if (!hasSupabase || !user?.branchId || storeProducts.length > 0) {
      setBootingPage(false)
      return
    }
    setBootingPage(true)
    loadBranch(user.branchId)
      .then((data) => {
        if (data) hydrate(data)
      })
      .catch(() => {})
      .finally(() => setBootingPage(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-run on branch change, not on every storeProducts update
  }, [user?.branchId, loadBranch, hydrate])

  const shiftRows = useMemo(
    () => rowsForShift(storeTransactions, shift),
    [storeTransactions, shift],
  )
  const paidRows = useMemo(() => shiftRows.filter((row) => row.status === 'Paid'), [shiftRows])

  // Net of refunds, matching the "Revenue" figure on the branch Dashboard's headline tile.
  const salesTotal = paidRows.reduce(
    (sum, row) => sum + Number(row.total || 0) - Number(row.refundedAmount || 0),
    0,
  )
  const transactionCount = paidRows.length
  const avgTransaction = transactionCount > 0 ? salesTotal / transactionCount : 0

  const paymentMethods = useMemo(() => {
    const byMethod = new Map()
    paidRows.forEach((row) => {
      const method = String(row.paymentMethod || 'cash').toLowerCase()
      const prev = byMethod.get(method) || { method, amount: 0 }
      prev.amount += Number(row.total || 0)
      byMethod.set(method, prev)
    })
    return [...byMethod.values()].sort((a, b) => b.amount - a.amount)
  }, [paidRows])

  const shiftItems = shift
    ? [
        { label: 'Shift', value: formatShiftPeriod(shift.clockIn) },
        { label: 'Started', value: formatShiftWhen(shift.clockIn) },
        { label: 'On shift', value: formatShiftDuration(shift.clockIn) },
        { label: 'Drawer', value: shift.holdsDrawer !== false ? shift.drawerLabel || shift.drawerId || '—' : 'Floor (no till)' },
        { label: 'Transactions', value: String(transactionCount) },
      ]
    : []

  const status = syncCopy(sync)
  const SyncIcon = sync.online ? FiWifi : FiWifiOff

  if (bootingPage) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div className="overflow-auto pt-2.5 pb-[18px]">
      <PageHeader eyebrow="DASHBOARD" title={greetingFor(user)} />

      {!shift && (
        <div className="mb-3.5 rounded-[10px] border border-brand-line bg-brand-card px-4 py-3 text-xs text-brand-subtle">
          No open shift on this terminal. Figures below will fill in once your shift starts.
        </div>
      )}

      <div className="mb-3.5 grid grid-cols-4 gap-3.5 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
        <KpiTile
          label="Shift sales"
          value={money(salesTotal)}
          note={`${transactionCount} paid transactions`}
          icon={(p) => <FiTrendingUp {...p} />}
          iconBg="bg-brand-success-bg"
          iconColor="text-brand-success-text"
        />
        <KpiTile
          label="Shift transactions"
          value={String(transactionCount)}
          note="Completed sales, this shift"
          icon={(p) => <FiShoppingBag {...p} />}
          iconBg="bg-brand-info/15"
          iconColor="text-brand-info"
        />
        <KpiTile
          label="Average sale"
          value={money(avgTransaction)}
          note="Per transaction"
          icon={(p) => <FiBarChart2 {...p} />}
          iconBg="bg-brand-gold/15"
          iconColor="text-brand-gold"
        />
        <div className="rounded-[10px] border border-brand-line bg-brand-card p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold tracking-wide text-brand-subtle uppercase">Sync status</span>
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-n100">
              <SyncIcon size={14} className={syncToneText[status.tone]} />
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${syncToneDot[status.tone]}`} />
            <strong className={`block text-lg ${syncToneText[status.tone]}`}>{status.label}</strong>
          </div>
          <span className="mt-1 block text-[10px] text-brand-subtle">{status.detail}</span>
        </div>
      </div>

      <div className="mb-3.5 grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1">
        <StatTiles title="Current shift" subtitle="Your shift only" items={shiftItems} />
        <SalesMixBar
          mix={paymentMethods.map((row) => ({
            category: PAYMENT_LABELS[row.method] || row.method,
            value: row.amount,
          }))}
          title="Payment methods"
          subtitle="This shift"
          showShare
          barClassFor={(item) => PAYMENT_BAR_CLASS[item.category] || 'bg-brand-gold'}
          emptyMessage="No sales on this shift yet."
        />
      </div>

      <AnnouncementsCard />
    </div>
  )
}

export default CashierDashboard
