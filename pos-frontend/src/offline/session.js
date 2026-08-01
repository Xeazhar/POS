import db from './db'

const SESSION_KEY = 'sessionStaff'

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
