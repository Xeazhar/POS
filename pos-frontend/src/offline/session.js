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
