import { useEffect, useMemo, useState } from 'react'
import { FiX } from 'react-icons/fi'
import { Link, useParams } from 'react-router-dom'
import TransactionDetailModal from '../../components/transactions/TransactionDetailModal'
import { DayEndReportPanels } from '../../components/dayend/DayEndReportPanels'
import {
  ErrorBanner,
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  Pager,
  PrimaryButton,
  SecondaryButton,
  SectionHeading,
  TableCard,
  ToggleSwitch,
  moneyClass,
  statusLabelFromTxn,
  statusToneFromTxn,
  StatusBadge,
  tableRowDenseClass,
  varianceToneClass,
} from '../../components/ui'
import {
  approverLabel,
  bootstrapBranchData,
  fetchBranchTelemetry,
  fetchBranches,
  fetchPettyCashTimeline,
  fetchRefundSummary,
  fetchStaffShifts,
  fetchTransactionDetail,
  hasSupabase,
  approveDayEnd,
  approvePettyCash,
  fulfillPettyCash,
  rejectPettyCash,
  reopenDayEnd,
  saveBranch,
} from '../../lib/api'
import { BRANCH_DEVICES, normalizeDeviceSettings } from '../../devices'
import { useAuthStore } from '../../stores/posStore'
import { previousDayRestockReport } from '../../utils/dayEndReport'
import { formatSupportError } from '../../utils/errors'
import { businessDate, formatOpenHourLabel, money, qty } from '../../utils/format'
import { isSupervisorOrAbove } from '../../utils/roles'
import { discountSourceLabel, isPromoDiscountType } from '../../utils/promo'
import { isUuid } from '../../utils/transactionDetail'

const PAGE_SIZE = 10
/** How far back the branch Staff table reads the clock-in/out log. */
const STAFF_LOG_DAYS = 30

