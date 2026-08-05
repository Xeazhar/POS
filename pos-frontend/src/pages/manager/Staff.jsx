import { useEffect, useState } from 'react'
import { FiEye, FiEyeOff } from 'react-icons/fi'
import {
  Field,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  TableCard,
} from '../../components/ui'
import {
  createStaffAccount,
  fetchAllStaff,
  fetchBranches,
  fetchRoles,
  hasSupabase,
  revealStaffPin,
  updateStaffRow,
} from '../../lib/api'
import { MODULES, defaultPermissionsFor, usesPinLogin } from '../../utils/roles'
import { PIN_RULES_HINT, randomComplexPin, sanitizePinInput, validateComplexPin } from '../../utils/pin'

const empty = {
  full_name: '',
  email: '',
  password: '',
  login_code: '',
  login_pin: '',
  role: 'cashier',
  branch_id: '',
  is_active: true,
  permissions: null,
}
const fallbackRoles = [
  { name: 'cashier', label: 'Cashier' },
  { name: 'supervisor', label: 'Supervisor' },
  { name: 'manager', label: 'Manager' },
  { name: 'admin', label: 'Admin' },
  { name: 'master', label: 'Master' },
]

function randomStaffCode(digits = 4) {
  let s = ''
  for (let i = 0; i < digits; i += 1) s += String(Math.floor(Math.random() * 10))
  return s
}

function uniqueStaffCode(existingStaff, excludeId = null, digits = 4) {
  const taken = new Set(
    existingStaff
      .filter((p) => p.id !== excludeId && p.login_code)
      .map((p) => String(p.login_code)),
  )
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const code = randomStaffCode(digits)
    if (!taken.has(code)) return code
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const code = randomStaffCode(6)
    if (!taken.has(code)) return code
  }
  return randomStaffCode(6)
}

function isStaffCodeTaken(existingStaff, code, excludeId = null) {
  const normalized = String(code || '').replace(/\D/g, '')
  if (!normalized) return false
  return existingStaff.some(
    (p) => p.id !== excludeId && String(p.login_code || '') === normalized,
  )
}

