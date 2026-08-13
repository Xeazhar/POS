import { useEffect, useState } from 'react'
import companyLogo from '../../constants/brand'
import { APP_VERSION_LABEL } from '../../utils/version'

const INTRO_MS = 2400
const FADE_OUT_MS = 420

/**
 * Brief splash after a successful sign-in — author logo, welcome line,
 * author credit, and copyright. Not shown on the login form.
 */
export default function LoginIntro({ staffName, onDone }) {
  const [exiting, setExiting] = useState(false)
  const year = new Date().getFullYear()

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    const hold = reduce ? 600 : INTRO_MS
    const t1 = window.setTimeout(() => setExiting(true), hold)
    const t2 = window.setTimeout(() => onDone?.(), hold + (reduce ? 0 : FADE_OUT_MS))
    return () => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [onDone])

  return (
    <div
      className={`login-intro fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden bg-brand-dark text-white ${
        exiting ? 'login-intro--out' : ''
      }`}
      role="status"
      aria-live="polite"
      aria-label="Welcome to POS"
    >
      <div className="login-intro__logo-wrap relative z-[1] px-6">
        <img
          src={companyLogo}
          alt=""
          aria-hidden="true"
          className="login-intro__logo mx-auto block"
          draggable={false}
        />
      </div>

      <div className="login-intro__copy relative z-[1] px-6 text-center">
        <p className="login-intro__eyebrow m-0 text-[10px] font-bold tracking-[0.22em] text-brand-gold uppercase">
          CalePOS
        </p>
        <h1 className="login-intro__title m-0 mt-3 text-[clamp(1.75rem,5vw,2.75rem)] font-bold tracking-[-0.03em] text-white">
          Welcome to POS
        </h1>
        {staffName ? (
          <p className="login-intro__hello m-0 mt-2 text-sm text-white/65">
            Hello, {staffName}
          </p>
        ) : null}
      </div>

      <footer className="login-intro__foot absolute inset-x-0 bottom-0 z-[1] px-6 pb-8 text-center">
        <p className="m-0 text-[12px] font-semibold tracking-wide text-brand-gold">By Xeazhar</p>
        <p className="m-0 mt-1.5 text-[10px] leading-relaxed text-white/45">
          © {year} Xeazhar. All rights reserved.
          <span className="mx-1.5 text-white/25">·</span>
          {APP_VERSION_LABEL}
        </p>
      </footer>
    </div>
  )
}
