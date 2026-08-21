import { supabase } from '../supabase'
import { normalizeBranchType } from '../../utils/features'
import { isSupervisorOrAbove, isManagerRole } from '../../utils/roles'
import { clearUnlockSecret, loadUnlockSecret, saveUnlockSecret } from '../../offline/session'
import { createVerifier, isVerifierExpired, verifyAgainst } from '../../utils/unlockVerifier'
import { withTimeout } from '../../utils/withTimeout'
import { hasSupabase } from './shared.js'
import { logAuditEvent } from './audit.js'

/** Minimal round-trip to verify Supabase is reachable (not just navigator.onLine). */
export async function pingBackend() {
  if (!supabase) throw new Error('Backend not configured')
  const { error } = await supabase.from('branches').select('id').limit(1)
  if (error) throw error
}

/** True when sessionStorage still holds a Supabase auth session (works offline). */
export async function hasAuthSession() {
  if (!supabase) return false
  const { data } = await supabase.auth.getSession()
  return Boolean(data?.session)
}

export async function fetchSessionStaff() {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return null
  const selectFull =
    'id, full_name, role, branch_id, is_active, login_code, permissions, branches(id, name, address, is_active, day_open_hour, branch_type, device_settings, vat_rate)'
  const selectBase =
    'id, full_name, role, branch_id, is_active, branches(id, name, address, is_active, day_open_hour, branch_type)'
  let { data, error } = await supabase
    .from('staff')
    .select(selectFull)
    .eq('auth_user_id', auth.user.id)
    .eq('is_active', true)
    .maybeSingle()
  if (error && /login_code|permissions|vat_rate|device_settings|schema cache|column/i.test(String(error.message || ''))) {
    ;({ data, error } = await supabase
      .from('staff')
      .select(selectBase)
      .eq('auth_user_id', auth.user.id)
      .eq('is_active', true)
      .maybeSingle())
  }
  if (error) throw error
  if (!data) return null
  return {
    id: data.id,
    authUserId: auth.user.id,
    email: auth.user.email,
    name: data.full_name,
    role: data.role,
    branchId: data.branch_id,
    branchName: data.branches?.name || 'Branch',
    branchAddress: data.branches?.address || '',
    branchType: normalizeBranchType(data.branches?.branch_type),
    dayOpenHour: Number(data.branches?.day_open_hour ?? 7),
    deviceSettings: data.branches?.device_settings || null,
    vatRate: Number(data.branches?.vat_rate ?? 0.12),
    loginCode: data.login_code || null,
    permissions: Array.isArray(data.permissions) ? data.permissions : null,
  }
}

export async function signIn(email, password, { captchaToken } = {}) {
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
    options: captchaToken ? { captchaToken } : undefined,
  })
  if (error) throw error
  return fetchSessionStaff()
}

/**
 * Authenticates a cashier or supervisor using a staff code and PIN.
 * @param {string|number} loginCode - The staff code; non-digit characters are ignored.
 * @param {string|number} pin - The six-digit PIN; non-digit characters are ignored.
 * @param {Object} [options] - Sign-in options.
 * @param {string} options.captchaToken - CAPTCHA verification token.
 * @returns {Promise<Object>} The authenticated user.
 * @throws {Error} If the CAPTCHA token is missing or the staff code and PIN are invalid.
 */
