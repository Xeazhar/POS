import { useEffect, useMemo, useRef, useState } from 'react'
import { FiX } from 'react-icons/fi'
import { Link, useParams } from 'react-router-dom'
import TransactionDetailModal from '../../components/transactions/TransactionDetailModal'
import {
  ErrorBanner,
  Eyebrow,
  Field,
  PageHeader,
  Pager,
  PrimaryButton,
  SecondaryButton,
  TableCard,
  ToggleSwitch,
} from '../../components/ui'
import {
  bootstrapBranchData,
  fetchBranchTelemetry,
  fetchBranches,
  fetchTransactionDetail,
  hasSupabase,
  reopenDayEnd,
  saveBranch,
} from '../../lib/api'
import { BRANCH_DEVICES, normalizeDeviceSettings } from '../../devices'
import { useAuthStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { businessDate, formatOpenHourLabel, greetingFor, money, qty } from '../../utils/format'
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
  const [selectedProduct, setSelectedProduct] = useState(null)
  const [deviceBusy, setDeviceBusy] = useState(null)
  const autoOffRef = useRef('')

  useEffect(() => {
    let active = true
    setInvPage(0)
    setSelectedProduct(null)
    autoOffRef.current = ''
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
  const isRestaurant = branch?.branch_type === 'restaurant'
  const todayKey = businessDate(new Date(), openHour)
  const todayTx = data.transactions.filter((item) => item.status === 'Paid' && item.date === todayKey)
  const revenue = todayTx.reduce((sum, item) => sum + item.total, 0)
  const low = data.products.filter((product) => product.stock <= product.lowStockAt)
  const menuOn = data.products.filter((p) => p.availableToday !== false)
  const menuOff = data.products.filter((p) => p.availableToday === false)
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
  const closedToday = (data.dayEnds || []).find((entry) => entry.date === todayKey && entry.status === 'closed')

  const handleReopen = async (entry) => {
    setReopening(entry.id)
    setError('')
    try {
      await reopenDayEnd({ id: entry.id, staffId: user.id })
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

  const deviceSettings = normalizeDeviceSettings(branch?.device_settings)

  // Once per branch visit: if nothing is connected, force all toggles Off.
  useEffect(() => {
    if (!branch?.id || deviceBusy) return
    if (autoOffRef.current === branch.id) return
    const rows = telemetry.devices || []
    // Wait for telemetry so we don't auto-off before statuses load
    if (hasSupabase && rows.length === 0) return

    const anyConnected = rows.some((row) => row.state === 'connected')
    if (anyConnected) {
      autoOffRef.current = branch.id
      return
    }
    const current = normalizeDeviceSettings(branch.device_settings)
    const anyOn = Object.values(current).some(Boolean)
    autoOffRef.current = branch.id
    if (!anyOn) return

    const next = {
      barcode_scanner: false,
      receipt_printer: false,
      cash_drawer: false,
    }
    const applyLocal = (saved) => {
      setBranch(saved)
      if (user?.branchId === saved.id) {
        useAuthStore.setState({
          user: { ...user, deviceSettings: next },
        })
      }
    }
    if (!hasSupabase) {
      applyLocal({ ...branch, device_settings: next })
      return
    }
    setDeviceBusy('auto')
    saveBranch({
      id: branch.id,
      name: branch.name,
      address: branch.address,
      is_active: branch.is_active,
      device_settings: next,
    })
      .then((saved) => applyLocal({ ...saved, device_settings: saved.device_settings || next }))
      .catch((err) => {
        autoOffRef.current = ''
        setError(formatSupportError(err, 'DEV02'))
      })
      .finally(() => setDeviceBusy(null))
  }, [branch, telemetry.devices, deviceBusy, user])

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

  const recentTxns = useMemo(() => {
    return [...(data.transactions || [])]
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tb - ta
      })
      .slice(0, 8)
  }, [data.transactions])

  const productMovements = useMemo(() => {
    if (!selectedProduct) return []
    return (data.movements || []).filter((m) => m.productId === selectedProduct.id)
  }, [data.movements, selectedProduct])

  const invPages = Math.max(1, Math.ceil(data.products.length / PAGE_SIZE))
  const pageIndex = Math.min(invPage, invPages - 1)
  const invSlice = data.products.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  return (
    <div>
      <PageHeader
        eyebrow={isRestaurant ? 'CARINDERIA' : 'BRANCH'}
        title={`${greetingFor(user)}${branch?.name ? ` - ${branch.name}` : ''}`}
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

      <TableCard className="mb-4 max-h-none">
        <div className="px-4 py-3">
          <h2 className="m-0 text-base">Devices</h2>
          <p className="m-0 mt-0.5 text-[11px] text-brand-subtle">
            Switches start Off when nothing is connected. Turn On when hardware is ready.
          </p>
        </div>
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
                            ? 'text-[#2f6b3c]'
                            : 'text-brand-muted'
                      }`}
                    >
                      {!enabled
                        ? 'Disabled'
                        : connected
                          ? 'Connected'
                          : telemetryRow?.detail || 'Not Connected'}
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

      <div className="mb-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[700px]:grid-cols-1">
        {(isRestaurant
          ? [
              ['Sales today', money(revenue)],
              ['Orders today', todayTx.length],
              ['Potahe on menu', menuOn.length],
              ['Off today', menuOff.length],
            ]
          : [
              ['Revenue today', money(revenue)],
              ['Orders today', todayTx.length],
              ['Low stock', low.length],
              ['Reseko loss', money(shrink)],
            ]
        ).map(([label, value]) => (
          <div
            key={label}
            className="rounded-[9px] bg-brand-dark p-4 text-white max-[700px]:flex max-[700px]:items-center max-[700px]:justify-between max-[700px]:p-3.5"
          >
            <span className="block text-[11px] text-[#abb1ad]">{label}</span>
            <strong className="mt-2 block text-xl text-brand-gold max-[700px]:mt-0">{value}</strong>
          </div>
        ))}
      </div>

      {isRestaurant && plateMix.byCategory.length > 0 && (
        <TableCard className="mb-4 max-h-none">
          <div className="px-4 py-3">
            <h2 className="m-0 text-base">Plate mix today</h2>
            <p className="m-0 mt-0.5 text-[11px] text-brand-subtle">Sales by menu category (meat, veggie, pancit, etc.)</p>
          </div>
          <div className="grid grid-cols-[1.4fr_1fr] gap-2 bg-[#f7f7f4] px-4 py-2 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase">
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
              className="tap-row grid cursor-pointer grid-cols-[0.9fr_1.1fr_1fr_0.7fr_0.7fr] gap-2 border-t border-brand-softline px-4 py-2.5 text-xs hover:bg-[#fafaf7] active:bg-[#f0f1ec] max-[900px]:grid-cols-[1fr_0.8fr_0.7fr]"
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
                  {entry.cashier ? ` - ${entry.cashier}` : ''}
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
          <h2 className="m-0 text-base">{isRestaurant ? "Today's menu / potahe" : 'Inventory'}</h2>
          <span className="text-[11px] text-brand-subtle">
            {data.products.length} {isRestaurant ? 'items' : 'SKUs'}
          </span>
        </div>
        <div
          className={`grid gap-2 bg-[#f7f7f4] px-4 py-2 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase ${
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
            className={`grid gap-2 border-t border-brand-softline px-4 py-2.5 text-xs ${
              isRestaurant
                ? 'grid-cols-[2.5rem_1.6fr_1fr_0.7fr_0.7fr]'
                : 'tap-row cursor-pointer grid-cols-[2.5rem_1.6fr_0.7fr_0.6fr_0.5fr] hover:bg-[#fafaf7] active:bg-[#f0f1ec]'
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
            <span className="tabular-nums text-brand-subtle">{pageIndex * PAGE_SIZE + index + 1}</span>
            <strong className="truncate text-brand-ink">{product.name}</strong>
            <span className="truncate text-brand-subtle">
              {isRestaurant ? product.category : product.sku}
            </span>
            {isRestaurant ? (
              <>
                <span className="tabular-nums">{money(product.price)}</span>
                <span className={product.availableToday !== false ? 'text-brand-success' : 'text-brand-muted'}>
                  {product.availableToday !== false ? 'On' : 'Off'}
                </span>
              </>
            ) : (
              <>
                <span>{qty(product.stock, product.pricingMode === 'kg' ? 'kg' : 'pc')}</span>
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
        {data.products.length > 0 && (
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
            <div className="grid max-h-[70vh] gap-3 overflow-auto pr-1">
              <Field label="Branch name" required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Field label="Business name (receipt)" value={form.business_name || ''} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
              <Field label="Address" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <Field label="TIN" value={form.tin || ''} onChange={(e) => setForm({ ...form, tin: e.target.value })} />
              <Field label="BIR permit no." value={form.bir_permit_no || ''} onChange={(e) => setForm({ ...form, bir_permit_no: e.target.value })} />
              <Field label="Machine ID (MIN)" value={form.machine_identification_no || ''} onChange={(e) => setForm({ ...form, machine_identification_no: e.target.value })} />
              <Field label="Serial number" value={form.serial_number || ''} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} />
              <Field label="OR prefix" value={form.or_prefix || 'OR'} onChange={(e) => setForm({ ...form, or_prefix: e.target.value })} />
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

      {selectedProduct && !isRestaurant && (
        <div className="fixed inset-0 z-[5] bg-[#20242666]" onClick={() => setSelectedProduct(null)}>
          <aside
            className="absolute top-0 right-0 h-full w-[min(520px,92vw)] overflow-auto bg-white p-7 shadow-[-8px_0_24px_#20242622]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="absolute top-[17px] right-[17px] border-0 bg-transparent text-lg text-[#6e7470]"
              onClick={() => setSelectedProduct(null)}
            >
              <FiX />
            </button>
            <Eyebrow>PRODUCT HISTORY</Eyebrow>
            <h2 className="m-0 mb-1 text-lg capitalize">{selectedProduct.name}</h2>
            <p className="m-0 text-xs text-brand-muted">
              {selectedProduct.sku}
              {selectedProduct.barcode ? ` - ${selectedProduct.barcode}` : ''} -{' '}
              {selectedProduct.category || '—'}
            </p>

            <div className="mt-4 grid grid-cols-3 gap-2">
              <div className="rounded-md bg-[#f7f7f4] px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">On hand</span>
                <strong className="text-sm text-brand-ink">
                  {qty(selectedProduct.stock, selectedProduct.pricingMode === 'kg' ? 'kg' : 'pc')}
                </strong>
              </div>
              <div className="rounded-md bg-[#f7f7f4] px-3 py-2.5">
                <span className="block text-[10px] text-brand-subtle">Price</span>
                <strong className="text-sm text-brand-gold">{money(selectedProduct.price)}</strong>
              </div>
              <div className="rounded-md bg-[#f7f7f4] px-3 py-2.5">
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
    </div>
  )
}

export default ManagerBranchDashboard
