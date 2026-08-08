import { useEffect, useState } from 'react'
import { FiEye, FiEyeOff } from 'react-icons/fi'
import {
  Field,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  TableCard,
  StatusBadge,
  tableRowClass,
} from '../../components/ui'
import {
  createStaffAccount,
  fetchAllStaff,
  fetchSessionStaff,
  fetchBranches,
  fetchRoles,
  hasSupabase,
  logAuditEvent,
  revealStaffPin,
  updateStaffRow,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import {
  MODULES,
  assignableRoles,
  canAssignRole,
  canEditStaff,
  defaultPermissionsFor,
  moduleLabel,
  permissionDiff,
  usesPinLogin,
} from '../../utils/roles'

import { PIN_RULES_HINT, randomComplexPin, sanitizePinInput, validateComplexPin } from '../../utils/pin'

/**
 * The access badge. Three states, not two.
 *
 * "Custom access" used to fire on ANY difference from the role defaults, which made a
 * perfectly ordinary narrowing — a cashier scoped to POS / Transactions / Day end —
 * look like exactly the same kind of exception as a cashier handed the Staff module.
 * Only the second is worth a warning colour, so only the second gets one; the first is
 * reported as plain information. If the warning fires on routine scoping, people learn
 * to ignore it, and then it is not a warning any more.
 */
function accessBadge(person) {
  const diff = permissionDiff(person)
  if (diff.mode === 'default') {
    return { tone: 'neutral', label: 'Role defaults', sub: 'Role defaults', title: '' }
  }
  if (diff.mode === 'restricted') {
    return {
      tone: 'neutral',
      label: `Scoped · ${diff.missing.length} fewer`,
      sub: 'Narrowed access',
      title: `Removed from role defaults: ${diff.missing.map(moduleLabel).join(', ')}`,
    }
  }
  return {
    tone: 'warn',
    label: `Elevated · +${diff.extra.length}`,
    sub: 'Above role defaults',
    title: `Granted beyond role defaults: ${diff.extra.map(moduleLabel).join(', ')}${
      diff.missing.length ? ` · Removed: ${diff.missing.map(moduleLabel).join(', ')}` : ''
    }`,
  }
}

/**
 * Record a staff create / change in the audit trail.
 *
 * Deliberately records the OLD and NEW role and module list, not just the new one. A row
 * only ever holds its current value, so "who was made a manager, by whom, and when" is
 * unanswerable from the table alone — and a change made then reverted leaves no trace at
 * all. Never logs the PIN itself, only that one was set.
 */
async function auditStaffChange({ branchId, actorId, eventType, target, before }) {
  const roleChanged = before && before.role !== target.role
  const parts = [target.full_name, `role ${target.role}`]
  if (roleChanged) parts.push(`(was ${before.role})`)
  if (before && before.is_active !== target.is_active) {
    parts.push(target.is_active ? 'reactivated' : 'DEACTIVATED')
  }
  if (target.login_pin) parts.push('PIN set')
  await logAuditEvent({
    branchId: branchId || null,
    staffId: actorId || null,
    eventType,
    detail: parts.join(' · '),
    meta: {
      targetStaffId: target.id || null,
      role: target.role,
      previousRole: before?.role ?? null,
      roleChanged: Boolean(roleChanged),
      permissions: target.permissions || null,
      previousPermissions: before?.permissions ?? null,
      isActive: target.is_active,
    },
  }).catch(() => {
    // Never block a legitimate staff change on the audit write — the change already
    // succeeded, and throwing here would leave the UI claiming it failed.
  })
}

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
  const currentUser = useAuthStore((state) => state.user)
  const [staff, setStaff] = useState([])
  const [branches, setBranches] = useState([])
  const [roles, setRoles] = useState(fallbackRoles)
  const [form, setForm] = useState(null)
  const [formError, setFormError] = useState('')
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState(null)
  const [showPin, setShowPin] = useState(false)
  const [loading, setLoading] = useState(true)

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
      setLoading(false)
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

  const pinMode = form && usesPinLogin(form.role)
  const allowedRoles = assignableRoles(currentUser)
  const formDiff = form
    ? permissionDiff({ role: form.role, permissions: form.permissions })
    : { mode: 'default', extra: [], missing: [] }

  if (loading && !staff.length) {
    return <PageSkeleton variant="table" />
  }

  return (
    <div>
      <PageHeader eyebrow="MANAGER" title="Staff accounts">
        <PrimaryButton
          compact
          type="button"
          disabled={!allowedRoles.length}
          title={allowedRoles.length ? undefined : 'Your role cannot create staff accounts.'}
          onClick={() => {
            setFormError('')
            setShowPin(false)
            const startRole = allowedRoles.includes('cashier') ? 'cashier' : allowedRoles[0]
            setForm({
              ...empty,
              branch_id: branches[0]?.id || '',
              role: startRole,
              login_code: uniqueStaffCode(staff),
              login_pin: randomComplexPin(10),
              permissions: defaultPermissionsFor(startRole),
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
        <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_0.8fr_0.7fr_0.7fr] gap-3 bg-brand-dark px-5 py-3 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:px-3">
          <span>Name</span>
          <span className="max-[700px]:hidden">Branch</span>
          <span className="max-[700px]:hidden">Role</span>
          <span className="max-[700px]:hidden">Status</span>
          <span className="text-right max-[700px]:text-left">Action</span>
        </div>
        {staff.map((person) => {
          const badge = accessBadge(person)
          // Whether THIS manager may touch THIS row. Rendering an Edit button that is
          // guaranteed to fail is worse than not rendering it — staff learn to ignore
          // errors, and the refusal is better explained here than as a database message.
          const editable = canEditStaff(currentUser, person)
          const isSelf = currentUser?.id === person.id
          return (
          <div
            key={person.id}
            className={`grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.3fr)_0.8fr_0.7fr_0.7fr] items-center gap-3 px-5 py-3 text-xs max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:items-start max-[700px]:px-3 ${tableRowClass}`}
          >
            <div className="min-w-0">
              <strong className="block truncate text-brand-ink">{person.full_name}</strong>
              <span className="mt-1 inline-flex items-center gap-1.5">
                <StatusBadge
                  tone={badge.tone}
                  className="min-w-0 rounded-md px-1.5 py-0.5 text-[9px]"
                  title={badge.title}
                >
                  {badge.label}
                </StatusBadge>
              </span>
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
            <span className="max-[700px]:hidden">
              {person.roles?.label || person.role}
              <span className="mt-0.5 block text-[10px] text-brand-subtle" title={badge.title}>
                {badge.sub}
              </span>
            </span>
            <span className="max-[700px]:hidden">
              <StatusBadge tone={person.is_active ? 'success' : 'danger'}>
                {person.is_active ? 'Active' : 'Inactive'}
              </StatusBadge>
            </span>
            <div className="flex justify-end gap-2 max-[700px]:flex-col max-[700px]:items-end">
              {/* Revealing a PIN is impersonation of that person for every future audit
                  entry, so it follows the same ceiling as editing them. */}
              {usesPinLogin(person.role) && editable && (
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
              {editable ? (
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
                      permissions: Array.isArray(person.permissions)
                        ? person.permissions
                        : defaultPermissionsFor(person.role),
                    })
                  }}
                >
                  Edit
                </button>
              ) : (
                <span
                  className="text-right text-[10px] leading-tight text-brand-subtle"
                  title={
                    isSelf
                      ? 'Changing your own role or access must be done by someone else.'
                      : 'This account is at or above your own role.'
                  }
                >
                  {isSelf ? 'Your account' : 'Locked'}
                </span>
              )}
            </div>
          </div>
          )
        })}
      </TableCard>
      {form && (
        <div className="fixed inset-0 z-[5] grid place-items-center overflow-auto bg-brand-scrim py-8">
          <form
            className="w-[min(520px,calc(100%-32px))] rounded-[10px] bg-white p-6"
            onSubmit={async (event) => {
              event.preventDefault()
              setFormError('')
              try {
                // Re-checked on submit, not only when rendering the picker: the role
                // field can still be driven by a stale form object, and this is the last
                // point before the write. The database trigger in
                // migrate_role_assignment_ceiling.sql is the actual control — this only
                // turns a rejected write into a sentence someone can act on.
                if (!canAssignRole(currentUser, form.role)) {
                  throw new Error(
                    `You cannot assign the ${form.role} role — it is at or above your own (${currentUser?.role || 'unknown'}). · Code SEC01`,
                  )
                }
                if (form.id && !canEditStaff(currentUser, { id: form.id, role: form.role })) {
                  throw new Error(
                    currentUser?.id === form.id
                      ? 'You cannot edit your own account. Ask someone above you to make this change. · Code SEC03'
                      : 'You cannot edit an account at or above your own role. · Code SEC02',
                  )
                }
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
                  const before = staff.find((p) => p.id === form.id) || {}
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
                  await auditStaffChange({
                    branchId: form.branch_id,
                    actorId: currentUser?.id,
                    eventType: 'staff_updated',
                    target: form,
                    before,
                  })
                  if (currentUser?.id === form.id && hasSupabase) {
                    const refreshed = await fetchSessionStaff()
                    if (refreshed) {
                      useAuthStore.setState((state) => ({ ...state, user: refreshed }))
                    }
                  }
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
                  await auditStaffChange({
                    branchId: form.branch_id,
                    actorId: currentUser?.id,
                    eventType: 'staff_created',
                    target: form,
                    before: null,
                  })
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
                    <label className="relative block min-w-0 flex-1 text-[11px] font-bold text-brand-n700">
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
                        className="absolute right-2 bottom-2.5 border-0 bg-transparent p-1 text-brand-n600 hover:text-brand-ink"
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
                {roles
                  .filter((role) => allowedRoles.includes(role.name))
                  .map((role) => (
                    <option key={role.name} value={role.name}>
                      {role.label}
                    </option>
                  ))}
              </SelectField>
              <p className="m-0 -mt-1 text-[10px] text-brand-subtle">
                You can only assign roles below your own ({currentUser?.role || '—'}).
              </p>
              <fieldset className="rounded-md border border-brand-line p-3">
                <legend className="px-1 text-[10px] font-bold tracking-wide text-brand-label uppercase">
                  Module access
                </legend>
                {/* Says how this differs from the role defaults WHILE it is being set,
                    rather than leaving someone to wonder later why the row is tagged. */}
                <div className="mb-2 flex items-start justify-between gap-2">
                  <span className="text-[10px] leading-snug text-brand-subtle">
                    {formDiff.mode === 'default'
                      ? 'Matches the role defaults.'
                      : formDiff.mode === 'restricted'
                        ? `Narrower than the role default — ${formDiff.missing.map(moduleLabel).join(', ')} removed.`
                        : `Above the role default — grants ${formDiff.extra.map(moduleLabel).join(', ')}.`}
                  </span>
                  {formDiff.mode !== 'default' && (
                    <button
                      type="button"
                      className="shrink-0 border-0 bg-transparent text-[10px] font-bold text-brand-ink underline underline-offset-2"
                      title="Reset to role defaults"
                      onClick={() =>
                        setForm({ ...form, permissions: defaultPermissionsFor(form.role) })
                      }
                    >
                      Reset
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {MODULES.map((mod) => {
                    const checked = (form.permissions || []).includes(mod.id)
                    // Marks access this role would not normally carry, at the moment it
                    // is granted rather than in a review three months later.
                    const beyondRole = checked && formDiff.extra.includes(mod.id)
                    return (
                      <label
                        key={mod.id}
                        className={`flex items-center gap-2 text-xs ${
                          beyondRole ? 'font-bold text-brand-warn' : 'text-brand-ink'
                        }`}
                        title={beyondRole ? 'Beyond this role’s defaults' : undefined}
                      >
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
                <label className="flex items-center gap-2 text-xs font-bold text-brand-n700">
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
        <div className="fixed inset-0 z-[6] grid place-items-center bg-brand-scrim">
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
