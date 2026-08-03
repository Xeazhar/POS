import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Field, PageHeader, PrimaryButton, SecondaryButton, SelectField, TableCard } from '../../components/ui'
import { branchSummary, fetchBranches, hasSupabase, reorderBranches, saveBranch } from '../../lib/api'
import { money } from '../../utils/format'

const empty = {
  name: '',
  address: '',
  is_active: true,
  branch_type: 'retail',
  vat_rate: 0.12,
}

function ManagerBranches() {
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [dragId, setDragId] = useState(null)

  const reload = async () => {
    if (!hasSupabase) {
      setBranches([
        {
          id: 'demo-main-branch',
          name: 'Bayombong Branch #001',
          address: 'Bayombong',
          is_active: true,
          vat_rate: 0.12,
        },
      ])
      setSummaries({ 'demo-main-branch': { revenue: 0, orders: 0, lowStock: 0 } })
      return
    }
    const rows = await fetchBranches()
    setBranches(rows)
    const next = {}
    await Promise.all(
      rows.map(async (branch) => {
        next[branch.id] = await branchSummary(branch.id)
      }),
    )
    setSummaries(next)
  }

  useEffect(() => {
    let active = true
    Promise.resolve()
      .then(() => reload())
      .catch((err) => {
        if (active) setError(err.message)
      })
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
                  {branch.branch_type === 'restaurant' && (
                    <p className="mt-1 text-[10px] font-bold tracking-wide text-brand-warn uppercase">
                      Restaurant / carinderia
                    </p>
                  )}
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold ${
                    branch.is_active ? 'bg-[#eef1ec] text-[#646a66]' : 'bg-brand-danger-bg text-brand-danger'
                  }`}
                >
                  {branch.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div className="mb-4 grid grid-cols-3 gap-2 text-center">
                <div>
                  <strong className="block text-brand-gold">{money(summary.revenue)}</strong>
                  <small className="text-[10px] text-brand-subtle">Today</small>
                </div>
                <div>
                  <strong className="block">{summary.orders}</strong>
                  <small className="text-[10px] text-brand-subtle">Orders</small>
                </div>
                <div>
                  <strong className="block text-brand-danger">{summary.lowStock}</strong>
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
      {form && (
        <div className="fixed inset-0 z-[5] grid place-items-center bg-[#202426aa]">
          <form
            className="w-[min(420px,calc(100%-32px))] rounded-[10px] bg-white p-6"
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                await saveBranch({
                  id: form.id,
                  name: form.name,
                  address: form.address,
                  is_active: form.is_active,
                  branch_type: form.branch_type || 'retail',
                  vat_rate: form.vat_rate != null ? Number(form.vat_rate) : 0.12,
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
              <SelectField
                label="Branch type"
                value={form.branch_type || 'retail'}
                onChange={(e) => setForm({ ...form, branch_type: e.target.value })}
              >
                <option value="retail">Retail / grocery</option>
                <option value="restaurant">Restaurant / carinderia</option>
              </SelectField>
              <Field
                label="VAT rate (e.g. 0.12)"
                value={form.vat_rate ?? 0.12}
                onChange={(e) => setForm({ ...form, vat_rate: e.target.value })}
                inputMode="decimal"
              />
              <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
                <input
                  type="checkbox"
                  checked={form.is_active !== false}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                />
                Active
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <SecondaryButton compact type="button" onClick={() => setForm(null)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton compact type="submit">
                Save
              </PrimaryButton>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

export default ManagerBranches
