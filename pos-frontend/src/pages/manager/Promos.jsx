import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  hasSupabase,
  bootstrapPosCatalog,
  fetchActivePromoEventsWithRules,
  fetchPromoEventsForBranch,
  deletePromoEvent,
  fetchBranches,
  approvePromoEvent,
  rejectPromoEvent,
  requestStopPromo,
  approveStopPromo,
  rejectStopPromo,
  requestPromoEdit,
  fetchPromoSalesStats,
  fetchPromoSalesStatsSummary,
  fetchActivePromosAcrossBranches,
  fetchPromoEventsAcrossBranches,
  fetchTransactionDetail,
  fetchRefundSummary,
  fetchBranchSalesTotal,
  fetchNetworkSalesTotal,
  fetchPromoRuleTypesForEvents,
  promoEffectiveStatus,
  promoStatusBadge,
} from '../../lib/api'
import { isOnline, readBranchSnapshot, readPromoCache, writePromoCache } from '../../offline'
import { withTimeout } from '../../utils/withTimeout'
import { useAuthStore, useProductStore } from '../../stores/posStore'
import { useLiveData } from '../../hooks/useLiveData'
import { money, qty } from '../../utils/format'
import { summarizePromoRuleTypes } from '../../utils/promo'
import { mapLimit } from '../../utils/mapLimit'
import { isManagerRole } from '../../utils/roles'
import { isUuid } from '../../utils/transactionDetail'
import TransactionDetailModal from '../../components/transactions/TransactionDetailModal'
import StatTiles from '../../components/dashboard/StatTiles'
import SalesMixBar from '../../components/dashboard/SalesMixBar'
import PromoEditorModal from '../../components/promos/PromoEditorModal'
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
  tableHeadClass,
  tableRowClass,
} from '../../components/ui'
import { FiMoreHorizontal } from 'react-icons/fi'

const HISTORY_PAGE_SIZE = 10