function ManagerStaff() {
  const [staff, setStaff] = useState([])
  const [branches, setBranches] = useState([])
  const [roles, setRoles] = useState(fallbackRoles)
  const [form, setForm] = useState(null)
  const [formError, setFormError] = useState('')
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState(null)
  const [showPin, setShowPin] = useState(false)

  const reload = async () => {
    if (!hasSupabase) {
      setStaff([
        {
          id: 'local',
          full_name: 'Demo Admin',
          role: 'admin',
          is_active: true,
          branches: { name: 'Bayombong Branch #001' },
          roles: { label: 'Admin' },
        },
      ])
      setBranches([{ id: 'demo-main-branch', name: 'Bayombong Branch #001' }])
      setRoles(fallbackRoles)
      return
    }
    const [people, branchRows, roleRows] = await Promise.all([
      fetchAllStaff(),
      fetchBranches(),
      fetchRoles(),
    ])
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

  const pinMode = form && usesPinLogin(form.role)

  return (
    <div>
      <PageHeader eyebrow="MANAGER" title="Staff accounts">
        <PrimaryButton
          compact
          type="button"
          onClick={() => {
            setFormError('')
            setShowPin(false)
            setForm({
              ...empty,
              branch_id: branches[0]?.id || '',
              role: 'cashier',
              login_code: uniqueStaffCode(staff),
              login_pin: randomComplexPin(10),
              permissions: defaultPermissionsFor('cashier'),
            })
          }}
        >
          Add staff
        </PrimaryButton>
      </PageHeader>
      {error && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>
      )}
      <TableCard>
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_0.8fr_0.7fr_0.7fr] gap-3 bg-brand-dark px-5 py-3 text-[9px] font-bold tracking-[1px] text-[#c8ceca] uppercase max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:px-3">
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
                {person.login_code ? ` · code ${person.login_code}` : ''}
                {' · '}
                <span className={person.is_active ? 'text-brand-success' : 'text-brand-danger'}>
                  {person.is_active ? 'Active' : 'Inactive'}
                </span>
              </small>
            </div>
            <span className="truncate max-[700px]:hidden">{person.branches?.name || '—'}</span>
            <span className="max-[700px]:hidden">{person.roles?.label || person.role}</span>
            <span
              className={`max-[700px]:hidden ${person.is_active ? 'text-brand-success' : 'text-brand-danger'}`}
            >
              {person.is_active ? 'Active' : 'Inactive'}
            </span>
            <div className="flex justify-end gap-2 max-[700px]:flex-col max-[700px]:items-end">
              {usesPinLogin(person.role) && (
                <button
                  type="button"
                  className="border-0 bg-transparent text-xs font-bold text-brand-ink"
                  onClick={async () => {
                    try {
                      if (!hasSupabase) {
                        setReveal({ name: person.full_name, loginCode: '1234', loginPin: '1234' })
                        return
                      }
                      const data = await revealStaffPin(person.id)
                      setReveal(data)
                    } catch (err) {
                      setError(err.message)
                    }
                  }}
                >
                  Reveal PIN
                </button>
              )}
              <button
                type="button"
                className="border-0 bg-transparent text-right text-xs font-bold text-brand-danger-soft"
                onClick={() => {
                setFormError('')
                setShowPin(false)
                setForm({
                  id: person.id,
                  full_name: person.full_name,
                  role: person.role,
                  branch_id: person.branch_id,
                  is_active: person.is_active,
                  email: '',
                  password: '',
                  login_code: person.login_code || '',
                  login_pin: '',
                  permissions: person.permissions || defaultPermissionsFor(person.role),
                })
              }}
            >
              Edit
            </button>
            </div>
          </div>
        ))}
      </TableCard>
      {form && (
        <div className="fixed inset-0 z-[5] grid place-items-center overflow-auto bg-[#202426aa] py-8">
          <form
            className="w-[min(520px,calc(100%-32px))] rounded-[10px] bg-white p-6"
            onSubmit={async (event) => {
              event.preventDefault()
              setFormError('')
              try {
                if (usesPinLogin(form.role) && form.login_code) {
                  if (isStaffCodeTaken(staff, form.login_code, form.id || null)) {
                    throw new Error('That staff code is already in use. Each person needs a unique code.')
                  }
                }
                if (usesPinLogin(form.role)) {
                  const pinRequired = !form.id || Boolean(form.login_pin)
                  if (pinRequired) {
                    const pinErr = validateComplexPin(form.login_pin)
                    if (pinErr) throw new Error(pinErr)
                  }
                }
                if (form.id) {
                  const changes = {
                    full_name: form.full_name,
                    role: form.role,
                    branch_id: form.branch_id,
                    is_active: form.is_active,
                    permissions: form.permissions,
                  }
                  if (usesPinLogin(form.role)) {
                    if (form.login_code) changes.loginCode = form.login_code
                    if (form.login_pin) changes.loginPin = form.login_pin
                  }
                  await updateStaffRow(form.id, changes)
                } else {
                  if (!hasSupabase) throw new Error('Connect Supabase to create staff logins.')
                  if (usesPinLogin(form.role)) {
                    if (!form.login_code || !form.login_pin) {
                      throw new Error('Staff code and PIN are required for cashiers/supervisors.')
                    }
                    await createStaffAccount({
                      fullName: form.full_name,
                      role: form.role,
                      branchId: form.branch_id,
                      loginCode: form.login_code,
                      loginPin: form.login_pin,
                      permissions: form.permissions,
                    })
                  } else {
                    await createStaffAccount({
                      email: form.email,
                      password: form.password,
                      fullName: form.full_name,
                      role: form.role,
                      branchId: form.branch_id,
                      permissions: form.permissions,
                    })
                  }
                }
                setForm(null)
                setFormError('')
                await reload()
              } catch (err) {
                setFormError(err.message || 'Could not save staff.')
              }
            }}
          >
            <h2 className="mb-4 text-lg">{form.id ? 'Edit staff' : 'Create staff login'}</h2>
            {formError && (
              <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">
                {formError}
              </p>
            )}
            <div className="grid gap-3">
              <Field
                label="Full name"
                required
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              />
              {!form.id && !pinMode && (
                <>
                  <Field
                    label="Email"
                    type="email"
                    required
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                  />
                  <Field
                    label="Password"
                    type="password"
                    required
                    minLength={6}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </>
              )}
              {pinMode && (
                <>
                  <Field
                    label="Staff code (unique, 4–6 digits)"
                    required={!form.id}
                    value={form.login_code}
                    onChange={(e) =>
                      setForm({ ...form, login_code: e.target.value.replace(/\D/g, '').slice(0, 6) })
                    }
                    inputMode="numeric"
                  />
                  <p className="m-0 -mt-1 text-[10px] text-brand-subtle">
                    Must be unique — no two staff can share the same code.
                  </p>
                  <div className="flex items-end gap-2">
                    <label className="relative block min-w-0 flex-1 text-[11px] font-bold text-[#646a66]">
                      {form.id ? 'New PIN (leave blank to keep)' : 'PIN'}
                      <input
                        className="mt-[7px] block w-full rounded-[5px] border border-brand-input bg-white p-2.5 pr-10 text-[13px] font-normal outline-none"
                        required={!form.id}
                        value={form.login_pin}
                        onChange={(e) =>
                          setForm({ ...form, login_pin: sanitizePinInput(e.target.value) })
                        }
                        type={showPin ? 'text' : 'password'}
                        autoComplete="new-password"
                        placeholder="e.g. Ka!9mP2$"
                      />
                      <button
                        type="button"
                        className="absolute right-2 bottom-2.5 border-0 bg-transparent p-1 text-[#7a807c] hover:text-brand-ink"
                        aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
                        onClick={() => setShowPin((v) => !v)}
                      >
                        {showPin ? <FiEyeOff size={16} /> : <FiEye size={16} />}
                      </button>
                    </label>
                    <SecondaryButton
                      compact
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          login_code: form.login_code || uniqueStaffCode(staff, form.id || null),
                          login_pin: randomComplexPin(10),
                        })
                      }
                    >
                      Generate
                    </SecondaryButton>
                  </div>
                  <p className="m-0 -mt-1 text-[10px] text-brand-subtle">{PIN_RULES_HINT}</p>
                </>
              )}
              <SelectField
                label="Branch"
                required
                value={form.branch_id}
                onChange={(e) => setForm({ ...form, branch_id: e.target.value })}
              >
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Role"
                required
                value={form.role}
                onChange={(e) => {
                  const role = e.target.value
                  setForm({
                    ...form,
                    role,
                    permissions: defaultPermissionsFor(role),
                    ...(usesPinLogin(role) && !form.login_code
                      ? {
                          login_code: uniqueStaffCode(staff, form.id || null),
                          login_pin: form.login_pin || randomComplexPin(10),
                        }
                      : {}),
                  })
                }}
              >
                {roles.map((role) => (
                  <option key={role.name} value={role.name}>
                    {role.label}
                  </option>
                ))}
              </SelectField>
              <fieldset className="rounded-md border border-brand-line p-3">
                <legend className="px-1 text-[10px] font-bold tracking-wide text-brand-label uppercase">
                  Module access
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {MODULES.map((mod) => {
                    const checked = (form.permissions || []).includes(mod.id)
                    return (
                      <label key={mod.id} className="flex items-center gap-2 text-xs text-brand-ink">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const next = new Set(form.permissions || [])
                            if (e.target.checked) next.add(mod.id)
                            else next.delete(mod.id)
                            setForm({ ...form, permissions: [...next] })
                          }}
                        />
                        {mod.label}
                      </label>
                    )
                  })}
                </div>
              </fieldset>
              {form.id && (
                <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
                  <input
                    type="checkbox"
                    checked={form.is_active}
                    onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  />
                  Active account
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <SecondaryButton
                compact
                type="button"
                onClick={() => {
                  setForm(null)
                  setFormError('')
                  setShowPin(false)
                }}
              >
                Cancel
              </SecondaryButton>
              <PrimaryButton compact type="submit">
                {form.id ? 'Save' : 'Create login'}
              </PrimaryButton>
            </div>
          </form>
        </div>
      )}
      {reveal && (
        <div className="fixed inset-0 z-[6] grid place-items-center bg-[#202426aa]">
          <div className="w-[min(360px,calc(100%-32px))] rounded-[10px] bg-white p-6">
            <h2 className="mb-2 text-lg">PIN for {reveal.name}</h2>
            <p className="text-sm text-brand-muted">
              Staff code: <strong>{reveal.loginCode || '—'}</strong>
            </p>
            <p className="mt-1 text-sm text-brand-muted">
              PIN: <strong>{reveal.loginPin || '—'}</strong>
            </p>
            <p className="mt-3 text-[11px] text-brand-subtle">This view is audited.</p>
            <div className="mt-4 flex justify-end">
              <PrimaryButton compact type="button" onClick={() => setReveal(null)}>
                Done
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ManagerStaff
