import db from './db'

const SESSION_KEY = 'sessionStaff'
const REQUIRE_FRESH_LOGIN_KEY = 'requireFreshLogin'

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
