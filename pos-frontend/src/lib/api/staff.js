import { supabase } from '../supabase'
import { appError } from '../../utils/errors'
import { pinAuthEmail } from '../../utils/roles'
import { createVerifier } from '../../utils/unlockVerifier'
import { isMissingColumnError } from './shared.js'
import { saveStaffPinVerifier } from './auth.js'
import { logAuditEvent } from './audit.js'

export async function fetchRoles() {
  const { data, error } = await supabase.from('roles').select('name, label, sort_order').order('sort_order')
  if (error) throw error
  return data || []
}

/**
 * Fetches staff members available to the current user's branch.
 * @param {string|null} [branchId=null] - The branch whose staff roster should be fetched.
 * @param {boolean} [isManager=false] - Whether to use the manager-accessible staff roster.
 * @return {Promise<Array>} The staff roster, including branch and role details.
 * @throws {Error} If the supervisor roster function is unavailable or the request fails.
 */
export async function fetchStaffRoster({ branchId = null, isManager = false } = {}) {
  if (isManager) return fetchAllStaff()
  const { data, error } = await supabase.rpc('branch_staff_roster', {
    p_branch_id: branchId || null,
  })
  if (error) {
    if (/branch_staff_roster|Could not find the function/i.test(String(error.message || ''))) {
      throw appError(
        'STAFF01',
        'Supervisor staff roster is not installed. Run migrate_branch_staff_roster.sql in Supabase.',
      )
    }
    throw error
  }
  return (data || []).map((row) => ({
    id: row.id,
    branch_id: row.branch_id,
    full_name: row.full_name,
    role: row.role,
    login_code: row.login_code,
    is_active: row.is_active,
    permissions: row.permissions,
    created_at: row.created_at,
    branches: { name: row.branch_name },
    roles: null,
  }))
}

export async function fetchAllStaff() {
  const selectFull =
    'id, branch_id, full_name, role, login_code, is_active, permissions, created_at, branches(name), roles(label)'
  const { data, error } = await supabase.from('staff').select(selectFull).order('full_name')
  if (error) {
    // Older DBs may lack permissions / roles join
    if (/permissions|roles|login_code|schema cache|column/i.test(String(error.message || ''))) {
      const fallback = await supabase
        .from('staff')
        .select('id, branch_id, full_name, role, is_active, created_at, branches(name)')
        .order('full_name')
      if (fallback.error) throw error
      return fallback.data || []
    }
    throw error
  }
  // Never return login_pin in list payloads — reveal only via revealStaffPin.
  return data || []
}

/**
 * Sessions currently held, for a master to inspect before ejecting anyone.
 *
 * `isStale` marks rows past the 15-minute heartbeat window `claim_staff_session()` uses:
 * those are no longer blocking a login, so a master can tell a genuinely live till apart
 * from a leftover row before kicking someone off mid-sale.
 */
export async function fetchActiveSessions() {
  const { data, error } = await supabase.rpc('admin_active_sessions')
  if (error) {
    if (/admin_active_sessions|Could not find the function/i.test(String(error.message || ''))) {
      throw appError('SESS01', 'Run migrate_admin_session_release.sql in Supabase.')
    }
    throw error
  }
  return (data || []).map((row) => ({
    staffId: row.staff_id,
    name: row.full_name || 'Staff',
    role: row.role || null,
    branchId: row.branch_id || null,
    branchName: row.branch_name || '—',
    heartbeatAt: row.session_heartbeat_at || null,
    isStale: row.is_stale === true,
  }))
}

/**
 * Clear a stuck "already signed in on another device" lock.
 *
 * A session is normally cleared by release_staff_session() on sign-out, which a crashed
 * tab, a dead battery or a power cut never gets to call — leaving the account locked out
 * of itself for up to 15 minutes with no device to sign out from. Master only, and the
 * database logs who forced whom off.
 */
