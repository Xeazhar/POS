import { useRef, useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { FiCheck } from 'react-icons/fi'
import { FaRegEdit } from 'react-icons/fa'
import {
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  SkeletonCards,
  StatusBadge,
  TableCard,
  moneyClass,
} from '../../components/ui'
import {
  branchSummary,
  fetchBranches,
  fetchManagerOverviewMetrics,
  fetchRecentDayEndStatuses,
  hasSupabase,
  reorderBranches,
  saveBranch,
} from '../../lib/api'
import { businessDate, money } from '../../utils/format'

const DAY_END_CUTOFF_HOUR = 21
import { RESTAURANT_FEATURES_ENABLED, normalizeBranchType } from '../../utils/features'
import { readBranchesCache, writeBranchesCache } from '../../offline'

const empty = {
  name: '',
  address: '',
  is_active: true,
  branch_type: 'retail',
}

function BranchCardBody({ branch, summary, summariesLoading, dayNotEnded, editMode }) {
  return (
    <>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {editMode && <p className="m-0 mb-1 text-[10px] text-brand-subtle">⋮⋮ Drag to reorder</p>}
          <h2 className="m-0 text-lg">{branch.name}</h2>
          <p className="mt-1 text-xs text-brand-muted">{branch.address || 'No address'}</p>
          {RESTAURANT_FEATURES_ENABLED && branch.branch_type === 'restaurant' && (
            <p className="mt-1 text-[10px] font-bold tracking-wide text-brand-warn uppercase">
              Restaurant / carinderia
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <StatusBadge tone={branch.is_active ? 'success' : 'danger'} className="rounded-full">
            {branch.is_active ? 'Active' : 'Inactive'}
          </StatusBadge>
          {dayNotEnded && (
            <StatusBadge tone="warn" className="rounded-full">
              Day not ended
            </StatusBadge>
          )}
        </div>
      </div>
      <div className="mb-4 grid grid-cols-3 gap-2 text-center">
        <div>
          <strong className={`block text-brand-ink ${moneyClass}`}>
            {summariesLoading && summary.revenue == null ? '…' : money(summary.revenue || 0)}
          </strong>
          <small className="text-[10px] text-brand-subtle">Today</small>
        </div>
        <div>
          <strong className="block">
            {summariesLoading && summary.orders == null ? '…' : summary.orders || 0}
          </strong>
          <small className="text-[10px] text-brand-subtle">Orders</small>
        </div>
        <div>
          <strong className="block text-brand-danger">
            {summariesLoading && summary.lowStock == null ? '…' : summary.lowStock || 0}
          </strong>
          <small className="text-[10px] text-brand-subtle">Low stock</small>
        </div>
      </div>
    </>
  )
}

function ManagerBranches() {
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [dayEndRows, setDayEndRows] = useState([])
  const [summariesLoading, setSummariesLoading] = useState(false)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [dragIndex, setDragIndex] = useState(null)
  const [ghost, setGhost] = useState(null)
  const gridRef = useRef(null)
  const dragOriginRef = useRef(null)
  const orderDirtyRef = useRef(false)
  const branchesRef = useRef(branches)
  branchesRef.current = branches

  const loadSummaries = async (rows) => {
    if (!rows?.length) {
      setSummaries({})
      return
    }
    setSummariesLoading(true)
    try {
      const { summaries: next } = await fetchManagerOverviewMetrics({ days: 1 })
      setSummaries(next || {})
    } catch {
      const next = {}
      await Promise.all(
        rows.map(async (branch) => {
          next[branch.id] = await branchSummary(branch.id).catch(() => ({
            revenue: 0,
            orders: 0,
            lowStock: 0,
          }))
        }),
      )
      setSummaries(next)
    } finally {
      setSummariesLoading(false)
    }
  }

  const reload = async () => {
    if (!hasSupabase) {
      setBranches([
        {
          id: 'demo-main-branch',
          name: 'Bayombong Branch #001',
          address: 'Bayombong',
          is_active: true,
        },
      ])
      setSummaries({ 'demo-main-branch': { revenue: 0, orders: 0, lowStock: 0 } })
      setLoading(false)
      return
    }
    const rows = await fetchBranches({ includeCompany: false })
    setBranches(rows)
    setLoading(false)
    await writeBranchesCache(rows).catch(() => {})
    await loadSummaries(rows)
    fetchRecentDayEndStatuses().then(setDayEndRows).catch(() => {})
  }

  // Only worth flagging past the usual close time (9 PM) — earlier than that, a branch
  // simply hasn't closed yet, not falling behind.
  const dayNotEnded = (branch) => {
    if (new Date().getHours() < DAY_END_CUTOFF_HOUR) return false
    const today = businessDate(new Date(), branch.day_open_hour ?? 7)
    const row = dayEndRows.find((r) => r.branch_id === branch.id && r.business_date === today)
    return !row || row.status !== 'closed'
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    ;(async () => {
      try {
        const cached = await readBranchesCache().catch(() => null)
        if (active && cached?.length) {
          setBranches(cached)
          setLoading(false)
        }
        if (!active) return
        await reload()
      } catch (err) {
        if (active) {
          setError(err.message)
          setLoading(false)
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const persistOrder = async (rows) => {
    try {
      if (hasSupabase) await reorderBranches(rows.map((b) => b.id))
      await writeBranchesCache(rows).catch(() => {})
    } catch (err) {
      setError(err.message)
      await reload()
    }
  }

  const indexFromPoint = (clientX, clientY) => {
    const cards = gridRef.current?.querySelectorAll('[data-branch-index]')
    if (!cards?.length) return 0
    let best = 0
    let bestDist = Infinity
    for (const card of cards) {
      const rect = card.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dist = (clientX - cx) ** 2 + (clientY - cy) ** 2
      if (dist < bestDist) {
        bestDist = dist
        best = Number(card.dataset.branchIndex)
      }
    }
    return best
  }

  const clearDrag = () => {
    setDragIndex(null)
    setGhost(null)
    dragOriginRef.current = null
  }

  const onPointerDown = (event, index) => {
    if (!editMode) return
    if (event.button != null && event.button !== 0) return
    if (event.target.closest('a, button, input, label, [data-branch-edit]')) return
    event.preventDefault()
    const el = event.currentTarget
    el.setPointerCapture(event.pointerId)
    const rect = el.getBoundingClientRect()
    const branch = branches[index]
    dragOriginRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      branchId: branch.id,
    }
    orderDirtyRef.current = false
    setDragIndex(index)
    setGhost({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      branch,
    })
  }

  const onPointerMove = (event) => {
    if (dragIndex == null || !dragOriginRef.current) return
    const { offsetX, offsetY, width, height, branchId } = dragOriginRef.current
    const branch = branches.find((b) => b.id === branchId) || branches[dragIndex]
    setGhost({
      x: event.clientX - offsetX,
      y: event.clientY - offsetY,
      width,
      height,
      branch,
    })
    const over = indexFromPoint(event.clientX, event.clientY)
    if (over === dragIndex) return
    const next = [...branchesRef.current]
    const [moved] = next.splice(dragIndex, 1)
    next.splice(over, 0, moved)
    branchesRef.current = next
    setBranches(next)
    setDragIndex(over)
    orderDirtyRef.current = true
  }

  const endDrag = async (event) => {
    if (dragIndex == null) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }
    const dirty = orderDirtyRef.current
    const rows = branchesRef.current
    clearDrag()
    if (dirty) await persistOrder(rows)
  }

  return (
    <div>
      <PageHeader eyebrow="MANAGER" title="Branches">
        <SecondaryButton
          compact
          type="button"
          onClick={() => {
            if (editMode) clearDrag()
            setEditMode((prev) => !prev)
          }}
          aria-pressed={editMode}
        >
          {editMode ? <FiCheck size={13} /> : <FaRegEdit size={13} />}
          {editMode ? 'Done' : 'Reorder'}
        </SecondaryButton>
        <PrimaryButton compact type="button" onClick={() => setForm({ ...empty })}>
          Add branch
        </PrimaryButton>
      </PageHeader>
      {editMode && (
        <p className="mb-3 text-[11px] text-brand-subtle">
          Drag cards to set display order — the card follows your pointer.
        </p>
      )}
      {error && <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>}
      {loading ? (
        <SkeletonCards count={3} />
      ) : (
        <div ref={gridRef}>
        {[
          { rows: branches.filter((b) => b.is_active !== false), label: null },
          { rows: branches.filter((b) => b.is_active === false), label: 'Inactive branches' },
        ].map(({ rows, label }) =>
          rows.length === 0 ? null : (
          <div key={label || 'active'}>
            {label && <hr className="my-4 border-brand-softline" />}
            {label && <p className="mb-2.5 text-[11px] font-bold tracking-wide text-brand-subtle uppercase">{label}</p>}
            <div className="grid grid-cols-3 gap-3.5 max-[1050px]:grid-cols-2 max-[700px]:grid-cols-1">
          {rows.map((branch) => {
            const index = branches.indexOf(branch)
            const summary = summaries[branch.id] || { revenue: 0, orders: 0, lowStock: 0 }
            const isPlaceholder = dragIndex === index
            return (
              <TableCard
                key={branch.id}
                data-branch-index={index}
                className={`max-h-none p-5 ${
                  editMode ? 'cursor-grab touch-none select-none active:cursor-grabbing' : ''
                } ${
                  isPlaceholder
                    ? 'border border-dashed border-brand-gold/60 bg-brand-gold/10 opacity-40 shadow-none'
                    : ''
                }`}
                onPointerDown={(event) => onPointerDown(event, index)}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <BranchCardBody
                  branch={branch}
                  summary={summary}
                  summariesLoading={summariesLoading}
                  dayNotEnded={dayNotEnded(branch)}
                  editMode={editMode}
                />
                {!isPlaceholder && (
                  <div className="flex justify-end gap-2" onPointerDown={(e) => e.stopPropagation()}>
                    <Link
                      className="inline-flex h-10 items-center rounded-[5px] bg-brand-gold px-4 text-xs font-bold text-brand-on-gold no-underline"
                      to={`/manager/branches/${branch.id}`}
                    >
                      Open dashboard
                    </Link>
                    <SecondaryButton compact type="button" onClick={() => setForm(branch)}>
                      Edit
                    </SecondaryButton>
                  </div>
                )}
              </TableCard>
            )
          })}
            </div>
          </div>
          ),
        )}
        </div>
      )}

      {ghost?.branch && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[80] max-h-none rounded-[10px] border border-brand-line bg-brand-card p-5 shadow-[0_16px_40px_rgba(0,0,0,0.28)] ring-2 ring-brand-gold"
          style={{
            left: ghost.x,
            top: ghost.y,
            width: ghost.width,
            minHeight: ghost.height,
            transform: 'scale(1.03) rotate(-1.5deg)',
          }}
        >
          <BranchCardBody
            branch={ghost.branch}
            summary={summaries[ghost.branch.id] || { revenue: 0, orders: 0, lowStock: 0 }}
            summariesLoading={summariesLoading}
          />
        </div>
      )}

      {form && (
        <Modal onClose={() => setForm(null)}>
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                await saveBranch({
                  id: form.id,
                  name: form.name,
                  address: form.address,
                  is_active: form.is_active,
                  branch_type: normalizeBranchType(form.branch_type || 'retail'),
                })
                setForm(null)
                await reload()
              } catch (err) {
                setError(err.message)
              }
            }}
          >
            <h2 className="mb-4 text-lg">{form.id ? 'Edit branch' : 'Add branch'}</h2>
            <div className="grid gap-3">
              <Field
                label="Branch name"
                required
                value={form.name || ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
              <Field
                label="Address"
                value={form.address || ''}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
              {RESTAURANT_FEATURES_ENABLED ? (
                <SelectField
                  label="Branch type"
                  value={form.branch_type || 'retail'}
                  onChange={(e) => setForm({ ...form, branch_type: e.target.value })}
                >
                  <option value="retail">Retail / grocery</option>
                  <option value="restaurant">Restaurant / carinderia</option>
                </SelectField>
              ) : (
                <input type="hidden" name="branch_type" value="retail" readOnly />
              )}
              <label className="flex items-center gap-2 text-xs font-bold text-brand-n700">
                <input
                  type="checkbox"
                  checked={form.is_active !== false}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                Active
              </label>
            </div>
            <ModalActions>
              <SecondaryButton compact type="button" onClick={() => setForm(null)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton compact type="submit">
                Save
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}
    </div>
  )
}

export default ManagerBranches
