/**
 * Idle lock delay used by Shell. Allowed values are 5 / 10 / 15 minutes — never off,
 * never longer than 15. The live value is company-wide (`company_profile.idle_lock_minutes`)
 * and cached in localStorage so an offline till keeps the last setting it pulled.
 */

export const IDLE_LOCK_CHOICES = [5, 10, 15]
export const IDLE_LOCK_MINUTES_DEFAULT = 10
export const IDLE_LOCK_MINUTES_MIN = 5
export const IDLE_LOCK_MINUTES_MAX = 15

/** Default delay in ms. Prefer getIdleLockMs() for the live preference. */
export const IDLE_LOCK_MS = IDLE_LOCK_MINUTES_DEFAULT * 60 * 1000
export const IDLE_LOCK_MINUTES = IDLE_LOCK_MINUTES_DEFAULT

const STORAGE_KEY = 'cale-idle-lock-minutes'

const listeners = new Set()

export function clampIdleLockMinutes(value) {
  const n = Number(value)
  if (IDLE_LOCK_CHOICES.includes(n)) return n
  if (!Number.isFinite(n)) return IDLE_LOCK_MINUTES_DEFAULT
  if (n <= IDLE_LOCK_MINUTES_MIN) return IDLE_LOCK_MINUTES_MIN
  if (n >= IDLE_LOCK_MINUTES_MAX) return IDLE_LOCK_MINUTES_MAX
  return IDLE_LOCK_CHOICES.reduce((best, choice) =>
    Math.abs(choice - n) < Math.abs(best - n) ? choice : best,
  )
}

export function getIdleLockMinutes() {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY))
    if (IDLE_LOCK_CHOICES.includes(stored)) return stored
  } catch {
    /* private mode / blocked storage */
  }
  return IDLE_LOCK_MINUTES_DEFAULT
}

export function getIdleLockMs() {
  return getIdleLockMinutes() * 60 * 1000
}

/** Persist the clamped value locally and notify Shell so the timer picks it up. */
export function applyIdleLockMinutes(value) {
  const next = clampIdleLockMinutes(value)
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    /* ignore */
  }
  listeners.forEach((fn) => fn(next))
  return next
}

export function subscribeIdleLock(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