export async function forceReleaseStaffSession(staffId) {
  const { error } = await supabase.rpc('admin_release_staff_session', { p_staff_id: staffId })
  if (error) {
    if (/SESSION_NOT_ALLOWED/i.test(String(error.message || ''))) {
      throw appError('SESS02')
    }
    if (/Could not find the function/i.test(String(error.message || ''))) {
      throw appError('SESS01', 'Run migrate_admin_session_release.sql in Supabase.')
    }
    throw error
  }
  return true
}

/** Same, for everyone (optionally one branch). Never releases the master doing it. */
export async function releaseAllStaffSessions(branchId = null) {
  const { data, error } = await supabase.rpc('admin_release_all_sessions', {
    p_branch_id: branchId,
  })
  if (error) {
    if (/SESSION_NOT_ALLOWED/i.test(String(error.message || ''))) {
      throw appError('SESS02')
    }
    if (/Could not find the function/i.test(String(error.message || ''))) {
      throw appError('SESS01', 'Run migrate_admin_session_release.sql in Supabase.')
    }
    throw error
  }
  return Number(data || 0)
}

export async function createStaffAccount({
  email,
  password,
  fullName,
  role,
  branchId,
  loginCode = null,
  loginPin = null,
  permissions = null,
  captchaToken = null,
}) {
  const { data: sessionData } = await supabase.auth.getSession()
  const managerSession = sessionData.session
  const pinRole = role === 'cashier' || role === 'supervisor'
  const authEmail = pinRole && loginCode ? pinAuthEmail(loginCode, branchId) : email
  // Till PIN is also the Auth password (never returned to clients after login resolve).
  const authPassword = pinRole ? String(loginPin || '') : password
  if (pinRole && !authPassword) throw new Error('PIN is required for cashier/supervisor accounts.')

  // Supabase captcha protection applies to signUp exactly as it does to signIn. Without a
  // token the project rejects the call with "captcha protection: request disallowed" —
  // which is why creating a staff login failed while logging in worked.
  const { data, error } = await supabase.auth.signUp({
    email: authEmail,
    password: authPassword,
    options: {
      data: { full_name: fullName, role, branch_id: branchId },
      ...(captchaToken ? { captchaToken } : {}),
    },
  })
  if (error) {
    if (/captcha/i.test(String(error.message || ''))) {
      throw appError(
        'AUTH06',
        'Complete the security check on the staff form before saving, then try again.',
      )
    }
    // Means an Auth user for this email/staff code already exists. Normally that is a
    // real duplicate — but it is also exactly what a previous attempt leaves behind when
    // signUp() succeeded and the staff-row write after it failed for any reason (rejected
    // write, network drop, closed tab): the login exists with no account attached to it,
    // and nothing before this fix could ever complete it. Give staff the actionable
    // version rather than Supabase's raw "already registered".
    if (/already registered|user_already_exists|already exists/i.test(String(error.message || error.code || ''))) {
      throw appError('AUTH10', authEmail)
    }
    throw error
  }
  // signUp() just switched the client's active session to the BRAND NEW account — restore
  // the manager's session now, before any staff-table write. Every write below (login_code/
  // login_pin/permissions via applyStaffPayload) is gated by RLS's "managers manage staff"
  // policy (requires is_manager() on the CURRENT session); running them while still signed
  // in as the new low-privilege cashier/supervisor makes RLS silently drop the UPDATE (0
  // rows touched, no error surfaced) — the row exists (handle_new_user's trigger stub, or
  // this function's own insert, both SECURITY DEFINER-adjacent) but login_code/login_pin/
  // permissions stay null forever. Restoring here, before those writes, is the fix.
  if (managerSession) await supabase.auth.setSession(managerSession)
  // The `staff` row id, distinct from data.user.id (the AUTH user id). The caller needs
  // this one for the audit trail — an audit row keyed to the auth user cannot be joined
  // back to the staff record support is actually looking at.
  let staffId = null
  if (data.user) {
    const staffPayload = {
      branch_id: branchId,
      full_name: fullName,
      role,
      is_active: true,
      login_code: pinRole ? String(loginCode || '').replace(/\D/g, '') : null,
      login_pin: pinRole ? String(loginPin || '') : null,
      auth_secret: pinRole ? String(loginPin || '') : null,
      permissions: Array.isArray(permissions) ? permissions : null,
    }
    // Shared by both branches below: whichever one ends up owning an already-existing
    // row (found directly, or via the 23505 race with handle_new_user's trigger stub)
    // must still apply login_code/login_pin/permissions to it — a bare read-back of the
    // id without this leaves the trigger's stub (full_name/role/branch only) permanently
    // missing PIN credentials.
    const applyStaffPayload = async (targetId) => {
      let { data: updated, error: updateError } = await supabase
        .from('staff')
        .update(staffPayload)
        .eq('id', targetId)
        .select('id')
      if (updateError && (isMissingColumnError(updateError, 'login_code') || isMissingColumnError(updateError, 'permissions') || isMissingColumnError(updateError, 'auth_secret'))) {
        const fallback = { branch_id: branchId, full_name: fullName, role, is_active: true }
        ;({ data: updated, error: updateError } = await supabase
          .from('staff')
          .update(fallback)
          .eq('id', targetId)
          .select('id'))
      }
      if (updateError) {
        const uniqueErr = staffCodeUniqueError(updateError)
        if (uniqueErr) throw uniqueErr
        throw updateError
      }
      // RLS ('managers manage staff', requires is_manager() on the CURRENT session) filters
      // rather than errors: an UPDATE run under the wrong session matches 0 rows and reports
      // success with an empty result, which is exactly how login_code/login_pin/permissions
      // went silently null before. Fail loudly instead of saving a half-written account.
      if (!updated || updated.length === 0) {
        throw new Error('Could not save staff credentials — the account session may be out of sync. Try again.')
      }
    }
    const { data: existing } = await supabase
      .from('staff')
      .select('id')
      .eq('auth_user_id', data.user.id)
      .maybeSingle()
    if (existing?.id) {
      staffId = existing.id
      await applyStaffPayload(staffId)
    } else {
      let { data: inserted, error: insertError } = await supabase
        .from('staff')
        .insert({ auth_user_id: data.user.id, ...staffPayload })
        .select('id')
        .maybeSingle()
      if (insertError && (isMissingColumnError(insertError, 'login_code') || isMissingColumnError(insertError, 'permissions') || isMissingColumnError(insertError, 'auth_secret'))) {
        ;({ data: inserted, error: insertError } = await supabase
          .from('staff')
          .insert({
            auth_user_id: data.user.id,
            branch_id: branchId,
            full_name: fullName,
            role,
            is_active: true,
          })
          .select('id')
          .maybeSingle())
      }
      if (insertError) {
        const uniqueErr = staffCodeUniqueError(insertError)
        if (uniqueErr) throw uniqueErr
        if (insertError.code !== '23505') throw insertError
      }
      staffId = inserted?.id || null
      if (!staffId) {
        // 23505 means a trigger (handle_new_user) already created the row — apply
        // staffPayload to it instead of just reading its id back, or its login_code/
        // login_pin stay null forever (the trigger never sets them).
        const { data: found } = await supabase
          .from('staff')
          .select('id')
          .eq('auth_user_id', data.user.id)
          .maybeSingle()
        staffId = found?.id || null
        if (staffId) await applyStaffPayload(staffId)
      }
    }
  }
  if (staffId && loginPin && pinRole) {
    await persistStaffPinVerifier(staffId, loginPin, {
      loginCode,
      fullName,
      role,
      branchId,
    })
  }
  return { ...data.user, staffId }
}

