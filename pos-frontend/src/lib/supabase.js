import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

/** Open demo (no Supabase) is allowed only in local dev, or when explicitly opted in. */
export const allowDemoMode =
  Boolean(import.meta.env.DEV) || import.meta.env.VITE_ALLOW_DEMO === 'true'

export const isConfigured = Boolean(supabaseUrl && supabaseKey)

/**
 * Auth lives in sessionStorage only — closing the tab/browser clears tokens.
 * App also marks a localStorage "browser closed" flag so Chrome session
 * restore cannot silently auto-login. Idle lock remains in Shell.
 */
function authStorage() {
  if (typeof window === 'undefined') return undefined
  try {
    // Drop any older localStorage Auth tokens so they cannot auto-login.
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith('sb-') && key.includes('auth')) {
        localStorage.removeItem(key)
      }
    })
  } catch {
    /* ignore */
  }
  return window.sessionStorage
}

export const supabase = isConfigured
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        storage: authStorage(),
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null
