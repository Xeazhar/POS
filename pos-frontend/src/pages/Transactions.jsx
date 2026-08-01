import { useMemo, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import TransactionDetailModal from '../components/transactions/TransactionDetailModal'
import { Eyebrow, Modal, PageHeader, SearchBox, SecondaryButton, TableCard } from '../components/ui'
import { fetchBranches, fetchTransactionDetail, hasSupabase } from '../lib/api'
import { receiptPrinter } from '../devices'
import { getLocalTransactionDetail } from '../offline'
import { useAuthStore, useInventoryStore } from '../stores/posStore'
import { money, today } from '../utils/format'
import { buildReceipt } from '../utils/receipt'
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

const filterSelectClass =
  'h-10 rounded-md border border-brand-line bg-white px-3 text-xs font-medium text-brand-ink'

function Transactions() {
  const transactions = useInventoryStore((state) => state.transactions)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const voidTransaction = useInventoryStore((state) => state.voidTransaction)
  const user = useAuthStore((state) => state.user)
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState('all') // all | today | date
  const [dateValue, setDateValue] = useState(today(dayOpenHour))
  const [statusFilter, setStatusFilter] = useState('all') // all | Paid | Voided
  const [sortBy, setSortBy] = useState('newest') // newest | oldest | price_high | price_low
  const [voiding, setVoiding] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState('')

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = transactions.filter((item) => {
      if (q) {
        const hay = `${item.id} ${item.orNumber || ''} ${item.cashier || ''} ${item.time || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (statusFilter !== 'all' && item.status !== statusFilter) return false
      if (dateFilter === 'today' && item.date !== today(dayOpenHour)) return false
      if (dateFilter === 'date' && dateValue && item.date !== dateValue) return false
      return true
    })

    rows = [...rows].sort((a, b) => {
      if (sortBy === 'price_high') return Number(b.total || 0) - Number(a.total || 0)
      if (sortBy === 'price_low') return Number(a.total || 0) - Number(b.total || 0)
      if (sortBy === 'oldest') return txnSortTime(a) - txnSortTime(b)
      return txnSortTime(b) - txnSortTime(a) // newest
    })
    return rows
  }, [transactions, query, statusFilter, dateFilter, dateValue, sortBy, dayOpenHour])

  const openDetail = async (item) => {
    setError('')
    setLoadingDetail(true)
    setDetail(null)
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
        setDetail(await fetchTransactionDetail(item.id))
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
    setSortBy('newest')
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
        <div className="grid grid-cols-[1.2fr_1.4fr_1.3fr_0.6fr_0.9fr_0.8fr_0.6fr] gap-3 border-0 bg-[#f7f7f4] px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[700px]:grid-cols-[1.3fr_0.8fr_0.8fr]">
          <span>OR / Invoice</span>
          <span>Time</span>
          <span>Cashier</span>
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
            className="grid cursor-pointer grid-cols-[1.2fr_1.4fr_1.3fr_0.6fr_0.9fr_0.8fr_0.6fr] items-center gap-3 border-t border-brand-softline px-5 py-[17px] text-xs text-brand-slate hover:bg-[#fafaf7] max-[700px]:grid-cols-[1.3fr_0.8fr_0.8fr]"
            onClick={() => openDetail(item)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') openDetail(item)
            }}
          >
            <strong className="text-brand-ink">{item.orNumber || item.id.slice(0, 8)}</strong>
            <span>{item.time}</span>
            <span>{item.cashier}</span>
            <span className="text-right tabular-nums max-[700px]:hidden">{Number(item.items).toFixed(0)}</span>
            <strong className="text-right tabular-nums text-brand-ink max-[700px]:hidden">{money(item.total)}</strong>
            <span className="justify-self-center max-[700px]:hidden">
              <span
                className={`inline-block min-w-[62px] rounded-[20px] px-2 py-[5px] text-center text-[10px] ${
                  item.status === 'Voided'
                    ? 'bg-brand-danger-bg text-brand-danger'
                    : 'bg-brand-success-bg text-brand-success-text'
                }`}
              >
                {item.status}
              </span>
            </span>
            <button
              type="button"
              className="border-0 bg-transparent text-[11px] text-brand-danger-soft disabled:text-[#b8bcba] max-[700px]:hidden"
              disabled={item.status === 'Voided'}
              onClick={(event) => {
                event.stopPropagation()
                setVoiding(item)
              }}
            >
              Void
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
          onClose={() => setDetail(null)}
          onPrint={async (row) => {
            try {
              let branch = { name: user?.branchName, business_name: user?.branchName }
              if (hasSupabase && user?.branchId) {
                const branches = await fetchBranches().catch(() => [])
                branch = branches.find((b) => b.id === user.branchId) || branch
              }
              const receipt = buildReceipt({ branch, user, transaction: row, lines: row.lines || [] })
              await receiptPrinter.printReceipt(receipt)
            } catch (err) {
              setError(err.message)
            }
          }}
          onVoid={(row) => {
            setVoiding(row)
            setDetail(null)
          }}
        />
      )}

      {voiding && (
        <Modal onClose={() => setVoiding(null)}>
          <Eyebrow>VOID TRANSACTION</Eyebrow>
          <h2 className="mb-[5px] text-[22px]">{voiding.orNumber || voiding.id.slice(0, 8)}</h2>
          <p className="text-[13px] text-brand-muted">Choose a reason for this void.</p>
          <div className="mt-5 grid gap-2">
            {['Wrong item', 'Customer changed mind', 'Damaged', 'Other'].map((reason) => (
              <button
                key={reason}
                type="button"
                className="rounded-[5px] border border-brand-border bg-[#f8f8f5] p-[11px] text-left text-[#4d534f]"
                onClick={() => {
                  voidTransaction(voiding.id, reason)
                  setVoiding(null)
                }}
              >
                {reason}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}

export default Transactions
