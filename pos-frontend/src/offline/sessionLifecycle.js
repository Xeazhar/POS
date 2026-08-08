/**
 * Session lifecycle: require a fresh login after the tab/browser is closed.
 * Reloads (F5) keep the session. Idle lock stays in Shell — not handled here.
 */

const BROWSER_CLOSED_KEY = 'calepos_browser_closed'

/**
 * Set by the app immediately before it reloads itself (utils/hardReload.js).
 *
 * Lives in sessionStorage, so it survives a same-tab reload and dies with the tab —
 * exactly the lifetime we want. It cannot leak into a genuine "browser was closed"
 * case, because closing the tab discards it.
 *
 * Needed because the navigationType() check below is not sufficient on its own: an
 * app-initiated navigation reports type 'navigate', not 'reload', so a self-refresh
 * looked identical to reopening a closed browser and forced a full sign-out — killing
 * the cashier's session and their open shift mid-service.
 */
const INTENTIONAL_RELOAD_KEY = 'calepos_intentional_reload'

function navigationType() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0]
    return nav?.type || ''
  } catch {
    return ''
  }
}

/** Mark the next load as an app-initiated refresh that must keep the session. */
export function markIntentionalReload() {
  try {
    sessionStorage.setItem(INTENTIONAL_RELOAD_KEY, '1')
  } catch {
    /* ignore */
  }
}

function consumeIntentionalReload() {
  try {
    const flagged = sessionStorage.getItem(INTENTIONAL_RELOAD_KEY) === '1'
    sessionStorage.removeItem(INTENTIONAL_RELOAD_KEY)
    return flagged
  } catch {
    return false
  }
}

/** True when this load follows a closed tab/browser (not a same-tab reload). */
export function consumeBrowserClosedFlag() {
  // Read first and unconditionally, so the flag is always cleared for the next load.
  const intentional = consumeIntentionalReload()

  let closed = false
  try {
    closed = localStorage.getItem(BROWSER_CLOSED_KEY) === '1'
    localStorage.removeItem(BROWSER_CLOSED_KEY)
  } catch {
    /* ignore */
  }
  if (!closed) return false
  // The app refreshed itself on purpose — keep the session and the open shift.
  if (intentional) return false
  if (navigationType() === 'reload') return false
  return true
}

/** Sync mark — must finish during pagehide/beforeunload. */
export function markBrowserClosed() {
  try {
    localStorage.setItem(BROWSER_CLOSED_KEY, '1')
  } catch {
    /* ignore */
  }
}

export function clearBrowserClosedFlag() {
  try {
    localStorage.removeItem(BROWSER_CLOSED_KEY)
  } catch {
    /* ignore */
  }
}

/** Drop Supabase Auth keys from sessionStorage so restore cannot revive them. */
export function clearAuthSessionStorage() {
  try {
    const keys = []
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i)
      if (key && key.startsWith('sb-') && key.includes('auth')) keys.push(key)
    }
    keys.forEach((key) => sessionStorage.removeItem(key))
  } catch {
    /* ignore */
  }
}

/**
 * Mark tab/browser close so the next open requires login.
 * Call once from App while a user is signed in.
 */
export function installSessionLifecycle({ enabled = true } = {}) {
  if (!enabled || typeof window === 'undefined') {
    return () => {}
  }

  const onUnload = () => {
    markBrowserClosed()
  }

  window.addEventListener('pagehide', onUnload)
  window.addEventListener('beforeunload', onUnload)

  // Soft restore from bfcache — tab is open again; cancel the close mark.
  const onPageShow = (event) => {
    if (event.persisted) clearBrowserClosedFlag()
  }
  window.addEventListener('pageshow', onPageShow)

  return () => {
    window.removeEventListener('pagehide', onUnload)
    window.removeEventListener('beforeunload', onUnload)
    window.removeEventListener('pageshow', onPageShow)
  }
}
