/**
 * Session lifecycle: require a fresh login after the tab/browser is closed.
 * Reloads (F5) keep the session. Idle lock stays in Shell — not handled here.
 */

const BROWSER_CLOSED_KEY = 'calepos_browser_closed'

function navigationType() {
  try {
    const nav = performance.getEntriesByType?.('navigation')?.[0]
    return nav?.type || ''
  } catch {
    return ''
  }
}

/** True when this load follows a closed tab/browser (not a same-tab reload). */
export function consumeBrowserClosedFlag() {
  let closed = false
  try {
    closed = localStorage.getItem(BROWSER_CLOSED_KEY) === '1'
    localStorage.removeItem(BROWSER_CLOSED_KEY)
  } catch {
    /* ignore */
  }
  if (!closed) return false
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
