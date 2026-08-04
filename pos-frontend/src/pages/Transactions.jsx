import { useMemo, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import TransactionDetailModal from '../components/transactions/TransactionDetailModal'
import SupervisorApprove from '../components/shared/SupervisorApprove'
import {
  Eyebrow,
  Modal,
  ModalActions,
  PageHeader,
  SearchBox,
  SecondaryButton,
  TableCard,
} from '../components/ui'
import {
  fetchBranches,
  fetchRefundSummary,
  fetchTransactionDetail,
  hasSupabase,
} from '../lib/api'
import { isDeviceEnabled, receiptPrinter } from '../devices'
import { getLocalTransactionDetail } from '../offline'
import { useAuthStore, useInventoryStore } from '../stores/posStore'
import { formatSupportError } from '../utils/errors'
import { money, qty, today } from '../utils/format'
import { buildReceipt } from '../utils/receipt'
import { isSupervisorOrAbove } from '../utils/roles'
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
const REFUND_REASONS = ['Wrong item', 'Customer changed mind', 'Damaged', 'Other']

const filterSelectClass =
  'h-10 rounded-md border border-brand-line bg-white px-3 text-xs font-medium text-brand-ink'

function Transactions() {
  const transactions = useInventoryStore((state) => state.transactions)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const voidTransaction = useInventoryStore((state) => state.voidTransaction)
  const refundTransactionItems = useInventoryStore((state) => state.refundTransactionItems)
  const user = useAuthStore((state) => state.user)
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState('all')
  const [dateValue, setDateValue] = useState(today(dayOpenHour))
  const [statusFilter, setStatusFilter] = useState('all')
  const [payFilter, setPayFilter] = useState('all')
  const [sortBy, setSortBy] = useState('newest')
  const [refunding, setRefunding] = useState(null) // txn summary or detail
  const [refundMode, setRefundMode] = useState(null) // 'full' | 'items' | null
  const [refundLines, setRefundLines] = useState([]) // detail lines with refund qty
  const [refundedByItem, setRefundedByItem] = useState({})
  const [refundSummary, setRefundSummary] = useState(null)
  const [pendingApproval, setPendingApproval] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const canApproveDirect = isSupervisorOrAbove(user?.role)
  const cashierDay = today(dayOpenHour)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = transactions.filter((item) => {
      // Cashiers only see current business-day transactions.
      if (user?.role === 'cashier' && item.date !== cashierDay) return false
      if (q) {
        const hay = `${item.id} ${item.orNumber || ''} ${item.cashier || ''} ${item.time || ''} ${item.paymentMethod || ''} ${item.paymentReference || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (statusFilter !== 'all' && item.status !== statusFilter) return false
      if (payFilter !== 'all' && (item.paymentMethod || 'cash') !== payFilter) return false
      if (dateFilter === 'today' && item.date !== today(dayOpenHour)) return false
      if (dateFilter === 'date' && dateValue && item.date !== dateValue) return false
      return true
    })

    rows = [...rows].sort((a, b) => {
      if (sortBy === 'price_high') return Number(b.total || 0) - Number(a.total || 0)
      if (sortBy === 'price_low') return Number(a.total || 0) - Number(b.total || 0)
      if (sortBy === 'oldest') return txnSortTime(a) - txnSortTime(b)
      return txnSortTime(b) - txnSortTime(a)
    })
    return rows
  }, [transactions, query, statusFilter, payFilter, dateFilter, dateValue, sortBy, dayOpenHour, user?.role, cashierDay])

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
    setDateFilter('all')
    setDateValue(today(dayOpenHour))
    setStatusFilter('all')
    setPayFilter('all')
    setSortBy('newest')
  }

  const closeRefund = () => {
    setRefunding(null)
    setRefundMode(null)
    setRefundLines([])
    setPendingApproval(null)
    setBusy(false)
  }

  const startRefund = async (item) => {
    setError('')
    setRefunding(item)
    setRefundMode(null)
    setRefundLines([])
    setPendingApproval(null)
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
      } else if (!lines.length && item.itemsList?.length) {
        lines = detailFromLocalTxn(item).lines
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
    }
  }

  const applyFullRefund = async (item, reason, approvedBy = null) => {
    setBusy(true)
    try {
      await voidTransaction(item.id, reason, approvedBy)
      closeRefund()
      setDetail(null)
    } catch (err) {
      setError(formatSupportError(err, 'SALE03'))
      setPendingApproval(null)
    } finally {
      setBusy(false)
    }
  }

  const applyItemRefund = async (item, reason, approvedBy = null) => {
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
        items: selected.map((line) => ({
          item_id: line.id,
          quantity: Number(line.refundQty),
        })),
      })
      closeRefund()
      setDetail(null)
    } catch (err) {
      setError(formatSupportError(err, 'SALE03'))
      setPendingApproval(null)
    } finally {
      setBusy(false)
    }
  }

  const requestRefund = (reason) => {
    if (!refunding || !refundMode) return
    const payload = { item: refunding, reason, mode: refundMode }
    if (canApproveDirect) {
      if (refundMode === 'full') applyFullRefund(refunding, reason, user?.id)
      else applyItemRefund(refunding, reason, user?.id)
    } else {
      setPendingApproval(payload)
    }
  }

  return (
    <div>
      <PageHeader eyebrow="AUDIT TRAIL" title="Transactions">
        <span className="text-xs text-[#797e7b]">
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
        <div className="grid grid-cols-[1.1fr_1.2fr_1fr_0.7fr_0.5fr_0.8fr_0.7fr_0.5fr] gap-3 border-0 bg-[#f7f7f4] px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[700px]:grid-cols-[1.3fr_0.8fr_0.8fr]">
          <span>OR / Invoice</span>
          <span>Time</span>
          <span>Cashier</span>
          <span className="max-[700px]:hidden">Pay</span>
          <span className="text-right tabular-nums max-[700px]:hidden">Items</span>
          <span className="text-right tabular-nums max-[700px]:hidden">Total</span>
          <span className="text-center max-[700px]:hidden">Status</span>
          <span className="max-[700px]:hidden">Action</span>
        </div>
        {list.map((item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            className="tap-row grid cursor-pointer grid-cols-[1.1fr_1.2fr_1fr_0.7fr_0.5fr_0.8fr_0.7fr_0.5fr] items-center gap-3 border-t border-brand-softline px-5 py-[17px] text-xs text-brand-slate hover:bg-[#fafaf7] active:bg-[#f0f1ec] max-[700px]:grid-cols-[1.3fr_0.8fr_0.8fr]"
            onClick={() => openDetail(item)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') openDetail(item)
            }}
          >
            <strong className="text-brand-ink">{item.orNumber || item.id.slice(0, 8)}</strong>
            <span>{item.time}</span>
            <span>{item.cashier}</span>
            <span className="max-[700px]:hidden">{PAY_LABEL[item.paymentMethod || 'cash'] || 'Cash'}</span>
            <span className="text-right tabular-nums max-[700px]:hidden">{Number(item.items).toFixed(0)}</span>
            <strong className="text-right tabular-nums text-brand-ink max-[700px]:hidden">
              {money(item.netTotal ?? item.total)}
              {Number(item.refundedAmount || 0) > 0 && item.status !== 'Voided' && (
                <span className="mt-0.5 block text-[10px] font-normal text-brand-danger">
                  −{money(item.refundedAmount)} refunded
                </span>
              )}
            </strong>
            <span className="justify-self-center max-[700px]:hidden">
              <span
                className={`inline-block min-w-[62px] rounded-[20px] px-2 py-[5px] text-center text-[10px] ${
                  item.status === 'Voided'
                    ? 'bg-brand-danger-bg text-brand-danger'
                    : Number(item.refundedAmount || 0) > 0
                      ? 'bg-[#f5efe6] text-[#8a6a3b]'
                      : 'bg-brand-success-bg text-brand-success-text'
                }`}
              >
                {item.status === 'Voided'
                  ? 'Voided'
                  : Number(item.refundedAmount || 0) > 0
                    ? 'Partial'
                    : item.status}
              </span>
            </span>
            <button
              type="button"
              className="border-0 bg-transparent text-[11px] text-brand-danger-soft disabled:text-[#b8bcba] max-[700px]:hidden"
              disabled={item.status === 'Voided'}
              onClick={(event) => {
                event.stopPropagation()
                startRefund(item)
              }}
            >
              Refund
            </button>
          </div>
        ))}
        {list.length === 0 && (
          <div className="px-5 py-8 text-xs text-brand-subtle">No transactions match these filters.</div>
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
                const branches = await fetchBranches().catch(() => [])
                branch = branches.find((b) => b.id === user.branchId) || branch
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
        />
      )}

      {refunding && !refundMode && !pendingApproval && (
        <Modal onClose={closeRefund}>
          <Eyebrow>REFUND</Eyebrow>
          <h2 className="mb-[5px] text-[22px]">
            {refunding.orNumber || String(refunding.id).slice(0, 8)}
          </h2>
          <p className="text-[13px] text-brand-muted">
            Voids are only allowed as a full refund of the whole sale. Or refund selected items.
          </p>
          <div className="mt-5 grid gap-2">
            <button
              type="button"
              className="rounded-[5px] border border-brand-border bg-[#f8f8f5] p-[11px] text-left text-[#4d534f]"
              onClick={() => setRefundMode('full')}
            >
              <strong className="block">Full refund</strong>
              <small className="text-[11px] text-brand-subtle">
                Return everything and void this transaction
              </small>
            </button>
            <button
              type="button"
              className="rounded-[5px] border border-brand-border bg-[#f8f8f5] p-[11px] text-left text-[#4d534f]"
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

      {refunding && refundMode === 'items' && !pendingApproval && (
        <Modal wide onClose={closeRefund}>
          <Eyebrow>SELECT ITEMS</Eyebrow>
          <h2 className="mb-2 text-[20px]">
            Refund · {refunding.orNumber || String(refunding.id).slice(0, 8)}
          </h2>
          <div className="max-h-[260px] overflow-auto rounded-md border border-brand-softline">
            {refundLines.map((line, index) => (
              <div
                key={line.id}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-3 border-t border-brand-softline px-3 py-2.5 text-xs first:border-t-0"
              >
                <input
                  type="checkbox"
                  checked={line.selected}
                  disabled={line.maxRefund <= 0}
                  onChange={(e) => {
                    const selected = e.target.checked
                    setRefundLines((rows) =>
                      rows.map((row, i) => (i === index ? { ...row, selected } : row)),
                    )
                  }}
                />
                <div className="min-w-0">
                  <strong className="block truncate">{line.name}</strong>
                  <small className="text-[10px] text-brand-subtle">
                    Sold {qty(line.quantity, line.pricingMode === 'kg' ? 'kg' : 'pc')}
                    {line.alreadyRefunded > 0
                      ? ` · already refunded ${qty(line.alreadyRefunded, line.pricingMode === 'kg' ? 'kg' : 'pc')}`
                      : ''}
                  </small>
                </div>
                <label className="flex items-center gap-1 text-[10px] text-brand-subtle">
                  Qty
                  <input
                    className="w-14 rounded border border-brand-line px-1 py-1 text-right text-xs text-brand-ink"
                    inputMode="decimal"
                    disabled={!line.selected || line.maxRefund <= 0}
                    value={line.refundQty}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^\d.]/g, '')
                      const n = Math.min(line.maxRefund, Math.max(0, Number(raw) || 0))
                      setRefundLines((rows) =>
                        rows.map((row, i) => (i === index ? { ...row, refundQty: n } : row)),
                      )
                    }}
                  />
                </label>
              </div>
            ))}
            {refundLines.length === 0 && (
              <div className="px-3 py-4 text-xs text-brand-subtle">No line items available.</div>
            )}
          </div>
          <p className="mt-3 text-[12px] text-brand-muted">Choose a reason to continue.</p>
          <div className="mt-3 grid gap-2">
            {REFUND_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                disabled={busy}
                className="rounded-[5px] border border-brand-border bg-[#f8f8f5] p-[11px] text-left text-[#4d534f] disabled:opacity-50"
                onClick={() => requestRefund(reason)}
              >
                {reason}
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

      {refunding && refundMode === 'full' && !pendingApproval && (
        <Modal onClose={closeRefund}>
          <Eyebrow>FULL REFUND</Eyebrow>
          <h2 className="mb-[5px] text-[22px]">
            {refunding.orNumber || String(refunding.id).slice(0, 8)}
          </h2>
          <p className="text-[13px] text-brand-muted">
            {canApproveDirect
              ? 'This voids the whole sale and restocks all items. Choose a reason.'
              : 'This voids the whole sale. Choose a reason — supervisor PIN required next.'}
          </p>
          <div className="mt-5 grid gap-2">
            {REFUND_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                disabled={busy}
                className="rounded-[5px] border border-brand-border bg-[#f8f8f5] p-[11px] text-left text-[#4d534f] disabled:opacity-50"
                onClick={() => requestRefund(reason)}
              >
                {reason}
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

      {pendingApproval && (
        <SupervisorApprove
          branchId={user?.branchId}
          title={pendingApproval.mode === 'full' ? 'Approve full refund' : 'Approve item refund'}
          detail={`Supervisor approval required for ${
            pendingApproval.item.orNumber || String(pendingApproval.item.id).slice(0, 8)
          }.`}
          onCancel={() => setPendingApproval(null)}
          onApproved={({ staffId }) => {
            if (pendingApproval.mode === 'full') {
              applyFullRefund(pendingApproval.item, pendingApproval.reason, staffId)
            } else {
              applyItemRefund(pendingApproval.item, pendingApproval.reason, staffId)
            }
          }}
        />
      )}
    </div>
  )
}

export default Transactions
