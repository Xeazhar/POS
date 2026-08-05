import { useEffect, useId, useRef } from 'react'

const SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js?render=explicit'
const SITEKEY = import.meta.env.VITE_HCAPTCHA_SITEKEY || ''

let scriptPromise = null

function loadHCaptchaScript() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'))
  if (window.hcaptcha?.render) return Promise.resolve(window.hcaptcha)
  if (scriptPromise) return scriptPromise

  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src^="https://js.hcaptcha.com/1/api.js"]`)
    if (existing) {
      existing.addEventListener('load', () => resolve(window.hcaptcha))
      existing.addEventListener('error', () => reject(new Error('Failed to load hCaptcha')))
      if (window.hcaptcha?.render) resolve(window.hcaptcha)
      return
    }
    const script = document.createElement('script')
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve(window.hcaptcha)
    script.onerror = () => reject(new Error('Failed to load hCaptcha'))
    document.head.appendChild(script)
  })
  return scriptPromise
}

/** Public sitekey — safe in the browser. Empty = captcha disabled. */
export function hcaptchaSiteKey() {
  return String(SITEKEY || '').trim()
}

/** True on localhost / loopback — hCaptcha hostname allowlisting is unreliable here. */
export function isLocalHost() {
  if (typeof window === 'undefined') return false
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.local')
}

/**
 * Captcha widget is shown whenever a sitekey is configured.
 * Token must be passed to Supabase Auth (Dashboard → Auth → CAPTCHA protection).
 */
export function isHCaptchaEnabled() {
  return Boolean(hcaptchaSiteKey())
}

/**
 * Explicit hCaptcha widget for login / forms.
 * Calls onVerify(token) when solved; onExpire/onError clear the token.
 */
export default function HCaptcha({ onVerify, onExpire, onError, className = '' }) {
  const hostId = useId().replace(/:/g, '')
  const widgetIdRef = useRef(null)
  const callbacksRef = useRef({ onVerify, onExpire, onError })
  callbacksRef.current = { onVerify, onExpire, onError }

  useEffect(() => {
    const sitekey = hcaptchaSiteKey()
    if (!sitekey) return undefined

    let cancelled = false

    void loadHCaptchaScript()
      .then((hcaptcha) => {
        if (cancelled || !hcaptcha?.render) return
        const el = document.getElementById(hostId)
        if (!el) return
        // Avoid double-render if Strict Mode remounts with leftover DOM
        el.innerHTML = ''
        widgetIdRef.current = hcaptcha.render(el, {
          sitekey,
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
        if (widgetIdRef.current != null && window.hcaptcha?.reset) {
          window.hcaptcha.reset(widgetIdRef.current)
        }
      } catch {
        /* ignore */
      }
      widgetIdRef.current = null
    }
  }, [hostId])

  if (!hcaptchaSiteKey()) return null

  return (
    <div className={className}>
      <div id={hostId} className="h-captcha" data-sitekey={hcaptchaSiteKey()} />
    </div>
  )
}
