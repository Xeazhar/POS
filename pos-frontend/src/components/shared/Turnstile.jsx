import { useEffect, useRef, useState } from 'react'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

let scriptPromise = null

function envSiteKey() {
  return String(import.meta.env.VITE_TURNSTILE_SITEKEY || '').trim()
}

async function loadRuntimeSiteKey() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}captcha.json`, { cache: 'no-store' })
    if (!res.ok) return ''
    const data = await res.json()
    return String(data?.turnstileSiteKey || '').trim()
  } catch {
    return ''
  }
}

export function useTurnstileSiteKey() {
  const [siteKey, setSiteKey] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false

    void (async () => {
      const key = envSiteKey() || (await loadRuntimeSiteKey())
      if (cancelled) return
      setSiteKey(key)
      if (!key) {
        setError('Turnstile site key missing. Set VITE_TURNSTILE_SITEKEY or public/captcha.json.')
      }
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return { siteKey, loading, error, enabled: Boolean(siteKey) }
}

function loadTurnstileScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.turnstile?.render) return Promise.resolve(window.turnstile)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')
    if (existing && window.turnstile?.render) {
      resolve(window.turnstile)
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
  return scriptPromise
}

/**
 * Cloudflare Turnstile (explicit render).
 * Do NOT use class "cf-turnstile" here — that conflicts with explicit mode.
 */
export default function Turnstile({ siteKey, onVerify, onExpire, onError, className = '' }) {
  const containerRef = useRef(null)
  const widgetIdRef = useRef(null)
  const callbacksRef = useRef({ onVerify, onExpire, onError })
  callbacksRef.current = { onVerify, onExpire, onError }

  useEffect(() => {
    if (!siteKey || !containerRef.current) return undefined

    let cancelled = false
    const el = containerRef.current

    const mount = (turnstile) => {
      if (cancelled || !el) return
      if (widgetIdRef.current != null) {
        try {
          turnstile.remove(widgetIdRef.current)
        } catch {
          /* ignore */
        }
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
          callbacksRef.current.onError?.()
          callbacksRef.current.onVerify?.('')
        },
      })
    }

    void loadTurnstileScript()
      .then((turnstile) => {
        if (cancelled) return
        if (turnstile.ready) {
          turnstile.ready(() => mount(turnstile))
        } else {
          mount(turnstile)
        }
      })
      .catch(() => {
        callbacksRef.current.onError?.()
      })

    return () => {
      cancelled = true
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
      <div ref={containerRef} />
    </div>
  )
}
