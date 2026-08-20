import { useEffect, useMemo, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import TransactionDetailModal from '../components/transactions/TransactionDetailModal'
import SupervisorApprove from '../components/shared/SupervisorApprove'
import {
  Eyebrow,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  Pager,
  PrimaryButton,
  SearchBox,
  SecondaryButton,
  SkeletonRows,
  StatusBadge,
  TableCard,
  moneyClass,
  statusLabelFromTxn,
  statusToneFromTxn,
  tableRowClass,
} from '../components/ui'
import {
  cancelRefundRequest,
  dismissPendingRefundRequestsForTransaction,
  fetchBranchFiscalHeader,
  fetchRefundRequestById,
  fetchRefundSummary,
  fetchTransactionDetail,
  hasSupabase,
  requestRefundApproval,
} from '../lib/api'
import { isDeviceEnabled, receiptPrinter } from '../devices'
import { getLocalTransactionDetail, readBranchSnapshot } from '../offline'
import { branchOperationsTopic, subscribeBroadcast } from '../offline/realtime'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { useSyncStore } from '../stores/syncStore'
import { appError, formatSupportError } from '../utils/errors'
import { isBusinessDayLocked, money, qty, rowBusinessDate, today } from '../utils/format'
import { buildReceipt } from '../utils/receipt'
import { isSupervisorOrAbove } from '../utils/roles'
import { discountSourceLabel, isPromoDiscountType } from '../utils/promo'
import { detailFromLocalTxn, isUuid } from '../utils/transactionDetail'

function txnSortTime(item) {
  if (item.createdAt) {
    const t = new Date(item.createdAt).getTime()
    if (!Number.isNaN(t)) return t
  }
  if (item.date) {
    const t = new Date(`${item.date}T12:00:00`).getTime()
    if (!Number.isNaN(t)) return t
  }
  return 0
}

const PAY_LABEL = { cash: 'Cash', card: 'Card', ewallet: 'E-wallet' }

/**
 * Column template for the transaction list. Declared once because the header row and the
 * body rows must not drift apart — when they were written out twice, adding a column meant
 * editing two strings and the headers silently stopped lining up with the data.
 *
 * Every track is `minmax(0, …)`, not a bare `Nfr`. A bare `1fr` means `minmax(auto, 1fr)`,
 * so a track never shrinks below its content: one long promo name or cashier name widened
 * that ROW's columns only — the header is a separate grid and kept its own widths, so the
 * labels sat over the wrong data and the whole table looked misaligned. With a 0 minimum
 * the proportions are identical in every row, and long values truncate instead of pushing.
 *
 * Promo is also narrower than it was. It had the widest track in the table while carrying
 * a short name, which pushed Total and Status into the cramped right-hand edge.
 */
const TXN_GRID =
  'grid-cols-[minmax(0,1.1fr)_minmax(0,0.6fr)_minmax(0,0.9fr)_minmax(0,0.75fr)_minmax(0,0.7fr)_minmax(0,0.55fr)_minmax(0,0.4fr)_minmax(0,0.85fr)_minmax(0,0.7fr)_minmax(0,0.55fr)]'
const TXN_GRID_NARROW = 'max-[700px]:grid-cols-[minmax(0,1.3fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]'

/** What kind of discount this was, for the compact/mobile summary and tooltips. */
function discountLabelFor(item) {
  if (isPromoDiscountType(item.discountType)) {
    return `Promo · ${discountSourceLabel(item.discountType) || 'Promo'}`
  }
  return discountSourceLabel(item.discountType) || 'Discount'
}
const PAGE_SIZE = 10
const REFUND_REASONS = ['Wrong item', 'Customer changed mind', 'Damaged', 'Other']

const filterSelectClass =
  'h-10 rounded-md border border-brand-line bg-brand-card px-3 text-xs font-medium text-brand-ink'

function Transactions() {
  const transactions = useInventoryStore((state) => state.transactions)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const voidTransaction = useInventoryStore((state) => state.voidTransaction)
  const refundTransactionItems = useInventoryStore((state) => state.refundTransactionItems)
  const user = useAuthStore((state) => state.user)
  const online = useSyncStore((state) => state.online)
  const refundOffline = hasSupabase && !online
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState('today')
  const [dateValue, setDateValue] = useState(today(dayOpenHour))
  const [statusFilter, setStatusFilter] = useState('all')
  const [payFilter, setPayFilter] = useState('all')
  const [discountFilter, setDiscountFilter] = useState('all') // all | promo | pwd | none
  const [sortBy, setSortBy] = useState('newest')
  const [page, setPage] = useState(0)
  const [refunding, setRefunding] = useState(null) // txn summary or detail
  const [refundMode, setRefundMode] = useState(null) // 'full' | 'items' | null
  const [refundLines, setRefundLines] = useState([]) // detail lines with refund qty
  const [refundedByItem, setRefundedByItem] = useState({})
  const [refundSummary, setRefundSummary] = useState(null)
  const [pendingApproval, setPendingApproval] = useState(null)
  const [selectedReason, setSelectedReason] = useState(null) // reason button clicked, while busy
  const [notifyManager, setNotifyManager] = useState(false)
  const [remoteRequest, setRemoteRequest] = useState(null) // refund_requests row while waiting on a remote manager
  const [refundResult, setRefundResult] = useState(null) // { invoiceNumber, amount, mode } shown after a refund/void completes
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [txLoading, setTxLoading] = useState(true)
  const [offlineRefundOpen, setOfflineRefundOpen] = useState(false)
  const [refundBusyId, setRefundBusyId] = useState(null) // txn id while startRefund fetches detail

  const canApproveDirect = isSupervisorOrAbove(user?.role)
  const cashierDay = today(dayOpenHour)
  // rowBusinessDate, NOT item.date — item.date is the plain calendar date and dayEnds is
  // keyed by business date. A sale rung between midnight and the branch's open hour still
  // carries the CURRENT business day (see rowBusinessDate's doc comment in utils/format.js);
  // comparing item.date directly checked the wrong day's closing status for every such sale.
  const isTxnLocked = (item) => isBusinessDayLocked(dayEnds, rowBusinessDate(item, dayOpenHour), dayOpenHour)

  const refundDisplayGroups = useMemo(() => {
    const groups = []
    const claimed = new Set()
    refundLines.forEach((line, index) => {
      if (claimed.has(index)) return
      if (line.promoGroupId) {
        const members = refundLines
          .map((row, i) => ({ row, index: i }))
          .filter(({ row }) => row.promoGroupId === line.promoGroupId)
        members.forEach(({ index: i }) => claimed.add(i))
        groups.push({
          kind: 'promo',
          id: line.promoGroupId,
          name: line.promoGroupName || 'Promo set',
          members,
        })
      } else {
        claimed.add(index)
        groups.push({ kind: 'line', members: [{ row: line, index }] })
      }
    })
    return groups
  }, [refundLines])

  const toggleRefundLine = (index, selected) => {
    setRefundLines((rows) => {
      const groupId = rows[index]?.promoGroupId
      if (!groupId) {
        return rows.map((row, i) =>
          i === index ? { ...row, selected, refundQty: selected ? row.maxRefund : 0 } : row,
        )
      }
      return rows.map((row) =>
        row.promoGroupId === groupId
          ? {
              ...row,
              selected: row.maxRefund > 0 ? selected : row.selected,
              refundQty: row.maxRefund > 0 ? (selected ? row.maxRefund : 0) : row.refundQty,
            }
          : row,
      )
    })
  }

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = transactions.filter((item) => {
      // rowBusinessDate, NOT item.date — see isTxnLocked above. Comparing the plain
      // calendar date against a business-date value dropped every sale rung between
      // midnight and the branch's open hour out of "today", which is how real,
      // server-confirmed sales could show "0 shown" on the default filter.
      const businessDay = rowBusinessDate(item, dayOpenHour)
      // Cashiers only see current business-day transactions.
      if (user?.role === 'cashier' && businessDay !== cashierDay) return false
      if (q) {
        const hay = `${item.id} ${item.invoiceNumber || ''} ${item.cashier || ''} ${item.time || ''} ${item.paymentMethod || ''} ${item.paymentReference || ''} ${item.discountType || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (statusFilter !== 'all' && item.status !== statusFilter) return false
      if (payFilter !== 'all' && (item.paymentMethod || 'cash') !== payFilter) return false
      if (discountFilter === 'promo' && !isPromoDiscountType(item.discountType)) return false
      if (discountFilter === 'pwd' && String(item.discountType || '').toLowerCase() !== 'pwd' && String(item.discountType || '').toLowerCase() !== 'senior') {
        return false
      }
      if (discountFilter === 'none' && Number(item.discountAmount || 0) > 0) return false
      if (dateFilter === 'today' && businessDay !== today(dayOpenHour)) return false
      if (dateFilter === 'date' && dateValue && businessDay !== dateValue) return false
      return true
    })

    rows = [...rows].sort((a, b) => {
      if (sortBy === 'price_high') return Number(b.total || 0) - Number(a.total || 0)
      if (sortBy === 'price_low') return Number(a.total || 0) - Number(b.total || 0)
      if (sortBy === 'oldest') return txnSortTime(a) - txnSortTime(b)
      return txnSortTime(b) - txnSortTime(a)
    })
    return rows
  }, [transactions, query, statusFilter, payFilter, discountFilter, dateFilter, dateValue, sortBy, dayOpenHour, user?.role, cashierDay])

  useEffect(() => {
    setPage(0)
  }, [query, statusFilter, payFilter, discountFilter, dateFilter, dateValue, sortBy])

  // Always paint from IndexedDB first — offline sales live here until sync.
  useEffect(() => {
    if (!user?.branchId) {
      setTxLoading(false)
      return undefined
    }
    let cancelled = false
    ;(async () => {
      try {
        const data = await readBranchSnapshot(user.branchId)
        if (!cancelled && data) hydrate(data)
      } finally {
        if (!cancelled) setTxLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [user?.branchId, hydrate])

  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = list.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  const openDetail = async (item) => {
    setError('')
    setLoadingDetail(true)
    setDetail(null)
    setRefundedByItem({})
    setRefundSummary(null)
    try {
      if (!isUuid(item.id) || item.syncStatus === 'pending' || item.syncStatus === 'local') {
        let local = item
        if (!item.itemsList?.length) {
          const stored = await getLocalTransactionDetail(item.id)
          if (stored) local = { ...item, ...stored.transaction, itemsList: stored.lines }
        }
        setDetail(detailFromLocalTxn(local))
        return
      }
      if (hasSupabase) {
        const [row, summary] = await Promise.all([
          fetchTransactionDetail(item.id),
          fetchRefundSummary(item.id).catch(() => null),
        ])
        setDetail(row)
        setRefundSummary(summary)
        setRefundedByItem(summary?.qtyByItem || {})
        return
      }
      setDetail(detailFromLocalTxn(item))
    } catch (err) {
      if (item.itemsList?.length) {
        setDetail(detailFromLocalTxn(item))
      } else {
        const stored = await getLocalTransactionDetail(item.id)
        if (stored) setDetail(detailFromLocalTxn({ ...item, ...stored.transaction }, stored.lines))
        else setError(err.message || 'Could not load transaction')
      }
    } finally {
      setLoadingDetail(false)
    }
  }

  const clearFilters = () => {
    setQuery('')
    setDateFilter('today')
    setDateValue(today(dayOpenHour))
    setStatusFilter('all')
    setPayFilter('all')
    setDiscountFilter('all')
    setSortBy('newest')
  }

  const closeRefund = () => {
    setRefunding(null)
    setRefundMode(null)
    setRefundLines([])
    setPendingApproval(null)
    setNotifyManager(false)
    setRemoteRequest(null)
    setBusy(false)
    setSelectedReason(null)
  }

  const startRefund = async (item) => {
    setError('')
    if (refundOffline) {
      setOfflineRefundOpen(true)
      return
    }
    if (isTxnLocked(item)) {
      // Quote TILL04 so support hears "day closed / wait for reopen or next day", not a
      // bare string — and not AUTH07, which used to steal any message containing "locked".
      setError(formatSupportError(appError('TILL04'), 'TILL04'))
      return
    }
    setRefundMode(null)
    setRefundLines([])
    setPendingApproval(null)
    setNotifyManager(false)
    setRemoteRequest(null)
    setRefundResult(null)
    setRefundBusyId(item.id)
    try {
      let lines = item.lines || []
      let refunded = {}
      if ((!lines.length || isUuid(item.id)) && hasSupabase && isUuid(item.id)) {
        const detailRow = await fetchTransactionDetail(item.id)
        lines = detailRow.lines || []
        setRefunding({ ...item, ...detailRow, lines })
        const summary = await fetchRefundSummary(item.id).catch(() => null)
        refunded = summary?.qtyByItem || {}
        setRefundSummary(summary)
      } else {
        setRefunding(item)
        if (!lines.length && item.itemsList?.length) {
          lines = detailFromLocalTxn(item).lines
        }
      }
      setRefundedByItem(refunded)
      setRefundLines(
        lines.map((line) => {
          const already = Number(refunded[line.id] || 0)
          const max = Math.max(0, Number(line.quantity || 0) - already)
          return {
            ...line,
            alreadyRefunded: already,
            maxRefund: max,
            refundQty: max > 0 ? max : 0,
            selected: false,
          }
        }),
      )
    } catch (err) {
      setError(formatSupportError(err, 'SALE03'))
      closeRefund()
    } finally {
      setRefundBusyId(null)
    }
  }

  const applyFullRefund = async (item, reason, approvedBy = null, approver = null) => {
    setBusy(true)
    try {
      await voidTransaction(item.id, reason, approvedBy, approver)
      await dismissPendingRefundRequestsForTransaction({
        transactionId: item.id,
        staffId: approvedBy || user?.id,
      })
      const amount = Number(item.netTotal ?? item.total - Number(item.refundedAmount || 0))
      closeRefund()
      setRefundResult({ invoiceNumber: item.invoiceNumber || String(item.id).slice(0, 8), amount, mode: 'full' })
      setDetail(null)
    } catch (err) {
      setError(formatSupportError(err, 'SALE03'))
      setPendingApproval(null)
    } finally {
      setBusy(false)
    }
  }

  const applyItemRefund = async (item, reason, approvedBy = null, approver = null) => {
    const selected = refundLines.filter((line) => line.selected && Number(line.refundQty) > 0)
    if (!selected.length) {
      setError('Select at least one item and quantity to refund.')
      return
    }
    setBusy(true)
    try {
      await refundTransactionItems(item.id, {
        reason,
        approvedBy,
        approver,
        items: selected.map((line) => ({
          item_id: line.id,
          quantity: Number(line.refundQty),
        })),
      })
      await dismissPendingRefundRequestsForTransaction({
        transactionId: item.id,
        staffId: approvedBy || user?.id,
      })
      // Matches migrate_refund_sale_items.sql's per-line amount: round(unit_price * refund_qty, 2).
      const amount = selected.reduce(
        (sum, line) => sum + Math.round(Number(line.unitPrice || 0) * Number(line.refundQty) * 100) / 100,
        0,
      )
      closeRefund()
      setRefundResult({ invoiceNumber: item.invoiceNumber || String(item.id).slice(0, 8), amount, mode: 'items' })
      setDetail(null)
    } catch (err) {
      setError(formatSupportError(err, 'SALE03'))
      setPendingApproval(null)
    } finally {
      setBusy(false)
    }
  }

  // No supervisor on site: create a pending refund_requests row instead of
  // showing SupervisorApprove's PIN form, and wait for a remote manager to
  // act on it (approve_refund_request executes the actual void/refund).
  const requestManagerApproval = async (reason) => {
    if (!refunding || !refundMode) return
    const items =
      refundMode === 'items'
        ? refundLines
            .filter((line) => line.selected && Number(line.refundQty) > 0)
            .map((line) => ({ item_id: line.id, quantity: Number(line.refundQty) }))
        : null
    if (refundMode === 'items' && !items.length) {
      setError('Select at least one item and quantity to refund.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const row = await requestRefundApproval({
        transactionId: refunding.id,
        staffId: user.id,
        branchId: user.branchId,
        mode: refundMode,
        reason,
        items,
      })
      setRemoteRequest(row)
    } catch (err) {
      setError(formatSupportError(err, 'SALE06'))
    } finally {
      setBusy(false)
    }
  }

  const requestRefund = (reason) => {
    if (!refunding || !refundMode) return
    setSelectedReason(reason)
    if (notifyManager) {
      void requestManagerApproval(reason)
      return
    }
    const payload = { item: refunding, reason, mode: refundMode }
    if (canApproveDirect) {
      // Self-approved: the signed-in supervisor/manager IS the approver on record.
      const self = { name: user?.name || null, role: user?.role || null }
      if (refundMode === 'full') applyFullRefund(refunding, reason, user?.id, self)
      else applyItemRefund(refunding, reason, user?.id, self)
    } else {
      setPendingApproval(payload)
    }
  }

  const cancelRemoteRequest = async () => {
    if (!remoteRequest?.id) return
    setBusy(true)
    try {
      await cancelRefundRequest({ id: remoteRequest.id, staffId: user.id })
    } catch (err) {
      setError(formatSupportError(err, 'SALE06'))
    } finally {
      closeRefund()
    }
  }

  // A manager acting remotely (not at this terminal) flips refund_requests.status —
  // picked up here via the branch operations Broadcast (same tg_ops_broadcast trigger
  // refund_requests already feeds the manager's notification bell through), with a poll
  // as a backstop in case the channel never connects. 20s, not 5s — this is a backstop
  // for a channel that never came up at all, not the primary path, and a tight poll just
  // burns requests on a flaky connection while a modal sits open.
  useEffect(() => {
    if (!remoteRequest?.id || remoteRequest.status !== 'pending') return undefined
    const requestId = remoteRequest.id

    const applyUpdate = (row) => {
      if (!row || row.status === 'pending') return
      if (row.status === 'approved') {
        void useProductStore
          .getState()
          .loadBranch(user.branchId)
          .then(() => {
            closeRefund()
            setDetail(null)
          })
      } else if (row.status === 'cancelled') {
        closeRefund()
      } else {
        setRemoteRequest((prev) =>
          prev && prev.id === requestId ? { ...prev, status: row.status, reject_reason: row.reject_reason } : prev,
        )
      }
    }

    const refetch = () => fetchRefundRequestById(requestId).then(applyUpdate).catch(() => {})

    const unsubscribe = subscribeBroadcast({
      topic: branchOperationsTopic(user.branchId),
      events: ['OPERATIONS_CHANGED'],
      onEvent: refetch,
    })
    const poll = window.setInterval(refetch, 20000)
    return () => {
      unsubscribe()
      window.clearInterval(poll)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteRequest?.id, remoteRequest?.status])

  if (txLoading && !transactions.length) {
    return <PageSkeleton variant="table" />
  }

  return (
    <div>
      <PageHeader eyebrow="RECEIPTS & VOIDS" title="Transactions">
        <span className="text-xs text-brand-n600">
          {list.length} shown · {transactions.length} total
        </span>
      </PageHeader>
      {error && <p className="mb-3 text-xs text-brand-danger">{error}</p>}

      <div className="mb-3.5 flex flex-wrap items-end gap-2.5">
        <SearchBox
          className="min-w-[200px] flex-1 max-w-[280px]"
          icon={<FiSearch />}
          placeholder="Search order or cashier"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label className="grid gap-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
          Date
          <select className={filterSelectClass} value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
            <option value="all">All dates</option>
            <option value="today">Today</option>
            <option value="date">Pick date</option>
          </select>
        </label>
        {dateFilter === 'date' && (
          <label className="grid gap-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
            On
            <input
              type="date"
              className={filterSelectClass}
              value={dateValue}
              onChange={(e) => setDateValue(e.target.value)}
            />
          </label>
        )}
        <label className="grid gap-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
          Status
          <select
            className={filterSelectClass}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="Paid">Paid</option>
            <option value="Voided">Voided</option>
          </select>
        </label>
        <label className="grid gap-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
          Payment
          <select className={filterSelectClass} value={payFilter} onChange={(e) => setPayFilter(e.target.value)}>
            <option value="all">All methods</option>
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="ewallet">E-wallet</option>
          </select>
        </label>
        <label className="grid gap-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
          Discount
          <select
            className={filterSelectClass}
            value={discountFilter}
            onChange={(e) => setDiscountFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="promo">Promo sales</option>
            <option value="pwd">PWD / Senior</option>
            <option value="none">No discount</option>
          </select>
        </label>
        <label className="grid gap-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
          Sort
          <select className={filterSelectClass} value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="price_high">Price high → low</option>
            <option value="price_low">Price low → high</option>
          </select>
        </label>
        <SecondaryButton compact type="button" onClick={clearFilters}>
          Reset
        </SecondaryButton>
      </div>

      <TableCard>
        {/* Promo and Discount are their own columns. They used to be stacked under the invoice
            number, which made that cell carry three unrelated facts and left the promo
            name truncated — so the one thing a manager scans this table for was the
            hardest thing to read. Own columns also mean the values line up down the page
            and can be compared at a glance. */}
        <div className={`grid ${TXN_GRID} ${TXN_GRID_NARROW} gap-2.5 border-0 bg-brand-dark px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase`}>
          <span className="truncate">Sales Invoice</span>
          <span className="truncate">Time</span>
          <span className="truncate">Cashier</span>
          <span className="truncate max-[700px]:hidden">Discount type</span>
          <span className="truncate pr-4 text-right max-[700px]:hidden">Discount</span>
          <span className="truncate max-[700px]:hidden">Pay</span>
          <span className="truncate text-right tabular-nums max-[700px]:hidden">Items</span>
          <span className="truncate text-right tabular-nums max-[700px]:hidden">Total</span>
          <span className="truncate text-center max-[700px]:hidden">Status</span>
          <span className="truncate text-right max-[700px]:hidden">Action</span>
        </div>
        {txLoading ? (
          <SkeletonRows rows={8} cols={5} />
        ) : (
        pageRows.map((item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            className={`tap-row grid cursor-pointer ${TXN_GRID} ${TXN_GRID_NARROW} items-center gap-2.5 px-5 py-[17px] text-xs text-brand-slate ${tableRowClass}`}
            onClick={() => openDetail(item)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') openDetail(item)
            }}
          >
            <strong className="min-w-0 truncate text-brand-ink">
              {item.invoiceNumber || `Pending · ${item.id.slice(0, 8)}`}
              {/* Narrow screens drop the Promo and Discount columns, so the discount is
                  summarised back under the invoice number there rather than disappearing. */}
              {Number(item.discountAmount || 0) > 0 && (
                <span className="mt-0.5 hidden truncate text-[10px] font-bold text-brand-warn max-[700px]:block">
                  {discountLabelFor(item)} −{money(item.discountAmount)}
                </span>
              )}
            </strong>
            <span className="truncate">{item.time}</span>
            <span className="truncate">{item.cashier}</span>
            {/* Em dash when there is no discount — an empty cell reads as missing data,
                a dash reads as "checked, none". The column names the KIND of discount, so
                it has to cover SC/PWD too, not only promos. */}
            <span className="min-w-0 max-[700px]:hidden">
              {Number(item.discountAmount || 0) > 0 || item.discountType ? (
                <span
                  className={`block truncate font-bold ${
                    isPromoDiscountType(item.discountType) ? 'text-brand-danger' : 'text-brand-warn'
                  }`}
                >
                  {discountLabelFor(item)}
                </span>
              ) : (
                <span className="text-brand-n500">—</span>
              )}
            </span>
            <span className={`pr-4 text-right max-[700px]:hidden ${moneyClass}`}>
              {Number(item.discountAmount || 0) > 0 ? (
                <span className="font-bold text-brand-warn">
                  −{money(item.discountAmount)}
                </span>
              ) : (
                <span className="text-brand-n500">—</span>
              )}
            </span>
            <span className="truncate max-[700px]:hidden">{PAY_LABEL[item.paymentMethod || 'cash'] || 'Cash'}</span>
            <span className={`text-right max-[700px]:hidden ${moneyClass}`}>{Number(item.items).toFixed(0)}</span>
            {/* The bold figure is the final amount — total_amount already has the discount
                baked in, and netTotal (from mapTransaction) additionally subtracts any
                refunds. The pre-refund total is kept as a struck-through reference above
                it so the refund reads as "this is what it's worth now", not a second
                deduction still to come. */}
            <strong className={`min-w-0 text-right text-brand-ink max-[700px]:hidden ${moneyClass}`}>
              {Number(item.refundedAmount || 0) > 0 && item.status !== 'Voided' ? (
                <>
                  <span className="block text-[10px] font-normal text-brand-n500 line-through">
                    {money(item.total)}
                  </span>
                  {money(item.netTotal)}
                  <span className="mt-0.5 block text-[10px] font-normal text-brand-danger">
                    Refunded {money(item.refundedAmount)}
                  </span>
                </>
              ) : (
                money(item.total)
              )}
            </strong>
            <span className="justify-self-center max-[700px]:hidden">
              <StatusBadge tone={statusToneFromTxn(item)}>{statusLabelFromTxn(item)}</StatusBadge>
            </span>
            <button
              type="button"
              className="justify-self-end border-0 bg-transparent text-[11px] text-brand-danger-soft disabled:text-brand-n500 max-[700px]:hidden"
              disabled={item.status === 'Voided' || isTxnLocked(item) || refundOffline || refundBusyId === item.id}
              onClick={(event) => {
                event.stopPropagation()
                startRefund(item)
              }}
            >
              {refundBusyId === item.id ? 'Loading…' : 'Refund'}
            </button>
          </div>
        ))
        )}
        {!txLoading && list.length === 0 && (
          <div className="px-5 py-8 text-xs text-brand-subtle">No transactions match these filters.</div>
        )}
        {!txLoading && pageCount > 1 && (
          <Pager
            page={pageIndex + 1}
            pageCount={pageCount}
            total={list.length}
            label="transactions"
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        )}
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
          onPrint={async (row) => {
            try {
              if (!isDeviceEnabled(user?.deviceSettings, 'receipt_printer')) {
                window.alert(
                  formatSupportError(
                    {
                      code: 'DEV03',
                      message: 'Receipt printer is disabled for this branch. Ask a manager to turn it On.',
                    },
                    'DEV03',
                  ),
                )
                return
              }
              let branch = { name: user?.branchName, business_name: user?.branchName }
              if (hasSupabase && user?.branchId) {
                branch = (await fetchBranchFiscalHeader(user.branchId).catch(() => null)) || branch
              }
              const receipt = buildReceipt({ branch, user, transaction: row, lines: row.lines || [] })
              await receiptPrinter.printReceipt(receipt)
            } catch (err) {
              window.alert(formatSupportError(err, 'DEV04'))
            }
          }}
          onRefund={(row) => {
            setDetail(null)
            startRefund(row)
          }}
          refundBlocked={detail ? isTxnLocked(detail) || refundOffline : false}
          refundBlockReason={
            refundOffline
              ? 'Refunds need a connection. Make a physical list and record when online (SALE07)'
              : detail && isTxnLocked(detail)
                ? 'Business day closed: no refunds until till reopens or next day opens (TILL04)'
                : undefined
          }
        />
      )}

      {refunding && !refundMode && !pendingApproval && !remoteRequest && (
        <Modal onClose={closeRefund}>
          <Eyebrow>REFUND</Eyebrow>
          <h2 className="mb-[5px] text-[22px]">
            {refunding.invoiceNumber || String(refunding.id).slice(0, 8)}
          </h2>
          <p className="text-[13px] text-brand-muted">
            Voids are only allowed as a full refund of the whole sale. Or refund selected items.
          </p>
          <div className="mt-5 grid gap-2">
            <button
              type="button"
              className="rounded-[5px] border border-brand-border bg-brand-n50 p-[11px] text-left text-brand-n800"
              onClick={() => setRefundMode('full')}
            >
              <strong className="block">Full refund</strong>
              <small className="text-[11px] text-brand-subtle">
                Return everything and void this transaction
              </small>
            </button>
            <button
              type="button"
              className="rounded-[5px] border border-brand-border bg-brand-n50 p-[11px] text-left text-brand-n800"
              onClick={() => setRefundMode('items')}
            >
              <strong className="block">Refund selected items</strong>
              <small className="text-[11px] text-brand-subtle">
                Choose lines and quantities to return
              </small>
            </button>
          </div>
        </Modal>
      )}

      {refunding && refundMode === 'items' && !pendingApproval && !remoteRequest && (
        <Modal wide onClose={closeRefund}>
          <Eyebrow>SELECT ITEMS</Eyebrow>
          <h2 className="mb-2 text-[20px]">
            Refund · {refunding.invoiceNumber || String(refunding.id).slice(0, 8)}
          </h2>
          <div className="max-h-[260px] overflow-auto rounded-md border border-brand-softline">
            {refundDisplayGroups.map((group) => {
              if (group.kind === 'promo') {
                const selectable = group.members.some(({ row }) => row.maxRefund > 0)
                const allSelected =
                  selectable &&
                  group.members.every(({ row }) => row.maxRefund <= 0 || (row.selected && row.refundQty === row.maxRefund))
                return (
                  <div
                    key={group.id}
                    className="grid grid-cols-[auto_1fr] items-start gap-3 border-t border-brand-softline px-3 py-2.5 text-xs first:border-t-0"
                  >
                    <input
                      type="checkbox"
                      checked={allSelected}
                      disabled={!selectable}
                      onChange={(e) => {
                        const selected = e.target.checked
                        group.members.forEach(({ index }) => toggleRefundLine(index, selected))
                      }}
                    />
                    <div className="min-w-0">
                      <strong className="block text-brand-ink">{group.name}</strong>
                      <small className="mt-0.5 block text-[10px] leading-snug text-brand-subtle">
                        {group.members
                          .map(({ row }) =>
                            `${row.name} · ${qty(row.quantity, row.pricingMode === 'kg' ? 'kg' : 'pc')}`,
                          )
                          .join(', ')}
                      </small>
                      <small className="mt-1 block text-[10px] text-brand-warn">
                        Promo sets must be refunded together.
                      </small>
                    </div>
                  </div>
                )
              }
              const { row, index } = group.members[0]
              return (
                <div
                  key={`${row.id}-${index}`}
                  className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-brand-softline px-3 py-2.5 text-xs first:border-t-0"
                >
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={row.maxRefund <= 0}
                    onChange={(e) => toggleRefundLine(index, e.target.checked)}
                  />
                  <div className="min-w-0">
                    <strong className="block truncate">{row.name}</strong>
                    <small className="text-[10px] text-brand-subtle">
                      Sold {qty(row.quantity, row.pricingMode === 'kg' ? 'kg' : 'pc')}
                      {row.alreadyRefunded > 0
                        ? ` · already refunded ${qty(row.alreadyRefunded, row.pricingMode === 'kg' ? 'kg' : 'pc')}`
                        : ''}
                    </small>
                  </div>
                  <label className="flex items-center gap-1 text-[10px] text-brand-subtle">
                    Qty
                    <input
                      className="w-14 rounded border border-brand-line px-1 py-1 text-right text-xs text-brand-ink"
                      inputMode="decimal"
                      disabled={!row.selected || row.maxRefund <= 0}
                      value={row.refundQty}
                      onChange={(e) => {
                        const raw = e.target.value.replace(/[^\d.]/g, '')
                        const n = Math.min(row.maxRefund, Math.max(0, Number(raw) || 0))
                        setRefundLines((rows) =>
                          rows.map((entry, i) => (i === index ? { ...entry, refundQty: n } : entry)),
                        )
                      }}
                    />
                  </label>
                </div>
              )
            })}
            {refundLines.length === 0 && (
              <div className="px-3 py-4 text-xs text-brand-subtle">No line items available.</div>
            )}
          </div>
          <p className="mt-3 text-[12px] text-brand-muted">Choose a reason to continue.</p>
          {!canApproveDirect && (
            <label className="mt-3 flex items-start gap-2 text-xs text-brand-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={notifyManager}
                onChange={(e) => setNotifyManager(e.target.checked)}
              />
              No supervisor available, notify manager instead
            </label>
          )}
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <div className="mt-3 grid gap-2">
            {REFUND_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                disabled={busy}
                className="rounded-[5px] border border-brand-border bg-brand-n50 p-[11px] text-left text-brand-n800 disabled:opacity-50"
                onClick={() => requestRefund(reason)}
              >
                {busy && selectedReason === reason ? 'Refunding…' : reason}
              </button>
            ))}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setRefundMode(null)}>
              Back
            </SecondaryButton>
          </ModalActions>
        </Modal>
      )}

      {refunding && refundMode === 'full' && !pendingApproval && !remoteRequest && (
        <Modal onClose={closeRefund}>
          <Eyebrow>FULL REFUND</Eyebrow>
          <h2 className="mb-[5px] text-[22px]">
            {refunding.invoiceNumber || String(refunding.id).slice(0, 8)}
          </h2>
          <p className="text-[13px] text-brand-muted">
            {canApproveDirect
              ? 'This voids the whole sale and restocks all items. Choose a reason.'
              : 'This voids the whole sale. Choose a reason, supervisor PIN required next.'}
          </p>
          {!canApproveDirect && (
            <label className="mt-3 flex items-start gap-2 text-xs text-brand-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={notifyManager}
                onChange={(e) => setNotifyManager(e.target.checked)}
              />
              No supervisor available, notify manager instead
            </label>
          )}
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <div className="mt-5 grid gap-2">
            {REFUND_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                disabled={busy}
                className="rounded-[5px] border border-brand-border bg-brand-n50 p-[11px] text-left text-brand-n800 disabled:opacity-50"
                onClick={() => requestRefund(reason)}
              >
                {busy && selectedReason === reason ? 'Voiding…' : reason}
              </button>
            ))}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setRefundMode(null)}>
              Back
            </SecondaryButton>
          </ModalActions>
        </Modal>
      )}

      {remoteRequest && (
        <Modal onClose={remoteRequest.status === 'pending' ? undefined : closeRefund}>
          <Eyebrow>MANAGER APPROVAL</Eyebrow>
          <h2 className="mb-2 text-[20px]">
            {remoteRequest.status === 'rejected' ? 'Refund rejected' : 'Waiting for manager…'}
          </h2>
          {remoteRequest.status === 'pending' && (
            <p className="text-[13px] text-brand-muted">
              The manager has been notified and can approve this refund from anywhere. This
              screen updates automatically once they respond, no need to reload.
            </p>
          )}
          {remoteRequest.status === 'rejected' && (
            <p className="text-[13px] text-brand-danger">
              {remoteRequest.reject_reason || 'No reason given.'}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <ModalActions>
            {remoteRequest.status === 'pending' ? (
              <SecondaryButton compact type="button" disabled={busy} onClick={() => void cancelRemoteRequest()}>
                Cancel request
              </SecondaryButton>
            ) : (
              <>
                <SecondaryButton compact type="button" onClick={closeRefund}>
                  Close
                </SecondaryButton>
                <PrimaryButton compact type="button" onClick={() => setRemoteRequest(null)}>
                  Try again
                </PrimaryButton>
              </>
            )}
          </ModalActions>
        </Modal>
      )}

      {pendingApproval && (
        <SupervisorApprove
          branchId={user?.branchId}
          title={pendingApproval.mode === 'full' ? 'Approve full refund' : 'Approve item refund'}
          detail={`Supervisor approval required for ${
            pendingApproval.item.invoiceNumber || String(pendingApproval.item.id).slice(0, 8)
          }.`}
          pending={busy}
          onCancel={() => setPendingApproval(null)}
          onApproved={({ staffId, name, role }) => {
            const approver = { name: name || null, role: role || null }
            if (pendingApproval.mode === 'full') {
              applyFullRefund(pendingApproval.item, pendingApproval.reason, staffId, approver)
            } else {
              applyItemRefund(pendingApproval.item, pendingApproval.reason, staffId, approver)
            }
          }}
        />
      )}

      {refundResult && (
        <Modal onClose={() => setRefundResult(null)}>
          <Eyebrow>{refundResult.mode === 'full' ? 'VOID COMPLETE' : 'REFUND COMPLETE'}</Eyebrow>
          <h2 className="mb-2 text-[20px]">{refundResult.invoiceNumber}</h2>
          <div className="flex items-center justify-between rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <span className="text-[12px] text-brand-muted">Give back to customer</span>
            <strong className="text-[18px] text-brand-ink">{money(refundResult.amount)}</strong>
          </div>
          <ModalActions>
            <PrimaryButton compact type="button" onClick={() => setRefundResult(null)}>
              Done
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {offlineRefundOpen && (
        <Modal onClose={() => setOfflineRefundOpen(false)}>
          <Eyebrow>REFUND</Eyebrow>
          <h2 className="mb-2 text-lg">Not available offline</h2>
          <p className="mb-1 text-sm text-brand-muted">
            Refunds change inventory, cash accountability, and audit records. They need a
            connection to the server.
          </p>
          <p className="mb-4 text-xs text-brand-subtle">
            Recommend making a physical list of items to refund and recording them when the system
            is back online.
          </p>
          <p className="mb-4 text-xs text-brand-n500">{formatSupportError(appError('SALE07'), 'SALE07')}</p>
          <ModalActions>
            <PrimaryButton type="button" onClick={() => setOfflineRefundOpen(false)}>
              Close
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default Transactions
