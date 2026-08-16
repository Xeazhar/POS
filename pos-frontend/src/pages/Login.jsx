import { useEffect, useState } from 'react'
import { Eyebrow, ErrorBanner, Field, PrimaryButton, Skeleton } from '../components/ui'
import Turnstile, { useTurnstileSiteKey } from '../components/shared/Turnstile'
import { CredentialAutofillTrap, secureFormProps } from '../components/shared/SecureCredential'
import { allowDemoMode, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { formatSupportError } from '../utils/errors'
import { sanitizePinInput } from '../utils/pin'
import { APP_VERSION_LABEL, IS_PRERELEASE } from '../utils/version'
import { LegalNavLinks } from '../legal/LegalNavLinks'

/**
 * Renders the CalePOS staff login screen with PIN and manager authentication modes.
 *
 * Supports Supabase and demo-mode authentication, CAPTCHA verification, authentication
 * errors, connectivity status, and post-login branch data loading.
 *
 * @returns {JSX.Element} The staff login interface.
 */
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
    // Welcome splash is shown by App.jsx LoginIntroGate (loginIntroUser in auth store).
  }

  return (
    <main className="grid min-h-screen place-items-center bg-brand-dark">
      <div className="w-[min(420px,calc(100%-32px))] rounded-[10px] border border-brand-line bg-brand-card p-11">
        <div className="mb-7 grid h-[43px] w-[43px] place-items-center rounded-lg bg-brand-gold text-[21px] font-bold text-brand-on-gold">
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
                : 'Demo mode: any code/PIN or email works offline.'}
            </p>
            <form
              className="relative mt-[22px]"
              method="POST"
              {...secureFormProps}
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
              <CredentialAutofillTrap />
              {mode === 'pin' ? (
                <>
                  <Field
                    label="Staff code"
                    className="mt-[15px]"
                    name="cale-staff-code"
                    noSave
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
                    name="cale-staff-pin"
                    noSave
                    secret
                    value={pin}
                    onChange={(event) => setPin(sanitizePinInput(event.target.value))}
                    inputMode="numeric"
                    maxLength={6}
                    required
                    placeholder=""
                  />
                </>
              ) : (
                <>
                  <Field
                    label={hasSupabase ? 'Email' : 'Staff name / email'}
                    className="mt-[15px]"
                    name="cale-staff-email"
                    noSave
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoFocus
                    type="text"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    required
                  />
                  <Field
                    label="Password"
                    className="mt-[15px]"
                    name="cale-staff-password"
                    noSave
                    secret
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
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
                <div className="mt-[18px] rounded-md border border-brand-danger bg-brand-card px-3 py-2 text-xs text-brand-danger">
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
              <p className="mt-4 text-center text-[10px] font-bold tracking-wide text-brand-warn uppercase">
                {APP_VERSION_LABEL} · In development
                <span className="mt-0.5 block font-normal normal-case tracking-normal">
                  Not for live sales
                </span>
              </p>
            )}
            <div className="mt-[22px] flex items-center justify-between gap-3">
              <small className="text-[10px] text-brand-n600">
                {!hasSupabase
                  ? 'Demo mode: no store database connected'
                  : isOffline
                    ? 'No network: PIN sign-in still works on this device'
                    : ''}
              </small>
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
        <LegalNavLinks
          className="mt-5 text-center text-[10px] text-brand-n500"
          linkClassName="text-brand-n500 underline-offset-2 hover:text-brand-n600 hover:underline"
        />
      </div>
    </main>
  )
}

export default Login
