/**
 * Which physical cash drawer / terminal this browser is.
 *
 * A shift is accountable for a drawer, not for a person alone — so "same cashier, same
 * open shift" is only safe to resume when it is also the SAME DRAWER. Moving to another
 * terminal means a different pile of cash, and silently resuming there would let someone
 * skip counting a drawer they are about to be held responsible for.
 *
 * Stored in localStorage, deliberately: it must survive sign-out, a reload and a closed
 * browser, because the drawer does not move when the cashier does. (Auth tokens stay in
 * sessionStorage — see src/lib/supabase.js — this is not one.)
 */

const ID_KEY = 'cale-pos-drawer-id'
const LABEL_KEY = 'cale-pos-drawer-label'

/** Used when localStorage is unavailable (private mode, locked-down kiosk). */
export const FALLBACK_DRAWER_ID = 'main'

function read(key) {
  try {
    return window.localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/**
 * Stable id for this terminal.
 *
 * Defaults to the shared `'main'` rather than minting a random per-device id, for two
 * reasons. Most shops have one physical drawer and several devices pointed at it — those
 * devices SHOULD share a drawer identity, or two people could count cash into the same
 * till and neither would be told. And `migrate_shift_cash_accountability.sql` backfills
 * every existing shift to `'main'`, so a random default would make a cashier's own open
 * shift look like it belonged to a different till the moment the migration landed.
 *
 * A branch that genuinely runs separate drawers names them per terminal — Settings →
 * Devices, which calls `setDrawerId`.
 */
export function getDrawerId() {
  return read(ID_KEY) || FALLBACK_DRAWER_ID
}

/** Human name shown on shift screens ("Front till", "Counter 2"). */
export function getDrawerLabel() {
  return read(LABEL_KEY) || 'Main drawer'
}

export function setDrawerLabel(label) {
  const clean = String(label || '').replace(/[<>]/g, '').trim().slice(0, 40)
  write(LABEL_KEY, clean)
  return clean || 'Main drawer'
}

/**
 * Point this browser at a specific drawer id — for a replacement device that must take
 * over an existing terminal's identity. Rare and deliberate; not part of normal use.
 */
export function setDrawerId(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
  if (!clean) return getDrawerId()
  write(ID_KEY, clean)
  return clean
}

export function drawerIdentity() {
  return { drawerId: getDrawerId(), drawerLabel: getDrawerLabel() }
}
