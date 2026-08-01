import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Field, PageHeader, PrimaryButton, SecondaryButton, TableCard } from '../../components/ui'
import { branchSummary, fetchBranches, hasSupabase, saveBranch } from '../../lib/api'
import { money } from '../../utils/format'

const empty = {
  name: '',
  address: '',
  is_active: true,
  business_name: '',
  tin: '',
  bir_permit_no: '',
  machine_identification_no: '',
  serial_number: '',
  or_prefix: 'OR',
}

function ManagerBranches() {
  const [branches, setBranches] = useState([])
  const [summaries, setSummaries] = useState({})
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')

  const reload = async () => {
    if (!hasSupabase) {
      setBranches([{ id: 'demo-main-branch', name: 'Bayombong Branch #001', address: 'Bayombong', is_active: true }])
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

  return (
    <div>
      <PageHeader eyebrow="MANAGER" title="Branches">
        <PrimaryButton compact type="button" onClick={() => setForm({ ...empty })}>
          Add branch
        </PrimaryButton>
      </PageHeader>
      {error && <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>}
      <div className="grid grid-cols-3 gap-3.5 max-[1050px]:grid-cols-2 max-[700px]:grid-cols-1">
        {branches.map((branch) => {
          const summary = summaries[branch.id] || { revenue: 0, orders: 0, lowStock: 0 }
          return (
            <TableCard key={branch.id} className="max-h-none p-5">
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="m-0 text-lg">{branch.name}</h2>
                  <p className="mt-1 text-xs text-brand-muted">{branch.address || 'No address'}</p>
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
            className="w-[min(480px,calc(100%-32px))] rounded-[10px] bg-white p-6"
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                await saveBranch(form)
                setForm(null)
                await reload()
              } catch (err) {
                setError(err.message)
              }
            }}
          >
            <h2 className="mb-4 text-lg">{form.id ? 'Edit branch' : 'Add branch'}</h2>
            <div className="grid gap-3">
              <Field label="Branch name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <Field label="Business name (receipt)" value={form.business_name || ''} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
              <Field label="Address" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              <Field label="TIN" value={form.tin || ''} onChange={(e) => setForm({ ...form, tin: e.target.value })} placeholder="000-000-000-000" />
              <Field label="BIR permit no." value={form.bir_permit_no || ''} onChange={(e) => setForm({ ...form, bir_permit_no: e.target.value })} />
              <Field label="Machine ID (MIN)" value={form.machine_identification_no || ''} onChange={(e) => setForm({ ...form, machine_identification_no: e.target.value })} />
              <Field label="Serial number" value={form.serial_number || ''} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} />
              <Field label="OR prefix" value={form.or_prefix || 'OR'} onChange={(e) => setForm({ ...form, or_prefix: e.target.value })} />
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
