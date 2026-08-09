import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Field, PageHeader, PrimaryButton, SecondaryButton, SelectField, SkeletonCards, StatusBadge, TableCard, moneyClass } from '../../components/ui'
import {
  branchSummary,
  fetchBranches,
  fetchCompanyProfile,
  hasSupabase,
  reorderBranches,
  saveBranch,
  saveCompanyProfile,
} from '../../lib/api'
import { money } from '../../utils/format'

const empty = {
  name: '',
  address: '',
  is_active: true,
  branch_type: 'retail',
}

function ManagerBranches() {
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')
  const [dragId, setDragId] = useState(null)
  const [company, setCompany] = useState({ business_name: '', tin: '', address: '' })
  const [companyBusy, setCompanyBusy] = useState(false)
  const [loading, setLoading] = useState(true)

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
    const rows = await fetchBranches()
    setBranches(rows)
    const profile = await fetchCompanyProfile({ force: true }).catch(() => null)
    if (profile) {
      setCompany({
        business_name: profile.business_name || '',
        tin: profile.tin || '',
        address: profile.address || '',
      })
    }
    const next = {}
    await Promise.all(
      rows.map(async (branch) => {
        next[branch.id] = await branchSummary(branch.id)
      }),
    )
    setSummaries(next)
    setLoading(false)
  }

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.resolve()
      .then(() => reload())
      .catch((err) => {
        if (active) {
          setError(err.message)
          setLoading(false)
        }
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
      {/* One TIN for the business. Branches carry a BIR branch code appended to it, set
          per branch under Branch settings — see migrate_company_tin.sql. */}
      <TableCard className="mb-4 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Company details</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Shared by every branch. The TIN printed on an invoice is this number plus that
          branch&apos;s BIR branch code, e.g. <strong>123-456-789-00001</strong>.
        </p>
        <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-1">
          <Field
            label="Registered business name"
            value={company.business_name || ''}
            onChange={(e) => setCompany({ ...company, business_name: e.target.value })}
          />
          <Field
            label="Main company TIN"
            value={company.tin || ''}
            onChange={(e) => setCompany({ ...company, tin: e.target.value })}
            placeholder="123-456-789"
          />
          <Field
            label="Registered address"
            value={company.address || ''}
            onChange={(e) => setCompany({ ...company, address: e.target.value })}
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <PrimaryButton
            compact
            type="button"
            disabled={companyBusy || !hasSupabase}
            onClick={async () => {
              setCompanyBusy(true)
              setError('')
              try {
                await saveCompanyProfile({
                  businessName: company.business_name || null,
                  tin: company.tin || null,
                  address: company.address || null,
                })
                await reload()
              } catch (err) {
                setError(err.message)
              } finally {
                setCompanyBusy(false)
              }
            }}
          >
            {companyBusy ? 'Saving…' : 'Save company details'}
          </PrimaryButton>
          {!hasSupabase && (
            <span className="text-[11px] text-brand-subtle">Offline demo — not saved.</span>
          )}
        </div>
      </TableCard>

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
                  {branch.branch_type === 'restaurant' && (
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
                  <strong className={`block text-brand-gold ${moneyClass}`}>{money(summary.revenue)}</strong>
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
      )}
      {form && (
        <div className="fixed inset-0 z-[5] grid place-items-center bg-brand-scrim">
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
              <label className="flex items-center gap-2 text-xs font-bold text-brand-n700">
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