function staffCodeUniqueError(error) {
  if (!error) return null
  if (error.code === '23505' && /login_code|staff_login_code/i.test(String(error.message || error.details || ''))) {
    return new Error('That staff code is already in use. Choose a different unique code.')
  }
  if (error.code === '23505' && /staff_branch_login_code|login_code/i.test(String(error.message || error.details || ''))) {
    return new Error('That staff code is already in use. Choose a different unique code.')
  }
  return null
}

async function persistStaffPinVerifier(staffId, loginPin, { loginCode, fullName, role, branchId } = {}) {
  if (!staffId || loginPin == null || String(loginPin).trim() === '') return
  const verifier = await createVerifier(staffId, String(loginPin).trim())
  await saveStaffPinVerifier(staffId, verifier).catch(() => {})
  try {
    const { upsertLocalSupervisorVerifier } = await import('../../offline/supervisorPin')
    await upsertLocalSupervisorVerifier({
      staffId,
      loginCode,
      fullName,
      role,
      branchId,
      pinVerifier: verifier,
    })
  } catch {
    /* offline table optional */
  }
}

/**
 * Updates a staff member and synchronizes PIN authentication data when provided.
 * @param {string} id - The staff member's identifier.
 * @param {Object} changes - Staff fields to update.
 * @returns {Object} The updated staff record, including its branch.
 * @throws {Error} If the update fails or the staff code is already in use.
 */