function daysAgoKey(days) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function hoursLabel(totalMs) {
  if (!totalMs || totalMs <= 0) return '—'
  const mins = Math.round(totalMs / 60000)
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

/**
 * One row per person, not per shift. "Who works here and how many hours did they log"
 * is a roster question; the shift-by-shift cash detail already has its own page.
 */
function rollUpStaffHours(rows = []) {
  const byStaff = new Map()
  for (const row of rows) {
    const key = row.staffId || row.staffName || 'unknown'
    const entry = byStaff.get(key) || {
      key,
      name: row.staffName || 'Staff',
      role: row.staffRole || null,
      sessions: 0,
      totalMs: 0,
      openNow: false,
      lastIn: null,
      lastOut: null,
    }
    entry.sessions += 1
    if (!entry.role && row.staffRole) entry.role = row.staffRole
    const start = row.clockIn ? new Date(row.clockIn).getTime() : NaN
    const end = row.clockOut ? new Date(row.clockOut).getTime() : NaN
    // An open shift counts up to now — otherwise today's hours read as zero all day.
    const stop = Number.isNaN(end) ? Date.now() : end
    if (!Number.isNaN(start) && stop > start) entry.totalMs += stop - start
    if (!row.clockOut) entry.openNow = true
    if (!entry.lastIn && row.clockIn) entry.lastIn = row.clockIn
    if (!entry.lastOut && row.clockOut) entry.lastOut = row.clockOut
    byStaff.set(key, entry)
  }
  return [...byStaff.values()].sort((a, b) => b.totalMs - a.totalMs)
}

function ManagerBranchDashboard() {
  const { branchId } = useParams()
  const user = useAuthStore((state) => state.user)
  const [branch, setBranch] = useState(null)
  const [data, setData] = useState({ products: [], transactions: [], movements: [], dayEnds: [], pettyTimeline: [] })
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [invPage, setInvPage] = useState(0)
  const [receiptsPage, setReceiptsPage] = useState(0)
  const [receiptDateFilter, setReceiptDateFilter] = useState('all') // all | today | date
  const [receiptDateValue, setReceiptDateValue] = useState('')
  const [receiptPromoFilter, setReceiptPromoFilter] = useState('all') // all | <promo name> | pwd | none
  const [dayEndPage, setDayEndPage] = useState(0)
  const [reopening, setReopening] = useState(null)
  const [reopenTarget, setReopenTarget] = useState(null)
  const [reopenReason, setReopenReason] = useState('')
  const [approving, setApproving] = useState(null)
  const [telemetry, setTelemetry] = useState({ devices: [] })
  const [detail, setDetail] = useState(null)
  const [refundSummary, setRefundSummary] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [deviceBusy, setDeviceBusy] = useState(null)
  const [pettyBusyId, setPettyBusyId] = useState(null)
  const [staffShifts, setStaffShifts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setInvPage(0)
    setReceiptsPage(0)
    setReceiptDateFilter('all')
    setReceiptDateValue('')
    setReceiptPromoFilter('all')
    setDayEndPage(0)
    setSelectedProduct(null)
    setLoading(true)
    Promise.resolve()
      .then(async () => {
        if (!hasSupabase) {
          if (!active) return
          setBranch({ id: branchId, name: 'Bayombong Branch #001', address: 'Bayombong', is_active: true, day_open_hour: 7 })
          setData({ products: [], transactions: [], movements: [], dayEnds: [], dayOpenHour: 7 })
          setTelemetry({ devices: [] })
          setLoading(false)
          return
        }
        const branches = await fetchBranches()
        if (!active) return
        setBranch(branches.find((row) => row.id === branchId) || null)
        const payload = await bootstrapBranchData(branchId)
        const pettyTimeline = await fetchPettyCashTimeline(branchId, {
          startDate: businessDate(new Date(), Number(payload.dayOpenHour ?? 7)),
          endDate: businessDate(new Date(), Number(payload.dayOpenHour ?? 7)),
        }).catch(() => [])
        const tel = await fetchBranchTelemetry([branchId])
        // Staff roster + hours comes from the shift log — the same clock-in/out records
        // Shifts.jsx reads. STAFF_LOG_DAYS back, so a fortnightly payroll question is
        // answerable without opening a second page.
        const shiftRows = await fetchStaffShifts({
          branchId,
          start: daysAgoKey(STAFF_LOG_DAYS),
          end: businessDate(new Date(), Number(payload.dayOpenHour ?? 7)),
        }).catch(() => [])
        if (active) {
          setData({ ...payload, pettyTimeline })
          setTelemetry({ devices: tel.devices[branchId] || [] })
          setStaffShifts(shiftRows || [])
          setLoading(false)
        }
      })
      .catch((err) => {
        if (active) {
          setError(err.message)
          setLoading(false)
        }
      })

    const poll = window.setInterval(() => {
      if (!hasSupabase) return
      fetchBranchTelemetry([branchId])
        .then((tel) => {
          if (!active) return
          setTelemetry({ devices: tel.devices[branchId] || [] })
        })
        .catch(() => {})
    }, 30_000)

    return () => {
      active = false
      window.clearInterval(poll)
    }
  }, [branchId])

  const reload = async () => {
    if (!hasSupabase) return
    const branches = await fetchBranches()
    setBranch(branches.find((row) => row.id === branchId) || null)
    const payload = await bootstrapBranchData(branchId)
    const pettyTimeline = await fetchPettyCashTimeline(branchId, {
      startDate: businessDate(new Date(), Number(payload.dayOpenHour ?? 7)),
      endDate: businessDate(new Date(), Number(payload.dayOpenHour ?? 7)),
    }).catch(() => [])
    setData({ ...payload, pettyTimeline })
  }

  const openHour = Number(branch?.day_open_hour ?? 7)
  const isRestaurant = branch?.branch_type === 'restaurant'
  const todayKey = businessDate(new Date(), openHour)
  const todayTx = data.transactions.filter((item) => item.status === 'Paid' && item.date === todayKey)
  const revenue = todayTx.reduce((sum, item) => sum + Number(item.netTotal ?? item.total), 0)
  /**
   * Money handed back today, across ALL of today's receipts — not just the ones still
   * marked Paid.
   *
   * A fully voided sale is the largest kind of refund there is, and it drops out of
   * `todayTx` (which filters to status === 'Paid'), so summing over that list reported
   * a smaller refund figure the more completely a sale was refunded. A void also does not
   * always write `refunded_amount`, so the whole total counts when it is absent.
   */
  const todayAll = data.transactions.filter((item) => item.date === todayKey)
  const refundedRows = todayAll.filter(
    (item) => item.status === 'Voided' || Number(item.refundedAmount || 0) > 0,
  )
  const refundedToday = refundedRows.reduce((sum, item) => {
    const refunded = Number(item.refundedAmount || 0)
    if (item.status === 'Voided') return sum + (refunded || Number(item.total || 0))
    return sum + refunded
  }, 0)
  const refundCountToday = refundedRows.length
  const low = data.products.filter((product) => product.stock <= product.lowStockAt)
  const menuOn = data.products.filter((p) => p.availableToday !== false)
  const menuOff = data.products.filter((p) => p.availableToday === false)
  const staffRoster = useMemo(() => rollUpStaffHours(staffShifts), [staffShifts])
  const plateMix = useMemo(() => {
    const map = {}
    const comboMap = {}
    todayTx.forEach((txn) => {
      if (txn.ulamCombo) {
        const label =
          txn.ulamCombo === 'meat_meat'
            ? 'Meat + Meat'
            : txn.ulamCombo === 'meat_veggie'
              ? 'Meat + Veggie'
              : txn.ulamCombo === 'veggie_veggie'
                ? 'Veggie + Veggie'
                : txn.ulamCombo
        comboMap[label] = (comboMap[label] || 0) + 1
      }
      ;(txn.itemsList || []).forEach((line) => {
        const product = data.products.find((p) => p.id === line.id)
        const cat = product?.category || product?.menuKind || 'Menu'
        const qtySold = line.pricingMode === 'kg' ? Number(line.weight || 0) : Number(line.quantity || 0)
        const amount = Number(line.price || 0) * qtySold
        map[cat] = (map[cat] || 0) + amount
      })
    })
    if (!Object.keys(map).length) {
      data.products.forEach((p) => {
        if (p.availableToday === false) return
        map[p.category || 'Menu'] = (map[p.category || 'Menu'] || 0) + 0
      })
    }
    return {
      byCategory: Object.entries(map)
        .map(([category, value]) => ({ category, value }))
        .sort((a, b) => b.value - a.value),
      byCombo: Object.entries(comboMap)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count),
    }
  }, [todayTx, data.products])
  const shrink = data.movements
    .filter((item) => item.type === 'Shrinkage' || item.movementType === 'shrinkage')
    .reduce(
      (sum, item) =>
        sum + Math.abs(item.quantityChange) * (data.products.find((p) => p.id === item.productId)?.price || 0),
      0,
    )
  const todayEntry = (data.dayEnds || []).find((entry) => entry.date === todayKey)
  const submittedToday = todayEntry?.status === 'submitted'
  const closedToday = todayEntry?.status === 'closed'
  const canApprove = isSupervisorOrAbove(user?.role)

  const handleApprove = async (entry) => {
    setApproving(entry.id)
    setError('')
    try {
      await approveDayEnd({ id: entry.id, staffId: user.id })
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
    } finally {
      setApproving(null)
    }
  }

  const handleReopen = async () => {
    const entry = reopenTarget
    if (!entry) return
    const reason = reopenReason.trim()
    if (!reason) {
      setError('Reopen reason is required.')
      return
    }
    setReopening(entry.id)
    setError('')
    try {
      await reopenDayEnd({ id: entry.id, staffId: user.id, reason })
      setReopenTarget(null)
      setReopenReason('')
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
    } finally {
      setReopening(null)
    }
  }

  const openTxnDetail = async (item) => {
    setError('')
    setLoadingDetail(true)
    setDetail(null)
    setRefundSummary(null)
    try {
      if (!hasSupabase || !isUuid(item.id)) {
        setError('Transaction details are only available after the sale has synced.')
        return
      }
      const [row, summary] = await Promise.all([
        fetchTransactionDetail(item.id),
        fetchRefundSummary(item.id).catch(() => null),
      ])
      setDetail(row)
      setRefundSummary(summary)
    } catch (err) {
      setError(err.message || 'Could not load transaction')
    } finally {
      setLoadingDetail(false)
    }
  }

  const deviceSettings = normalizeDeviceSettings(branch?.device_settings)

  const persistDeviceSettings = async (next, previousBranch) => {
    if (!hasSupabase) {
      const saved = { ...previousBranch, device_settings: next }
      setBranch(saved)
      if (user?.branchId === saved.id) {
        useAuthStore.setState({ user: { ...user, deviceSettings: next } })
      }
      return saved
    }
    const saved = await saveBranch({
      id: previousBranch.id,
      name: previousBranch.name,
      address: previousBranch.address,
      is_active: previousBranch.is_active,
      device_settings: next,
    })
    const merged = {
      ...saved,
      device_settings: saved.device_settings || next,
    }
    setBranch(merged)
    if (user?.branchId === merged.id) {
      useAuthStore.setState({
        user: { ...user, deviceSettings: normalizeDeviceSettings(merged.device_settings) },
      })
    }
    return merged
  }

  const toggleDevice = async (key, enabled) => {
    if (!branch?.id || deviceBusy) return
    const next = { ...deviceSettings, [key]: enabled === true }
    const previous = branch
    // Optimistic UI so the switch moves immediately
    setBranch({ ...branch, device_settings: next })
    setDeviceBusy(key)
    setError('')
    try {
      await persistDeviceSettings(next, previous)
    } catch (err) {
      setBranch(previous)
      setError(formatSupportError(err, 'DEV02'))
    } finally {
      setDeviceBusy(null)
    }
  }

  const receiptPromoNames = useMemo(() => {
    const set = new Set()
    for (const txn of data.transactions || []) {
      if (isPromoDiscountType(txn.discountType)) set.add(txn.discountType)
    }
    return [...set].sort()
  }, [data.transactions])

  const recentTxns = useMemo(() => {
    let rows = [...(data.transactions || [])]
    if (receiptDateFilter === 'today') rows = rows.filter((t) => t.date === todayKey)
    else if (receiptDateFilter === 'date' && receiptDateValue) rows = rows.filter((t) => t.date === receiptDateValue)

    if (receiptPromoFilter === 'pwd') {
      rows = rows.filter((t) => ['pwd', 'senior'].includes(String(t.discountType || '').toLowerCase()))
    } else if (receiptPromoFilter === 'none') {
      rows = rows.filter((t) => !(Number(t.discountAmount || 0) > 0))
    } else if (receiptPromoFilter !== 'all') {
      rows = rows.filter((t) => t.discountType === receiptPromoFilter)
    }

    return rows.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return tb - ta
    })
  }, [data.transactions, receiptDateFilter, receiptDateValue, receiptPromoFilter, todayKey])

  useEffect(() => {
    setReceiptsPage(0)
  }, [receiptDateFilter, receiptDateValue, receiptPromoFilter])

  const receiptsPageCount = Math.max(1, Math.ceil(recentTxns.length / PAGE_SIZE))
  const receiptsPageIndex = Math.min(receiptsPage, receiptsPageCount - 1)
  const recentTxnsPage = recentTxns.slice(
    receiptsPageIndex * PAGE_SIZE,
    receiptsPageIndex * PAGE_SIZE + PAGE_SIZE,
  )

  const dayEndPageCount = Math.max(1, Math.ceil((data.dayEnds || []).length / PAGE_SIZE))
  const dayEndPageIndex = Math.min(dayEndPage, dayEndPageCount - 1)
  const dayEndPageRows = (data.dayEnds || []).slice(
    dayEndPageIndex * PAGE_SIZE,
    dayEndPageIndex * PAGE_SIZE + PAGE_SIZE,
  )

  const productMovements = useMemo(() => {
    if (!selectedProduct) return []
    return (data.movements || []).filter((m) => m.productId === selectedProduct.id)
  }, [data.movements, selectedProduct])

  const pettyTimeline = useMemo(() => data.pettyTimeline || [], [data.pettyTimeline])
  const cashStats = useMemo(() => {
    return pettyTimeline.reduce(
      (acc, row) => {
        if (row.kind === 'change_fund') acc.changeFund += Number(row.amount || 0)
        else if (row.kind === 'pickup') acc.pickup += Number(row.amount || 0)
        // Only cash actually handed over has left the drawer. 'approved' is now an
        // intermediate state where the money is still in the till.
        else if (row.kind === 'paid_out' && row.status === 'fulfilled') {
          acc.paidOut += Number(row.amount || 0)
        } else if (row.kind === 'paid_out' && row.status === 'approved') {
          acc.approvedUnfulfilled += Number(row.amount || 0)
        }
        return acc
      },
      { changeFund: 0, pickup: 0, paidOut: 0, approvedUnfulfilled: 0 },
    )
  }, [pettyTimeline])

  const promoSalesToday = useMemo(() => {
    const byPromo = {}
    for (const txn of todayTx) {
      if (txn.status === 'Voided') continue
      if (!isPromoDiscountType(txn.discountType)) continue
      const name = discountSourceLabel(txn.discountType) || 'Promo'
      if (!byPromo[name]) {
        byPromo[name] = { name, receipts: 0, discount: 0, sales: 0 }
      }
      byPromo[name].receipts += 1
      byPromo[name].discount += Number(txn.discountAmount || 0)
      byPromo[name].sales += Number(txn.netTotal ?? txn.total ?? 0)
    }
    return Object.values(byPromo)
      .map((row) => ({
        ...row,
        discount: Number(row.discount.toFixed(2)),
        sales: Number(row.sales.toFixed(2)),
      }))
      .sort((a, b) => b.discount - a.discount)
  }, [todayTx])

  const invPages = Math.max(1, Math.ceil(data.products.length / PAGE_SIZE))
  const pageIndex = Math.min(invPage, invPages - 1)
  const invSlice = data.products.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)
  const restockEntry = !isRestaurant
    ? previousDayRestockReport(data.dayEnds || [], todayKey)
    : null

  // First load only — see the same note in manager/Overview.jsx. Changing period or
  // re-entering the page kept the data cached but still flashed a full skeleton over it.
  if (loading && !branch) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div>
      <PageHeader
        eyebrow={isRestaurant ? 'CARINDERIA' : 'BRANCH'}
        title={branch?.name || 'Branch'}
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SecondaryButton compact type="button" onClick={() => { setForm(branch); setEditing(true) }}>
            Branch settings
          </SecondaryButton>
          <Link to="/manager/branches" className="inline-flex h-10 items-center px-2 text-xs font-bold text-brand-slate no-underline">
            ← All branches
          </Link>
        </div>
      </PageHeader>
      {error && (
        <ErrorBanner error={error} onDismiss={() => setError('')} />
      )}

      <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3.5 max-[700px]:grid-cols-1">
        {(isRestaurant
          ? [
              ['Sales today', money(revenue), ''],
              // Refunds get their own card rather than a footnote under Sales: money going
              // back out is its own number, and a hint under another figure is not
              // something anyone scans for.
              ['Refunded today', money(refundedToday), refundCountToday
                ? `${refundCountToday} receipt${refundCountToday === 1 ? '' : 's'}`
                : ''],
              ['Orders today', todayTx.length, ''],
              ['Potahe on menu', menuOn.length, ''],
              ['Off today', menuOff.length, ''],
            ]
          : [
              ['Revenue today', money(revenue), ''],
              ['Refunded today', money(refundedToday), refundCountToday
                ? `${refundCountToday} receipt${refundCountToday === 1 ? '' : 's'}`
                : ''],
              ['Orders today', todayTx.length, ''],
              ['Low stock', low.length, ''],
              ['Reseko loss', money(shrink), ''],
            ]
        ).map(([label, value, hint]) => (
          <div
            key={label}
            className="rounded-[10px] bg-brand-dark p-4 text-white max-[700px]:flex max-[700px]:items-center max-[700px]:justify-between max-[700px]:p-3.5"
          >
            <span className="block text-[10px] tracking-wide text-white/60 uppercase">{label}</span>
            <strong className={`mt-2 block text-xl max-[700px]:mt-0 max-[700px]:text-lg ${moneyClass}`}>{value}</strong>
            {hint ? <span className="mt-1 block text-[10px] text-brand-warn-ondark">{hint}</span> : null}
          </div>
        ))}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <TableCard className="max-h-none overflow-hidden">
          <SectionHeading
            title="Recent receipts"
            meta={
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <select
                  className="h-7 rounded border border-brand-line bg-white px-1.5 text-[10px] font-medium text-brand-ink"
                  value={receiptDateFilter}
                  onChange={(e) => setReceiptDateFilter(e.target.value)}
                  title="Filter by date"
                >
                  <option value="all">All dates</option>
                  <option value="today">Today</option>
                  <option value="date">Pick date</option>
                </select>
                {receiptDateFilter === 'date' && (
                  <input
                    type="date"
                    className="h-7 rounded border border-brand-line bg-white px-1.5 text-[10px] font-medium text-brand-ink"
                    value={receiptDateValue}
                    onChange={(e) => setReceiptDateValue(e.target.value)}
                  />
                )}
                <select
                  className="h-7 rounded border border-brand-line bg-white px-1.5 text-[10px] font-medium text-brand-ink"
                  value={receiptPromoFilter}
                  onChange={(e) => setReceiptPromoFilter(e.target.value)}
                  title="Filter by discount"
                >
                  <option value="all">All discounts</option>
                  {receiptPromoNames.map((name) => (
                    <option key={name} value={name}>
                      Promo · {discountSourceLabel(name)}
                    </option>
                  ))}
                  <option value="pwd">PWD / Senior</option>
                  <option value="none">No discount</option>
                </select>
                <span className="pl-1 text-[11px] font-semibold whitespace-nowrap text-brand-muted">
                  {recentTxns.length} of {data.transactions.length}
                </span>
              </div>
            }
          />
          <div className="grid grid-cols-[0.9fr_1.1fr_1fr_0.7fr_0.7fr] gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[900px]:grid-cols-[1fr_0.8fr_0.7fr]">
            <span>Date</span>
            <span>Order</span>
            <span className="max-[900px]:hidden">Cashier</span>
            <span>Total</span>
            <span>Status</span>
          </div>
          {recentTxnsPage.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              className={`tap-row grid cursor-pointer grid-cols-[0.9fr_1.1fr_1fr_0.7fr_0.7fr] gap-2 text-xs max-[900px]:grid-cols-[1fr_0.8fr_0.7fr] ${tableRowDenseClass}`}
              onClick={() => openTxnDetail(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') openTxnDetail(item)
              }}
            >
              <span className="self-center text-[11px] text-brand-slate">{item.time || item.date || '—'}</span>
              {/* Tags sit inline on one line rather than stacking under the OR number —
                  three stacked blocks made every discounted row three times taller and
                  turned the list into a wall. Full detail is still in the row's modal. */}
              <span className="flex min-w-0 items-center gap-1.5 self-center">
                <strong className="truncate text-brand-ink">
                  {item.orNumber || item.id.slice(0, 8)}
                </strong>
                {Number(item.discountAmount || 0) > 0 && (
                  <span
                    className={`shrink-0 rounded-[3px] px-1 py-px text-[9px] font-bold ${
                      isPromoDiscountType(item.discountType)
                        ? 'bg-brand-danger-bg text-brand-danger'
                        : 'bg-brand-warn-bg text-brand-warn'
                    }`}
                    title={discountSourceLabel(item.discountType) || 'Discount'}
                  >
                    {isPromoDiscountType(item.discountType) ? 'PROMO' : 'DISC'}
                  </span>
                )}
                {Number(item.vatExemptSales || 0) > 0 && (
                  <span
                    className="shrink-0 rounded-[3px] bg-brand-success-bg px-1 py-px text-[9px] font-bold text-brand-success-text"
                    title="VAT-exempt (SC/PWD)"
                  >
                    EX
                  </span>
                )}
              </span>
              {/* Voided/refunded receipts name their approver right here — the question
                  "who authorised this" should not need the detail modal to answer. */}
              <span className="min-w-0 self-center max-[900px]:hidden">
                <span className="block truncate">{item.cashier}</span>
                {approverLabel(item.voidApprovedByName, item.voidApprovedByRole) && (
                  <span className="block truncate text-[10px] text-brand-subtle">
                    Appr: {approverLabel(item.voidApprovedByName, item.voidApprovedByRole)}
                  </span>
                )}
              </span>
              {/* Original total, then the refund as its own labelled figure — never a
                  single already-netted number sitting next to a minus sign. */}
              <span className={`self-center ${moneyClass}`}>
                {money(item.total)}
                {Number(item.refundedAmount || 0) > 0 && item.status !== 'Voided' && (
                  <span className="block text-[10px] text-brand-danger">
                    Refunded {money(item.refundedAmount)}
                  </span>
                )}
              </span>
              <StatusBadge compact tone={statusToneFromTxn(item)} className="justify-self-start self-center">
                {statusLabelFromTxn(item)}
              </StatusBadge>
            </div>
          ))}
          {recentTxns.length === 0 && (
            <div className="px-4 py-6 text-xs text-brand-subtle">
              {data.transactions.length === 0 ? 'No transactions yet.' : 'No receipts match these filters.'}
            </div>
          )}
          {receiptsPageCount > 1 && (
            <Pager
              page={receiptsPageIndex + 1}
              pageCount={receiptsPageCount}
              total={recentTxns.length}
              label="receipts"
              onPrev={() => setReceiptsPage((p) => Math.max(0, p - 1))}
              onNext={() => setReceiptsPage((p) => Math.min(receiptsPageCount - 1, p + 1))}
            />
          )}
        </TableCard>

        <TableCard className="max-h-none overflow-hidden">
          <SectionHeading title="Day-end closings" meta={`${(data.dayEnds || []).length} recorded`} />
          {submittedToday && (
            <div className="mx-4 my-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-brand-warn-bg px-3 py-2.5 text-xs text-brand-warn">
              <span>
                Business day {todayKey} submitted — awaiting approval. POS sales locked until approved.
              </span>
              {canApprove && (
                <PrimaryButton
                  compact
                  type="button"
                  disabled={approving === todayEntry.id}
                  onClick={() => handleApprove(todayEntry)}
                >
                  {approving === todayEntry.id ? 'Approving…' : 'Approve & close'}
                </PrimaryButton>
              )}
            </div>
          )}
          {closedToday && (
            <div className="mx-4 my-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-brand-warn-bg px-3 py-2.5 text-xs text-brand-warn">
              <span>Business day {todayKey} is closed — POS sales locked for this branch.</span>
              <PrimaryButton
                compact
                type="button"
                disabled={reopening === todayEntry.id}
                onClick={() => {
                  setReopenTarget(todayEntry)
                  setReopenReason('')
                }}
              >
                Reopen till
              </PrimaryButton>
            </div>
          )}
          <div className="grid grid-cols-[minmax(0,1.3fr)_5.5rem_5.5rem_5.5rem_4.5rem_minmax(0,1fr)_4.25rem] items-center gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[900px]:grid-cols-[minmax(0,1fr)_5rem_4.25rem]">
            <span>Date</span>
            <span className="text-right max-[900px]:hidden">Expected</span>
            <span className="text-right max-[900px]:hidden">Counted</span>
            <span className="text-right">Variance</span>
            <span className="max-[900px]:hidden">Status</span>
            <span className="max-[900px]:hidden">Note</span>
            <span className="text-right">Action</span>
          </div>
          {dayEndPageRows.map((entry) => (
            <div
              key={entry.id}
              className={`grid grid-cols-[minmax(0,1.3fr)_5.5rem_5.5rem_5.5rem_4.5rem_minmax(0,1fr)_4.25rem] items-center gap-2 text-xs max-[900px]:grid-cols-[minmax(0,1fr)_5rem_4.25rem] ${tableRowDenseClass}`}
            >
              <div className="min-w-0">
                <strong className="block truncate text-brand-ink">{entry.date}</strong>
                <small className="block truncate text-[10px] text-brand-subtle">
                  {entry.closedAt || '—'}
                  {entry.cashier ? ` · ${entry.cashier}` : ''}
                </small>
                <small className="mt-0.5 hidden text-[10px] text-brand-subtle max-[900px]:block">
                  Exp {money(entry.recordedCash)} · Cnt {money(entry.cashOnHand)}
                  {entry.status ? ` · ${entry.status}` : ''}
                </small>
              </div>
              <span className={`text-right max-[900px]:hidden ${moneyClass}`}>{money(entry.recordedCash)}</span>
              <span className={`text-right max-[900px]:hidden ${moneyClass}`}>{money(entry.cashOnHand)}</span>
              <span className={`text-right font-bold ${moneyClass} ${varianceToneClass(entry.variance)}`}>
                {money(entry.variance)}
              </span>
              <span className="capitalize max-[900px]:hidden">{entry.status || 'closed'}</span>
              <span className="truncate text-brand-slate max-[900px]:hidden" title={entry.note || ''}>
                {entry.note || '—'}
              </span>
              <span className="text-right">
                {entry.status === 'submitted' && canApprove ? (
                  <button
                    type="button"
                    className="border-0 bg-transparent text-[11px] font-bold whitespace-nowrap text-brand-ink underline disabled:opacity-40"
                    disabled={approving === entry.id}
                    onClick={() => handleApprove(entry)}
                  >
                    {approving === entry.id ? '…' : 'Approve'}
                  </button>
                ) : entry.status === 'closed' && entry.date === todayKey ? (
                  /* Reopen is only ever offered for the CURRENT business day. Once a new
                     business day has started, a past closing is permanently locked — no
                     role, no override. Reopening a passed day would let cash figures move
                     under a Z-reading that has already been filed. */
                  <button
                    type="button"
                    className="border-0 bg-transparent text-[11px] font-bold whitespace-nowrap text-brand-ink underline disabled:opacity-40"
                    disabled={reopening === entry.id}
                    onClick={() => {
                      setReopenTarget(entry)
                      setReopenReason('')
                    }}
                  >
                    Reopen
                  </button>
                ) : entry.status === 'closed' ? (
                  <span className="text-[11px] text-brand-subtle" title="Closed days stay locked once a new business day starts">
                    Locked
                  </span>
                ) : (
                  <span className="text-brand-subtle">—</span>
                )}
              </span>
            </div>
          ))}
          {(data.dayEnds || []).length === 0 && (
            <div className="px-4 py-6 text-xs text-brand-subtle">No day-end closings yet.</div>
          )}
          {dayEndPageCount > 1 && (
            <Pager
              page={dayEndPageIndex + 1}
              pageCount={dayEndPageCount}
              total={(data.dayEnds || []).length}
              label="closings"
              onPrev={() => setDayEndPage((p) => Math.max(0, p - 1))}
              onNext={() => setDayEndPage((p) => Math.min(dayEndPageCount - 1, p + 1))}
            />
          )}
        </TableCard>
      </div>

      <TableCard className="mb-4 max-h-none overflow-hidden">
        <SectionHeading
          title="Promo sales today"
          meta={promoSalesToday.length ? `${promoSalesToday.length} promo(s)` : 'None yet'}
          subtitle={`Discounted receipts on ${todayKey} — receipts, discount given, and net sales`}
        />
        <div className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr] gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase">
          <span>Promo</span>
          <span className="text-right">Receipts</span>
          <span className="text-right">Discount</span>
          <span className="text-right">Sales</span>
        </div>
        {promoSalesToday.map((row) => (
          <div
            key={row.name}
            className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr] gap-2 border-t border-brand-softline px-4 py-2.5 text-xs"
          >
            <strong className="truncate text-brand-danger">{row.name}</strong>
            <span className="text-right tabular-nums">{row.receipts}</span>
            <span className="text-right tabular-nums text-brand-danger">−{money(row.discount)}</span>
            <span className="text-right tabular-nums">{money(row.sales)}</span>
          </div>
        ))}
        {promoSalesToday.length === 0 && (
          <div className="px-4 py-6 text-xs text-brand-subtle">
            No promo-tagged sales yet today. Promo name is saved on each discounted receipt.
          </div>
        )}
      </TableCard>

      {isRestaurant && plateMix.byCategory.length > 0 && (
        <TableCard className="mb-4 max-h-none overflow-hidden">
          <SectionHeading
            title="Plate mix today"
            subtitle="Sales by menu category (meat, veggie, pancit, etc.)"
          />
          <div className="grid grid-cols-[1.4fr_1fr] gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase">
            <span>Category</span>
            <span className="text-right">Sales</span>
          </div>
          {plateMix.byCategory.map((row) => (
            <div key={row.category} className="grid grid-cols-[1.4fr_1fr] gap-2 border-t border-brand-softline px-4 py-2.5 text-xs">
              <strong className="text-brand-ink">{row.category}</strong>
              <span className="text-right tabular-nums text-brand-gold">{money(row.value)}</span>
            </div>
          ))}
          {plateMix.byCombo.length > 0 && (
            <div className="border-t border-brand-softline px-4 py-3">
              <p className="m-0 mb-2 text-[11px] font-bold text-brand-subtle">2-ulam combos (count)</p>
              <div className="flex flex-wrap gap-2">
                {plateMix.byCombo.map((row) => (
                  <span
                    key={row.label}
                    className="rounded border border-brand-border bg-white px-2 py-1 text-[11px] text-brand-ink"
                  >
                    {row.label}: <strong>{row.count}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
        </TableCard>
      )}

      <TableCard className="mb-4 max-h-none overflow-hidden">
        <SectionHeading
          title="Cash drawer log"
          subtitle={`Change fund, cash pickups, and petty paid-outs · ${todayKey}`}
        />
        <div className="grid grid-cols-3 gap-2 border-b border-brand-line bg-white px-4 py-3 text-xs max-[700px]:grid-cols-1">
          <div>
            <span className="block text-[10px] font-bold uppercase tracking-[1px] text-brand-label">Change fund</span>
            <strong className="text-brand-ink">{money(cashStats.changeFund)}</strong>
          </div>
          <div>
            <span className="block text-[10px] font-bold uppercase tracking-[1px] text-brand-label">Cash pickups</span>
            <strong className="text-brand-ink">{money(cashStats.pickup)}</strong>
          </div>
          <div>
            <span className="block text-[10px] font-bold uppercase tracking-[1px] text-brand-label">Paid-out</span>
            <strong className="text-brand-ink">{money(cashStats.paidOut)}</strong>
          </div>
        </div>
        <div className="grid grid-cols-[0.9fr_0.9fr_0.9fr_1fr_1.2fr_1.1fr] gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[900px]:grid-cols-[0.9fr_0.9fr_1fr]">
          <span>Time</span>
          <span>Type</span>
          <span className="text-right">Amount</span>
          <span className="max-[900px]:hidden">Cashier</span>
          <span className="max-[900px]:hidden">Note</span>
          <span className="max-[900px]:hidden">Action</span>
        </div>
        {pettyTimeline.map((row) => (
          <div
            key={row.id}
            className="grid grid-cols-[0.9fr_0.9fr_0.9fr_1fr_1.2fr_1.1fr] gap-2 border-t border-brand-softline px-4 py-2.5 text-xs max-[900px]:grid-cols-[0.9fr_0.9fr_1fr]"
          >
            <span className="text-brand-slate">
              {row.createdAt ? new Date(row.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
            </span>
            <strong className="capitalize text-brand-ink">
              {row.kind === 'change_fund'
                ? 'Change fund'
                : row.kind === 'pickup'
                  ? 'Cash pickup'
                  : row.status === 'pending'
                    ? 'Petty (pending)'
                    : row.status === 'rejected'
                      ? 'Petty (rejected)'
                      : row.status === 'approved'
                        ? 'Petty (approved, not handed over)'
                        : 'Paid-out'}
            </strong>
            <span className="text-right tabular-nums">{money(row.amount)}</span>
            <span className="truncate max-[900px]:hidden">{row.staffName}</span>
            <span className="truncate text-brand-slate max-[900px]:hidden" title={row.reason || ''}>
              {row.reason || '—'}
              {row.receiptRef ? ` · ${row.receiptRef}` : ''}
            </span>
            <span className="max-[900px]:col-span-full">
              {row.kind === 'paid_out' && row.status === 'pending' && isSupervisorOrAbove(user?.role) ? (
                <span className="flex flex-wrap gap-1.5">
                  <SecondaryButton
                    compact
                    type="button"
                    disabled={pettyBusyId === row.id}
                    onClick={async () => {
                      try {
                        setPettyBusyId(row.id)
                        setError('')
                        await rejectPettyCash({ id: row.id, approvedBy: user.id })
                        await reload()
                      } catch (err) {
                        setError(formatSupportError(err, 'PETTY02'))
                      } finally {
                        setPettyBusyId(null)
                      }
                    }}
                  >
                    Reject
                  </SecondaryButton>
                  <PrimaryButton
                    compact
                    type="button"
                    disabled={pettyBusyId === row.id}
                    onClick={async () => {
                      try {
                        setPettyBusyId(row.id)
                        setError('')
                        await approvePettyCash({ id: row.id, approvedBy: user.id })
                        await reload()
                      } catch (err) {
                        setError(formatSupportError(err, 'PETTY02'))
                      } finally {
                        setPettyBusyId(null)
                      }
                    }}
                  >
                    Approve
                  </PrimaryButton>
                </span>
              ) : row.kind === 'paid_out' && row.status === 'approved' ? (
                /* Fulfilment is not role-gated — whoever is on site hands the cash over,
                   including the cashier who raised it. The approval already happened. */
                <PrimaryButton
                  compact
                  type="button"
                  disabled={pettyBusyId === row.id}
                  title="Confirm the cash has physically left the drawer"
                  onClick={async () => {
                    try {
                      setPettyBusyId(row.id)
                      setError('')
                      await fulfillPettyCash({ id: row.id, confirmedBy: user.id })
                      await reload()
                    } catch (err) {
                      setError(formatSupportError(err, 'PETTY03'))
                    } finally {
                      setPettyBusyId(null)
                    }
                  }}
                >
                  Mark handed over
                </PrimaryButton>
              ) : (
                <span className="text-brand-subtle max-[900px]:hidden">—</span>
              )}
            </span>
          </div>
        ))}
        {pettyTimeline.length === 0 && (
          <div className="px-4 py-6 text-xs text-brand-subtle">
            No cash accountability entries recorded for this business day yet.
          </div>
        )}
      </TableCard>

      <TableCard className="mb-4 max-h-none overflow-hidden">
        <SectionHeading
          title="Staff"
          subtitle={`Clock-in / out hours · last ${STAFF_LOG_DAYS} days`}
          meta={`${staffRoster.length} on the log`}
        />
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_5rem_5.5rem_minmax(0,1fr)] items-center gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[900px]:grid-cols-[minmax(0,1fr)_5.5rem]">
          <span>Name</span>
          <span className="max-[900px]:hidden">Role</span>
          <span className="text-right max-[900px]:hidden">Shifts</span>
          <span className="text-right">Hours</span>
          <span className="max-[900px]:hidden">Last in / out</span>
        </div>
        {staffRoster.map((row) => (
          <div
            key={row.key}
            className={`grid grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_5rem_5.5rem_minmax(0,1fr)] items-center gap-2 text-xs max-[900px]:grid-cols-[minmax(0,1fr)_5.5rem] ${tableRowDenseClass}`}
          >
            <div className="min-w-0">
              <strong className="block truncate text-brand-ink">{row.name}</strong>
              <small className="block truncate text-[10px] text-brand-subtle capitalize max-[900px]:block">
                {row.role || '—'}
                {row.openNow ? ' · on shift now' : ''}
              </small>
            </div>
            <span className="truncate capitalize max-[900px]:hidden">{row.role || '—'}</span>
            <span className="text-right tabular-nums max-[900px]:hidden">{row.sessions}</span>
            <strong className="text-right tabular-nums text-brand-ink">{hoursLabel(row.totalMs)}</strong>
            <span className="truncate text-brand-slate max-[900px]:hidden">
              {row.lastIn ? new Date(row.lastIn).toLocaleString() : '—'}
              {row.lastOut ? ` → ${new Date(row.lastOut).toLocaleTimeString()}` : row.openNow ? ' → open' : ''}
            </span>
          </div>
        ))}
        {staffRoster.length === 0 && (
          <div className="px-4 py-6 text-xs text-brand-subtle">
            No clock-in records for this branch in the last {STAFF_LOG_DAYS} days.
          </div>
        )}
      </TableCard>

      {restockEntry && (
        <DayEndReportPanels
          report={restockEntry.dayReport}
          title="Sold"
          showRestock
          compact
          alert
          fromDate={restockEntry.date}
          inventoryHref={null}
        />
      )}

      <TableCard className="mb-4 max-h-none overflow-hidden">
        <SectionHeading
          title={isRestaurant ? "Today's menu / potahe" : 'Inventory'}
          meta={`${data.products.length} ${isRestaurant ? 'items' : 'SKUs'}`}
        />
        <div
          className={`grid gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase ${
            isRestaurant ? 'grid-cols-[2.5rem_1.6fr_1fr_0.7fr_0.7fr]' : 'grid-cols-[2.5rem_1.6fr_0.7fr_0.6fr_0.5fr]'
          }`}
        >
          <span>#</span>
          <span>{isRestaurant ? 'Potahe' : 'Product'}</span>
          <span>{isRestaurant ? 'Plate' : 'SKU'}</span>
          <span>{isRestaurant ? 'Price' : 'On hand'}</span>
          <span>{isRestaurant ? 'Today' : 'Status'}</span>
        </div>
        {invSlice.map((product, index) => (
          <div
            key={product.id}
            role={isRestaurant ? undefined : 'button'}
            tabIndex={isRestaurant ? undefined : 0}
            className={`grid gap-2 text-xs ${tableRowDenseClass} ${
              isRestaurant
                ? 'grid-cols-[2.5rem_1.6fr_1fr_0.7fr_0.7fr]'
                : 'tap-row cursor-pointer grid-cols-[2.5rem_1.6fr_0.7fr_0.6fr_0.5fr]'
            }`}
            onClick={isRestaurant ? undefined : () => setSelectedProduct(product)}
            onKeyDown={
              isRestaurant
                ? undefined
                : (event) => {
                    if (event.key === 'Enter' || event.key === ' ') setSelectedProduct(product)
                  }
            }
          >
            <span className={`${moneyClass} text-brand-subtle`}>{pageIndex * PAGE_SIZE + index + 1}</span>
            <strong className="truncate text-brand-ink">{product.name}</strong>
            <span className="truncate text-brand-subtle">
              {isRestaurant ? product.category : product.sku}
            </span>
            {isRestaurant ? (
              <>
                <span className={moneyClass}>{money(product.price)}</span>
                <span className={product.availableToday !== false ? 'text-brand-success' : 'text-brand-muted'}>
                  {product.availableToday !== false ? 'On' : 'Off'}
                </span>
              </>
            ) : (
              <>
                <span className={moneyClass}>{qty(product.stock, product.pricingMode === 'kg' ? 'kg' : 'pc')}</span>
                <span className={product.stock <= Number(product.lowStockAt ?? 5) ? 'text-brand-danger' : 'text-brand-success'}>
                  {product.stock <= Number(product.lowStockAt ?? 5) ? 'Low' : 'OK'}
                </span>
              </>
            )}
          </div>
        ))}
        {data.products.length === 0 && (
          <div className="px-4 py-6 text-xs text-brand-subtle">
            {isRestaurant
              ? 'No menu items yet. Add or import potahe from Data.'
              : 'No inventory rows yet.'}
          </div>
        )}
        {invPages > 1 && (
          <Pager
            page={pageIndex + 1}
            pageCount={invPages}
            total={data.products.length}
            label={isRestaurant ? 'items' : 'SKUs'}
            onPrev={() => setInvPage((p) => Math.max(0, p - 1))}
            onNext={() => setInvPage((p) => Math.min(invPages - 1, p + 1))}
          />
        )}
      </TableCard>

      {editing && form && (
        <div className="fixed inset-0 z-[5] grid place-items-center bg-brand-scrim">
          <form
            className="w-[min(420px,calc(100%-32px))] rounded-[10px] bg-white p-6"
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                const saved = await saveBranch(form)
                setEditing(false)
                setBranch(saved)
                if (user?.branchId === saved.id) {
                  useAuthStore.setState({
                    user: { ...user, dayOpenHour: Number(saved.day_open_hour ?? 7) },
                  })
                }
                await reload()
              } catch (err) {
                setError(err.message)
              }
            }}
          >
            <h2 className="mb-4 text-lg">Branch settings</h2>
            <div className="grid max-h-[70vh] gap-3 overflow-auto pr-1">
              <Field label="Branch name" required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Field label="Business name (receipt)" value={form.business_name || ''} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
              <Field label="Address" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              {/* Two-level TIN: the business has one TIN, each branch has a BIR branch
                  code appended to it. The main TIN is edited once on Branches, not here,
                  so two branches cannot end up claiming different company TINs. */}
              <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
                <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                  Main company TIN
                </span>
                <strong className="block text-sm text-brand-ink">
                  {branch?.company_tin || 'Not set'}
                </strong>
                <span className="mt-0.5 block text-[10px] text-brand-subtle">
                  {branch?.company_tin
                    ? 'Shared by every branch. Change it on Manager → Branches.'
                    : 'Set it on Manager → Branches. Until then this branch prints its own TIN below.'}
                </span>
              </div>
              <Field
                label="Branch TIN code (BIR branch code)"
                value={form.branch_tin_code ?? ''}
                onChange={(e) =>
                  setForm({ ...form, branch_tin_code: e.target.value.replace(/\D/g, '').slice(0, 5) })
                }
                inputMode="numeric"
                placeholder="00000 for head office, 00001 for the first branch"
              />
              <p className="-mt-1 text-[11px] text-brand-muted">
                Prints on the invoice as{' '}
                <strong className="text-brand-ink">
                  {branch?.company_tin
                    ? `${branch.company_tin}-${(form.branch_tin_code || '00000').padStart(5, '0')}`
                    : form.tin || '—'}
                </strong>
              </p>
              <Field
                label="Branch TIN override (only if this branch is registered separately)"
                value={form.tin || ''}
                onChange={(e) => setForm({ ...form, tin: e.target.value })}
              />
              <Field label="BIR permit no." value={form.bir_permit_no || ''} onChange={(e) => setForm({ ...form, bir_permit_no: e.target.value })} />
              <Field label="Machine ID (MIN)" value={form.machine_identification_no || ''} onChange={(e) => setForm({ ...form, machine_identification_no: e.target.value })} />
              <Field label="Serial number" value={form.serial_number || ''} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} />
              <Field label="OR prefix" value={form.or_prefix || 'OR'} onChange={(e) => setForm({ ...form, or_prefix: e.target.value })} />
              <label className="grid gap-1.5 text-xs font-bold text-brand-n700">
                Day opens at
                <select
                  className="h-10 rounded-md border border-brand-line bg-white px-3 text-sm font-medium text-brand-ink"
                  value={form.day_open_hour ?? 7}
                  onChange={(e) => setForm({ ...form, day_open_hour: Number(e.target.value) })}
                >
                  {Array.from({ length: 12 }, (_, i) => i + 4).map((hour) => (
                    <option key={hour} value={hour}>
                      {formatOpenHourLabel(hour)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-[11px] text-brand-muted">
                After day end, POS stays locked until a manager reopens, or until this time starts the next
                business day (Asia/Manila).
              </p>
              <label className="flex items-center gap-2 text-xs font-bold text-brand-n700">
                <input
                  type="checkbox"
                  checked={form.is_active !== false}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                Branch active
              </label>
              <p className="text-[11px] text-brand-muted">Inactive branches stay in history but are hidden from normal operations.</p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <SecondaryButton compact type="button" onClick={() => setEditing(false)}>Cancel</SecondaryButton>
              <PrimaryButton compact type="submit">Save settings</PrimaryButton>
            </div>
          </form>
        </div>
      )}

      <TableCard className="mb-4 max-h-none overflow-hidden">
        <SectionHeading
          title="Branch devices"
          subtitle="Manager switches control whether each device is enabled for this branch."
        />
        <div className="grid grid-cols-3 gap-0 border-t border-brand-softline max-[700px]:grid-cols-1">
          {BRANCH_DEVICES.map((device) => {
            const telemetryRow = (telemetry.devices || []).find((row) => row.key === device.key)
            const enabled = deviceSettings[device.key] === true
            const connected = enabled && telemetryRow?.state === 'connected'
            return (
              <div
                key={device.key}
                className="border-t border-brand-softline px-4 py-3 max-[700px]:border-t min-[701px]:border-t-0 min-[701px]:border-l min-[701px]:first:border-l-0"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <strong className="block text-xs text-brand-ink">{device.label}</strong>
                    <span className="mt-0.5 block text-[10px] text-brand-subtle">{device.hint}</span>
                    <span
                      className={`mt-1 inline-block text-[11px] font-bold ${
                        !enabled
                          ? 'text-brand-muted'
                          : connected
                            ? 'text-brand-success-text'
                            : 'text-brand-muted'
                      }`}
                    >
                      {!enabled
                        ? 'Disabled by manager'
                        : connected
                          ? 'Enabled by manager · Connected'
                          : 'Enabled by manager · Not connected'}
                    </span>
                  </div>
                  <ToggleSwitch
                    checked={enabled}
                    disabled={Boolean(deviceBusy)}
                    busy={deviceBusy === device.key}
                    onChange={(on) => toggleDevice(device.key, on)}
                    label={device.label}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </TableCard>

      {(detail || loadingDetail) && (
        <TransactionDetailModal
          detail={detail}
          loading={loadingDetail}
          refundSummary={refundSummary}
          onClose={() => {
            setDetail(null)
            setRefundSummary(null)
          }}
        />
      )}

      {selectedProduct && !isRestaurant && (
        <div className="fixed inset-0 z-[5] bg-[#20242666]" onClick={() => setSelectedProduct(null)}>
          <aside
            className="absolute top-0 right-0 h-full w-[min(520px,92vw)] overflow-auto bg-white p-7 shadow-[-8px_0_24px_#20242622]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="absolute top-[17px] right-[17px] border-0 bg-transparent text-lg text-brand-n700"
              onClick={() => setSelectedProduct(null)}
            >
              <FiX />
            </button>
            <Eyebrow>PRODUCT HISTORY</Eyebrow>
            <h2 className="m-0 mb-1 text-lg capitalize">{selectedProduct.name}</h2>
            {!isRestaurant && typeof selectedProduct.discountEligible === 'boolean' && (
              <p className="m-0 mb-2 text-[11px] text-brand-subtle">
                Discountable: {selectedProduct.discountEligible ? 'Yes' : 'No'}
              </p>
            )}
            <p className="m-0 text-xs text-brand-muted">
              {selectedProduct.sku}
              {selectedProduct.barcode ? ` - ${selectedProduct.barcode}` : ''} -{' '}
              {selectedProduct.category || '—'}
            </p>

            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-md bg-brand-n100 px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">On hand</span>
                <strong className="text-sm text-brand-ink">
                  {qty(selectedProduct.stock, selectedProduct.pricingMode === 'kg' ? 'kg' : 'pc')}
                </strong>
              </div>
              <div className="rounded-md bg-brand-n100 px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">Price</span>
                <strong className="text-sm text-brand-gold">{money(selectedProduct.price)}</strong>
              </div>
              <div className="rounded-md bg-brand-n100 px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">Status</span>
                <strong
                  className={`text-sm ${
                    selectedProduct.stock <= Number(selectedProduct.lowStockAt ?? 5)
                      ? 'text-brand-danger'
                      : 'text-brand-success'
                  }`}
                >
                  {selectedProduct.stock <= Number(selectedProduct.lowStockAt ?? 5) ? 'Low' : 'OK'}
                </strong>
              </div>
            </div>

            <h3 className="mt-6 mb-2.5 text-sm">Movement history</h3>
            <div className="rounded-none border border-brand-sheet">
              <div className="grid grid-cols-[1.2fr_0.9fr_1.4fr_1fr] gap-1.5 bg-brand-sheet-head p-2 text-[11px] font-bold">
                <span>Type</span>
                <span>Date</span>
                <span>Change</span>
                <span className="text-right tabular-nums">Balance</span>
              </div>
              {productMovements.length === 0 ? (
                <div className="border-t border-brand-sheet-line p-2 text-[11px] text-brand-subtle">
                  No movements yet.
                </div>
              ) : (
                productMovements.map((movement, index) => {
                  const isPrice =
                    movement.movementType === 'price_change' || movement.type === 'Price change'
                  const unit = selectedProduct.pricingMode === 'kg' ? 'kg' : 'pc'
                  return (
                    <div
                      key={movement.id}
                      className={`grid grid-cols-[1.2fr_0.9fr_1.4fr_1fr] gap-1.5 border-t border-brand-sheet-line p-2 text-[11px] ${
                        index % 2 === 0 ? 'bg-white' : 'bg-brand-sheet-alt'
                      }`}
                    >
                      <span className={isPrice ? 'font-bold text-brand-ink' : ''}>{movement.type}</span>
                      <span>{movement.date}</span>
                      <span className="tabular-nums">
                        {isPrice
                          ? `${money(movement.oldPrice)} \u2192 ${money(movement.newPrice)}`
                          : movement.quantityChange > 0
                            ? `+${qty(movement.quantityChange, unit)}`
                            : movement.quantityChange < 0
                              ? `−${qty(Math.abs(movement.quantityChange), unit)}`
                              : '—'}
                      </span>
                      <strong
                        className={`text-right tabular-nums ${
                          !isPrice && movement.resultingStock < 0 ? 'text-brand-danger' : ''
                        }`}
                      >
                        {isPrice ? '—' : qty(movement.resultingStock, unit)}
                      </strong>
                    </div>
                  )
                })
              )}
            </div>
            <p className="mt-4 text-[11px] text-brand-subtle">View only — edit stock or prices from cashier / Data tools.</p>
          </aside>
        </div>
      )}
      {reopenTarget && (
        <Modal wide onClose={() => setReopenTarget(null)}>
          <Eyebrow>REOPEN TILL</Eyebrow>
          <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Reopen {reopenTarget.date}?</h2>
          <p className="mb-3 text-xs text-brand-muted">
            POS sales will unlock for this business day. A reason is required and will be logged.
          </p>
          <Field
            label="Why reopen?"
            value={reopenReason}
            onChange={(e) => setReopenReason(e.target.value.replace(/[<>]/g, ''))}
            placeholder="e.g. missed transaction, count correction"
          />
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setReopenTarget(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={!reopenReason.trim() || reopening === reopenTarget.id}
              onClick={handleReopen}
            >
              {reopening === reopenTarget.id ? 'Reopening…' : 'Reopen till'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default ManagerBranchDashboard