export async function signInWithPin(loginCode, pin, { captchaToken } = {}) {
  const code = String(loginCode || '').replace(/\D/g, '')
  // Till PIN is exactly 6 digits (cashier/supervisor).
  const pinVal = String(pin || '').replace(/\D/g, '').slice(0, 6)
  if (!captchaToken) {
    throw new Error('Complete the security check before signing in.')
  }
  const { data, error } = await supabase.rpc('resolve_pin_login', {
    p_login_code: code,
    p_pin: pinVal,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.auth_email) throw new Error('Invalid staff code or PIN')
  const user = await signIn(row.auth_email, pinVal, { captchaToken })
  if (row.staff_id && (isSupervisorOrAbove(row.role) || isManagerRole(row.role))) {
    try {
      const { cacheSupervisorVerifierFromPin } = await import('../../offline/supervisorPin')
      await cacheSupervisorVerifierFromPin(
        {
          staffId: row.staff_id,
          fullName: row.full_name,
          role: row.role,
          branchId: row.branch_id,
        },
        code,
        pinVal,
      )
    } catch {
      /* local cache optional */
    }
  }
  return user
}

function parseSupervisorPinRpcResult(data) {
  if (data == null) return null
  let row
  if (typeof data === 'string') {
    row = { staff_id: data, staffId: data }
  } else {
    row = Array.isArray(data) ? data[0] : data
  }
  if (!row) return null
  const staffId = row.staff_id || row.staffId || row.id || null
  if (!staffId) return null
  const fullName = row.full_name || row.fullName || row.name || null
  return {
    staffId,
    staff_id: staffId,
    fullName,
    full_name: fullName,
    name: fullName,
    role: row.role || 'supervisor',
  }
}

function isSupervisorPinAuthFailure(err) {
  const raw = String(err?.message || err || '')
  return /Invalid supervisor|Supervisor approval failed|Invalid.*PIN|wrong (code|pin)/i.test(raw)
}

export async function verifySupervisorPin(branchId, loginCode, pin) {
  const code = String(loginCode || '').replace(/\D/g, '')
  const pinVal = String(pin || '').trim()
  if (code.length < 4 || pinVal.length < 4) {
    throw new Error('Invalid supervisor code or PIN')
  }

  const { canSyncWithBackend, isDeviceOnline } = await import('../../offline/reachability')
  const { verifySupervisorPinOffline, cacheSupervisorVerifierFromPin } = await import('../../offline/supervisorPin')

  let onlineResult = null
  let onlineError = null

  if (hasSupabase && isDeviceOnline()) {
    for (const force of [false, true]) {
      if (!(await canSyncWithBackend(force))) continue
      try {
        const { data, error } = await withTimeout(
          supabase.rpc('verify_supervisor_pin', {
            p_branch_id: branchId,
            p_login_code: code,
            p_pin: pinVal,
          }),
          6000,
          'Supervisor PIN check',
        )
        if (error) throw error
        onlineResult = parseSupervisorPinRpcResult(data)
        if (onlineResult?.staffId) break
      } catch (err) {
        // Bounded, and never fatal: a stalled/erroring online check must fall through to
        // the offline PBKDF2 verifier below (same offline-capable design as the lock
        // screen — an approval can't be stuck forever behind a flaky connection or an ISP
        // outage). Only a definitive "wrong PIN" from the server is worth remembering as
        // `onlineError` to prefer over a generic offline failure below.
        onlineError = err
      }
    }
  }

  if (onlineResult?.staffId) {
    try {
      await cacheSupervisorVerifierFromPin({ ...onlineResult, branchId, role: onlineResult.role }, code, pinVal)
    } catch {
      /* local cache optional */
    }
    return onlineResult
  }

  try {
    return await verifySupervisorPinOffline(branchId, code, pinVal)
  } catch (offlineErr) {
    if (onlineError && isSupervisorPinAuthFailure(onlineError)) throw onlineError
    throw offlineErr
  }
}

export async function fetchSupervisorPinVerifiers(branchId) {
  if (!supabase || !branchId) return []
  const { data, error } = await supabase.rpc('fetch_branch_supervisor_verifiers', {
    p_branch_id: branchId,
  })
  if (error) {
    if (String(error.message || '').includes('Could not find the function')) return []
    throw error
  }
  return (data || []).map((row) => ({
    staffId: row.staff_id,
    staff_id: row.staff_id,
    loginCode: row.login_code,
    login_code: row.login_code,
    fullName: row.full_name,
    full_name: row.full_name,
    role: row.role,
    branchId: row.branch_id,
    branch_id: row.branch_id,
    pinVerifier: row.pin_verifier,
    pin_verifier: row.pin_verifier,
  }))
}

export async function saveStaffPinVerifier(staffId, pinVerifier) {
  if (!supabase || !staffId || !pinVerifier) return null
  const { error } = await supabase.rpc('save_staff_pin_verifier', {
    p_staff_id: staffId,
    p_verifier: pinVerifier,
  })
  if (error) {
    if (String(error.message || '').includes('Could not find the function')) return null
    throw error
  }
  return true
}

/** Push a queued approval audit row (idempotent when clientId is set). */
export async function logApprovalEventRemote({
  branchId,
  requestedBy,
  approvedBy,
  approverName = null,
  approverRole = null,
  action,
  detail = null,
  meta = {},
  clientId = null,
  deviceId = null,
}) {
  const eventType = action.startsWith('approval:') ? action : `approval:${action}`
  const payloadMeta = {
    ...meta,
    action: meta.action || action,
    requested_by: requestedBy || meta.requested_by || null,
    approved_by: approvedBy || meta.approved_by || null,
    approver_name: approverName ?? meta.approver_name ?? null,
    approver_role: approverRole ?? meta.approver_role ?? null,
    offline: meta.offline === true,
    device_id: deviceId || meta.device_id || null,
  }
  if (supabase) {
    const { data, error } = await supabase.rpc('log_audit_event_idempotent', {
      p_branch_id: branchId || null,
      p_staff_id: requestedBy || approvedBy || null,
      p_event_type: eventType,
      p_detail: detail || null,
      p_meta: payloadMeta,
      p_client_id: clientId || meta.offline_client_id || null,
    })
    if (!error) return data
    if (!String(error.message || '').includes('Could not find the function')) {
      throw error
    }
  }
  return logAuditEvent({
    branchId,
    staffId: requestedBy || approvedBy || null,
    eventType,
    detail,
    meta: payloadMeta,
  })
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function claimStaffSession() {
  const { data, error } = await supabase.rpc('claim_staff_session')
  if (error) throw error
  return data
}

export async function heartbeatStaffSession() {
  const { error } = await supabase.rpc('heartbeat_staff_session')
  if (error) throw error
  return true
}

export async function releaseStaffSession() {
  const { error } = await supabase.rpc('release_staff_session')
  if (error) console.warn('release_staff_session:', error.message)
  return true
}

/** True when an error is this device's session having been evicted by a login elsewhere. */
export function isSessionRevokedError(error) {
  return /SESSION_REVOKED/i.test(String(error?.message || error || ''))
}

const MANAGER_UNLOCK_SESSION_KEY = 'cale-manager-unlock-v1'

/**
 * Remember a password verifier for lock-screen unlock.
 *
 * Session stays signed in — this only compares locally, so the lock screen keeps working
 * with no network (blackout, ISP outage). The stored value is a PBKDF2 verifier, never the
 * password and never a fast hash — see src/utils/unlockVerifier.js for the threat model.
 */
export async function setManagerUnlockSecret(staffId, password) {
  if (!staffId || password == null || password === '') return
  const record = await createVerifier(staffId, password)
  try {
    sessionStorage.setItem(MANAGER_UNLOCK_SESSION_KEY, JSON.stringify(record))
  } catch {
    /* ignore */
  }
  try {
    await saveUnlockSecret(staffId, record)
  } catch {
    /* ignore */
  }
}

export async function clearManagerUnlockSecret() {
  try {
    sessionStorage.removeItem(MANAGER_UNLOCK_SESSION_KEY)
  } catch {
    /* ignore */
  }
  try {
    await clearUnlockSecret()
  } catch {
    /* ignore */
  }
}

/** Load the verifier record (v2 PBKDF2, or a legacy v1 digest pending upgrade). */
async function readUnlockRecord(staffId) {
  try {
    const raw = sessionStorage.getItem(MANAGER_UNLOCK_SESSION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.staffId === staffId && (parsed.hash || parsed.digest)) return parsed
    }
  } catch {
    /* ignore */
  }
  try {
    const row = await loadUnlockSecret(staffId)
    if (row?.hash || row?.digest) {
      try {
        sessionStorage.setItem(MANAGER_UNLOCK_SESSION_KEY, JSON.stringify({ staffId, ...row }))
      } catch {
        /* ignore */
      }
      return { staffId, ...row }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Lock-screen unlock for managers — verified entirely on-device so it works with no
 * network. Comparison is constant-time PBKDF2; see src/utils/unlockVerifier.js.
 */
export async function verifyAccountPassword(_email, password, { staffId = null } = {}) {
  const pwd = String(password || '')
  if (!pwd) throw new Error('Enter your password')
  if (!staffId) throw new Error('No staff session to unlock')

  const record = await readUnlockRecord(staffId)
  if (!record) {
    throw new Error('Unlock not available for this session. Sign out and sign in again.')
  }
  // A verifier that has sat on a device for a month must be refreshed by a real sign-in —
  // bounds how long a walked-off terminal keeps something worth attacking.
  if (isVerifierExpired(record)) {
    await clearManagerUnlockSecret()
    throw new Error('Unlock expired for security. Sign out and sign in with your password.')
  }

  const { ok, needsUpgrade } = await verifyAgainst(record, staffId, pwd)
  if (!ok) throw new Error('Incorrect password')

  // Correct password + weak/outdated stored form: rewrite it now, while we legitimately
  // hold the plaintext. This is what retires the old unsalted SHA-256 records without
  // locking out a terminal that is offline at upgrade time.
  if (needsUpgrade) {
    try {
      await setManagerUnlockSecret(staffId, pwd)
    } catch {
      /* non-fatal — unlock already succeeded */
    }
  }
  return true
}

export async function verifyOwnPin(staffId, pin) {
  const { error } = await supabase.rpc('verify_own_pin', {
    p_staff_id: staffId,
    p_pin: String(pin || '').trim(),
  })
  if (error) throw error
  return true
}

/**
 * Stable per-browser device fingerprint for claim_staff_session — deliberately in
 * localStorage, not sessionStorage. It carries no auth capability (opaque UUID, not a
 * credential), so it doesn't fall under the "auth token stays sessionStorage-only" rule.
 * It MUST survive a closed tab: claim_staff_session's same-device self-heal only fires
 * when this id matches what the server still has recorded, and a plain tab close never
 * gets a chance to call releaseStaffSession (see sessionLifecycle.js) — closing the tab
 * without clicking Logout used to leave the server-side claim held for up to the 15-minute
 * heartbeat window, so reopening on the very same till got rejected with "Already signed
 * in on another device." Reusing the same id makes that reopen self-heal instantly instead.
 */
export function getOrCreateDeviceSessionId() {
  const key = 'cale-pos-device-session'
  try {
    let id = localStorage.getItem(key)
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`
      localStorage.setItem(key, id)
    }
    return id
  } catch {
    return `sess_${Date.now()}`
  }
}

export function clearDeviceSessionId() {
  try {
    localStorage.removeItem('cale-pos-device-session')
  } catch {
    /* ignore */
  }
}
