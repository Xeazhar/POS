import { useEffect, useState } from 'react'
import { Field, PageHeader, PrimaryButton, SecondaryButton, SelectField, TableCard } from '../../components/ui'
import { createStaffAccount, fetchAllStaff, fetchBranches, fetchRoles, hasSupabase, updateStaffRow } from '../../lib/api'

const empty = { full_name: '', email: '', password: '', role: 'cashier', branch_id: '', is_active: true }
const fallbackRoles = [
  { name: 'cashier', label: 'Cashier' },
  { name: 'manager', label: 'Manager' },
  { name: 'admin', label: 'Admin' },
]

function ManagerStaff() {
  const [staff, setStaff] = useState([])
  const [branches, setBranches] = useState([])
  const [roles, setRoles] = useState(fallbackRoles)
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')

  const reload = async () => {
    if (!hasSupabase) {
      setStaff([{ id: 'local', full_name: 'Demo Admin', role: 'admin', is_active: true, branches: { name: 'Bayombong Branch #001' }, roles: { label: 'Admin' } }])
      setBranches([{ id: 'demo-main-branch', name: 'Bayombong Branch #001' }])
      setRoles(fallbackRoles)
      return
    }
    const [people, branchRows, roleRows] = await Promise.all([fetchAllStaff(), fetchBranches(), fetchRoles()])
    setStaff(people)
    setBranches(branchRows)
    setRoles(roleRows.length ? roleRows : fallbackRoles)
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
      <PageHeader eyebrow="MANAGER" title="Staff accounts">
        <PrimaryButton
          compact
          type="button"
          onClick={() => setForm({ ...empty, branch_id: branches[0]?.id || '', role: roles[0]?.name || 'cashier' })}
        >
          Add staff
        </PrimaryButton>
      </PageHeader>
      {error && <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>}
      <TableCard>
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_0.8fr_0.7fr_0.7fr] gap-3 bg-[#f7f7f4] px-5 py-3 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:px-3">
          <span>Name</span>
          <span className="max-[700px]:hidden">Branch</span>
          <span className="max-[700px]:hidden">Role</span>
          <span className="max-[700px]:hidden">Status</span>
          <span className="text-right max-[700px]:text-left">Action</span>
        </div>
        {staff.map((person) => (
          <div
            key={person.id}
            className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_0.8fr_0.7fr_0.7fr] items-center gap-3 border-t border-brand-softline px-5 py-3 text-xs max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:items-start max-[700px]:px-3"
          >
            <div className="min-w-0">
              <strong className="block truncate text-brand-ink">{person.full_name}</strong>
              <small className="mt-0.5 hidden text-[10px] leading-snug text-brand-subtle max-[700px]:block">
                {person.branches?.name || '—'}
                {' · '}
                {person.roles?.label || person.role}
                {' · '}
                <span className={person.is_active ? 'text-brand-success' : 'text-brand-danger'}>
                  {person.is_active ? 'Active' : 'Inactive'}
                </span>
              </small>
            </div>
            <span className="truncate max-[700px]:hidden">{person.branches?.name || '—'}</span>
            <span className="max-[700px]:hidden">{person.roles?.label || person.role}</span>
            <span className={`max-[700px]:hidden ${person.is_active ? 'text-brand-success' : 'text-brand-danger'}`}>
              {person.is_active ? 'Active' : 'Inactive'}
            </span>
            <button
              type="button"
              className="justify-self-end border-0 bg-transparent text-right text-xs font-bold text-brand-danger-soft max-[700px]:pt-0.5"
              onClick={() => setForm({
                id: person.id,
                full_name: person.full_name,
                role: person.role,
                branch_id: person.branch_id,
                is_active: person.is_active,
                email: '',
                password: '',
              })}
            >
              Edit
            </button>
          </div>
        ))}
      </TableCard>
      {form && (
        <div className="fixed inset-0 z-[5] grid place-items-center bg-[#202426aa]">
          <form
            className="w-[min(460px,calc(100%-32px))] rounded-[10px] bg-white p-6"
            onSubmit={async (event) => {
              event.preventDefault()
              try {
                if (form.id) {
                  await updateStaffRow(form.id, {
                    full_name: form.full_name,
                    role: form.role,
                    branch_id: form.branch_id,
                    is_active: form.is_active,
                  })
                } else {
                  if (!hasSupabase) throw new Error('Connect Supabase to create staff logins.')
                  await createStaffAccount({
                    email: form.email,
                    password: form.password,
                    fullName: form.full_name,
                    role: form.role,
                    branchId: form.branch_id,
                  })
                }
                setForm(null)
                await reload()
              } catch (err) {
                setError(err.message)
              }
            }}
          >
            <h2 className="mb-4 text-lg">{form.id ? 'Edit staff' : 'Create staff login'}</h2>
            <div className="grid gap-3">
              <Field label="Full name" required value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
              {!form.id && (
                <>
                  <Field label="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  <Field label="Password" type="password" required minLength={6} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </>
              )}
              <SelectField label="Branch" required value={form.branch_id} onChange={(e) => setForm({ ...form, branch_id: e.target.value })}>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </SelectField>
              <SelectField label="Role" required value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {roles.map((role) => (
                  <option key={role.name} value={role.name}>{role.label}</option>
                ))}
              </SelectField>
              {form.id && (
                <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
                  <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                  Active account
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <SecondaryButton compact type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton>
              <PrimaryButton compact type="submit">{form.id ? 'Save' : 'Create login'}</PrimaryButton>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

export default ManagerStaff
