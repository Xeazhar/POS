import { useEffect, useRef, useState } from 'react'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** Cloudflare always-pass test key — local `npm run dev` only; never ship in production builds. */
const DEV_TEST_SITE_KEY = '0x4AAAAAAEG89XtzHd_oWzOv'

/**
 * Reads and trims the configured Turnstile site key.
 * @return {string} The trimmed site key, or an empty string when none is configured.
 */
function envSiteKey() {
  return String(import.meta.env.VITE_TURNSTILE_SITEKEY || '').trim()
}

/**
 * Determines the Turnstile site key for the current environment.
 * @return {string} The configured environment key, the development test key, or an empty string when no production key is configured.
 */
function resolveSiteKey() {
  const fromEnv = envSiteKey()
  if (fromEnv) return fromEnv
  if (import.meta.env.DEV) return DEV_TEST_SITE_KEY
  return ''
}

/**
 * Resolves the Turnstile site key and reports its configuration status.
 * @return {{siteKey: string, loading: boolean, error: string, enabled: boolean}} The resolved site key, loading state, configuration error, and whether Turnstile is enabled.
 */
export function useTurnstileSiteKey() {
  const [siteKey, setSiteKey] = useState(() => resolveSiteKey())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(() => {
    if (envSiteKey() || import.meta.env.DEV) return ''
    return 'Turnstile site key missing. Set VITE_TURNSTILE_SITEKEY in the hosting dashboard.'
  })

  useEffect(() => {
    const key = resolveSiteKey()
    setSiteKey(key)
    if (!key && import.meta.env.PROD) {
      setError('Turnstile site key missing. Set VITE_TURNSTILE_SITEKEY in the hosting dashboard.')
    } else {
      setError('')
    }
    setLoading(false)
  }, [])

  return { siteKey, loading, error, enabled: Boolean(siteKey) }
}

function loadTurnstileScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.turnstile?.render) return Promise.resolve(window.turnstile)

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.turnstile?.render) resolve(window.turnstile)
        else reject(new Error('Turnstile failed to initialize'))
      })
      existing.addEventListener('error', () => reject(new Error('Failed to load Turnstile')))
      if (window.turnstile?.render) resolve(window.turnstile)
      return
    }

    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => {
      if (window.turnstile?.render) resolve(window.turnstile)
      else reject(new Error('Turnstile failed to initialize'))
    }
    script.onerror = () => reject(new Error('Failed to load Turnstile'))
    document.head.appendChild(script)
  })
}

/**
 * Cloudflare Turnstile (explicit render).
 */
export default function Turnstile({ siteKey, onVerify, onExpire, onError, onReady, className = '' }) {
  const containerRef = useRef(null)
  const widgetIdRef = useRef(null)
  const callbacksRef = useRef({ onVerify, onExpire, onError, onReady })
  callbacksRef.current = { onVerify, onExpire, onError, onReady }
  const [widgetError, setWidgetError] = useState('')

  useEffect(() => {
    if (!siteKey || !containerRef.current) return undefined

    let cancelled = false
    const el = containerRef.current
    setWidgetError('')

    const mount = (turnstile) => {
      if (cancelled || !el) return
      try {
        if (widgetIdRef.current != null) {
          turnstile.remove(widgetIdRef.current)
          widgetIdRef.current = null
        }
        el.innerHTML = ''
        widgetIdRef.current = turnstile.render(el, {
          sitekey: siteKey,
          theme: 'light',
          callback: (token) => callbacksRef.current.onVerify?.(token),
          'expired-callback': () => {
            callbacksRef.current.onExpire?.()
            callbacksRef.current.onVerify?.('')
          },
          'error-callback': () => {
            setWidgetError('Security check failed. Refresh the page and try again.')
            callbacksRef.current.onError?.()
            callbacksRef.current.onVerify?.('')
          },
        })
        callbacksRef.current.onReady?.()
      } catch (e) {
        setWidgetError(e?.message || 'Could not show security check.')
        callbacksRef.current.onError?.()
      }
    }

    const tryMount = () => {
      void loadTurnstileScript()
        .then((turnstile) => {
          if (cancelled) return
          // Do not use turnstile.ready() with async script loading — mount after onload instead.
          mount(turnstile)
        })
        .catch((e) => {
          if (cancelled) return
          setWidgetError(e?.message || 'Could not load security check.')
          callbacksRef.current.onError?.()
        })
    }

    // Small delay so the container is painted before Turnstile measures it.
    const timer = window.setTimeout(tryMount, 50)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      try {
        if (widgetIdRef.current != null && window.turnstile?.remove) {
          window.turnstile.remove(widgetIdRef.current)
        }
      } catch {
        /* ignore */
      }
      widgetIdRef.current = null
    }
  }, [siteKey])

  if (!siteKey) return null

  return (
    <div className={className}>
      <div ref={containerRef} className="min-h-[65px]" />
      {widgetError && (
        <p className="mt-2 text-xs text-brand-danger">{widgetError}</p>
      )}
    </div>
  )
}
