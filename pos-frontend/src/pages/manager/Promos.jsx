import { useEffect, useMemo, useState } from 'react'
import {
  hasSupabase,
  bootstrapBranchData,
  createAndActivatePromoEvent,
  createPromoRule,
  fetchActivePromoEventsWithRules,
  fetchPromoRulesForEvent,
  deletePromoRule,
  updatePromoEventDetails,
  fetchPromoEventsForBranch,
  deletePromoEvent,
  fetchBranches,
  approvePromoEvent,
  rejectPromoEvent,
  requestStopPromo,
  approveStopPromo,
  rejectStopPromo,
  fetchPromoSalesStats,
  fetchActivePromosAcrossBranches,
  fetchTransactionDetail,
  fetchRefundSummary,
  promoEffectiveStatus,
  promoStatusBadge,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { money, qty } from '../../utils/format'
import { isManagerRole } from '../../utils/roles'
import { isUuid } from '../../utils/transactionDetail'
import TransactionDetailModal from '../../components/transactions/TransactionDetailModal'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  Pager,
  PrimaryButton,
  SelectField,
  SecondaryButton,
  Skeleton,
  SkeletonRows,
  StatusBadge,
  TableCard,
  tableRowClass,
} from '../../components/ui'
import { FiPlus } from 'react-icons/fi'

const HISTORY_PAGE_SIZE = 10

/**
 * Searchable multi-select product list.
 *
 * Replaces one-at-a-time dropdowns: putting a promo on 30 items meant adding 30 separate
 * rules, one page interaction each. `item_pct` already applies its % to every product on
 * the rule, so one rule with many products is the same result for a fraction of the work.
 */
function ProductMultiSelect({ products, selected, onChange, label, hint }) {
  const [search, setSearch] = useState('')
  const term = search.trim().toLowerCase()
  const visible = term
    ? products.filter(
        (p) =>
          String(p.name || '').toLowerCase().includes(term) ||
          String(p.sku || '').toLowerCase().includes(term),
      )
    : products
  const selectedSet = new Set(selected)
  const visibleIds = visible.map((p) => p.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id))

  const toggle = (id, on) => {
    const next = new Set(selected)
    if (on) next.add(id)
    else next.delete(id)
    onChange([...next])
  }

  return (
    <div className="sm:col-span-2">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-brand-n700">
          {label}
          {selected.length > 0 && <span className="ml-1 text-brand-subtle">· {selected.length} selected</span>}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="border-0 bg-transparent text-[11px] font-bold text-brand-ink underline"
            onClick={() => {
              // Scoped to what the search is currently showing, so "select all" after a
              // search means "all the ones I filtered to", not the whole catalog.
              const next = new Set(selected)
              if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id))
              else visibleIds.forEach((id) => next.add(id))
              onChange([...next])
            }}
          >
            {allVisibleSelected ? 'Clear shown' : 'Select all shown'}
          </button>
          {selected.length > 0 && (
            <button
              type="button"
              className="border-0 bg-transparent text-[11px] font-bold text-brand-ink underline"
              onClick={() => onChange([])}
            >
              Clear all
            </button>
          )}
        </div>
      </div>
      <input
        className="mb-2 w-full rounded border border-brand-line bg-white p-2 text-xs text-brand-ink outline-none"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search name or SKU…"
      />
      <div className="max-h-[240px] overflow-auto rounded border border-brand-softline bg-white p-2.5">
        {visible.map((p) => (
          <label key={p.id} className="flex cursor-pointer items-center justify-between gap-3 py-1.5 text-xs">
            <span className="min-w-0 truncate">
              {p.name} <span className="text-brand-subtle">({p.sku})</span>
            </span>
            <input
              type="checkbox"
              checked={selectedSet.has(p.id)}
              onChange={(e) => toggle(p.id, e.target.checked)}
            />
          </label>
        ))}
        {visible.length === 0 && (
          <div className="py-3 text-center text-[11px] text-brand-subtle">No products match that search.</div>
        )}
      </div>
      {hint && <div className="mt-2 text-[11px] text-brand-subtle">{hint}</div>}
    </div>
  )
}

/**
 * Format a Date for an <input type="datetime-local"> value.
 *
 * Must be built from local getters, not `toISOString().slice(0,16)` — ISO is UTC, so that
 * shortcut shows a Manila manager a time 8 hours behind what they actually picked, and
 * saves back a promo that starts 8 hours early.
 */
