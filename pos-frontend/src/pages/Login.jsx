import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eyebrow, ErrorBanner, Field, PrimaryButton, Skeleton } from '../components/ui'
import Turnstile, { useTurnstileSiteKey } from '../components/shared/Turnstile'
import { allowDemoMode, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { formatSupportError } from '../utils/errors'
import { sanitizePinInput } from '../utils/pin'
import { staffHomePath } from '../constants/nav'
import { APP_VERSION_LABEL, IS_PRERELEASE } from '../utils/version'
import { SHOW_ENV_BADGE, environmentLabel } from '../utils/environment'

function Login() {
  const configured = hasSupabase || allowDemoMode
  const { siteKey: turnstileSiteKey, loading: captchaLoading, error: captchaConfigError, enabled: captchaRequired } =
    useTurnstileSiteKey()
  const captchaActive = hasSupabase && captchaRequired
  const [mode, setMode] = useState('pin') // pin | email
  const [loginCode, setLoginCode] = useState('')
  const [pin, setPin] = useState('')
  const [email, setEmail] = useState(hasSupabase ? '' : allowDemoMode ? 'demo@calepos.local' : '')
  const [password, setPassword] = useState(hasSupabase ? '' : allowDemoMode ? 'demo' : '')
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaKey, setCaptchaKey] = useState(0)
  const login = useAuthStore((state) => state.login)
  const error = useAuthStore((state) => state.error)
  const booting = useAuthStore((state) => state.booting)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const loadBranch = useProductStore((state) => state.loadBranch)
  const navigate = useNavigate()

  /**
   * Real network state, not build configuration.
   *
   * This screen used to print "Connected to Supabase" whenever the env vars existed —
   * which is a statement about the build, not about whether this terminal can currently
   * reach anything. A cashier on dead wifi read "Connected" and concluded the problem was
   * their PIN. Only surfaced when actually offline, because "you are online" is not news.
   */
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine)
  useEffect(() => {
    const sync = () => setIsOffline(!navigator.onLine)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])

  const resetCaptcha = () => {
    setCaptchaToken('')
    setCaptchaKey((k) => k + 1)
  }

  // Hard gate: when captcha is configured, a token is required (matches Supabase Auth CAPTCHA).
  const captchaBlocking = captchaActive && !captchaToken

  async function afterLogin(user) {
    if (hasSupabase && user?.branchId) {
      const data = await loadBranch(user.branchId)
      if (data) hydrate(data)
    }
    // Whether a change fund is needed is decided by the shift store inside Shell, from
    // local state first. Deciding it here would mean a signed-in cashier with no network
    // could not be told "your shift is still open" and would be asked to count a drawer
    // they already counted.
    navigate(staffHomePath(user))
  }

  return (
    <main className="grid min-h-screen place-items-center bg-brand-dark">
      <div className="w-[min(420px,calc(100%-32px))] rounded-[10px] bg-white p-11">
        <div className="mb-7 grid h-[43px] w-[43px] place-items-center rounded-lg bg-brand-gold text-[21px] font-bold text-brand-dark">
          C
        </div>
        <Eyebrow>STAFF ACCESS</Eyebrow>
        <h1 className="mb-2 text-[30px] tracking-[-1px]">Welcome back</h1>
        {!configured ? (
          <>
            <p className="text-[13px] text-brand-muted">
              This deployment is missing Supabase credentials. Add environment variables before going live.
            </p>
            <p className="mt-4 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">
              Required: <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>
              <br />
              Support code <strong>AUTH05</strong>
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] text-brand-muted">
              {hasSupabase
                ? mode === 'pin'
                  ? 'Enter your staff code and PIN to continue.'
                  : 'Sign in with your account email.'
                : 'Demo mode — any code/PIN or email works offline.'}
            </p>
            <form
              className="mt-[22px]"
              method="POST"
              onSubmit={async (event) => {
                event.preventDefault()
                try {
                  if (captchaActive && !captchaToken) {
                    useAuthStore.setState({ error: 'Complete the security check before signing in.' })
                    return
                  }
                  const user =
                    mode === 'pin'
                      ? await login(loginCode, pin, { mode: 'pin', captchaToken: captchaToken || undefined })
                      : await login(email, password, { mode: 'email', captchaToken: captchaToken || undefined })
                  await afterLogin(user)
                } catch {
                  resetCaptcha()
                }
              }}
            >
              {mode === 'pin' ? (
                <>
                  <Field
                    label="Staff code"
                    className="mt-[15px]"
                    value={loginCode}
                    onChange={(event) => setLoginCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    inputMode="numeric"
                    autoFocus
                    required
                    placeholder=""
                  />
                  <Field
                    label="PIN"
                    className="mt-[15px]"
                    value={pin}
                    onChange={(event) => setPin(sanitizePinInput(event.target.value))}
                    type="password"
                    autoComplete="current-password"
                    required
                    placeholder=""
                  />
                </>
              ) : (
                <>
                  <Field
                    label={hasSupabase ? 'Email' : 'Staff name / email'}
                    className="mt-[15px]"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoFocus
                    type={hasSupabase ? 'email' : 'text'}
                    required
                  />
                  <Field
                    label="Password"
                    className="mt-[15px]"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    required
                  />
                </>
              )}

              {captchaLoading && hasSupabase && (
                <div className="mt-[18px] space-y-2" role="status" aria-label="Loading">
                  <Skeleton className="h-3 w-36" />
                  <Skeleton className="h-[65px] w-full max-w-[300px]" />
                </div>
              )}

              {captchaConfigError && hasSupabase && (
                <div className="mt-[18px] rounded-md border border-brand-danger bg-white px-3 py-2 text-xs text-brand-danger">
                  {captchaConfigError}
                </div>
              )}

              {captchaActive && !captchaLoading && (
                <div className="mt-[18px]">
                  <Turnstile
                    key={captchaKey}
                    siteKey={turnstileSiteKey}
                    onVerify={setCaptchaToken}
                    onExpire={() => setCaptchaToken('')}
                    onError={() => setCaptchaToken('')}
                  />
                </div>
              )}

              {error && (
                <ErrorBanner
                  className="mt-3 mb-0"
                  error={formatSupportError(error, /captcha|turnstile/i.test(String(error)) ? 'AUTH06' : 'AUTH01')}
                />
              )}
              <PrimaryButton
                className="mt-[25px]"
                type="submit"
                disabled={booting || captchaBlocking || (captchaActive && captchaLoading)}
              >
                {booting ? 'Signing in…' : 'Enter CalePOS'} <span>→</span>
              </PrimaryButton>
            </form>
            {IS_PRERELEASE && (
              <div className="mt-4 rounded-[6px] border border-brand-warn/40 bg-brand-warn-bg px-3 py-2 text-center">
                <strong className="block text-[11px] text-brand-warn">
                  {APP_VERSION_LABEL} · In development
                </strong>
                <span className="mt-0.5 block text-[10px] text-brand-warn">
                  Testing build — not yet approved for live sales.
                </span>
              </div>
            )}
            <div className="mt-[22px] flex items-center justify-between gap-3">
              <small className="text-[10px] text-brand-n600">
                {!hasSupabase
                  ? 'Demo mode — no store database connected'
                  : isOffline
                    ? 'No network — PIN sign-in still works on this device'
                    : ''}
              </small>
              {/* Which database this build talks to, before anyone signs in and starts
                  entering data into it. */}
              {SHOW_ENV_BADGE && hasSupabase && (
                <span
                  className="rounded-[4px] bg-brand-warn-bg px-2 py-0.5 text-[10px] font-bold tracking-wide text-brand-warn uppercase"
                  title="Not the live store database"
                >
                  {environmentLabel()}
                </span>
              )}
              {mode === 'pin' ? (
                <button
                  type="button"
                  className="border-0 bg-transparent p-0 text-[10px] text-brand-n500 underline-offset-2 hover:text-brand-n600 hover:underline"
                  onClick={() => {
                    setMode('email')
                    resetCaptcha()
                  }}
                >
                  Manager login
                </button>
              ) : (
                <button
                  type="button"
                  className="border-0 bg-transparent p-0 text-[10px] text-brand-n500 underline-offset-2 hover:text-brand-n600 hover:underline"
                  onClick={() => {
                    setMode('pin')
                    resetCaptcha()
                  }}
                >
                  Use staff PIN
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  )
}

export default Login