function SortableTh({ label, sortKey, current, onSort, className = '' }) {
  const active = current.key === sortKey
  const arrow = active ? (current.dir === 'asc' ? ' ↑' : ' ↓') : ''
  return (
    <th className={`px-3 py-2.5 ${className}`}>
      <button
        type="button"
        className="border-0 bg-transparent p-0 text-left text-[inherit] font-[inherit] tracking-[inherit] uppercase"
        onClick={() =>
          onSort({
            key: sortKey,
            dir: active && current.dir === 'desc' ? 'asc' : 'desc',
          })
        }
      >
        {label}
        {arrow}
      </button>
    </th>
  )
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
  const [managingId, setManagingId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const [history, setHistory] = useState([])
  const [historyPage, setHistoryPage] = useState(0)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [stopReason, setStopReason] = useState('')
  const [stopTarget, setStopTarget] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectTarget, setRejectTarget] = useState(null)
  const [historyStats, setHistoryStats] = useState({})
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [historySort, setHistorySort] = useState({ key: 'starts_at', dir: 'desc' })
  const [branchSalesTotal, setBranchSalesTotal] = useState(null)
  const [eventRuleTypes, setEventRuleTypes] = useState({})
  const [openActionsId, setOpenActionsId] = useState(null)
  const [actionsAnchor, setActionsAnchor] = useState(null)
  const [trackingEvent, setTrackingEvent] = useState(null)
  const [txnDetail, setTxnDetail] = useState(null)
  const [txnRefundSummary, setTxnRefundSummary] = useState(null)
  const [loadingTxnDetail, setLoadingTxnDetail] = useState(false)
  const [networkActive, setNetworkActive] = useState([])
  const [networkBusy, setNetworkBusy] = useState(false)
  const [networkHistory, setNetworkHistory] = useState([])
  const [networkHistoryBusy, setNetworkHistoryBusy] = useState(false)
  const [networkHistoryFrom, setNetworkHistoryFrom] = useState('')
  const [networkHistoryTo, setNetworkHistoryTo] = useState('')
  const [networkHistoryPage, setNetworkHistoryPage] = useState(0)
  const [networkHistorySort, setNetworkHistorySort] = useState({ key: 'starts_at', dir: 'desc' })
  const [networkHistoryStats, setNetworkHistoryStats] = useState({})
  const [networkEventRuleTypes, setNetworkEventRuleTypes] = useState({})
  const [networkSalesTotal, setNetworkSalesTotal] = useState(null)
  const [promoEditor, setPromoEditor] = useState(null)
  const [pageLoading, setPageLoading] = useState(false)

  const selectedBranch = branches.find((b) => b.id === branchId)
  // The live event currently selected for rule editing / sales stats (defaults to the newest live event).
  const managedEvent = activeEvents.find((e) => e.event.id === managingId) || activeEvents[0] || null
  // Filtered by the promo's start date, so "show me March" means "promos that started in March" —
  // the date a manager actually has in mind when they say "promo history for [range]".
  const filteredHistory = useMemo(() => {
    if (!historyFrom && !historyTo) return history
    return history.filter((e) => {
      if (!e.starts_at) return false
      const started = e.starts_at.slice(0, 10)
      if (historyFrom && started < historyFrom) return false
      if (historyTo && started > historyTo) return false
      return true
    })
  }, [history, historyFrom, historyTo])

  const sortedHistory = useMemo(() => {
    const rows = [...filteredHistory]
    const { key, dir } = historySort
    const mul = dir === 'asc' ? 1 : -1
    const discountPct = (e) => {
      const d = historyStats[e.id]?.discountTotal || 0
      if (!branchSalesTotal || branchSalesTotal <= 0) return -1
      return (d / branchSalesTotal) * 100
    }
    rows.sort((a, b) => {
      if (key === 'name') return mul * String(a.name || '').localeCompare(String(b.name || ''))
      if (key === 'rule_type') {
        return mul * summarizePromoRuleTypes(eventRuleTypes[a.id]).localeCompare(
          summarizePromoRuleTypes(eventRuleTypes[b.id]),
        )
      }
      if (key === 'starts_at') return mul * String(a.starts_at || '').localeCompare(String(b.starts_at || ''))
      if (key === 'receipts') {
        return mul * ((historyStats[a.id]?.receiptCount ?? -1) - (historyStats[b.id]?.receiptCount ?? -1))
      }
      if (key === 'discount') {
        return mul * ((historyStats[a.id]?.discountTotal ?? -1) - (historyStats[b.id]?.discountTotal ?? -1))
      }
      if (key === 'discount_pct') return mul * (discountPct(a) - discountPct(b))
      return 0
    })
    return rows
  }, [filteredHistory, historySort, historyStats, eventRuleTypes, branchSalesTotal])

  const historyPageCount = Math.max(1, Math.ceil(sortedHistory.length / HISTORY_PAGE_SIZE))
  const historyPageIndex = Math.min(historyPage, historyPageCount - 1)
  const historyPageRows = sortedHistory.slice(
    historyPageIndex * HISTORY_PAGE_SIZE,
    historyPageIndex * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE,
  )

  const branchPerformanceSummary = useMemo(() => {
    const promosRun = filteredHistory.filter((e) => !['pending', 'rejected'].includes(e.status)).length
    let totalDiscount = 0
    let totalReceipts = 0
    for (const e of filteredHistory) {
      const s = historyStats[e.id]
      if (!s) continue
      totalDiscount += s.discountTotal || 0
      totalReceipts += s.receiptCount || 0
    }
    const pctOfSales =
      branchSalesTotal && branchSalesTotal > 0 ? (totalDiscount / branchSalesTotal) * 100 : null
    return { promosRun, totalDiscount, totalReceipts, pctOfSales }
  }, [filteredHistory, historyStats, branchSalesTotal])
  // workingEvent (below) only ever surfaces the first pending row it finds — this covers
  // every pending request on the branch, not just one, so a second supervisor's submission
  // isn't invisible until someone happens to scroll into Promo History.
  const pendingRequests = useMemo(() => history.filter((r) => r.status === 'pending'), [history])
  const networkPendingRequests = useMemo(
    () => networkHistory.filter((r) => r.status === 'pending'),
    [networkHistory],
  )
  // Same shape as filteredHistory/historyPageRows above, but across every branch — its own
  // filter/page state since it's a different data set (all statuses, all branches) than the
  // single-branch table.
  const filteredNetworkHistory = useMemo(() => {
    if (!networkHistoryFrom && !networkHistoryTo) return networkHistory
    return networkHistory.filter((e) => {
      if (!e.starts_at) return false
      const started = e.starts_at.slice(0, 10)
      if (networkHistoryFrom && started < networkHistoryFrom) return false
      if (networkHistoryTo && started > networkHistoryTo) return false
      return true
    })
  }, [networkHistory, networkHistoryFrom, networkHistoryTo])

  const sortedNetworkHistory = useMemo(() => {
    const rows = [...filteredNetworkHistory]
    const { key, dir } = networkHistorySort
    const mul = dir === 'asc' ? 1 : -1
    const discountPct = (e) => {
      const d = networkHistoryStats[e.id]?.discountTotal || 0
      if (!networkSalesTotal || networkSalesTotal <= 0) return -1
      return (d / networkSalesTotal) * 100
    }
    rows.sort((a, b) => {
      if (key === 'branch') return mul * String(a.branchName || '').localeCompare(String(b.branchName || ''))
      if (key === 'name') return mul * String(a.name || '').localeCompare(String(b.name || ''))
      if (key === 'rule_type') {
        return mul * summarizePromoRuleTypes(networkEventRuleTypes[a.id]).localeCompare(
          summarizePromoRuleTypes(networkEventRuleTypes[b.id]),
        )
      }
      if (key === 'starts_at') return mul * String(a.starts_at || '').localeCompare(String(b.starts_at || ''))
      if (key === 'receipts') {
        return mul * ((networkHistoryStats[a.id]?.receiptCount ?? -1) - (networkHistoryStats[b.id]?.receiptCount ?? -1))
      }
      if (key === 'discount') {
        return mul * ((networkHistoryStats[a.id]?.discountTotal ?? -1) - (networkHistoryStats[b.id]?.discountTotal ?? -1))
      }
      if (key === 'discount_pct') return mul * (discountPct(a) - discountPct(b))
      return 0
    })
    return rows
  }, [filteredNetworkHistory, networkHistorySort, networkHistoryStats, networkEventRuleTypes, networkSalesTotal])

  const networkHistoryPageCount = Math.max(1, Math.ceil(sortedNetworkHistory.length / HISTORY_PAGE_SIZE))
  const networkHistoryPageIndex = Math.min(networkHistoryPage, networkHistoryPageCount - 1)
  const networkHistoryPageRows = sortedNetworkHistory.slice(
    networkHistoryPageIndex * HISTORY_PAGE_SIZE,
    networkHistoryPageIndex * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE,
  )

  const networkPerformanceSummary = useMemo(() => {
    const promosRun = filteredNetworkHistory.filter((e) => !['pending', 'rejected'].includes(e.status)).length
    let totalDiscount = 0
    let totalReceipts = 0
    for (const e of filteredNetworkHistory) {
      const s = networkHistoryStats[e.id]
      if (!s) continue
      totalDiscount += s.discountTotal || 0
      totalReceipts += s.receiptCount || 0
    }
    const pctOfSales =
      networkSalesTotal && networkSalesTotal > 0 ? (totalDiscount / networkSalesTotal) * 100 : null
    return { promosRun, totalDiscount, totalReceipts, pctOfSales }
  }, [filteredNetworkHistory, networkHistoryStats, networkSalesTotal])

  const networkRuleTypeChart = useMemo(() => {
    const byType = {}
    for (const e of filteredNetworkHistory) {
      const types = networkEventRuleTypes[e.id] || []
      const discount = networkHistoryStats[e.id]?.discountTotal || 0
      if (!discount) continue
      const label = summarizePromoRuleTypes(types)
      byType[label] = (byType[label] || 0) + discount
    }
    return Object.entries(byType)
      .map(([category, value]) => ({ category, value }))
      .sort((a, b) => b.value - a.value)
  }, [filteredNetworkHistory, networkEventRuleTypes, networkHistoryStats])

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
    setPendingDelete(null)
    setPromoEditor(null)

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
      setNetworkHistoryBusy(true)
      fetchPromoEventsAcrossBranches()
        .then((rows) => {
          if (alive) setNetworkHistory(rows)
        })
        .catch((e) => {
          if (alive) setError(e?.message || 'Failed to load promo history.')
        })
        .finally(() => {
          if (alive) setNetworkHistoryBusy(false)
        })
      return () => {
        alive = false
      }
    }

    setNetworkActive([])
    setNetworkHistory([])
    if (!branchId) {
      setPageLoading(false)
      return undefined
    }

    let alive = true
    setPageLoading(true)
    void (async () => {
      try {
        const storeProducts = useProductStore.getState().products
        if (storeProducts.length) {
          if (alive) setProducts(storeProducts)
        } else if (!isOnline()) {
          const local = await readBranchSnapshot(branchId)
          if (alive) setProducts(local.products || [])
        } else {
          const data = await withTimeout(bootstrapPosCatalog(branchId), 15000, 'Promo catalog')
          if (alive) setProducts(data.products || [])
        }

        if (!isOnline()) {
          const cached = await readPromoCache(branchId)
          if (alive) {
            setActiveEvents(cached?.active || [])
            setManagingId((prev) =>
              (cached?.active || []).some((e) => e.event.id === prev)
                ? prev
                : cached?.active?.[0]?.event.id || null,
            )
            setHistory(cached?.history || [])
          }
          return
        }

        const [next, rows] = await Promise.all([
          withTimeout(fetchActivePromoEventsWithRules(branchId, { respectDuration: false }), 15000, 'Active promos'),
          withTimeout(fetchPromoEventsForBranch(branchId), 15000, 'Promo history'),
        ])
        if (!alive) return
        setActiveEvents(next)
        setManagingId((prev) => (next.some((e) => e.event.id === prev) ? prev : next[0]?.event.id || null))
        if (alive) setHistory(rows)
        await writePromoCache(branchId, { active: next, history: rows })
      } catch (e) {
        const cached = await readPromoCache(branchId).catch(() => null)
        if (alive && cached) {
          setActiveEvents(cached.active || [])
          setHistory(cached.history || [])
        } else if (alive) {
          setError(e?.message || 'Failed to load branch promos.')
        }
      } finally {
        if (alive) setPageLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [branchId, managerView])

  useEffect(() => {
    setHistoryStats({})
    setEventRuleTypes({})
  }, [branchId])

  useEffect(() => {
    if (!branchId) {
      setBranchSalesTotal(null)
      return
    }
    fetchBranchSalesTotal({ branchId, from: historyFrom || null, to: historyTo || null })
      .then(setBranchSalesTotal)
      .catch(() => setBranchSalesTotal(null))
  }, [branchId, historyFrom, historyTo])

  useEffect(() => {
    if (!managerView || branchId) return
    fetchNetworkSalesTotal({ from: networkHistoryFrom || null, to: networkHistoryTo || null })
      .then(setNetworkSalesTotal)
      .catch(() => setNetworkSalesTotal(null))
  }, [managerView, branchId, networkHistoryFrom, networkHistoryTo])

  useEffect(() => {
    const ids = historyPageRows.map((e) => e.id)
    if (!ids.length) return
    fetchPromoRuleTypesForEvents(ids)
      .then((map) => setEventRuleTypes((prev) => ({ ...prev, ...map })))
      .catch(() => {})
  }, [historyPageRows])

  useEffect(() => {
    const ids = networkHistoryPageRows.map((e) => e.id)
    if (!ids.length) return
    fetchPromoRuleTypesForEvents(ids)
      .then((map) => setNetworkEventRuleTypes((prev) => ({ ...prev, ...map })))
      .catch(() => {})
  }, [networkHistoryPageRows])

  // Receipts/discount-given on Promo History used to only fill in once a manager opened a
  // row's Sales modal. Fetch the currently-visible page eagerly and keep it live off the
  // same realtime+poll pattern POS.jsx uses for promos, so a sale bumps the count without
  // anyone clicking in. Scoped to the visible page, not all history — each event's stats
  // query scans attributed promo lines directly, so doing this for every row ever created would be
  // a lot of redundant work for rows nobody is looking at.
  const refreshVisibleStats = useCallback(async () => {
    if (!branchId || !historyPageRows.length) return
    const entries = await mapLimit(historyPageRows, 3, async (e) => {
      try {
        const stats = await fetchPromoSalesStatsSummary({
          branchId,
          promoName: e.name,
          startsAt: e.starts_at || null,
          endsAt: e.ends_at || null,
        })
        return [e.id, { receiptCount: stats.receiptCount, discountTotal: stats.discountTotal, saleTotal: stats.saleTotal }]
      } catch {
        return null
      }
    })
    setHistoryStats((prev) => ({ ...prev, ...Object.fromEntries(entries.filter(Boolean)) }))
  }, [branchId, historyPageRows])

  useLiveData({
    enabled: !!branchId && historyPageRows.length > 0,
    fetch: refreshVisibleStats,
    tables: [
      { table: 'transactions', filter: `branch_id=eq.${branchId}` },
      { table: 'transaction_items' },
    ],
  })

  const refreshNetworkVisibleStats = useCallback(async () => {
    if (!networkHistoryPageRows.length) return
    const entries = await mapLimit(networkHistoryPageRows, 3, async (e) => {
      try {
        const stats = await fetchPromoSalesStatsSummary({
          branchId: e.branch_id,
          promoName: e.name,
          startsAt: e.starts_at || null,
          endsAt: e.ends_at || null,
        })
        return [e.id, { receiptCount: stats.receiptCount, discountTotal: stats.discountTotal, saleTotal: stats.saleTotal }]
      } catch {
        return null
      }
    })
    setNetworkHistoryStats((prev) => ({ ...prev, ...Object.fromEntries(entries.filter(Boolean)) }))
  }, [networkHistoryPageRows])

  useLiveData({
    enabled: managerView && !branchId && networkHistoryPageRows.length > 0,
    fetch: refreshNetworkVisibleStats,
    tables: [{ table: 'transactions' }, { table: 'transaction_items' }],
  })

  useEffect(() => {
    if (managerView && !branchId && networkHistoryPageRows.length) {
      void refreshNetworkVisibleStats()
    }
  }, [managerView, branchId, networkHistoryPageRows, refreshNetworkVisibleStats])

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
      setHistory([])
      return
    }
    const next = await fetchActivePromoEventsWithRules(branchId, { respectDuration: false })
    setActiveEvents(next)
    setManagingId((prev) => (next.some((e) => e.event.id === prev) ? prev : next[0]?.event.id || null))
    const rows = await fetchPromoEventsForBranch(branchId)
    setHistory(rows)
  }

  const openPromoEditor = async ({ mode, branchId: bId, event = null }) => {
    setError('')
    setOpenActionsId(null)
    setActionsAnchor(null)
    const targetBranch = bId || branchId
    setPromoEditor({
      mode,
      branchId: targetBranch,
      event,
    })
  }

  const closePromoEditor = useCallback(() => setPromoEditor(null), [])

  const onRequestEdit = async (row) => {
    if (!row?.id) return
    setBusy(true)
    setError('')
    try {
      const revision = await requestPromoEdit({ promoEventId: row.id, staffId: user.id })
      if (branchId && (row.branch_id || branchId) === branchId) await refreshActive()
      else await refreshNetworkOverview()
      await openPromoEditor({ mode: 'edit', branchId: row.branch_id || branchId, event: revision })
    } catch (e) {
      setError(e?.message || 'Failed to request promo edit.')
    } finally {
      setBusy(false)
    }
  }

  const renderPendingPromoRow = (r, { showBranch = false } = {}) => (
    <div
      key={r.id}
      className="flex flex-wrap items-center justify-between gap-2 rounded border border-brand-warn/40 bg-brand-warn/5 p-2.5"
    >
      <div className="min-w-0">
        {showBranch && <div className="text-[10px] font-bold uppercase tracking-wide text-brand-subtle">{r.branchName}</div>}
        <div className="text-xs font-bold text-brand-ink">{r.name}</div>
        {r.supersedes_event_id && (
          <div className="text-[10px] text-brand-warn">Edit revision — needs reapproval</div>
        )}
        {r.description && <div className="text-[11px] text-brand-subtle">{r.description}</div>}
        <div className="mt-0.5 text-[10px] text-brand-muted">
          {fmtPromoSchedule(r.starts_at)} → {fmtPromoSchedule(r.ends_at)}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <SecondaryButton
          compact
          type="button"
          disabled={busy}
          onClick={() => void openPromoEditor({ mode: 'edit', branchId: r.branch_id || branchId, event: r })}
        >
          Edit
        </SecondaryButton>
        {managerView && (
          <>
            <PrimaryButton compact type="button" disabled={busy} onClick={() => onApproveCreate(r.id)}>
              Approve
            </PrimaryButton>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setRejectTarget({ id: r.id, name: r.name })}>
              Reject
            </SecondaryButton>
          </>
        )}
      </div>
    </div>
  )

  const onEditorSaved = async () => {
    if (branchId) await refreshActive()
    else await refreshNetworkOverview()
  }

  // refreshActive() is branch-scoped and no-ops with no branch selected — actions taken from
  // the network view (approve/reject/create with no branch chosen) need this instead, or the
  // network tables just sit stale even though the backend call succeeded.
  const refreshNetworkOverview = async () => {
    setNetworkBusy(true)
    setNetworkHistoryBusy(true)
    await Promise.all([
      fetchActivePromosAcrossBranches()
        .then(setNetworkActive)
        .catch((e) => setError(e?.message || 'Failed to load active promos.'))
        .finally(() => setNetworkBusy(false)),
      fetchPromoEventsAcrossBranches()
        .then(setNetworkHistory)
        .catch((e) => setError(e?.message || 'Failed to load promo history.'))
        .finally(() => setNetworkHistoryBusy(false)),
    ])
  }

  const onApproveCreate = async (id) => {
    setBusy(true)
    setError('')
    try {
      await approvePromoEvent({ id, staffId: user.id })
      // Approve can be triggered from the network view's tables too, which has no selected
      // branch — refreshActive() only reloads branch-scoped state and no-ops without one.
      await (branchId ? refreshActive() : refreshNetworkOverview())
    } catch (e) {
      setError(e?.message || 'Failed to approve promo.')
    } finally {
      setBusy(false)
    }
  }

  const onSubmitReject = async () => {
    if (!rejectTarget?.id || !rejectReason.trim()) {
      setError('Enter a reason to reject this promo.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await rejectPromoEvent({ id: rejectTarget.id, staffId: user.id, reason: rejectReason.trim() })
      setRejectTarget(null)
      setRejectReason('')
      await (branchId ? refreshActive() : refreshNetworkOverview())
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

  const onDeleteEvent = async (promoEventId) => {
    if (!promoEventId) return
    setBusy(true)
    setError('')
    try {
      await deletePromoEvent(promoEventId)
      await (branchId ? refreshActive() : refreshNetworkOverview())
    } catch (e) {
      setError(e?.message || 'Failed to delete promo event.')
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
    if (!pendingDelete || pendingDelete.kind !== 'event') return
    await onDeleteEvent(pendingDelete.id)
    setPendingDelete(null)
  }

  const openPromoTrackingForRow = async (eventRow, rowBranchId) => {
    const bId = rowBranchId || branchId
    if (!bId || !eventRow?.name) return
    const statsMap = bId === branchId ? historyStats : networkHistoryStats
    const cached = statsMap[eventRow.id]
    const partialStats = cached
      ? { ...cached, receipts: [], offers: [], items: [] }
      : null
    setTrackingEvent({
      event: eventRow,
      stats: partialStats,
      busy: !partialStats,
      detailBusy: true,
      branchId: bId,
      branchName: eventRow.branchName,
    })
    try {
      const stats = await fetchPromoSalesStats({
        branchId: bId,
        promoName: eventRow.name,
        promoEventId: eventRow.id,
        startsAt: eventRow.starts_at || null,
        endsAt: eventRow.ends_at || null,
      })
      const patch = {
        receiptCount: stats.receiptCount,
        discountTotal: stats.discountTotal,
        saleTotal: stats.saleTotal,
      }
      if (bId === branchId) {
        setHistoryStats((prev) => ({ ...prev, [eventRow.id]: patch }))
      } else {
        setNetworkHistoryStats((prev) => ({ ...prev, [eventRow.id]: patch }))
      }
      setTrackingEvent({
        event: eventRow,
        stats,
        busy: false,
        detailBusy: false,
        branchId: bId,
        branchName: eventRow.branchName,
      })
    } catch (e) {
      setError(e?.message || 'Failed to load promo transactions.')
      setTrackingEvent(null)
    }
  }

  const fmtPromoSchedule = (iso) => {
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

  const renderPerformanceActionsMenu = (e, { isLive, isNetwork = false }) => {
    const status = promoEffectiveStatus(e)
    return (
      <div className="relative inline-block text-left">
        <button
          type="button"
          className="rounded p-1.5 text-brand-ink hover:bg-brand-n100"
          aria-label="Actions"
          aria-haspopup="true"
          aria-expanded={openActionsId === e.id}
          onClick={(event) => {
            if (openActionsId === e.id) {
              setOpenActionsId(null)
              setActionsAnchor(null)
              return
            }
            const rect = event.currentTarget.getBoundingClientRect()
            setActionsAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
            setOpenActionsId(e.id)
          }}
        >
          <FiMoreHorizontal />
        </button>
        {openActionsId === e.id && actionsAnchor && createPortal(
          <div
            className="fixed z-50 flex min-w-[170px] flex-col rounded-md border border-brand-line bg-white p-1 text-left shadow-lg"
            style={{ top: actionsAnchor.top, right: actionsAnchor.right }}
          >
            <button
              type="button"
              className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-danger hover:bg-brand-n100"
              disabled={busy}
              onClick={() => {
                setOpenActionsId(null)
                openPromoTrackingForRow(e, isNetwork ? e.branch_id : branchId)
              }}
            >
              Sales
            </button>
            {e.status === 'pending' && (
              <button
                type="button"
                className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-ink hover:bg-brand-n100"
                disabled={busy}
                onClick={() => {
                  setOpenActionsId(null)
                  void openPromoEditor({ mode: 'edit', branchId: e.branch_id || branchId, event: e })
                }}
              >
                Edit
              </button>
            )}
            {managerView && e.status === 'pending' && (
              <>
                <button
                  type="button"
                  className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-ink hover:bg-brand-n100"
                  disabled={busy}
                  onClick={() => {
                    setOpenActionsId(null)
                    onApproveCreate(e.id)
                  }}
                >
                  Approve
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-ink hover:bg-brand-n100"
                  disabled={busy}
                  onClick={() => {
                    setOpenActionsId(null)
                    setRejectTarget({ id: e.id, name: e.name })
                  }}
                >
                  Reject
                </button>
              </>
            )}
            {managerView && status === 'stop_pending' && (
              <>
                <button
                  type="button"
                  className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-ink hover:bg-brand-n100"
                  disabled={busy}
                  onClick={() => {
                    setOpenActionsId(null)
                    onApproveStop(e.id)
                  }}
                >
                  Approve stop
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-ink hover:bg-brand-n100"
                  disabled={busy}
                  onClick={() => {
                    setOpenActionsId(null)
                    onRejectStop(e.id)
                  }}
                >
                  Reject stop
                </button>
              </>
            )}
            {isLive && (
              <button
                type="button"
                className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-ink hover:bg-brand-n100"
                disabled={busy}
                onClick={() => {
                  setOpenActionsId(null)
                  void onRequestEdit(e)
                }}
              >
                Request edit
              </button>
            )}
            {!isLive && (
              <button
                type="button"
                className="rounded px-2 py-1.5 text-left text-xs font-bold text-brand-ink hover:bg-brand-n100"
                disabled={busy}
                onClick={() => {
                  setOpenActionsId(null)
                  openDeleteConfirm({ kind: 'event', id: e.id, label: e.name })
                }}
              >
                Delete
              </button>
            )}
          </div>,
          document.body,
        )}
      </div>
    )
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
          <>
          <TableCard className="max-h-none overflow-hidden">
            <div className="px-5 pt-4 pb-2">
              <Eyebrow>NETWORK</Eyebrow>
              <h2 className="m-0 text-lg">Active promos</h2>
              <p className="m-0 mt-1 text-xs text-brand-muted">
                Pending approval must be approved before going live on POS.
                {networkBusy ? '' : ` · ${networkActive.length} live`}
                {networkPendingRequests.length ? ` · ${networkPendingRequests.length} awaiting approval` : ''}
              </p>
            </div>

            {networkPendingRequests.length > 0 && (
              <div className="border-t border-brand-softline px-5 py-4">
                <p className="m-0 mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-warn">
                  Awaiting approval · {networkPendingRequests.length}
                </p>
                <div className="flex flex-col gap-2">
                  {networkPendingRequests.map((r) => renderPendingPromoRow(r, { showBranch: true }))}
                </div>
              </div>
            )}

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
            {!networkBusy && networkActive.length === 0 && networkPendingRequests.length === 0 && (
              <div className="px-5 py-6 text-xs text-brand-subtle">
                No active or pending promos on any branch right now. Select a branch to create one.
              </div>
            )}
            {!networkBusy && networkActive.length === 0 && networkPendingRequests.length > 0 && (
              <div className="px-5 py-4 text-xs text-brand-subtle">
                No live promos yet — approve a pending promo above to activate it on POS.
              </div>
            )}
          </TableCard>

          <TableCard className="mt-4 max-h-none overflow-visible p-0">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-brand-softline px-5 py-4">
              <div>
                <Eyebrow>NETWORK</Eyebrow>
                <h2 className="m-0 text-base">Promo performance</h2>
                <p className="m-0 mt-1 text-xs text-brand-muted">
                  Compare promos across branches — open Sales on any row for receipt and item detail.
                </p>
              </div>
              <PrimaryButton
                compact
                type="button"
                disabled={busy}
                onClick={() => void openPromoEditor({ mode: 'create', branchId: '' })}
              >
                Create promo
              </PrimaryButton>
            </div>

            <div className="px-5 py-4">
              <StatTiles
                embedded
                title="Summary"
                subtitle={networkHistoryFrom || networkHistoryTo ? 'Filtered by promo start date' : 'All promos'}
                items={[
                  { label: 'Total promos run', value: networkPerformanceSummary.promosRun },
                  {
                    label: 'Total discount given',
                    value: `−${money(networkPerformanceSummary.totalDiscount)}`,
                    tone: 'danger',
                  },
                  { label: 'Total promo receipts', value: networkPerformanceSummary.totalReceipts },
                  {
                    label: 'Discount % of sales',
                    value:
                      networkPerformanceSummary.pctOfSales != null
                        ? `${networkPerformanceSummary.pctOfSales.toFixed(1)}%`
                        : '—',
                    hint: networkSalesTotal ? `of ${money(networkSalesTotal)} branch sales` : null,
                  },
                ]}
              />
            </div>

            <div className="border-t border-brand-softline px-5 py-4">
              <SalesMixBar
                embedded
                mix={networkRuleTypeChart}
                title="Discount by rule type"
                subtitle={networkHistoryFrom || networkHistoryTo ? 'Filtered promos' : 'All promos'}
                showShare
                emptyMessage="No promo discount data in this period."
              />
            </div>

            <div className="border-t border-brand-softline px-5 pt-4 pb-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="m-0 text-base">Branch comparison</h2>
                <p className="m-0 mt-1 text-xs text-brand-subtle">
                  Sort columns to compare performance — Sales opens the same receipt drill-down as branch view.
                </p>
              </div>
              <div className="flex items-end gap-2">
                <label className="block text-[11px] font-bold text-brand-n700">
                  From
                  <input
                    type="date"
                    value={networkHistoryFrom}
                    onChange={(e) => {
                      setNetworkHistoryFrom(e.target.value)
                      setNetworkHistoryPage(0)
                    }}
                    className="mt-[7px] block rounded-[5px] border border-brand-input bg-white p-2 text-[12px] outline-none"
                  />
                </label>
                <label className="block text-[11px] font-bold text-brand-n700">
                  To
                  <input
                    type="date"
                    value={networkHistoryTo}
                    onChange={(e) => {
                      setNetworkHistoryTo(e.target.value)
                      setNetworkHistoryPage(0)
                    }}
                    className="mt-[7px] block rounded-[5px] border border-brand-input bg-white p-2 text-[12px] outline-none"
                  />
                </label>
                {(networkHistoryFrom || networkHistoryTo) && (
                  <button
                    type="button"
                    className="border-0 bg-transparent pb-2 text-[11px] font-bold text-brand-ink underline"
                    onClick={() => {
                      setNetworkHistoryFrom('')
                      setNetworkHistoryTo('')
                      setNetworkHistoryPage(0)
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {networkHistoryBusy && (
              <div className="mt-4" role="status" aria-label="Loading">
                <SkeletonRows rows={4} cols={8} />
              </div>
            )}

            {!networkHistoryBusy && networkHistoryPageRows.length ? (
              <div className="-mx-5 mt-4 overflow-x-auto overflow-y-visible">
                <table className="min-w-full text-left text-xs [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <thead className={tableHeadClass}>
                    <tr>
                      <SortableTh label="Branch" sortKey="branch" current={networkHistorySort} onSort={setNetworkHistorySort} />
                      <SortableTh label="Promo name" sortKey="name" current={networkHistorySort} onSort={setNetworkHistorySort} />
                      <SortableTh label="Rule type" sortKey="rule_type" current={networkHistorySort} onSort={setNetworkHistorySort} />
                      <SortableTh label="Date range" sortKey="starts_at" current={networkHistorySort} onSort={setNetworkHistorySort} />
                      <th className="px-3 py-2.5">Status</th>
                      <SortableTh label="Receipts" sortKey="receipts" current={networkHistorySort} onSort={setNetworkHistorySort} className="text-right" />
                      <SortableTh label="Discount given" sortKey="discount" current={networkHistorySort} onSort={setNetworkHistorySort} className="text-right" />
                      <SortableTh label="Discount % sales" sortKey="discount_pct" current={networkHistorySort} onSort={setNetworkHistorySort} className="text-right" />
                      <th className="px-3 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {networkHistoryPageRows.map((e) => {
                      const badge = promoStatusBadge(e)
                      const stats = networkHistoryStats[e.id]
                      const isLive = promoEffectiveStatus(e) === 'active' || promoEffectiveStatus(e) === 'stop_pending'
                      const discountPct =
                        stats?.discountTotal && networkSalesTotal > 0
                          ? ((stats.discountTotal / networkSalesTotal) * 100).toFixed(1)
                          : null
                      return (
                        <tr key={e.id} className="border-t border-brand-softline">
                          <td className="px-3 py-3 font-bold text-brand-ink">{e.branchName}</td>
                          <td className="px-3 py-3">
                            <span className="font-bold text-brand-ink">{e.name}</span>
                            {e.supersedes_event_id && (
                              <span className="mt-0.5 block text-[10px] text-brand-warn">Edit revision</span>
                            )}
                          </td>
                          <td className="px-3 py-3">{summarizePromoRuleTypes(networkEventRuleTypes[e.id])}</td>
                          <td className="px-3 py-3">{fmtPromoSchedule(e.starts_at)} → {fmtPromoSchedule(e.ends_at)}</td>
                          <td className="px-3 py-3">
                            <StatusBadge compact tone={badge.tone} title={badge.hint}>
                              {badge.label}
                            </StatusBadge>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{stats ? stats.receiptCount : '—'}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-brand-danger">
                            {stats ? `−${money(stats.discountTotal || 0)}` : '—'}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {discountPct != null ? `${discountPct}%` : '—'}
                          </td>
                          <td className="px-3 py-3 text-right">
                            {renderPerformanceActionsMenu(e, { isLive, isNetwork: true })}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              !networkHistoryBusy && (
                <div className="mt-4 text-xs text-brand-subtle">
                  {networkHistory.length ? 'No promo events in that date range.' : 'No promo events yet.'}
                </div>
              )
            )}
            {networkHistoryPageCount > 1 && (
              <div className="-mx-5 -mb-5 mt-4">
                <Pager
                  page={networkHistoryPageIndex + 1}
                  pageCount={networkHistoryPageCount}
                  total={sortedNetworkHistory.length}
                  label="events"
                  onPrev={() => setNetworkHistoryPage((p) => Math.max(0, p - 1))}
                  onNext={() => setNetworkHistoryPage((p) => Math.min(networkHistoryPageCount - 1, p + 1))}
                />
              </div>
            )}
            </div>
          </TableCard>
          </>
        ) : (
          <TableCard className="max-h-none overflow-visible p-5">
            <p className="m-0 text-sm text-brand-muted">No assigned branch found for this account.</p>
          </TableCard>
        )
      ) : (
        <>
      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <Eyebrow>Live promos{activeEvents.length ? ` · ${activeEvents.length}` : ''}</Eyebrow>
        <p className="m-0 mt-1 text-xs text-brand-muted">
          {managerView
            ? 'Approve pending promos below to go live on POS. Several promos can run at once once approved.'
            : 'New promos need manager approval before going live on POS.'}
          {pendingRequests.length > 0 && (
            <span className="mt-1 block font-bold text-brand-warn">
              {pendingRequests.length} awaiting approval — not live until approved.
            </span>
          )}
        </p>

        {pendingRequests.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            <p className="m-0 text-[11px] font-bold uppercase tracking-wide text-brand-warn">
              Awaiting approval
            </p>
            {pendingRequests.map((r) => renderPendingPromoRow(r))}
          </div>
        )}

        {!activeEvents.length ? (
          <>
            <p className="m-0 mt-3 text-sm text-brand-ink">
              {pendingRequests.length ? 'No live promo yet — approve one above to activate it.' : 'No live promo right now.'}
            </p>
            <div className="mt-3 flex justify-end">
              <PrimaryButton
                compact
                type="button"
                disabled={busy || !branchId}
                onClick={() => void openPromoEditor({ mode: 'create', branchId })}
              >
                {managerView ? 'Create promo' : 'Request promo'}
              </PrimaryButton>
            </div>
          </>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <SelectField
                label="Managing"
                className="w-full sm:w-auto sm:min-w-[240px] sm:max-w-xs"
                value={managingId || ''}
                onChange={(e) => setManagingId(e.target.value)}
              >
                {activeEvents.map((evt) => (
                  <option key={evt.event.id} value={evt.event.id}>
                    {evt.event.name} · {evt.event.status === 'stop_pending' ? 'Stop pending' : 'Active'}
                  </option>
                ))}
              </SelectField>
              {managedEvent && (
                <>
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
              <PrimaryButton
                compact
                type="button"
                className="w-full sm:ml-auto sm:w-auto"
                disabled={busy || !branchId}
                onClick={() => void openPromoEditor({ mode: 'create', branchId })}
              >
                {managerView ? 'Create promo' : 'Request promo'}
              </PrimaryButton>
            </div>
            {managedEvent?.event?.status === 'stop_pending' && managedEvent.event.stopReason && (
              <p className="mt-1 mb-0 text-[11px] text-brand-warn">
                Stop awaiting manager approval: {managedEvent.event.stopReason}
              </p>
            )}
          </>
        )}
      </TableCard>

      <TableCard className="mb-4 mt-4 max-h-none overflow-visible p-0">
        <div className="px-5 pt-5 pb-4">
            <StatTiles
              embedded
              title="Promo performance"
              subtitle={historyFrom || historyTo ? 'Filtered by promo start date' : 'All promos on this branch'}
              items={[
                { label: 'Total promos run', value: branchPerformanceSummary.promosRun },
                {
                  label: 'Total discount given',
                  value: `−${money(branchPerformanceSummary.totalDiscount)}`,
                  tone: 'danger',
                },
                { label: 'Total promo receipts', value: branchPerformanceSummary.totalReceipts },
                {
                  label: 'Discount % of sales',
                  value:
                    branchPerformanceSummary.pctOfSales != null
                      ? `${branchPerformanceSummary.pctOfSales.toFixed(1)}%`
                      : '—',
                  hint: branchSalesTotal ? `of ${money(branchSalesTotal)} branch sales` : null,
                },
              ]}
            />
        </div>

        <div className="border-t border-brand-softline px-5 pt-4 pb-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="m-0 text-base">Promo summary</h2>
                <p className="m-0 mt-1 text-xs text-brand-subtle">
                  Sort columns to compare promos — Sales opens receipts and per-item breakdown.
                </p>
              </div>
              {/* Filters by the promo's own start date, so picking a range means "promos that
                  started here" — not when the row happened to be created or edited. */}
              <div className="flex items-end gap-2">
                <label className="block text-[11px] font-bold text-brand-n700">
                  From
                  <input
                    type="date"
                    value={historyFrom}
                    onChange={(e) => {
                      setHistoryFrom(e.target.value)
                      setHistoryPage(0)
                    }}
                    className="mt-[7px] block rounded-[5px] border border-brand-input bg-white p-2 text-[12px] outline-none"
                  />
                </label>
                <label className="block text-[11px] font-bold text-brand-n700">
                  To
                  <input
                    type="date"
                    value={historyTo}
                    onChange={(e) => {
                      setHistoryTo(e.target.value)
                      setHistoryPage(0)
                    }}
                    className="mt-[7px] block rounded-[5px] border border-brand-input bg-white p-2 text-[12px] outline-none"
                  />
                </label>
                {(historyFrom || historyTo) && (
                  <button
                    type="button"
                    className="border-0 bg-transparent pb-2 text-[11px] font-bold text-brand-ink underline"
                    onClick={() => {
                      setHistoryFrom('')
                      setHistoryTo('')
                      setHistoryPage(0)
                    }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {sortedHistory.length ? (
              <div className="-mx-5 mt-4 overflow-x-auto overflow-y-visible">
                <table className="min-w-full text-left text-xs [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_th:first-child]:pl-5 [&_th:last-child]:pr-5">
                  <thead className={tableHeadClass}>
                    <tr>
                      <SortableTh label="Promo name" sortKey="name" current={historySort} onSort={setHistorySort} />
                      <SortableTh label="Rule type" sortKey="rule_type" current={historySort} onSort={setHistorySort} />
                      <SortableTh label="Date range" sortKey="starts_at" current={historySort} onSort={setHistorySort} />
                      <th className="px-3 py-2.5">Status</th>
                      <SortableTh label="Receipts" sortKey="receipts" current={historySort} onSort={setHistorySort} className="text-right" />
                      <SortableTh label="Discount given" sortKey="discount" current={historySort} onSort={setHistorySort} className="text-right" />
                      <SortableTh label="Discount % sales" sortKey="discount_pct" current={historySort} onSort={setHistorySort} className="text-right" />
                      <th className="px-3 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyPageRows.map((e) => {
                      const badge = promoStatusBadge(e)
                      const isLive = promoEffectiveStatus(e) === 'active' || promoEffectiveStatus(e) === 'stop_pending'
                      const stats = historyStats[e.id]
                      const discountPct =
                        stats?.discountTotal && branchSalesTotal > 0
                          ? ((stats.discountTotal / branchSalesTotal) * 100).toFixed(1)
                          : null
                      return (
                        <tr key={e.id} className="border-t border-brand-softline">
                          <td className="px-3 py-3">
                            <span className="font-bold text-brand-ink">{e.name}</span>
                            {e.supersedes_event_id && (
                              <span className="mt-0.5 block text-[10px] text-brand-warn">Edit revision</span>
                            )}
                          </td>
                          <td className="px-3 py-3">{summarizePromoRuleTypes(eventRuleTypes[e.id])}</td>
                          <td className="px-3 py-3">{fmtPromoSchedule(e.starts_at)} → {fmtPromoSchedule(e.ends_at)}</td>
                          <td className="px-3 py-3">
                            <StatusBadge compact tone={badge.tone} title={badge.hint}>
                              {badge.label}
                            </StatusBadge>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{stats ? stats.receiptCount : '—'}</td>
                          <td className="px-3 py-3 text-right tabular-nums text-brand-danger">
                            {stats ? `−${money(stats.discountTotal || 0)}` : '—'}
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">
                            {discountPct != null ? `${discountPct}%` : '—'}
                          </td>
                          <td className="px-3 py-3 text-right">
                            {renderPerformanceActionsMenu(e, { isLive })}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="mt-4 text-xs text-brand-subtle">
                {history.length ? 'No promo events in that date range.' : 'No promo events yet.'}
              </div>
            )}
            {historyPageCount > 1 && (
              <div className="-mx-5 -mb-5 mt-4">
                <Pager
                  page={historyPageIndex + 1}
                  pageCount={historyPageCount}
                  total={sortedHistory.length}
                  label="events"
                  onPrev={() => setHistoryPage((p) => Math.max(0, p - 1))}
                  onNext={() => setHistoryPage((p) => Math.min(historyPageCount - 1, p + 1))}
                />
              </div>
            )}
        </div>
      </TableCard>

        </>
      )}

      {/* Click-away for the "..." row menu — sits below the portal menu's z-50. */}
      {openActionsId && !promoEditor && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => {
            setOpenActionsId(null)
            setActionsAnchor(null)
          }}
        />
      )}

      {promoEditor && (
        <PromoEditorModal
          open
          mode={promoEditor.mode}
          branchId={promoEditor.branchId}
          branches={branches}
          products={products}
          event={promoEditor.event}
          managerView={managerView}
          staffId={user?.id}
          onClose={closePromoEditor}
          onSaved={onEditorSaved}
        />
      )}

      {pendingDelete && (
        <Modal onClose={closeDeleteConfirm}>
          <Eyebrow>CONFIRM DELETE</Eyebrow>
          <h2 className="m-0 text-lg">Delete promo event?</h2>
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

      {rejectTarget && (
        <Modal onClose={() => !busy && setRejectTarget(null)}>
          <Eyebrow>REJECT PROMO</Eyebrow>
          <h2 className="m-0 mb-2 text-lg">Reject {rejectTarget.name}?</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            This declines the promo request. It stays on record with the reason below.
          </p>
          <Field
            label="Reason (required)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value.replace(/[<>]/g, ''))}
            placeholder="Why reject this promo?"
          />
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setRejectTarget(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy || !rejectReason.trim()} onClick={onSubmitReject}>
              {busy ? 'Rejecting…' : 'Reject promo'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {trackingEvent && (
        <Modal wide onClose={() => setTrackingEvent(null)}>
          <Eyebrow>PROMO TRANSACTIONS</Eyebrow>
          <h2 className="m-0 text-lg">{trackingEvent.event?.name}</h2>
          <p className="m-0 mt-1 text-xs text-brand-muted">
            Receipts and promo offers sold under this event
            {trackingEvent.branchName ? ` · ${trackingEvent.branchName}` : ''}
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

              {trackingEvent.detailBusy ? (
                <div className="mt-4 space-y-2" role="status" aria-label="Loading transactions">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-24 w-full" />
                  <SkeletonRows rows={2} cols={3} />
                </div>
              ) : (
                <>
              <div className="mt-4">
                <p className="m-0 mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-subtle">
                  Transactions
                  {trackingEvent.stats.receiptsTruncated ? (
                    <span className="ml-1 font-normal normal-case text-brand-muted">
                      (showing latest {trackingEvent.stats.receipts?.length || 0})
                    </span>
                  ) : null}
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

              {(trackingEvent.stats.offers || trackingEvent.stats.items || []).length > 0 && (
                <div className="mt-4">
                  <p className="m-0 mb-2 text-[11px] font-bold uppercase tracking-wide text-brand-subtle">
                    Offers sold
                  </p>
                  <div className="max-h-[200px] overflow-auto rounded border border-brand-softline">
                    <div className="grid grid-cols-[1.2fr_0.8fr_0.7fr_0.9fr_0.9fr] gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase">
                      <span>Offer</span>
                      <span>Type</span>
                      <span className="text-right">Qty</span>
                      <span className="text-right">Discount</span>
                      <span className="text-right">Net</span>
                    </div>
                    {(trackingEvent.stats.offers?.length
                      ? trackingEvent.stats.offers
                      : trackingEvent.stats.items.map((row) => ({
                          label: row.name,
                          badge: 'Item',
                          sets: 0,
                          qty: row.qty,
                          pricingMode: row.pricingMode,
                          discount: row.discount,
                          net: row.net,
                        }))
                    ).map((row) => (
                      <div
                        key={`${row.label}-${row.badge}-${row.sets}-${row.qty}`}
                        className="grid grid-cols-[1.2fr_0.8fr_0.7fr_0.9fr_0.9fr] gap-2 border-t border-brand-softline px-3 py-2 text-xs"
                      >
                        <strong className="truncate text-brand-ink" title={row.label}>
                          {row.label}
                        </strong>
                        <span className="truncate text-[10px] text-brand-subtle">{row.badge || '—'}</span>
                        <span className="text-right tabular-nums">
                          {row.sets > 0
                            ? `${row.sets} set${row.sets === 1 ? '' : 's'}`
                            : qty(row.qty, row.pricingMode === 'kg' ? 'kg' : 'pc')}
                        </span>
                        <span className="text-right tabular-nums text-brand-danger">
                          −{money(row.discount)}
                        </span>
                        <span className="text-right tabular-nums">{money(row.net)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
                </>
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