function localDateTimeValue(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Manager / Supervisor Promos
 * - Promos are always scoped to one branch (never all branches)
 * - Managers pick the branch first, then manage that branch's promos
 * - Supervisors only see / manage promos for their assigned branch
 * - Several promos can be live on the same branch at once; POS applies the
 *   best discount per line across all of them (no stacking on one line)
 *
 * Promo rules:
 *  - item_pct: applies % off to a selected product (all units)
 *  - pair_pct: applies % off to both matched products (for matched quantity pairs)
 *  - bundle_pct: applies % off to all products in the bundle (for matched bundle sets)
 *  - bogo_pct: buy_qty/get_qty (default 1/1). Applies % discount to get units (second unit for B1T1)
 *
 * POS side will fetch `fetchActivePromoEventsWithRules(branchId)` and apply discounts automatically.
 */
export default function ManagerPromos() {
  const user = useAuthStore((s) => s.user)
  const managerView = isManagerRole(user?.role)

  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [products, setProducts] = useState([])

  // Several promo events can be live (active/stop_pending) on a branch at once.
  const [activeEvents, setActiveEvents] = useState([])
  const [managingId, setManagingId] = useState(null) // which live event's rules are being edited
  const [busy, setBusy] = useState(false)
  const [eventName, setEventName] = useState('')
  const [error, setError] = useState('')
  const [startsAt, setStartsAt] = useState('')
  const [endsAt, setEndsAt] = useState('')

  const [ruleType, setRuleType] = useState('item_pct')
  const [discountPct, setDiscountPct] = useState(20)
  const [productSingle, setProductSingle] = useState(null)
  const [productA, setProductA] = useState(null)
  const [productB, setProductB] = useState(null)
  const [bundleSelected, setBundleSelected] = useState([])
  const [itemSelected, setItemSelected] = useState([])

  const [history, setHistory] = useState([])
  const [historyPage, setHistoryPage] = useState(0)
  const [editingEventId, setEditingEventId] = useState(null)
  const [editStartsAt, setEditStartsAt] = useState('')
  const [editEndsAt, setEditEndsAt] = useState('')
  const [renameTarget, setRenameTarget] = useState(null) // { id, name } while the rename modal is open
  const [renameValue, setRenameValue] = useState('')
  const [pendingDelete, setPendingDelete] = useState(null)
  const [workingEvent, setWorkingEvent] = useState(null) // pending event for adding rules
  const [stopReason, setStopReason] = useState('')
  const [stopTarget, setStopTarget] = useState(null) // event being stopped, or null when modal closed
  const [historyStats, setHistoryStats] = useState({}) // eventId -> summary
  const [trackingEvent, setTrackingEvent] = useState(null) // { event, stats, busy }
  const [txnDetail, setTxnDetail] = useState(null)
  const [txnRefundSummary, setTxnRefundSummary] = useState(null)
  const [loadingTxnDetail, setLoadingTxnDetail] = useState(false)
  const [networkActive, setNetworkActive] = useState([])
  const [networkBusy, setNetworkBusy] = useState(false)
  const [pageLoading, setPageLoading] = useState(false)

  const selectedBranch = branches.find((b) => b.id === branchId)
  // The live event currently selected for rule editing / sales stats (defaults to the newest live event).
  const managedEvent = activeEvents.find((e) => e.event.id === managingId) || activeEvents[0] || null
  const historyPageCount = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE))
  const historyPageIndex = Math.min(historyPage, historyPageCount - 1)
  const historyPageRows = history.slice(
    historyPageIndex * HISTORY_PAGE_SIZE,
    historyPageIndex * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE,
  )
  const selectedProductsForRule = useMemo(() => {
    if (ruleType === 'item_pct') return itemSelected
    if (ruleType === 'bogo_pct') return [productSingle].filter(Boolean)
    if (ruleType === 'pair_pct') return [productA, productB].filter(Boolean)
    if (ruleType === 'bundle_pct') return bundleSelected
    return []
  }, [ruleType, itemSelected, productSingle, productA, productB, bundleSelected])

  // Managers: load all branches and require an explicit selection.
  // Supervisors: lock to their assigned branch only.
  useEffect(() => {
    if (!managerView) {
      const id = user?.branchId || (hasSupabase ? '' : 'demo-main-branch')
      setBranches([
        {
          id,
          name: user?.branchName || 'Assigned branch',
        },
      ])
      setBranchId(id)
      return
    }
    if (!hasSupabase) {
      setBranches([
        {
          id: user?.branchId || 'demo-main-branch',
          name: user?.branchName || 'Demo branch',
        },
      ])
      setBranchId('')
      return
    }
    fetchBranches()
      .then((rows) => {
        setBranches(rows)
        setBranchId('')
      })
      .catch((err) => setError(err.message))
  }, [user, managerView])

  useEffect(() => {
    setActiveEvents([])
    setManagingId(null)
    setHistory([])
    setHistoryPage(0)
    setProducts([])
    setProductSingle(null)
    setProductA(null)
    setProductB(null)
    setBundleSelected([])
    setItemSelected([])
    setEventName('')
    setStartsAt('')
    setEndsAt('')
    setEditingEventId(null)
    setEditStartsAt('')
    setEditEndsAt('')
    setPendingDelete(null)
    setWorkingEvent(null)

    if (!hasSupabase) return undefined

    // Manager with no branch: show all live promos across the network
    if (managerView && !branchId) {
      let alive = true
      setNetworkBusy(true)
      fetchActivePromosAcrossBranches()
        .then((rows) => {
          if (alive) setNetworkActive(rows)
        })
        .catch((e) => {
          if (alive) setError(e?.message || 'Failed to load active promos.')
        })
        .finally(() => {
          if (alive) setNetworkBusy(false)
        })
      return () => {
        alive = false
      }
    }

    setNetworkActive([])
    if (!branchId) {
      setPageLoading(false)
      return undefined
    }

    let alive = true
    setPageLoading(true)
    void (async () => {
      try {
        const data = await bootstrapBranchData(branchId)
        if (!alive) return
        setProducts(data.products || [])
        const next = await fetchActivePromoEventsWithRules(branchId, { respectDuration: false })
        if (!alive) return
        setActiveEvents(next)
        setManagingId((prev) => (next.some((e) => e.event.id === prev) ? prev : next[0]?.event.id || null))
        const rows = await fetchPromoEventsForBranch(branchId)
        if (alive) setHistory(rows)
      } catch (e) {
        if (alive) setError(e?.message || 'Failed to load branch promos.')
      } finally {
        if (alive) setPageLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [branchId, managerView])

  useEffect(() => {
    // A new promo almost always starts now — pre-fill it so the manager only has to pick an
    // end. Only fills a blank field: never clobbers a start the manager already typed, and
    // never runs again once they have.
    setStartsAt((prev) => prev || localDateTimeValue(new Date()))
  }, [branchId])

  useEffect(() => {
    // Clear cached Sales summaries when switching branches.
    setHistoryStats({})
  }, [branchId])

  const openPromoTracking = async (eventRow) => {
    if (!branchId || !eventRow?.name) return
    setTrackingEvent({ event: eventRow, stats: null, busy: true })
    try {
      const stats = await fetchPromoSalesStats({
        branchId,
        promoName: eventRow.name,
        startsAt: eventRow.starts_at || null,
        endsAt: eventRow.ends_at || null,
      })
      setHistoryStats((prev) => ({
        ...prev,
        [eventRow.id]: {
          receiptCount: stats.receiptCount,
          discountTotal: stats.discountTotal,
          saleTotal: stats.saleTotal,
        },
      }))
      setTrackingEvent({ event: eventRow, stats, busy: false })
    } catch (e) {
      setError(e?.message || 'Failed to load promo transactions.')
      setTrackingEvent(null)
    }
  }

  const openTxnDetail = async (receipt) => {
    if (!receipt?.id) return
    setError('')
    setLoadingTxnDetail(true)
    setTxnDetail(null)
    setTxnRefundSummary(null)
    try {
      if (!hasSupabase || !isUuid(receipt.id)) {
        setError('Transaction details are only available after the sale has synced.')
        return
      }
      const [row, summary] = await Promise.all([
        fetchTransactionDetail(receipt.id),
        fetchRefundSummary(receipt.id).catch(() => null),
      ])
      setTxnDetail(row)
      setTxnRefundSummary(summary)
    } catch (err) {
      setError(err?.message || 'Could not load transaction')
    } finally {
      setLoadingTxnDetail(false)
    }
  }

  const refreshHistory = async () => {
    if (!hasSupabase || !branchId) {
      setHistory([])
      return
    }
    const rows = await fetchPromoEventsForBranch(branchId)
    setHistory(rows)
  }

  const refreshActive = async () => {
    if (!branchId) {
      setActiveEvents([])
      setManagingId(null)
      setWorkingEvent(null)
      setHistory([])
      return
    }
    const next = await fetchActivePromoEventsWithRules(branchId, { respectDuration: false })
    setActiveEvents(next)
    setManagingId((prev) => (next.some((e) => e.event.id === prev) ? prev : next[0]?.event.id || null))
    const rows = await fetchPromoEventsForBranch(branchId)
    setHistory(rows)
    const pending = (rows || []).find((r) => r.status === 'pending')
    if (pending) {
      const rules = await fetchPromoRulesForEvent(pending.id).catch(() => [])
      setWorkingEvent({
        event: {
          id: pending.id,
          name: pending.name,
          status: 'pending',
          startsAt: pending.starts_at,
          endsAt: pending.ends_at,
        },
        rules,
      })
    } else {
      setWorkingEvent(null)
    }
  }

  // Rule editor targets the pending draft if there is one, else the live event picked in "Manage rules".
  const eventForRules = workingEvent || managedEvent

  const onCreateEvent = async () => {
    if (!branchId) {
      setError('Select a branch before creating a promo.')
      return
    }
    if (!eventName.trim()) return
    if (!startsAt || !endsAt) {
      setError('Enter a promo duration (Starts at + Ends at) before creating.')
      return
    }
    setBusy(true)
    setError('')
    try {
      // Managers create drafts they activate themselves; supervisors submit for manager approval.
      await createAndActivatePromoEvent({
        branchId,
        name: eventName.trim(),
        startsAt: startsAt || null,
        endsAt: endsAt || null,
        staffId: user?.id,
      })
      setEventName('')
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to create promo event.')
    } finally {
      setBusy(false)
    }
  }

  const onApproveCreate = async (id) => {
    setBusy(true)
    setError('')
    try {
      await approvePromoEvent({ id, staffId: user.id })
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to approve promo.')
    } finally {
      setBusy(false)
    }
  }

  const onRejectCreate = async (id) => {
    setBusy(true)
    setError('')
    try {
      await rejectPromoEvent({ id, staffId: user.id })
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to reject promo.')
    } finally {
      setBusy(false)
    }
  }

  const onRequestStop = async () => {
    if (!stopTarget?.id || !stopReason.trim()) {
      setError(managerView ? 'Enter a reason to stop this promo.' : 'Enter a reason to request stop.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await requestStopPromo({ id: stopTarget.id, staffId: user.id, reason: stopReason.trim() })
      // Managers are the approvers — stop immediately after recording the reason.
      if (managerView) {
        await approveStopPromo({ id: stopTarget.id, staffId: user.id })
      }
      setStopTarget(null)
      setStopReason('')
      await refreshActive()
    } catch (e) {
      setError(e?.message || (managerView ? 'Failed to stop promo.' : 'Failed to request stop.'))
    } finally {
      setBusy(false)
    }
  }

  const onApproveStop = async (id) => {
    setBusy(true)
    setError('')
    try {
      await approveStopPromo({ id, staffId: user.id })
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to approve stop.')
    } finally {
      setBusy(false)
    }
  }

  const onRejectStop = async (id) => {
    setBusy(true)
    setError('')
    try {
      await rejectStopPromo({ id, staffId: user.id })
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to reject stop.')
    } finally {
      setBusy(false)
    }
  }

  const onDeleteRule = async (ruleId) => {
    if (!ruleId) return
    setBusy(true)
    setError('')
    try {
      await deletePromoRule(ruleId)
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to delete promo rule.')
    } finally {
      setBusy(false)
    }
  }

  const isoToLocalValueForEdit = (iso) => (iso ? localDateTimeValue(iso) : '')

  const onDeleteEvent = async (promoEventId) => {
    if (!promoEventId) return
    setBusy(true)
    setError('')
    try {
      await deletePromoEvent(promoEventId)
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to delete promo event.')
    } finally {
      setBusy(false)
    }
  }

  const onStartEditEvent = (row) => {
    if (!row?.id) return
    setEditingEventId(row.id)
    setEditStartsAt(isoToLocalValueForEdit(row.starts_at))
    setEditEndsAt(isoToLocalValueForEdit(row.ends_at))
  }

  const onCancelEditEvent = () => {
    setEditingEventId(null)
    setEditStartsAt('')
    setEditEndsAt('')
  }

  // Renaming is a typo fix, not a change to what the promo does — it never touches
  // schedule or approval state, so it needs no dual-control step. Note the name is also
  // what per-line promo attribution matches on (transaction_items.promo_name), so past
  // receipts keep the OLD name and stay correctly attributed to it.
  const onStartRenameEvent = (row) => {
    if (!row?.id) return
    setRenameTarget({ id: row.id, name: row.name || '' })
    setRenameValue(row.name || '')
  }

  const onSaveRename = async () => {
    const nextName = renameValue.trim()
    if (!renameTarget?.id || !nextName) return
    setBusy(true)
    setError('')
    try {
      await updatePromoEventDetails({ promoEventId: renameTarget.id, name: nextName })
      setRenameTarget(null)
      setRenameValue('')
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to rename promo.')
    } finally {
      setBusy(false)
    }
  }

  const openDeleteConfirm = (payload) => {
    setPendingDelete(payload)
  }

  const closeDeleteConfirm = () => {
    if (busy) return
    setPendingDelete(null)
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    if (pendingDelete.kind === 'rule') {
      await onDeleteRule(pendingDelete.id)
    } else if (pendingDelete.kind === 'event') {
      await onDeleteEvent(pendingDelete.id)
    }
    setPendingDelete(null)
  }

  const onSaveEditEvent = async () => {
    if (!editingEventId) return
    if (!editStartsAt || !editEndsAt) {
      setError('Enter Starts + Ends when modifying an event.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await updatePromoEventDetails({
        promoEventId: editingEventId,
        startsAt: editStartsAt || null,
        endsAt: editEndsAt || null,
      })
      await refreshActive()
      onCancelEditEvent()
    } catch (e) {
      setError(e?.message || 'Failed to modify promo event duration.')
    } finally {
      setBusy(false)
    }
  }

  const onAddRule = async () => {
    const eventId = eventForRules?.event?.id
    if (!eventId) return
    if (!selectedProductsForRule.length) return
    if (discountPct < 0 || discountPct > 100) return
    setBusy(true)
    setError('')
    try {
      let buyQty = 1
      let getQty = 1
      if (ruleType !== 'bogo_pct') {
        buyQty = 1
        getQty = 1
      }
      await createPromoRule({
        promoEventId: eventId,
        ruleType,
        discountPct: Number(discountPct),
        productIds: selectedProductsForRule,
        buyQty,
        getQty,
      })

      setProductSingle(null)
      setProductA(null)
      setProductB(null)
      setBundleSelected([])
      setItemSelected([])
    setItemSelected([])
      await refreshActive()
    } catch (e) {
      setError(e?.message || 'Failed to create promo rule.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <PageHeader eyebrow={managerView ? 'MANAGER' : 'SUPERVISOR'} title="Manage promo events" />
      {error && <div className="mb-3 rounded-md border border-brand-danger bg-white px-3 py-2 text-xs text-brand-danger">{error}</div>}

      {pageLoading ? (
        <PageSkeleton variant="table" />
      ) : (
      <>

      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {managerView ? (
            <SelectField
              label="Branch"
              className="w-full min-w-0 sm:max-w-[280px]"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">All branches · active overview</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <p className="m-0 text-xs text-brand-muted sm:pb-1">
              Branch: <strong className="text-brand-ink">{user?.branchName || selectedBranch?.name || 'Assigned branch'}</strong>
              <span className="mt-1 block text-brand-subtle">You can only view promos for your assigned branch.</span>
            </p>
          )}
          {managerView && branchId && (
            <p className="m-0 text-xs text-brand-subtle sm:pb-1">
              Promo applies only to <strong className="text-brand-ink">{selectedBranch?.name || 'this branch'}</strong>
            </p>
          )}
          {managerView && !branchId && (
            <p className="m-0 text-xs text-brand-subtle sm:pb-1">
              Showing live promos across all branches. Select a branch to create or edit.
            </p>
          )}
        </div>
      </TableCard>

      {!branchId ? (
        managerView ? (
          <TableCard className="max-h-none overflow-hidden">
            <div className="px-5 pt-4 pb-2">
              <Eyebrow>NETWORK</Eyebrow>
              <h2 className="m-0 text-lg">Active promos</h2>
              <p className="m-0 mt-1 text-xs text-brand-muted">
                Every live and stop-pending promo across branches
                {networkBusy ? '' : ` · ${networkActive.length} shown`}. Open a row to manage that branch.
              </p>
            </div>
            <div className="grid grid-cols-[1.2fr_1.3fr_1fr_0.9fr_0.8fr] gap-2 bg-brand-dark px-5 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[900px]:grid-cols-[1.2fr_1fr_0.8fr]">
              <span>Branch</span>
              <span>Promo</span>
              <span className="max-[900px]:hidden">Duration</span>
              <span>Status</span>
              <span className="text-right">Open</span>
            </div>
            {networkBusy && (
              <div className="px-2 py-2" role="status" aria-label="Loading">
                <SkeletonRows rows={4} cols={4} />
              </div>
            )}
            {!networkBusy &&
              networkActive.map((row) => {
                const fmt = (iso) => {
                  if (!iso) return '—'
                  const d = new Date(iso)
                  if (Number.isNaN(d.getTime())) return '—'
                  return d.toLocaleString([], {
                    month: '2-digit',
                    day: '2-digit',
                    year: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                }
                return (
                  <div
                    key={row.id}
                    role="button"
                    tabIndex={0}
                    className={`tap-row grid cursor-pointer grid-cols-[1.2fr_1.3fr_1fr_0.9fr_0.8fr] gap-2 px-5 py-3 text-xs max-[900px]:grid-cols-[1.2fr_1fr_0.8fr] ${tableRowClass}`}
                    onClick={() => setBranchId(row.branch_id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') setBranchId(row.branch_id)
                    }}
                  >
                    <strong className="truncate text-brand-ink">{row.branchName}</strong>
                    <span className="min-w-0">
                      <strong className="block truncate text-brand-ink">{row.name}</strong>
                      {row.stop_reason ? (
                        <span className="mt-0.5 block truncate text-[10px] text-brand-warn">
                          Stop: {row.stop_reason}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-brand-slate max-[900px]:hidden">
                      {fmt(row.starts_at)} → {fmt(row.ends_at)}
                    </span>
                    {/* justify-self-start: as a direct grid child the badge would otherwise
                        stretch to the full column and the pill ends up far wider than its
                        text. `compact` sizes it to the label, matching the status tags
                        used in the transaction lists. */}
                    <StatusBadge
                      compact
                      className="justify-self-start capitalize"
                      tone={row.status === 'stop_pending' ? 'warn' : 'success'}
                    >
                      {row.status === 'stop_pending' ? 'Stop pending' : row.status || 'active'}
                    </StatusBadge>
                    <span className="text-right font-bold text-brand-ink underline">Manage</span>
                  </div>
                )
              })}
            {!networkBusy && networkActive.length === 0 && (
              <div className="px-5 py-6 text-xs text-brand-subtle">
                No active promos on any branch right now. Select a branch to create one.
              </div>
            )}
          </TableCard>
        ) : (
          <TableCard className="max-h-none overflow-visible p-5">
            <p className="m-0 text-sm text-brand-muted">No assigned branch found for this account.</p>
          </TableCard>
        )
      ) : (
        <>
      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="grid gap-4 sm:grid-cols-2 sm:items-start">
          <div>
            <Eyebrow>Live promos{activeEvents.length ? ` · ${activeEvents.length}` : ''}</Eyebrow>
            <p className="m-0 mt-1 text-xs text-brand-muted">
              {managerView
                ? 'Create a promo, add rules, then activate it. Several promos can run at once — Supervisor-submitted promos appear here for your approval.'
                : 'New promos need manager approval before going live. Stopping also needs manager approval first.'}
            </p>
            {!activeEvents.length ? (
              <p className="m-0 mt-3 text-sm text-brand-ink">No live promo right now.</p>
            ) : (
              <>
              {/* Selector and its actions on ONE row, bottom-aligned (`items-end`) so the
                  buttons line up with the select box itself. They used to sit on a second
                  row right-aligned under a full-width select, which read as floating
                  loose rather than belonging to the control they act on. */}
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <SelectField
                  label="Managing"
                  className="min-w-[220px] flex-1"
                  value={managingId || ''}
                  onChange={(e) => setManagingId(e.target.value)}
                >
                  {activeEvents.map((evt) => (
                    <option key={evt.event.id} value={evt.event.id}>
                      {evt.event.name} · {evt.event.status === 'stop_pending' ? 'Stop pending' : 'Active'}
                    </option>
                  ))}
                </SelectField>

                {/* No "Active" badge: everything in this dropdown is live by definition, and
                    the option label already spells out Active vs Stop pending. */}
                {managedEvent && (
                  <>
                    <SecondaryButton compact type="button" disabled={busy} onClick={() => onStartRenameEvent(managedEvent.event)}>
                      Rename
                    </SecondaryButton>
                    {managedEvent.event.status === 'active' && (
                      <PrimaryButton compact type="button" disabled={busy} onClick={() => setStopTarget(managedEvent.event)}>
                        {managerView ? 'Stop promo' : 'Request stop'}
                      </PrimaryButton>
                    )}
                    {managerView && managedEvent.event.status === 'stop_pending' && (
                      <>
                        <PrimaryButton compact type="button" disabled={busy} onClick={() => onApproveStop(managedEvent.event.id)}>
                          Approve stop
                        </PrimaryButton>
                        <SecondaryButton compact type="button" disabled={busy} onClick={() => onRejectStop(managedEvent.event.id)}>
                          Reject stop
                        </SecondaryButton>
                      </>
                    )}
                  </>
                )}
              </div>
              {managedEvent?.event?.status === 'stop_pending' && managedEvent.event.stopReason && (
                <p className="mt-1 mb-0 text-[11px] text-brand-warn">
                  Stop awaiting manager approval: {managedEvent.event.stopReason}
                </p>
              )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field
                  label={managerView ? 'New promo event' : 'Request new promo event'}
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  placeholder="e.g. Valentines"
                />
              </div>
              <PrimaryButton
                compact
                type="button"
                disabled={busy || !branchId || !eventName.trim() || !startsAt || !endsAt}
                onClick={onCreateEvent}
              >
                {busy ? 'Saving…' : managerView ? 'Create promo' : 'Submit for approval'}
              </PrimaryButton>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                <div className="mb-1 font-bold text-brand-muted">Starts at</div>
                <input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
                />
              </label>
              <label className="block text-xs">
                <div className="mb-1 font-bold text-brand-muted">Ends at</div>
                <input
                  type="datetime-local"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
                />
              </label>
            </div>
          </div>
        </div>
      </TableCard>

      {/* Most urgent first: a draft waiting on you needs action before anything else here matters. */}
      {workingEvent && (
        <TableCard className="mb-4 max-h-none overflow-visible p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Eyebrow>{managerView ? 'READY TO ACTIVATE' : 'PENDING APPROVAL'}</Eyebrow>
              <h2 className="m-0 text-lg">{workingEvent.event.name}</h2>
              <p className="m-0 mt-1 text-xs text-brand-muted">
                {managerView
                  ? 'Add rules, then activate when ready. Not live on POS yet.'
                  : 'Add rules while waiting. Not live on POS yet.'}
              </p>
            </div>
            {managerView && (
              <div className="flex gap-2">
                <PrimaryButton compact type="button" disabled={busy} onClick={() => onApproveCreate(workingEvent.event.id)}>
                  Activate
                </PrimaryButton>
                <SecondaryButton compact type="button" disabled={busy} onClick={() => onRejectCreate(workingEvent.event.id)}>
                  Discard
                </SecondaryButton>
              </div>
            )}
          </div>
        </TableCard>
      )}

      {/*
        Promo sales/performance lives on the History row's "Sales" action (below) — a
        separate always-visible stats card for the currently-managed promo duplicated that
        same data, so it was removed. Rules / Add rule live further below, full width —
        editing a promo's structure needs room, not a half-width column.
      */}
      <TableCard className="mb-4 max-h-none p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="m-0 text-base">Promo history</h2>
                <p className="m-0 mt-1 text-xs text-brand-subtle">
                  Past and current events with sales tracking — open Sales to see receipts and items sold.
                </p>
              </div>
            </div>

            {history.length ? (
              // Full-bleed: negative margin cancels the card's p-5 so the dark header row
              // reaches both edges instead of floating in a white gutter, and the first/last
              // cells get that padding back individually so text still lines up with the title.
              <div className="-mx-5 mt-4 overflow-x-auto overflow-y-visible">
                <table className="min-w-full text-left text-xs [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <thead className="bg-brand-dark text-[9px] tracking-[1px] text-brand-ondark uppercase">
                    <tr>
                      <th className="px-3 py-2.5">Promo name</th>
                      <th className="px-3 py-2.5">Schedule</th>
                      <th className="px-3 py-2.5">Status</th>
                      <th className="px-3 py-2.5 text-right">Promo receipts</th>
                      <th className="px-3 py-2.5 text-right">Discount given</th>
                      <th className="px-3 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyPageRows.map((e) => {
                      // Effective, not stored: a promo past its end date reads as expired even
                      // if the DB sweep hasn't run yet. Keeps the row (and the Delete button
                      // below) honest the moment the end time passes.
                      const status = promoEffectiveStatus(e)
                      const badge = promoStatusBadge(e)
                      const isLive = status === 'active' || status === 'stop_pending'
                      const endedByClock = isLive !== (e.status === 'active' || e.status === 'stop_pending')
                      const isEditing = editingEventId === e.id
                      const stats = historyStats[e.id]
                      const fmt = (iso) => {
                        if (!iso) return '—'
                        const d = new Date(iso)
                        if (Number.isNaN(d.getTime())) return '—'
                        return d.toLocaleString([], { month: '2-digit', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
                      }

                      return (
                        <tr key={e.id} className="border-t border-brand-softline">
                          <td className="px-3 py-3 font-bold text-brand-ink">{e.name}</td>
                          <td className="px-3 py-3">{fmt(e.starts_at)} → {fmt(e.ends_at)}</td>
                          {/* Colour-coded, and Stopped never renders as Expired or vice
                              versa: "a manager pulled this" and "this finished on
                              schedule" are different facts. */}
                          <td className="px-3 py-3">
                            <StatusBadge compact tone={badge.tone} title={badge.hint}>
                              {badge.label}
                            </StatusBadge>
                            {status === 'stopped' && e.stop_reason && (
                              <span className="mt-0.5 block text-[10px] text-brand-subtle">
                                {e.stop_reason}
                              </span>
                            )}
                            {endedByClock && (
                              <span className="mt-0.5 block text-[10px] text-brand-subtle">
                                Reached its end time
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {stats ? stats.receiptCount : '—'}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums text-brand-danger">
                            {stats ? `−${money(stats.discountTotal || 0)}` : '—'}
                          </td>
                          <td className="px-3 py-3 text-right">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              <button
                                type="button"
                                className="border-0 bg-transparent text-xs font-bold text-brand-danger underline"
                                disabled={busy}
                                onClick={() => openPromoTracking(e)}
                              >
                                Sales
                              </button>
                            {managerView && e.status === 'pending' && (
                              <>
                                <button
                                  type="button"
                                  className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                                  disabled={busy}
                                  onClick={() => onApproveCreate(e.id)}
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                                  disabled={busy}
                                  onClick={() => onRejectCreate(e.id)}
                                >
                                  Reject
                                </button>
                              </>
                            )}
                            {managerView && status === 'stop_pending' && (
                              <>
                                <button
                                  type="button"
                                  className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                                  disabled={busy}
                                  onClick={() => onApproveStop(e.id)}
                                >
                                  Approve stop
                                </button>
                                <button
                                  type="button"
                                  className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                                  disabled={busy}
                                  onClick={() => onRejectStop(e.id)}
                                >
                                  Reject stop
                                </button>
                              </>
                            )}
                            {/* Duration can be edited regardless of status — including an already-active
                                promo — this only ever touches starts_at/ends_at (updatePromoEventDetails),
                                never approval state, so it doesn't need to go through dual control. */}
                            <button
                              type="button"
                              className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                              disabled={busy || isEditing}
                              onClick={() => onStartEditEvent(e)}
                            >
                              Modify
                            </button>
                            <button
                              type="button"
                              className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                              disabled={busy}
                              onClick={() => onStartRenameEvent(e)}
                            >
                              Rename
                            </button>
                            {!isLive && (
                              <button
                                type="button"
                                className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                                disabled={busy}
                                onClick={() =>
                                  openDeleteConfirm({
                                    kind: 'event',
                                    id: e.id,
                                    label: e.name,
                                  })}
                              >
                                Delete
                              </button>
                            )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-4 text-xs text-brand-subtle">No promo events yet.</div>
            )}
            {historyPageCount > 1 && (
              <div className="-mx-5 -mb-5 mt-4">
                <Pager
                  page={historyPageIndex + 1}
                  pageCount={historyPageCount}
                  total={history.length}
                  label="events"
                  onPrev={() => setHistoryPage((p) => Math.max(0, p - 1))}
                  onNext={() => setHistoryPage((p) => Math.min(historyPageCount - 1, p + 1))}
                />
              </div>
            )}
      </TableCard>

      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="m-0 text-base">Rules</h2>
            <p className="m-0 mt-1 text-xs text-brand-subtle">
              {eventForRules?.rules?.length
                ? `${eventForRules.rules.length} rule(s) on ${eventForRules.event?.status || 'event'}`
                : 'Add rules to the pending or live event.'}
            </p>
          </div>
        </div>

        {eventForRules?.rules?.length ? (
          // Full-bleed to the card edges, same treatment as Promo history above.
          <div className="-mx-5 -mb-5 mt-4 overflow-x-auto overflow-y-visible">
            <table className="min-w-full text-left text-xs [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
              <thead className="bg-brand-dark text-[9px] tracking-[1px] text-brand-ondark uppercase">
                <tr>
                  <th className="px-3 py-2.5">Rule type</th>
                  <th className="px-3 py-2.5">Discount %</th>
                  <th className="px-3 py-2.5">Products in rule</th>
                  <th className="px-3 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {eventForRules.rules.map((r) => (
                  <tr key={r.id} className="border-t border-brand-softline">
                    <td className="px-3 py-3 font-bold text-brand-ink">{r.ruleType}</td>
                    <td className="px-3 py-3">
                      {r.discountPct}% off
                    </td>
                    <td className="px-3 py-3">
                      {r.ruleType === 'item_pct' && r.products[0]?.productName
                        ? `${r.products[0].productName}${r.products[0].sku ? ` (${r.products[0].sku})` : ''}`
                        : r.products.map((p) => p.productName || p.productId).join(', ')}
                      {r.ruleType === 'pair_pct' && r.products.length >= 2 && (
                        <span className="text-brand-subtle"> (pair)</span>
                      )}
                      {r.ruleType === 'bundle_pct' && r.products.length >= 2 && (
                        <span className="text-brand-subtle"> (bundle)</span>
                      )}
                      {r.ruleType === 'bogo_pct' && r.products[0] && (
                        <span className="text-brand-subtle">
                          {' '}
                          (buy {r.buyQty || 1} get {r.getQty || 1})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        type="button"
                        className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                        disabled={busy || eventForRules?.event?.status === 'stop_pending'}
                        onClick={() =>
                          openDeleteConfirm({
                            kind: 'rule',
                            id: r.id,
                            label: r.ruleType,
                          })}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mt-4 text-xs text-brand-subtle">No rules yet.</div>
        )}
      </TableCard>

      <TableCard className="max-h-none overflow-visible p-5">
        <h2 className="m-0 text-base">Add promo rule</h2>
        <p className="m-0 mt-1 text-xs text-brand-muted">
          Applied only when cashier did not select PWD/Senior (no stacking).
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <SelectField label="Rule type" value={ruleType} onChange={(e) => setRuleType(e.target.value)}>
            <option value="item_pct">Individual item % off</option>
            <option value="pair_pct">Pair % off (both items)</option>
            <option value="bundle_pct">Bundle % off (all bundle items)</option>
            <option value="bogo_pct">Buy 1 Take 1 % off second (B1T1)</option>
          </SelectField>

          <Field
            label="Discount % (0-100)"
            inputMode="decimal"
            value={String(discountPct)}
            onChange={(e) => setDiscountPct(Number(e.target.value.replace(/[^\d.]/g, '')))}
          />

          {/* item_pct applies its % to every product on the rule, so one rule covers as
              many items as you tick — no need for one rule per product. */}
          {ruleType === 'item_pct' && (
            <ProductMultiSelect
              label="Products on this promo"
              products={products}
              selected={itemSelected}
              onChange={setItemSelected}
              hint="Every ticked product gets this % off. One rule covers them all."
            />
          )}

          {/* BOGO stays single: buy/get quantities are counted against one product. */}
          {ruleType === 'bogo_pct' && (
            <SelectField
              label="Product"
              value={productSingle || ''}
              onChange={(e) => setProductSingle(e.target.value || null)}
            >
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku})
                </option>
              ))}
            </SelectField>
          )}

          {ruleType === 'pair_pct' && (
            <>
              <SelectField label="Product A" value={productA || ''} onChange={(e) => setProductA(e.target.value || null)}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </SelectField>
              <SelectField label="Product B" value={productB || ''} onChange={(e) => setProductB(e.target.value || null)}>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </SelectField>
            </>
          )}

          {ruleType === 'bundle_pct' && (
            <ProductMultiSelect
              label="Select bundle products"
              products={products}
              selected={bundleSelected}
              onChange={setBundleSelected}
              hint={bundleSelected.length < 2 ? 'Select at least 2 products for a bundle.' : null}
            />
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <SecondaryButton
            compact
            type="button"
            disabled={busy || !eventForRules?.event?.id || !selectedProductsForRule.length}
            onClick={onAddRule}
          >
            <FiPlus className="mr-1" />
            {busy ? 'Adding…' : 'Add rule'}
          </SecondaryButton>
        </div>
      </TableCard>
        </>
      )}

      {editingEventId && (
        <Modal onClose={onCancelEditEvent}>
          <Eyebrow>MODIFY PROMO</Eyebrow>
          <h2 className="m-0 text-lg">Update promo duration</h2>
          <p className="mt-1 mb-4 text-xs text-brand-muted">
            Set the new start and end date for this promo event.
          </p>

          <div className="grid gap-3">
            <label className="block text-xs">
              <div className="mb-1 font-bold text-brand-muted">Starts at</div>
              <input
                type="datetime-local"
                value={editStartsAt}
                onChange={(ev) => setEditStartsAt(ev.target.value)}
                className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
              />
            </label>
            <label className="block text-xs">
              <div className="mb-1 font-bold text-brand-muted">Ends at</div>
              <input
                type="datetime-local"
                value={editEndsAt}
                onChange={(ev) => setEditEndsAt(ev.target.value)}
                className="w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
              />
            </label>
          </div>

          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={onCancelEditEvent}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={onSaveEditEvent}>
              {busy ? 'Saving…' : 'Save changes'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {renameTarget && (
        <Modal onClose={() => !busy && setRenameTarget(null)}>
          <Eyebrow>RENAME PROMO</Eyebrow>
          <h2 className="m-0 text-lg">Fix the promo name</h2>
          <p className="mt-1 mb-4 text-xs text-brand-muted">
            Only the name changes — schedule, rules, and approval status stay as they are.
            Receipts already rung up keep the old name in their sales history.
          </p>
          <Field
            label="Promo name"
            value={renameValue}
            onChange={(ev) => setRenameValue(ev.target.value.replace(/[<>]/g, ''))}
            placeholder="e.g. Valentines"
          />
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setRenameTarget(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={busy || !renameValue.trim() || renameValue.trim() === renameTarget.name}
              onClick={onSaveRename}
            >
              {busy ? 'Saving…' : 'Save name'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {pendingDelete && (
        <Modal onClose={closeDeleteConfirm}>
          <Eyebrow>CONFIRM DELETE</Eyebrow>
          <h2 className="m-0 text-lg">
            Delete {pendingDelete.kind === 'rule' ? 'rule' : 'promo event'}?
          </h2>
          <p className="mt-1 mb-0 text-xs text-brand-muted">
            {pendingDelete.label ? `This will remove "${pendingDelete.label}". ` : ''}
            This action cannot be undone.
          </p>

          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={closeDeleteConfirm}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? 'Deleting…' : 'Confirm delete'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {stopTarget && (
        <Modal onClose={() => !busy && setStopTarget(null)}>
          <Eyebrow>{managerView ? 'STOP PROMO' : 'REQUEST STOP'}</Eyebrow>
          <h2 className="m-0 mb-2 text-lg">Stop {stopTarget.name}?</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            {managerView
              ? 'This ends the promo on POS immediately.'
              : 'Promo stays live until a manager approves this stop request.'}
          </p>
          <Field
            label="Reason (required)"
            value={stopReason}
            onChange={(e) => setStopReason(e.target.value.replace(/[<>]/g, ''))}
            placeholder="Why end this promo early?"
          />
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setStopTarget(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy || !stopReason.trim()} onClick={onRequestStop}>
              {busy ? (managerView ? 'Stopping…' : 'Submitting…') : managerView ? 'Stop now' : 'Submit stop request'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {trackingEvent && (
        <Modal wide onClose={() => setTrackingEvent(null)}>
          <Eyebrow>PROMO TRANSACTIONS</Eyebrow>
          <h2 className="m-0 text-lg">{trackingEvent.event?.name}</h2>
          <p className="m-0 mt-1 text-xs text-brand-muted">
            Receipts and items sold under this promo
            {trackingEvent.event?.status ? ` · ${trackingEvent.event.status}` : ''}
          </p>

          {trackingEvent.busy || !trackingEvent.stats ? (
            <div className="mt-4 space-y-2" role="status" aria-label="Loading sales">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-56" />
              <Skeleton className="mt-3 h-24 w-full" />
              <SkeletonRows rows={3} cols={3} />
            </div>
          ) : (
            <>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs max-[700px]:grid-cols-1">
                <div className="rounded-md bg-brand-n100 px-3 py-2">
                  <span className="block text-[10px] text-brand-subtle">Receipts</span>
                  <strong>{trackingEvent.stats.receiptCount}</strong>
                </div>
                <div className="rounded-md bg-brand-n100 px-3 py-2">
                  <span className="block text-[10px] text-brand-subtle">Discount given</span>
                  <strong className="text-brand-danger">−{money(trackingEvent.stats.discountTotal)}</strong>
                </div>
                <div className="rounded-md bg-brand-n100 px-3 py-2">
                  <span className="block text-[10px] text-brand-subtle">Net sales</span>
                  <strong>{money(trackingEvent.stats.saleTotal)}</strong>
                </div>
              </div>

              <div className="mt-4">
                <p className="m-0 mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-subtle">
                  Transactions
                </p>
                <div className="max-h-[240px] overflow-auto rounded border border-brand-softline">
                  <div className="grid grid-cols-[1fr_1fr_0.9fr_0.9fr] gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase">
                    <span>OR / Time</span>
                    <span>Cashier</span>
                    <span className="text-right">Discount</span>
                    <span className="text-right">Total</span>
                  </div>
                  {(trackingEvent.stats.receipts || []).map((r) => (
                    <div
                      key={r.id}
                      role="button"
                      tabIndex={0}
                      className={`tap-row grid cursor-pointer grid-cols-[1fr_1fr_0.9fr_0.9fr] gap-2 px-3 py-2 text-xs ${tableRowClass}`}
                      onClick={() => openTxnDetail(r)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') openTxnDetail(r)
                      }}
                      title="View transaction detail"
                    >
                      <div className="min-w-0">
                        <strong className="block truncate text-brand-ink">
                          {r.orNumber || String(r.id).slice(0, 8)}
                        </strong>
                        <span className="text-[10px] text-brand-subtle">{r.time}</span>
                      </div>
                      <span className="truncate">{r.cashier}</span>
                      <span className="text-right tabular-nums text-brand-danger">
                        −{money(r.discountAmount)}
                      </span>
                      <span className="text-right tabular-nums">{money(r.total)}</span>
                    </div>
                  ))}
                  {!(trackingEvent.stats.receipts || []).length && (
                    <div className="px-3 py-6 text-xs text-brand-subtle">No transactions for this promo.</div>
                  )}
                </div>
              </div>

              {(trackingEvent.stats.items || []).length > 0 && (
                <div className="mt-4">
                  <p className="m-0 mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-subtle">
                    Items sold
                  </p>
                  <div className="max-h-[200px] overflow-auto rounded border border-brand-softline">
                    <div className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr] gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase">
                      <span>Item</span>
                      <span className="text-right">Qty</span>
                      <span className="text-right">Discount</span>
                      <span className="text-right">Net</span>
                    </div>
                    {trackingEvent.stats.items.map((row) => (
                      <div
                        key={row.productId}
                        className="grid grid-cols-[1.4fr_0.7fr_0.9fr_0.9fr] gap-2 border-t border-brand-softline px-3 py-2 text-xs"
                      >
                        <strong className="truncate text-brand-ink">{row.name}</strong>
                        <span className="text-right tabular-nums">
                          {qty(row.qty, row.pricingMode === 'kg' ? 'kg' : 'pc')}
                        </span>
                        <span className="text-right tabular-nums text-brand-danger">−{money(row.discount)}</span>
                        <span className="text-right tabular-nums">{money(row.net)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setTrackingEvent(null)}>
              Close
            </SecondaryButton>
          </ModalActions>
        </Modal>
      )}

      {(txnDetail || loadingTxnDetail) && (
        <TransactionDetailModal
          layer={Boolean(trackingEvent)}
          detail={txnDetail}
          loading={loadingTxnDetail}
          refundSummary={txnRefundSummary}
          onClose={() => {
            setTxnDetail(null)
            setTxnRefundSummary(null)
            setLoadingTxnDetail(false)
          }}
        />
      )}
      </>
      )}
    </div>
  )
}

