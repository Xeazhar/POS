import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import TransactionDetailModal from '../../components/transactions/TransactionDetailModal'
import { Field, PageHeader, PrimaryButton, SecondaryButton, TableCard } from '../../components/ui'
import {
  bootstrapBranchData,
  fetchBranchTelemetry,
  fetchBranches,
  fetchTransactionDetail,
  hasSupabase,
  reopenDayEnd,
  saveBranch,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { businessDate, formatOpenHourLabel, money, qty } from '../../utils/format'
import { isUuid } from '../../utils/transactionDetail'

const PAGE_SIZE = 10

function ManagerBranchDashboard() {
  const { branchId } = useParams()
  const user = useAuthStore((state) => state.user)
  const [branch, setBranch] = useState(null)
  const [data, setData] = useState({ products: [], transactions: [], movements: [], dayEnds: [] })
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [invPage, setInvPage] = useState(0)
  const [reopening, setReopening] = useState(null)
  const [telemetry, setTelemetry] = useState({ devices: [] })
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)

  useEffect(() => {
    let active = true
    setInvPage(0)
    Promise.resolve()
      .then(async () => {
        if (!hasSupabase) {
          if (!active) return
          setBranch({ id: branchId, name: 'Bayombong Branch #001', address: 'Bayombong', is_active: true, day_open_hour: 7 })
          setData({ products: [], transactions: [], movements: [], dayEnds: [], dayOpenHour: 7 })
          setTelemetry({ devices: [] })
          return
        }
        const branches = await fetchBranches()
        if (!active) return
        setBranch(branches.find((row) => row.id === branchId) || null)
        const payload = await bootstrapBranchData(branchId)
        const tel = await fetchBranchTelemetry([branchId])
        if (active) {
          setData(payload)
          setTelemetry({ devices: tel.devices[branchId] || [] })
        }
      })
      .catch((err) => {
        if (active) setError(err.message)
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
    setData(await bootstrapBranchData(branchId))
  }

  const openHour = Number(branch?.day_open_hour ?? 7)
  const todayKey = businessDate(new Date(), openHour)
  const todayTx = data.transactions.filter((item) => item.status === 'Paid' && item.date === todayKey)
  const revenue = todayTx.reduce((sum, item) => sum + item.total, 0)
  const low = data.products.filter((product) => product.stock <= product.lowStockAt)
  const shrink = data.movements
    .filter((item) => item.type === 'Shrinkage')
    .reduce(
      (sum, item) =>
        sum + Math.abs(item.quantityChange) * (data.products.find((p) => p.id === item.productId)?.price || 0),
      0,
    )
  const closedToday = (data.dayEnds || []).find((entry) => entry.date === todayKey && entry.status === 'closed')

  const handleReopen = async (entry) => {
    setReopening(entry.id)
    setError('')
    try {
      await reopenDayEnd({ id: entry.id, staffId: user.id })
      await reload()
    } catch (err) {
      setError(err.message || 'Could not reopen till')
    } finally {
      setReopening(null)
    }
  }

  const openTxnDetail = async (item) => {
    setError('')
    setLoadingDetail(true)
    setDetail(null)
    try {
      if (!hasSupabase || !isUuid(item.id)) {
        setError('Transaction details are only available after the sale has synced.')
        return
      }
      setDetail(await fetchTransactionDetail(item.id))
    } catch (err) {
      setError(err.message || 'Could not load transaction')
    } finally {
      setLoadingDetail(false)
    }
  }

  const recentTxns = useMemo(() => {
    return [...(data.transactions || [])]
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tb - ta
      })
      .slice(0, 8)
  }, [data.transactions])

  const invPages = Math.max(1, Math.ceil(data.products.length / PAGE_SIZE))
  const pageIndex = Math.min(invPage, invPages - 1)
  const invSlice = data.products.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  return (
    <div>
      <PageHeader eyebrow="BRANCH" title={branch?.name || 'Branch'}>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SecondaryButton compact type="button" onClick={() => { setForm(branch); setEditing(true) }}>
            Branch settings
          </SecondaryButton>
          <Link to="/manager/branches" className="inline-flex h-10 items-center px-2 text-xs font-bold text-brand-slate no-underline">
            ← All branches
          </Link>
        </div>
      </PageHeader>
      {error && <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>}

      <TableCard className="mb-4 max-h-none">
        <div className="px-4 py-3">
          <h2 className="m-0 text-base">Devices</h2>
          <p className="m-0 mt-0.5 text-[11px] text-brand-subtle">
            Hardware status for this branch till (not network online/offline)
          </p>
        </div>
        <div className="grid grid-cols-3 gap-0 border-t border-brand-softline max-[700px]:grid-cols-1">
          {(telemetry.devices.length
            ? telemetry.devices
            : [
                { key: 'barcode_scanner', label: 'Barcode Scanner', state: 'disconnected', detail: 'Not Connected' },
                { key: 'receipt_printer', label: 'Receipt Printer', state: 'disconnected', detail: 'Not Connected' },
                { key: 'cash_drawer', label: 'Cash Drawer', state: 'disconnected', detail: 'Not Connected' },
              ]
          ).map((device) => (
            <div
              key={device.key}
              className="border-t border-brand-softline px-4 py-3 max-[700px]:border-t min-[701px]:border-t-0 min-[701px]:border-l min-[701px]:first:border-l-0"
            >
              <strong className="block text-xs text-brand-ink">{device.label}</strong>
              <span
                className={`mt-1 inline-block text-[11px] font-bold ${
                  device.state === 'connected' ? 'text-[#2f6b3c]' : 'text-brand-muted'
                }`}
              >
                {device.state === 'connected' ? 'Connected' : 'Not Connected'}
              </span>
            </div>
          ))}
        </div>
      </TableCard>

      <div className="mb-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
        {[
          ['Revenue today', money(revenue)],
          ['Orders today', todayTx.length],
          ['Low stock', low.length],
          ['Reseko loss', money(shrink)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[9px] bg-brand-dark p-4 text-white">
            <span className="block text-[11px] text-[#abb1ad]">{label}</span>
            <strong className="mt-2 block text-xl text-brand-gold">{value}</strong>
          </div>
        ))}
      </div>

      <div className="mb-3.5 grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1">
        <TableCard className="max-h-none">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="m-0 text-base">Recent transactions</h2>
            <span className="text-[11px] text-brand-subtle">{data.transactions.length} total</span>
          </div>
          <div className="grid grid-cols-[0.9fr_1.1fr_1fr_0.7fr_0.7fr] gap-2 bg-[#f7f7f4] px-4 py-2 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[900px]:grid-cols-[1fr_0.8fr_0.7fr]">
            <span>Date</span>
            <span>Order</span>
            <span className="max-[900px]:hidden">Cashier</span>
            <span>Total</span>
            <span>Status</span>
          </div>
          {recentTxns.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              className="grid cursor-pointer grid-cols-[0.9fr_1.1fr_1fr_0.7fr_0.7fr] gap-2 border-t border-brand-softline px-4 py-2.5 text-xs hover:bg-[#fafaf7] max-[900px]:grid-cols-[1fr_0.8fr_0.7fr]"
              onClick={() => openTxnDetail(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') openTxnDetail(item)
              }}
            >
              <span className="text-[11px] text-brand-slate">{item.time || item.date || '—'}</span>
              <strong className="truncate text-brand-ink">{item.id.slice(0, 8)}</strong>
              <span className="truncate max-[900px]:hidden">{item.cashier}</span>
              <span>{money(item.total)}</span>
              <span className={item.status === 'Voided' ? 'text-brand-danger' : 'text-brand-success'}>{item.status}</span>
            </div>
          ))}
          {data.transactions.length === 0 && (
            <div className="px-4 py-6 text-xs text-brand-subtle">No transactions yet.</div>
          )}
        </TableCard>

        <TableCard className="max-h-none">
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="m-0 text-base">Day ends</h2>
            <span className="text-[11px] text-brand-subtle">{(data.dayEnds || []).length} recorded</span>
          </div>
          {closedToday && (
            <div className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md bg-brand-warn-bg px-3 py-2.5 text-xs text-brand-warn">
              <span>Business day {todayKey} is closed — POS sales locked for this branch.</span>
              <PrimaryButton compact type="button" disabled={reopening === closedToday.id} onClick={() => handleReopen(closedToday)}>
                {reopening === closedToday.id ? 'Reopening…' : 'Reopen till'}
              </PrimaryButton>
            </div>
          )}
          <div className="grid grid-cols-[0.85fr_0.65fr_0.65fr_0.65fr_0.7fr_1fr_auto] gap-2 bg-[#f7f7f4] px-4 py-2 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[900px]:grid-cols-[1fr_0.8fr_0.8fr]">
            <span>Date</span>
            <span>Expected</span>
            <span>Counted</span>
            <span>Variance</span>
            <span className="max-[900px]:hidden">Status</span>
            <span className="max-[900px]:hidden">Note</span>
            <span />
          </div>
          {(data.dayEnds || []).slice(0, 8).map((entry) => (
            <div key={entry.id} className="grid grid-cols-[0.85fr_0.65fr_0.65fr_0.65fr_0.7fr_1fr_auto] gap-2 border-t border-brand-softline px-4 py-2.5 text-xs max-[900px]:grid-cols-[1fr_0.8fr_0.8fr]">
              <div>
                <strong className="block text-brand-ink">{entry.date}</strong>
                <small className="text-[10px] text-brand-subtle">
                  {entry.closedAt || '—'}
                  {entry.cashier ? ` · ${entry.cashier}` : ''}
                </small>
              </div>
              <span>{money(entry.recordedCash)}</span>
              <span>{money(entry.cashOnHand)}</span>
              <span className={Number(entry.variance) === 0 ? 'text-brand-success' : 'text-brand-danger'}>
                {money(entry.variance)}
              </span>
              <span className="capitalize max-[900px]:hidden">{entry.status || 'closed'}</span>
              <span className="truncate text-brand-slate max-[900px]:hidden" title={entry.note || ''}>
                {entry.note || '—'}
              </span>
              <span className="text-right">
                {entry.status === 'closed' && (
                  <button
                    type="button"
                    className="border-0 bg-transparent text-[11px] font-bold text-brand-ink underline disabled:opacity-40"
                    disabled={reopening === entry.id}
                    onClick={() => handleReopen(entry)}
                  >
                    Reopen
                  </button>
                )}
              </span>
            </div>
          ))}
          {(data.dayEnds || []).length === 0 && (
            <div className="px-4 py-6 text-xs text-brand-subtle">No day-end closings yet.</div>
          )}
        </TableCard>
      </div>

      <TableCard className="max-h-none">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="m-0 text-base">Inventory</h2>
          <span className="text-[11px] text-brand-subtle">{data.products.length} SKUs</span>
        </div>
        <div className="grid grid-cols-[1.6fr_0.7fr_0.6fr_0.5fr] gap-2 bg-[#f7f7f4] px-4 py-2 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase">
          <span>Product</span>
          <span>SKU</span>
          <span>On hand</span>
          <span>Status</span>
        </div>
        {invSlice.map((product) => (
            <div key={product.id} className="grid grid-cols-[1.6fr_0.7fr_0.6fr_0.5fr] gap-2 border-t border-brand-softline px-4 py-2.5 text-xs">
              <strong className="truncate text-brand-ink">{product.name}</strong>
              <span className="truncate text-brand-subtle">{product.sku}</span>
              <span>{qty(product.stock, product.pricingMode === 'kg' ? 'kg' : 'pc')}</span>
              <span className={product.stock <= Number(product.lowStockAt ?? 5) ? 'text-brand-danger' : 'text-brand-success'}>
                {product.stock <= Number(product.lowStockAt ?? 5) ? 'Low' : 'OK'}
              </span>
            </div>
          ))}
        {data.products.length === 0 && (
          <div className="px-4 py-6 text-xs text-brand-subtle">No inventory rows yet.</div>
        )}
        {data.products.length > 0 && (
          <div className="flex items-center justify-between border-t border-brand-softline px-4 py-3">
            <span className="text-[11px] text-brand-subtle">
              Page {pageIndex + 1} of {invPages}
            </span>
            <div className="flex gap-2">
              <SecondaryButton
                compact
                type="button"
                disabled={pageIndex <= 0}
                onClick={() => setInvPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </SecondaryButton>
              <SecondaryButton
                compact
                type="button"
                disabled={pageIndex >= invPages - 1}
                onClick={() => setInvPage((p) => Math.min(invPages - 1, p + 1))}
              >
                Next
              </SecondaryButton>
            </div>
          </div>
        )}
      </TableCard>

      {editing && form && (
        <div className="fixed inset-0 z-[5] grid place-items-center bg-[#202426aa]">
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
            <div className="grid gap-3">
              <Field label="Branch name" required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Field label="Address" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <label className="grid gap-1.5 text-xs font-bold text-[#646a66]">
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
              <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
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

      {(detail || loadingDetail) && (
        <TransactionDetailModal
          detail={detail}
          loading={loadingDetail}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

export default ManagerBranchDashboard
