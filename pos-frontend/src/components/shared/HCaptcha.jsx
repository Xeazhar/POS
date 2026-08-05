import { useEffect, useId, useRef, useState } from 'react'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

let scriptPromise = null
let runtimeSiteKeyPromise = null

function envSiteKey() {
  return String(import.meta.env.VITE_TURNSTILE_SITEKEY || import.meta.env.VITE_HCAPTCHA_SITEKEY || '').trim()
}

async function loadRuntimeSiteKey() {
  if (runtimeSiteKeyPromise) return runtimeSiteKeyPromise
  runtimeSiteKeyPromise = fetch(`${import.meta.env.BASE_URL}captcha.json`, { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) return ''
      const data = await res.json()
      return String(data?.turnstileSiteKey || '').trim()
    })
    .catch(() => '')
  return runtimeSiteKeyPromise
}

/** Resolve sitekey from Vite env first, then /public/captcha.json fallback. */
export async function resolveTurnstileSiteKey() {
  const fromEnv = envSiteKey()
  if (fromEnv) return fromEnv
  return loadRuntimeSiteKey()
}

export function turnstileSiteKey() {
  return envSiteKey()
}

export function isTurnstileEnabled() {
  return Boolean(envSiteKey())
}

export function useTurnstileSiteKey() {
  const [siteKey, setSiteKey] = useState(envSiteKey())
  const [loading, setLoading] = useState(!envSiteKey())
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    if (envSiteKey()) {
      setSiteKey(envSiteKey())
      setLoading(false)
      return undefined
    }

    void resolveTurnstileSiteKey()
      .then((key) => {
        if (cancelled) return
        setSiteKey(key)
        if (!key) {
          setError('CAPTCHA site key missing in this deployment. Set VITE_TURNSTILE_SITEKEY and redeploy.')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Could not load CAPTCHA configuration.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

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
    const existing = document.querySelector(`script[src^="https://challenges.cloudflare.com/turnstile"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(window.turnstile))
      existing.addEventListener('error', () => reject(new Error('Failed to load Turnstile')))
      if (window.turnstile?.render) resolve(window.turnstile)
      return
    }
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve(window.turnstile)
    script.onerror = () => reject(new Error('Failed to load Turnstile'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

function mountWidget(turnstile, el, sitekey, callbacksRef, onMounted) {
  el.innerHTML = ''
  const widgetId = turnstile.render(el, {
    sitekey,
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
  onMounted(widgetId)
}

function renderWidget(turnstile, el, sitekey, callbacksRef, onMounted) {
  if (turnstile.ready) {
    turnstile.ready(() => mountWidget(turnstile, el, sitekey, callbacksRef, onMounted))
    return
  }
  mountWidget(turnstile, el, sitekey, callbacksRef, onMounted)
}

/**
 * Cloudflare Turnstile widget.
 * Token is passed to Supabase Auth via signInWithPassword({ options: { captchaToken } }).
 */
export default function Turnstile({ siteKey, onVerify, onExpire, onError, className = '' }) {
  const hostId = useId().replace(/:/g, '')
  const widgetIdRef = useRef(null)
  const callbacksRef = useRef({ onVerify, onExpire, onError })
  callbacksRef.current = { onVerify, onExpire, onError }

  useEffect(() => {
    if (!siteKey) return undefined

    let cancelled = false

    void loadTurnstileScript()
      .then((turnstile) => {
        if (cancelled || !turnstile?.render) return
        const el = document.getElementById(hostId)
        if (!el) return
        widgetIdRef.current = null
        renderWidget(turnstile, el, siteKey, callbacksRef, (widgetId) => {
          if (!cancelled) widgetIdRef.current = widgetId
        })
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
  }, [hostId, siteKey])

  if (!siteKey) return null

  return (
    <div className={className}>
      <div id={hostId} className="cf-turnstile" data-sitekey={siteKey} data-theme="light" />
    </div>
  )
}
