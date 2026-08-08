import db from './db'

const SESSION_KEY = 'sessionStaff'
const REQUIRE_FRESH_LOGIN_KEY = 'requireFreshLogin'
const UNLOCK_SECRET_KEY = 'managerUnlockSecret'

export async function saveLocalSession(user) {
  if (!user) {
    await db.meta.delete(SESSION_KEY)
    return
  }
  await db.meta.put({ key: SESSION_KEY, value: user })
}

export async function loadLocalSession() {
  const row = await db.meta.get(SESSION_KEY)
  return row?.value || null
}

export async function clearLocalSession() {
  await db.meta.delete(SESSION_KEY)
}

/** After day-end close: block auto-restore until password login. */
export async function markRequireFreshLogin() {
  await db.meta.put({ key: REQUIRE_FRESH_LOGIN_KEY, value: true })
}

export async function clearRequireFreshLogin() {
  await db.meta.delete(REQUIRE_FRESH_LOGIN_KEY)
}

export async function needsFreshLogin() {
  const row = await db.meta.get(REQUIRE_FRESH_LOGIN_KEY)
  return Boolean(row?.value)
}

/** Hash-only unlock verifier for lock screen (never stores the password). */
export async function saveUnlockSecret(staffId, digest) {
  if (!staffId || !digest) return
  await db.meta.put({ key: UNLOCK_SECRET_KEY, value: { staffId, digest } })
}

export async function loadUnlockSecret(staffId) {
  const row = await db.meta.get(UNLOCK_SECRET_KEY)
  const value = row?.value
  if (!value?.digest) return null
  if (staffId && value.staffId !== staffId) return null
  return value
}

export async function clearUnlockSecret() {
  await db.meta.delete(UNLOCK_SECRET_KEY)
}

const UNLOCK_ATTEMPTS_KEY = 'unlockAttempts'

/**
 * Failed-unlock throttle for the lock screen.
 *
 * PBKDF2 raises the cost of an OFFLINE attack on a stolen device; this raises the cost of
 * the far more common one — somebody at the counter typing guesses into an unattended
 * terminal. Persisted to IndexedDB rather than memory so it survives the obvious bypass of
 * reloading the tab or power-cycling the machine.
 *
 * Backoff doubles from 5s and caps at 5 minutes, starting after 3 free attempts so an
 * honest typo never punishes a cashier mid-shift.
 */
const FREE_ATTEMPTS = 3
const BASE_DELAY_MS = 5000
const MAX_DELAY_MS = 5 * 60 * 1000

export async function getUnlockLockout(staffId) {
  const row = await db.meta.get(UNLOCK_ATTEMPTS_KEY)
  const value = row?.value
  if (!value || value.staffId !== staffId) return { attempts: 0, lockedUntil: 0 }
  return { attempts: value.attempts || 0, lockedUntil: value.lockedUntil || 0 }
}

export async function recordUnlockFailure(staffId) {
  const current = await getUnlockLockout(staffId)
  const attempts = current.attempts + 1
  const over = attempts - FREE_ATTEMPTS
  const lockedUntil =
    over > 0 ? Date.now() + Math.min(BASE_DELAY_MS * 2 ** (over - 1), MAX_DELAY_MS) : 0
  await db.meta.put({ key: UNLOCK_ATTEMPTS_KEY, value: { staffId, attempts, lockedUntil } })
  return { attempts, lockedUntil }
}

export async function clearUnlockFailures() {
  await db.meta.delete(UNLOCK_ATTEMPTS_KEY)
}
