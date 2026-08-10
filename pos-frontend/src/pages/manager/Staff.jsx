import { useEffect, useMemo, useState } from 'react'
import { FiEye, FiEyeOff, FiSearch } from 'react-icons/fi'
import Turnstile, { useTurnstileSiteKey } from '../../components/shared/Turnstile'
import {
  ErrorBanner,
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SecondaryButton,
  SearchBox,
  SelectField,
  SkeletonRows,
  Tabs,
  TableCard,
  StatusBadge,
  moneyClass,
  tableRowClass,
  varianceToneClass,
} from '../../components/ui'
import {
  acknowledgeShiftReview,
  adjustShiftCash,
  closeShift,
  createStaffAccount,
  fetchStaffRoster,
  fetchBranches,
  fetchActiveSessions,
  fetchRoles,
  fetchShiftAdjustments,
  fetchStaffShifts,
  hasSupabase,
  logAuditEvent,
  releaseAllStaffSessions,
  forceReleaseStaffSession,
  revealStaffPin,
  updateStaffRow,
  verifyAccountPassword,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { money, today } from '../../utils/format'
import { decimalOnly } from '../../utils/validate'
import {
  MODULES,
  assignableRoles,
  canAssignRole,
  canEditStaff,
  defaultPermissionsFor,
  isManagerRole,
  isSupervisorOrAbove,
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
/**
 * Column template declared once so the header row and the body rows cannot drift apart.
 * Every track is `minmax(0, …)`: a bare `1fr` is `minmax(auto, 1fr)`, so one long name
 * widens that row's columns only and the header ends up over the wrong data.
 */
const STAFF_GRID =
  'grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.6fr)_minmax(0,0.45fr)_minmax(0,0.7fr)_minmax(0,0.6fr)_minmax(0,0.8fr)]'

const fallbackRoles = [
  { name: 'cashier', label: 'Cashier' },
  { name: 'supervisor', label: 'Supervisor' },
  { name: 'manager', label: 'Manager' },
  { name: 'admin', label: 'Admin' },
  { name: 'master', label: 'Master' },
]

function formatWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatDuration(clockIn, clockOut) {
  if (!clockIn) return '—'
  const start = new Date(clockIn).getTime()
  const end = clockOut ? new Date(clockOut).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const mins = Math.round((end - start) / 60000)
  const h = Math.floor(mins / 60)
  return h <= 0 ? `${mins}m` : `${h}h ${mins % 60}m`
}

function totalHoursLabel(shifts = []) {
  let ms = 0
  for (const row of shifts) {
    const start = row.clockIn ? new Date(row.clockIn).getTime() : NaN
    if (Number.isNaN(start)) continue
    // An open shift counts up to now, otherwise today's hours read as zero all day.
    const end = row.clockOut ? new Date(row.clockOut).getTime() : Date.now()
    if (end > start) ms += end - start
  }
  if (ms <= 0) return '—'
  const mins = Math.round(ms / 60000)
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

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

/**
 * Shift status as a badge, not as shorthand buried in a line of text.
 *
 * "main · open now" made a supervisor parse a drawer name and a state out of one string.
 * Drawer and status are different facts and get different columns.
 */
function shiftStatus(row, adjusted) {
  if (row.open) {
    return { label: 'Open', tone: 'success', hint: 'Cashier is on this drawer now' }
  }
  // Closed with no count recorded = the shift ended without the drawer being counted.
  // That is not a normal close and must not look like one.
  if (row.holdsDrawer !== false && row.endingCash == null) {
    return { label: 'Pending handoff', tone: 'warn', hint: 'Ended without a drawer count' }
  }
  if (row.closedWithoutSupervisor && !row.reviewedAt) {
    return { label: 'Needs review', tone: 'warn', hint: 'Closed by the cashier — no supervisor was available to verify' }
  }
  if (adjusted) {
    return { label: 'Adjusted', tone: 'warn', hint: 'Cash figures were corrected after closing' }
  }
  return { label: 'Closed', tone: 'neutral', hint: 'Counted and cashed out' }
}

/**
 * Written out in full, twice, rather than built by interpolation. Tailwind generates
 * classes by scanning source text — a class name assembled at runtime is never seen by
 * the scanner and simply does not exist in the stylesheet.
 */
const SHIFT_GRID_WITH_BRANCH =
  'grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.7fr)]'
const SHIFT_GRID_NO_BRANCH =
  'grid-cols-[minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.75fr)_minmax(0,0.7fr)]'
const SHIFT_GRID_NARROW =
  'max-[900px]:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_minmax(0,0.8fr)]'

/**
 * Shifts tab — chronological, every cashier, one row per shift.
 *
 * Column-per-fact. Whose shift · which drawer · is it live · what went in · what came out ·
 * what it should have been · how far off. A supervisor should be able to scan the variance
 * column alone and stop on the row that is wrong.
 */
function ShiftsTab({ rows, adjustments, loading, showBranch, canAdjustCash, onAdjust, onCloseShift, onAcknowledgeReview }) {
  const grid = showBranch ? SHIFT_GRID_WITH_BRANCH : SHIFT_GRID_NO_BRANCH
  const narrow = SHIFT_GRID_NARROW
  return (
    <TableCard className="max-h-none rounded-t-none">
      <div
        className={`grid ${grid} ${narrow} items-center gap-2 bg-brand-dark px-4 py-2.5 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase`}
      >
        <span>Cashier</span>
        {showBranch && <span className="max-[900px]:hidden">Branch</span>}
        <span className="max-[900px]:hidden">Drawer / terminal</span>
        <span>Status</span>
        <span className="text-right max-[900px]:hidden">Opening float</span>
        <span className="text-right max-[900px]:hidden">Closing cash</span>
        <span className="text-right max-[900px]:hidden">Expected</span>
        <span className="text-right">Variance</span>
      </div>

      {loading ? (
        <SkeletonRows rows={8} cols={showBranch ? 6 : 5} />
      ) : rows.length === 0 ? (
        <div className="px-4 py-8 text-xs text-brand-subtle">
          No shifts in this date range.
        </div>
      ) : (
        rows.map((row) => {
          const logged = adjustments[row.id] || []
          const status = shiftStatus(row, logged.length > 0)
          const floorShift = row.holdsDrawer === false
          return (
            <div
              key={row.id}
              className={`grid ${grid} ${narrow} items-center gap-2 px-4 py-3 text-xs ${tableRowClass}`}
            >
              <div className="min-w-0">
                <strong className="block truncate text-brand-ink">{row.staffName}</strong>
                <small className="block truncate text-[10px] text-brand-subtle capitalize">
                  {row.staffRole || '—'} · {formatWhen(row.clockIn)} ·{' '}
                  {formatDuration(row.clockIn, row.clockOut)}
                </small>
                {/* Narrow screens drop most columns, so the money is summarised here. */}
                <small className="mt-0.5 hidden text-[10px] text-brand-subtle max-[900px]:block">
                  {floorShift ? 'No drawer' : row.drawerLabel || row.drawerId}
                  {' · in '}
                  {floorShift ? '—' : money(row.startingCash)}
                </small>
              </div>
              {showBranch && (
                <span className="truncate text-brand-muted max-[900px]:hidden">
                  {row.branchName || '—'}
                </span>
              )}
              <span className="truncate text-brand-muted max-[900px]:hidden">
                {floorShift ? 'No drawer' : row.drawerLabel || row.drawerId}
              </span>
              <span className="min-w-0">
                <StatusBadge compact tone={status.tone} title={status.hint}>
                  {status.label}
                </StatusBadge>
                {row.shiftPeriod && (
                  <span className="mt-0.5 block text-[10px] text-brand-subtle">
                    {row.shiftPeriod.toUpperCase()}
                  </span>
                )}
              </span>
              <span className={`text-right max-[900px]:hidden ${moneyClass}`}>
                {floorShift ? '—' : money(row.startingCash)}
              </span>
              <span className={`text-right max-[900px]:hidden ${moneyClass}`}>
                {row.endingCash == null ? '—' : money(row.endingCash)}
              </span>
              <span className={`text-right text-brand-muted max-[900px]:hidden ${moneyClass}`}>
                {row.expectedCash == null ? '—' : money(row.expectedCash)}
              </span>
              <div className="text-right">
                <strong className={`block ${moneyClass} ${varianceToneClass(row.variance)}`}>
                  {row.variance == null ? '—' : money(row.variance)}
                </strong>
                {canAdjustCash && !row.open && !floorShift && (
                  <button
                    type="button"
                    className="mt-0.5 border-0 bg-transparent text-[10px] font-bold text-brand-ink underline underline-offset-2"
                    onClick={() => onAdjust(row, 'ending_cash', row.endingCash)}
                  >
                    Correct
                  </button>
                )}
                {canAdjustCash && row.closedWithoutSupervisor && !row.reviewedAt && (
                  <button
                    type="button"
                    className="mt-0.5 block border-0 bg-transparent text-[10px] font-bold text-brand-ink underline underline-offset-2"
                    onClick={() => onAcknowledgeReview(row)}
                  >
                    Acknowledge
                  </button>
                )}
                {/* A cashier starting a new shift on this drawer never sees who is holding
                    it or a way to close it (see ShiftGate) — the drawer is freed from here
                    instead, by someone who can actually count and verify the cash. */}
                {canAdjustCash && row.open && !floorShift && (
                  <button
                    type="button"
                    className="mt-0.5 border-0 bg-transparent text-[10px] font-bold text-brand-ink underline underline-offset-2"
                    onClick={() => onCloseShift(row)}
                  >
                    Close shift
                  </button>
                )}
              </div>
            </div>
          )
        })
      )}
    </TableCard>
  )
}

/**
 * Staff — one tab covering both "who works here" and "what did their shifts look like".
 *
 * These used to be two pages listing the same people, and the shift log could not answer
 * "what role is this person" while the staff list could not answer "did their drawer
 * balance". One row per person, expanding into that person's shifts, answers both.
 *
 * Role-aware rather than role-gated: supervisors get the roster + hours + drawer detail
 * for their own branch (what the old Shifts page gave them); account creation, role
 * changes and PIN reveal stay manager-only, exactly as before the merge.
 */
function ManagerStaff() {
  const currentUser = useAuthStore((state) => state.user)
  const canManageAccounts = isManagerRole(currentUser?.role)
  const canAdjustCash = isSupervisorOrAbove(currentUser?.role)
  const lockedBranchId = canManageAccounts ? null : currentUser?.branchId || null

  const [staff, setStaff] = useState([])
  const [branches, setBranches] = useState([])
  const [roles, setRoles] = useState(fallbackRoles)
  const [form, setForm] = useState(null)
  const [formError, setFormError] = useState('')
  const [error, setError] = useState('')
  const [reveal, setReveal] = useState(null)
  const [pinRevealTarget, setPinRevealTarget] = useState(null) // person whose PIN to reveal once password is confirmed
  const [pinRevealPassword, setPinRevealPassword] = useState('')
  const [pinRevealError, setPinRevealError] = useState('')
  const [pinRevealBusy, setPinRevealBusy] = useState(false)
  const [showPin, setShowPin] = useState(false)
  const [loading, setLoading] = useState(true)

  // Browser-tab style: 'staff' = who works here, 'shifts' = the shift log. Both read the
  // same branch + date filters above them, so switching tabs keeps your place.
  const [tab, setTab] = useState('staff')
  const [query, setQuery] = useState('')

  // Shift log (merged in from the old Shifts page)
  const [branchFilter, setBranchFilter] = useState(lockedBranchId || '')
  const [start, setStart] = useState(today())
  const [end, setEnd] = useState(today())
  const [shifts, setShifts] = useState([])
  const [adjustments, setAdjustments] = useState({})
  const [shiftsLoading, setShiftsLoading] = useState(false)
  const [adjusting, setAdjusting] = useState(null) // { shift, field }
  const [adjustValue, setAdjustValue] = useState('')
  const [adjustReason, setAdjustReason] = useState('')
  const [adjustBusy, setAdjustBusy] = useState(false)
  const [closingShift, setClosingShift] = useState(null)
  const [closingCash, setClosingCash] = useState('')
  const [closingNote, setClosingNote] = useState('')
  const [closingBusy, setClosingBusy] = useState(false)
  const [closingError, setClosingError] = useState('')

  // Captcha for account creation (signUp), not for editing.
  const {
    siteKey: turnstileSiteKey,
    loading: captchaLoading,
    enabled: captchaActive,
  } = useTurnstileSiteKey()
  const [captchaToken, setCaptchaToken] = useState('')
  // Bumped after each attempt so a consumed/expired token is replaced with a fresh widget
  // instead of leaving a dead one on screen.
  const [captchaKey, setCaptchaKey] = useState(0)

  // Force sign-out (master only) — see fetchActiveSessions for why this exists.
  const isMaster = currentUser?.role === 'master'
  const [sessions, setSessions] = useState([])
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(null)
  const [sessionNote, setSessionNote] = useState('')

  const loadSessions = async () => {
    if (!isMaster || !hasSupabase) return
    try {
      setSessions(await fetchActiveSessions())
      setSessionNote('')
    } catch (err) {
      setSessionNote(formatSupportError(err, 'SESS01'))
    }
  }

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
    // Branches and the roles lookup are manager-shaped reads. A supervisor opening this
    // page for the shift log must not get an empty screen because one of them was denied
    // by RLS — only the staff list is load-bearing here.
    const [people, branchRows, roleRows] = await Promise.all([
      // Supervisors go through the definer roster (their RLS grants them one row only).
      fetchStaffRoster({ branchId: lockedBranchId, isManager: canManageAccounts }),
      fetchBranches().catch(() => []),
      fetchRoles().catch(() => []),
    ])
    setStaff(people)
    setBranches(branchRows)
    setRoles(roleRows.length ? roleRows : fallbackRoles)
    setLoading(false)
  }

  const loadShifts = async () => {
    if (!hasSupabase) {
      setShifts([])
      return
    }
    setShiftsLoading(true)
    try {
      const effectiveBranch = lockedBranchId || branchFilter || null
      const data = await fetchStaffShifts({
        branchId: effectiveBranch,
        start: start || null,
        end: end || null,
      })
      setShifts(data || [])
      const logged = await fetchShiftAdjustments((data || []).map((row) => row.id)).catch(() => [])
      setAdjustments(
        logged.reduce((acc, row) => {
          acc[row.shiftId] = [...(acc[row.shiftId] || []), row]
          return acc
        }, {}),
      )
    } catch (err) {
      setError(formatSupportError(err, 'SHIFT01'))
    } finally {
      setShiftsLoading(false)
    }
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

  useEffect(() => {
    void loadShifts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchFilter, start, end])

  /** shifts grouped by staff id — the join between the two old pages. */
  const shiftsByStaff = useMemo(() => {
    const map = new Map()
    for (const row of shifts) {
      const key = row.staffId
      if (!key) continue
      map.set(key, [...(map.get(key) || []), row])
    }
    return map
  }, [shifts])

  // Supervisors see their own branch's people only. The server already scopes this
  // (branch_staff_roster); the client filter keeps the list honest for managers switching
  // branches, and costs nothing.
  const visibleStaff = useMemo(() => {
    const q = query.trim().toLowerCase()
    let rows = staff
    if (lockedBranchId) rows = rows.filter((p) => p.branch_id === lockedBranchId)
    else if (branchFilter) rows = rows.filter((p) => p.branch_id === branchFilter)
    if (q) {
      rows = rows.filter((p) =>
        `${p.full_name || ''} ${p.role || ''} ${p.login_code || ''} ${p.branches?.name || ''}`
          .toLowerCase()
          .includes(q),
      )
    }
    return rows
  }, [staff, lockedBranchId, branchFilter, query])

  /** Flat shift rows for the Shifts tab, narrowed by the same search box. */
  const visibleShifts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return shifts
    return shifts.filter((row) =>
      `${row.staffName || ''} ${row.staffRole || ''} ${row.drawerLabel || row.drawerId || ''} ${
        row.branchName || ''
      }`
        .toLowerCase()
        .includes(q),
    )
  }, [shifts, query])

  const pinMode = form && usesPinLogin(form.role)
  const allowedRoles = assignableRoles(currentUser)
  const formDiff = form
    ? permissionDiff({ role: form.role, permissions: form.permissions })
    : { mode: 'default', extra: [], missing: [] }

  if (loading && !staff.length) {
    return <PageSkeleton variant="table" />
  }

  // Revealing a PIN is impersonation for every future audit entry (see the button above) —
  // re-confirming the manager's own password first means a screen left unlocked can't be
  // used to lift someone else's login on a glance. Same verifier the lock screen uses, so
  // it works offline too.
  const onConfirmPinReveal = async () => {
    if (!pinRevealTarget) return
    if (!pinRevealPassword) {
      setPinRevealError('Enter your password to continue.')
      return
    }
    setPinRevealBusy(true)
    setPinRevealError('')
    try {
      if (hasSupabase) {
        await verifyAccountPassword(currentUser?.email, pinRevealPassword, { staffId: currentUser?.id })
      }
      const data = hasSupabase
        ? await revealStaffPin(pinRevealTarget.id)
        : { name: pinRevealTarget.full_name, loginCode: '1234', loginPin: '1234' }
      setReveal(data)
      setPinRevealTarget(null)
      setPinRevealPassword('')
    } catch (err) {
      setPinRevealError(err.message)
    } finally {
      setPinRevealBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow={canManageAccounts ? 'MANAGER' : 'BRANCH'}
        title="Staff"
      >
        {isMaster && (
          <SecondaryButton
            compact
            type="button"
            className="mr-2"
            onClick={() => {
              setSessionsOpen(true)
              void loadSessions()
            }}
          >
            Signed-in devices
          </SecondaryButton>
        )}
        {canManageAccounts && (
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
        )}
      </PageHeader>
      {error && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>
      )}

      {/* One filter row for both tabs. Search and Branch are labelled controls of the
          same height so the row reads as one strip — the search box used to be a
          different height from the dropdown beside it. */}
      <TableCard className="mb-3.5 max-h-none p-4">
        <div className="flex flex-wrap items-end gap-3">
          <SearchBox
            label={tab === 'shifts' ? 'Search staff or drawer' : 'Search staff'}
            className="min-w-[220px] flex-1"
            icon={<FiSearch />}
            placeholder={tab === 'shifts' ? 'Name, drawer or branch' : 'Name, role or staff code'}
            value={query}
            onChange={(e) => setQuery(e.target.value.replace(/[<>]/g, ''))}
          />
          {canManageAccounts ? (
            <SelectField
              label="Branch"
              className="min-w-[170px]"
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
          ) : (
            /* Supervisors are pinned to their own branch by RLS, so a dropdown here would
               offer choices the server refuses. Show which branch they are looking at
               instead of a control that cannot work. */
            <label className="block min-w-[170px] text-[11px] font-bold text-brand-n700">
              Branch
              <span className="mt-[7px] flex h-10 items-center rounded-[5px] border border-brand-input bg-brand-n50 px-3 text-[13px] font-normal text-brand-muted">
                {branches.find((b) => b.id === lockedBranchId)?.name ||
                  currentUser?.branchName ||
                  'Your branch'}
              </span>
            </label>
          )}
          <Field
            label="Shifts from"
            type="date"
            className="min-w-[140px]"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <Field
            label="To"
            type="date"
            className="min-w-[140px]"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
          <SecondaryButton compact type="button" disabled={shiftsLoading} onClick={() => void loadShifts()}>
            {shiftsLoading ? 'Loading…' : 'Refresh'}
          </SecondaryButton>
        </div>
        <p className="m-0 mt-2 text-[11px] text-brand-subtle">
          Hours, shift count and variance are for the date range above. Role, branch and
          access are not.
        </p>
      </TableCard>

      <Tabs
        className="mb-0"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'staff', label: 'Staff', count: visibleStaff.length },
          { id: 'shifts', label: 'Shifts', count: visibleShifts.length },
        ]}
      />

      {tab === 'shifts' ? (
        <ShiftsTab
          rows={visibleShifts}
          adjustments={adjustments}
          loading={shiftsLoading}
          showBranch={canManageAccounts}
          canAdjustCash={canAdjustCash}
          onAdjust={(shift, field, current) => {
            setAdjusting({ shift, field })
            setAdjustValue(String(current ?? ''))
            setAdjustReason('')
          }}
          onCloseShift={(shift) => {
            setClosingShift(shift)
            setClosingCash('')
            setClosingNote('')
            setClosingError('')
          }}
          onAcknowledgeReview={async (shift) => {
            try {
              await acknowledgeShiftReview(shift.id, currentUser?.id || null)
              await loadShifts()
            } catch (err) {
              setError(formatSupportError(err, 'SHIFT01'))
            }
          }}
        />
      ) : (
      <TableCard className="rounded-t-none">
        <div className={`grid ${STAFF_GRID} gap-3 bg-brand-dark px-5 py-3 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:px-3`}>
          <span>Name</span>
          <span className="max-[700px]:hidden">Branch</span>
          <span className="max-[700px]:hidden">Role</span>
          <span className="text-right max-[700px]:hidden">Hours</span>
          <span className="text-right max-[700px]:hidden">Shifts</span>
          <span className="text-right max-[700px]:hidden">Variance</span>
          <span className="max-[700px]:hidden">Status</span>
          <span className="text-right max-[700px]:text-left">Action</span>
        </div>
        {visibleStaff.map((person) => {
          const badge = accessBadge(person)
          // Whether THIS manager may touch THIS row. Rendering an Edit button that is
          // guaranteed to fail is worse than not rendering it — staff learn to ignore
          // errors, and the refusal is better explained here than as a database message.
          const editable = canManageAccounts && canEditStaff(currentUser, person)
          const isSelf = currentUser?.id === person.id
          const personShifts = shiftsByStaff.get(person.id) || []
          const closedShifts = personShifts.filter((s) => !s.open && s.variance != null)
          const netVariance = closedShifts.reduce((sum, s) => sum + Number(s.variance || 0), 0)
          const openNow = personShifts.some((s) => s.open)
          return (
          <div key={person.id}>
          <div
            className={`grid ${STAFF_GRID} items-center gap-3 px-5 py-3 text-xs max-[700px]:grid-cols-[minmax(0,1fr)_auto] max-[700px]:items-start max-[700px]:px-3 ${tableRowClass}`}
          >
            <div className="min-w-0">
              <strong className="block truncate text-brand-ink">
                {person.full_name}
                {openNow && (
                  <span className="ml-1.5 rounded-[3px] bg-brand-success-bg px-1 py-px text-[9px] font-bold text-brand-success-text">
                    ON SHIFT
                  </span>
                )}
              </strong>
              <small className="mt-0.5 hidden text-[10px] leading-snug text-brand-subtle max-[700px]:block">
                {person.branches?.name || '—'}
                {' · '}
                {person.roles?.label || person.role}
                {' · '}
                {totalHoursLabel(personShifts)}
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
            <strong className="text-right tabular-nums text-brand-ink max-[700px]:hidden">
              {totalHoursLabel(personShifts)}
            </strong>
            <span className="text-right tabular-nums max-[700px]:hidden">
              {personShifts.length || '—'}
            </span>
            <strong
              className={`text-right max-[700px]:hidden ${moneyClass} ${
                closedShifts.length ? varianceToneClass(netVariance) : 'text-brand-subtle'
              }`}
            >
              {closedShifts.length ? money(netVariance) : '—'}
            </strong>
            <span className="max-[700px]:hidden">
              <StatusBadge tone={person.is_active ? 'success' : 'danger'}>
                {person.is_active ? 'Active' : 'Inactive'}
              </StatusBadge>
            </span>
            <div
              className="flex justify-end gap-2 max-[700px]:flex-col max-[700px]:items-end"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              role="presentation"
            >
              {/* Revealing a PIN is impersonation of that person for every future audit
                  entry, so it follows the same ceiling as editing them. */}
              {usesPinLogin(person.role) && editable && (
                <button
                  type="button"
                  className="border-0 bg-transparent text-xs font-bold text-brand-ink"
                  onClick={() => {
                    setPinRevealError('')
                    setPinRevealPassword('')
                    setPinRevealTarget(person)
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
          </div>
          )
        })}
        {visibleStaff.length === 0 && (
          <div className="px-5 py-8 text-xs text-brand-subtle">
            {query.trim() ? 'No staff match that search.' : 'No staff accounts to show.'}
          </div>
        )}
      </TableCard>
      )}

      {/* Break-glass: clear a session that no device is actually holding. A tab killed
          from Task Manager, a dead battery or a power cut never runs the sign-out that
          releases the lock, so the account refuses its own owner for up to 15 minutes. */}
      {sessionsOpen && (
        <Modal wide onClose={() => setSessionsOpen(false)}>
          <Eyebrow>SIGNED-IN DEVICES</Eyebrow>
          <h2 className="mb-1 text-lg">Force sign-out</h2>
          <p className="m-0 text-xs text-brand-muted">
            One account can only be signed in on one device at a time. If someone is locked
            out with &ldquo;already signed in&rdquo; but no device is actually holding the
            account, clear it here. <strong>Expired</strong> rows are no longer blocking
            anyone; <strong>live</strong> ones will eject that person mid-sale.
          </p>
          {sessionNote && <p className="mt-2 text-xs text-brand-danger">{sessionNote}</p>}

          <div className="mt-3 max-h-[46vh] overflow-auto rounded border border-brand-softline">
            {sessions.length === 0 ? (
              <p className="m-0 px-3 py-6 text-xs text-brand-subtle">
                No account is currently holding a session.
              </p>
            ) : (
              sessions.map((row) => (
                <div
                  key={row.staffId}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-brand-softline px-3 py-2.5 text-xs first:border-t-0"
                >
                  <div className="min-w-0">
                    <strong className="block truncate text-brand-ink">{row.name}</strong>
                    <span className="block text-[10px] text-brand-subtle capitalize">
                      {row.role || '—'} · {row.branchName}
                      {row.heartbeatAt
                        ? ` · last seen ${new Date(row.heartbeatAt).toLocaleString()}`
                        : ''}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusBadge compact tone={row.isStale ? 'neutral' : 'success'}>
                      {row.isStale ? 'Expired' : 'Live'}
                    </StatusBadge>
                    <SecondaryButton
                      compact
                      type="button"
                      disabled={sessionBusy === row.staffId || row.staffId === currentUser?.id}
                      title={
                        row.staffId === currentUser?.id
                          ? 'This is your own session'
                          : 'Clear this session so they can sign in again'
                      }
                      onClick={async () => {
                        setSessionBusy(row.staffId)
                        setSessionNote('')
                        try {
                          await forceReleaseStaffSession(row.staffId)
                          await loadSessions()
                        } catch (err) {
                          setSessionNote(formatSupportError(err, 'SESS02'))
                        } finally {
                          setSessionBusy(null)
                        }
                      }}
                    >
                      Sign out
                    </SecondaryButton>
                  </div>
                </div>
              ))
            )}
          </div>

          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setSessionsOpen(false)}>
              Close
            </SecondaryButton>
            <SecondaryButton compact type="button" onClick={() => void loadSessions()}>
              Refresh
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={sessionBusy === 'all' || sessions.length === 0}
              onClick={async () => {
                setSessionBusy('all')
                setSessionNote('')
                try {
                  const n = await releaseAllStaffSessions(null)
                  await loadSessions()
                  setSessionNote(`Signed out ${n} account${n === 1 ? '' : 's'}. Yours was kept.`)
                } catch (err) {
                  setSessionNote(formatSupportError(err, 'SESS02'))
                } finally {
                  setSessionBusy(null)
                }
              }}
            >
              {sessionBusy === 'all' ? 'Working…' : 'Sign out everyone'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {adjusting && (
        <Modal onClose={() => !adjustBusy && setAdjusting(null)}>
          <Eyebrow>CORRECT SHIFT CASH</Eyebrow>
          <h2 className="mb-1 text-lg">
            {adjusting.field === 'starting_cash' ? 'Float in' : 'Ending count'} ·{' '}
            {adjusting.shift.staffName}
          </h2>
          <p className="m-0 text-xs text-brand-muted">
            The old value, the new value, your name and this reason are all written to the
            adjustment log. The original shift record is never overwritten silently.
          </p>
          <Field
            className="mt-3"
            label="Corrected amount"
            value={adjustValue}
            onChange={(e) => setAdjustValue(decimalOnly(e.target.value))}
            inputMode="decimal"
            required
          />
          <Field
            className="mt-3"
            label="Reason (required)"
            value={adjustReason}
            onChange={(e) => setAdjustReason(e.target.value.replace(/[<>]/g, ''))}
            required
          />
          {error && <ErrorBanner className="mt-3 mb-0" error={error} />}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={adjustBusy} onClick={() => setAdjusting(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={adjustBusy || adjustValue === '' || !adjustReason.trim()}
              onClick={async () => {
                setAdjustBusy(true)
                setError('')
                try {
                  await adjustShiftCash({
                    shiftId: adjusting.shift.id,
                    field: adjusting.field,
                    newValue: Number(adjustValue),
                    reason: adjustReason.trim(),
                    approvedBy: currentUser?.id || null,
                  })
                  setAdjusting(null)
                  await loadShifts()
                } catch (err) {
                  setError(formatSupportError(err, 'SHIFT03'))
                } finally {
                  setAdjustBusy(false)
                }
              }}
            >
              {adjustBusy ? 'Saving…' : 'Save correction'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
      {closingShift && (
        <Modal onClose={() => !closingBusy && setClosingShift(null)}>
          <Eyebrow>CLOSE SHIFT</Eyebrow>
          <h2 className="mb-1 text-lg">{closingShift.staffName}'s drawer</h2>
          <p className="m-0 text-xs text-brand-muted">
            Count {closingShift.drawerLabel || closingShift.drawerId} yourself before entering
            this — it becomes their ending count and their variance, and frees the drawer for
            the next cashier.
          </p>
          <Field
            className="mt-3"
            label="Cash counted in the drawer"
            value={closingCash}
            onChange={(e) => setClosingCash(decimalOnly(e.target.value))}
            inputMode="decimal"
            required
            placeholder="0.00"
          />
          <Field
            className="mt-3"
            label="Note"
            value={closingNote}
            onChange={(e) => setClosingNote(e.target.value.replace(/[<>]/g, ''))}
            placeholder="Optional"
          />
          {closingError && <ErrorBanner className="mt-3 mb-0" error={closingError} />}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={closingBusy} onClick={() => setClosingShift(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={closingBusy || closingCash === ''}
              onClick={async () => {
                setClosingBusy(true)
                setClosingError('')
                try {
                  await closeShift({
                    shiftId: closingShift.serverId || closingShift.id,
                    endingCash: Number(closingCash),
                    note: closingNote.trim(),
                    closedBy: currentUser?.id || null,
                  })
                  setClosingShift(null)
                  await loadShifts()
                } catch (err) {
                  setClosingError(formatSupportError(err, 'SHIFT02'))
                } finally {
                  setClosingBusy(false)
                }
              }}
            >
              {closingBusy ? 'Closing…' : 'Close shift'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
      {form && (
        <Modal
          wide
          onClose={() => {
            setForm(null)
            setFormError('')
            setShowPin(false)
          }}
        >
          <form
            onSubmit={async (event) => {
              event.preventDefault()
              setFormError('')
              try {
                // Re-checked on submit, not only when rendering the picker: the role
                // field can still be driven by a stale form object, and this is the last
                // point before the write. The database trigger in
                // migrate_role_assignment_ceiling.sql is the actual control — this only
                // turns a rejected write into a sentence someone can act on.
                // The account as it is STORED, not as the form currently describes it.
                const storedTarget = form.id ? staff.find((p) => p.id === form.id) : null
                // Checking against form.role let the ceiling be sidestepped: point the form
                // at an admin, set the role field to 'cashier', and both guards pass on the
                // new low rank while the write lands on the high-ranked row. Authorisation
                // has to be decided by what is being edited, never by what the editor typed.
                if (form.id && !canEditStaff(currentUser, storedTarget || { id: form.id, role: 'master' })) {
                  throw new Error(
                    currentUser?.id === form.id
                      ? 'You cannot edit your own account. Ask someone above you to make this change. · Code SEC03'
                      : 'You cannot edit an account at or above your own role. · Code SEC02',
                  )
                }
                // Separately: the role being ASSIGNED must also be below the actor's.
                if (!canAssignRole(currentUser, form.role)) {
                  throw new Error(
                    `You cannot assign the ${form.role} role — it is at or above your own (${currentUser?.role || 'unknown'}). · Code SEC01`,
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
                  // No self-refresh branch here any more: canEditStaff rejects self-edit
                  // above, so a manager can never be editing their own row by this point.
                } else {
                  if (!hasSupabase) throw new Error('Connect Supabase to create staff logins.')
                  let created = null
                  if (usesPinLogin(form.role)) {
                    if (!form.login_code || !form.login_pin) {
                      throw new Error('Staff code and PIN are required for cashiers/supervisors.')
                    }
                    created = await createStaffAccount({
                      fullName: form.full_name,
                      role: form.role,
                      branchId: form.branch_id,
                      loginCode: form.login_code,
                      loginPin: form.login_pin,
                      permissions: form.permissions,
                      captchaToken: captchaToken || undefined,
                    })
                  } else {
                    created = await createStaffAccount({
                      email: form.email,
                      password: form.password,
                      fullName: form.full_name,
                      role: form.role,
                      branchId: form.branch_id,
                      permissions: form.permissions,
                      captchaToken: captchaToken || undefined,
                    })
                  }
                  await auditStaffChange({
                    branchId: form.branch_id,
                    actorId: currentUser?.id,
                    eventType: 'staff_created',
                    // The created row's id, not the form's (which has none yet). Without it
                    // the audit entry identifies the new account only by a free-text name,
                    // so two people sharing a name — or one later renamed — makes the
                    // record unattributable, defeating the point of logging it.
                    target: { ...form, id: created?.staffId || created?.id || null },
                    before: null,
                  })
                }
                setForm(null)
                setFormError('')
                setCaptchaToken('')
                setCaptchaKey((k) => k + 1)
                await reload()
              } catch (err) {
                // A Turnstile token is single-use, so a failed submit needs a fresh
                // challenge — otherwise the retry fails on a spent token and looks like
                // the same error twice.
                setCaptchaToken('')
                setCaptchaKey((k) => k + 1)
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
              {/* Creating a login calls supabase.auth.signUp, and the project has captcha
                  protection switched on — the same gate the sign-in screen already
                  satisfies. Without a token the server rejects it with "captcha
                  protection: request disallowed". Editing an existing account does not
                  touch Auth, so no challenge there. */}
              {!form.id && captchaActive && !captchaLoading && (
                <div>
                  <span className="mb-1.5 block text-[11px] font-bold text-brand-n700">
                    Security check
                  </span>
                  <Turnstile
                    key={captchaKey}
                    siteKey={turnstileSiteKey}
                    onVerify={setCaptchaToken}
                    onExpire={() => setCaptchaToken('')}
                    onError={() => setCaptchaToken('')}
                  />
                </div>
              )}
            </div>
            <ModalActions>
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
              <PrimaryButton
                compact
                type="submit"
                disabled={!form.id && captchaActive && !captchaLoading && !captchaToken}
                title={
                  !form.id && captchaActive && !captchaToken
                    ? 'Complete the security check first'
                    : undefined
                }
              >
                {form.id ? 'Save' : 'Create login'}
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}
      {pinRevealTarget && (
        <Modal
          layer
          onClose={() => {
            setPinRevealTarget(null)
            setPinRevealPassword('')
            setPinRevealError('')
          }}
        >
            <h2 className="mb-2 text-lg">Confirm your password</h2>
            <p className="text-sm text-brand-muted">
              Re-enter your password to reveal {pinRevealTarget.full_name}&rsquo;s PIN.
            </p>
            <Field
              className="mt-3"
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={pinRevealPassword}
              onChange={(e) => setPinRevealPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onConfirmPinReveal()
              }}
              autoFocus
            />
            {pinRevealError && <p className="mt-2 text-xs text-brand-danger">{pinRevealError}</p>}
            <ModalActions>
              <SecondaryButton
                compact
                type="button"
                disabled={pinRevealBusy}
                onClick={() => {
                  setPinRevealTarget(null)
                  setPinRevealPassword('')
                  setPinRevealError('')
                }}
              >
                Cancel
              </SecondaryButton>
              <PrimaryButton compact type="button" disabled={pinRevealBusy} onClick={onConfirmPinReveal}>
                {pinRevealBusy ? 'Checking…' : 'Confirm'}
              </PrimaryButton>
            </ModalActions>
        </Modal>
      )}
      {reveal && (
        <Modal layer onClose={() => setReveal(null)}>
            <h2 className="mb-2 text-lg">PIN for {reveal.name}</h2>
            <p className="text-sm text-brand-muted">
              Staff code: <strong>{reveal.loginCode || '—'}</strong>
            </p>
            <p className="mt-1 text-sm text-brand-muted">
              PIN: <strong>{reveal.loginPin || '—'}</strong>
            </p>
            <p className="mt-3 text-[11px] text-brand-subtle">This view is audited.</p>
            <ModalActions>
              <PrimaryButton compact type="button" onClick={() => setReveal(null)}>
                Done
              </PrimaryButton>
            </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default ManagerStaff
