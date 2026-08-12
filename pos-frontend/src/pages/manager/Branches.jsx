import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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
  hasSupabase,
  reorderBranches,
  saveBranch,
} from '../../lib/api'
import { money } from '../../utils/format'
import { RESTAURANT_FEATURES_ENABLED, normalizeBranchType } from '../../utils/features'
import { readBranchesCache, writeBranchesCache } from '../../offline'

const empty = {
  name: '',
  address: '',
  is_active: true,
  branch_type: 'retail',
}

function ManagerBranches() {
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [summariesLoading, setSummariesLoading] = useState(false)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [dragId, setDragId] = useState(null)
  const [loading, setLoading] = useState(true)

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
      // RPC missing — same fan-out Overview used to do (slow, but correct).
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
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    ;(async () => {
      try {
        // Instant paint from last visit when cache exists.
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

  const onDropReorder = async (targetId) => {
    if (!dragId || dragId === targetId) {
      setDragId(null)
      return
    }
    const from = branches.findIndex((b) => b.id === dragId)
    const to = branches.findIndex((b) => b.id === targetId)
    if (from < 0 || to < 0) {
      setDragId(null)
      return
    }
    const next = [...branches]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setBranches(next)
    setDragId(null)
    try {
      if (hasSupabase) await reorderBranches(next.map((b) => b.id))
    } catch (err) {
      setError(err.message)
      await reload()
    }
  }

  return (
    <div>
      <PageHeader eyebrow="MANAGER" title="Branches">
        <PrimaryButton compact type="button" onClick={() => setForm({ ...empty })}>
          Add branch
        </PrimaryButton>
      </PageHeader>
      <p className="mb-3 text-[11px] text-brand-subtle">Drag cards to set display order.</p>
      {error && <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>}
      {loading ? (
        <SkeletonCards count={3} />
      ) : (
      <div className="grid grid-cols-3 gap-3.5 max-[1050px]:grid-cols-2 max-[700px]:grid-cols-1">
        {branches.map((branch) => {
          const summary = summaries[branch.id] || { revenue: 0, orders: 0, lowStock: 0 }
          return (
            <TableCard
              key={branch.id}
              className={`max-h-none p-5 ${dragId === branch.id ? 'opacity-60 ring-2 ring-brand-gold' : ''}`}
              draggable
              onDragStart={() => setDragId(branch.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDropReorder(branch.id)}
            >
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="m-0 mb-1 text-[10px] text-brand-subtle">⋮⋮ Drag to reorder</p>
                  <h2 className="m-0 text-lg">{branch.name}</h2>
                  <p className="mt-1 text-xs text-brand-muted">{branch.address || 'No address'}</p>
                  {RESTAURANT_FEATURES_ENABLED && branch.branch_type === 'restaurant' && (
                    <p className="mt-1 text-[10px] font-bold tracking-wide text-brand-warn uppercase">
                      Restaurant / carinderia
                    </p>
                  )}
                </div>
                <StatusBadge tone={branch.is_active ? 'success' : 'danger'} className="rounded-full">
                  {branch.is_active ? 'Active' : 'Inactive'}
                </StatusBadge>
              </div>
              <div className="mb-4 grid grid-cols-3 gap-2 text-center">
                <div>
                  <strong className={`block text-brand-gold ${moneyClass}`}>
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
              <div className="flex justify-end gap-2">
                <Link
                  className="inline-flex h-10 items-center rounded-[5px] bg-brand-gold px-4 text-xs font-bold text-brand-dark no-underline"
                  to={`/manager/branches/${branch.id}`}
                >
                  Open dashboard
                </Link>
                <SecondaryButton compact type="button" onClick={() => setForm(branch)}>
                  Edit
                </SecondaryButton>
              </div>
            </TableCard>
          )
        })}
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