export async function updateStaffRow(id, changes) {
  const payload = { ...changes }
  const pinForVerifier = changes.loginPin ?? changes.login_pin ?? null
  if ('loginCode' in payload) {
    payload.login_code = payload.loginCode
    delete payload.loginCode
  }
  if ('loginPin' in payload) {
    payload.login_pin = payload.loginPin
    // Keep Auth secret aligned so next PIN login can sign in with the till PIN.
    payload.auth_secret = payload.loginPin
    delete payload.loginPin
  }
  let { data, error } = await supabase.from('staff').update(payload).eq('id', id).select('*, branches(name)').single()
  if (error && (isMissingColumnError(error, 'login_code') || isMissingColumnError(error, 'login_pin') || isMissingColumnError(error, 'permissions'))) {
    const fallback = { ...payload }
    delete fallback.login_code
    delete fallback.login_pin
    delete fallback.permissions
    ;({ data, error } = await supabase.from('staff').update(fallback).eq('id', id).select('*, branches(name)').single())
  }
  const uniqueErr = staffCodeUniqueError(error)
  if (uniqueErr) throw uniqueErr
  if (error) throw error
  if (pinForVerifier) {
    await persistStaffPinVerifier(id, pinForVerifier, {
      loginCode: data?.login_code,
      fullName: data?.full_name,
      role: data?.role,
      branchId: data?.branch_id,
    })
  }
  return data
}

/**
 * Reveals the login credentials for a staff member.
 * @param {string} staffId - The identifier of the staff member.
 * @returns {{loginCode: string, loginPin: string, name: string, role: string}} The staff member's login code, PIN, name, and role.
 * @throws {Error} If the staff member is not found, the reveal capability is unavailable, or the caller is unauthorized.
 */
export async function revealStaffPin(staffId) {
  const { data, error } = await supabase.rpc('reveal_staff_pin', { p_staff_id: staffId })
  if (error) {
    if (/reveal_staff_pin|Could not find the function/i.test(String(error.message || ''))) {
      throw appError(
        'STAFF02',
        'PIN reveal is not installed. Run migrate_reveal_staff_pin.sql in Supabase.',
      )
    }
    if (/not authorized/i.test(String(error.message || ''))) {
      throw appError('STAFF03', error.message)
    }
    throw error
  }
  if (!data) throw new Error('Staff not found')
  await logAuditEvent({
    branchId: null,
    staffId: null,
    eventType: 'pin_viewed',
    detail: `PIN viewed for ${data.full_name}`,
    meta: { targetStaffId: staffId },
  }).catch(() => {})
  return {
    loginCode: data.login_code,
    loginPin: data.login_pin,
    name: data.full_name,
    role: data.role,
  }
}
