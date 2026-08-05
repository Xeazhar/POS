import { useEffect, useId, useRef } from 'react'

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
const SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY || ''

let scriptPromise = null

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

/** Public sitekey — safe in the browser. Empty = captcha disabled. */
export function turnstileSiteKey() {
  return String(SITEKEY || '').trim()
}

export function isTurnstileEnabled() {
  return Boolean(turnstileSiteKey())
}

/**
 * Cloudflare Turnstile widget.
 * Calls onVerify(token) when solved; onExpire/onError clear the token.
 * Token is passed to Supabase Auth (signInWithPassword captchaToken option).
 * Supabase Auth must be configured with Turnstile provider + secret key.
 */
export default function Turnstile({ onVerify, onExpire, onError, className = '' }) {
  const hostId = useId().replace(/:/g, '')
  const widgetIdRef = useRef(null)
  const callbacksRef = useRef({ onVerify, onExpire, onError })
  callbacksRef.current = { onVerify, onExpire, onError }

  useEffect(() => {
    const sitekey = turnstileSiteKey()
    if (!sitekey) return undefined

    let cancelled = false

    void loadTurnstileScript()
      .then((turnstile) => {
        if (cancelled || !turnstile?.render) return
        const el = document.getElementById(hostId)
        if (!el) return
        el.innerHTML = ''
        widgetIdRef.current = turnstile.render(el, {
          sitekey,
          // Force white/light UI to match the app's login card.
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
  }, [hostId])

  if (!turnstileSiteKey()) return null

  return (
    <div className={className}>
      <div
        id={hostId}
        className="cf-turnstile"
        data-sitekey={turnstileSiteKey()}
        data-theme="light"
      />
    </div>
  )
}
