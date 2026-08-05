import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eyebrow, ErrorBanner, Field, PrimaryButton } from '../components/ui'
import Turnstile, { useTurnstileSiteKey } from '../components/shared/Turnstile'
import { allowDemoMode, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { formatSupportError } from '../utils/errors'
import { isManagerRole } from '../utils/roles'
import { staffHomePath } from '../constants/nav'
import * as api from '../lib/api'

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
  const [captchaReady, setCaptchaReady] = useState(false)
  const [captchaWidgetError, setCaptchaWidgetError] = useState(false)
  const [captchaKey, setCaptchaKey] = useState(0)
  const login = useAuthStore((state) => state.login)
  const error = useAuthStore((state) => state.error)
  const booting = useAuthStore((state) => state.booting)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const loadBranch = useProductStore((state) => state.loadBranch)
  const navigate = useNavigate()

  const resetCaptcha = () => {
    setCaptchaToken('')
    setCaptchaReady(false)
    setCaptchaWidgetError(false)
    setCaptchaKey((k) => k + 1)
  }

  // Only block submit once the widget is on-screen and waiting for a token.
  const captchaBlocking = captchaActive && captchaReady && !captchaWidgetError && !captchaToken

  async function afterLogin(user) {
    if (hasSupabase && user?.branchId) {
      const data = await loadBranch(user.branchId)
      if (data) hydrate(data)
    }
    let needsClock = false
    if (!isManagerRole(user?.role) && hasSupabase && user?.branchId) {
      try {
        const open = await api.fetchOpenShift(user.id)
        needsClock = !open
      } catch {
        /* clock-in optional if migration missing */
      }
    }
    // Always navigate into the app (avoids blank shell when Login unmounts)
    navigate(staffHomePath(user))
    if (needsClock) {
      useAuthStore.setState({ pendingClockIn: true })
    }
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
                  if (captchaActive && captchaReady && !captchaWidgetError && !captchaToken) {
                    useAuthStore.setState({ error: 'Complete the security check before signing in.' })
                    return
                  }
                  // Pass token to Supabase Auth (Auth → CAPTCHA protection). Do not use a separate verify call.
                  const user =
                    mode === 'pin'
                      ? await login(loginCode, pin, { mode: 'pin', captchaToken: captchaToken || undefined })
                      : await login(email, password, { mode: 'email', captchaToken: captchaToken || undefined })
                  await afterLogin(user)
                } catch {
                  resetCaptcha()
                  /* error in store */
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
                    placeholder="4–6 digit code"
                  />
                  <Field
                    label="PIN"
                    className="mt-[15px]"
                    value={pin}
                    onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    type="password"
                    inputMode="numeric"
                    required
                    placeholder="4–6 digit PIN"
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
                <p className="mt-[18px] text-xs text-brand-muted">Loading security check…</p>
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
                    onReady={() => setCaptchaReady(true)}
                    onVerify={setCaptchaToken}
                    onExpire={() => setCaptchaToken('')}
                    onError={() => {
                      setCaptchaWidgetError(true)
                      setCaptchaToken('')
                    }}
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
                disabled={booting || captchaBlocking}
              >
                {booting ? 'Signing in…' : 'Enter CalePOS'} <span>→</span>
              </PrimaryButton>
            </form>
            <div className="mt-[22px] flex items-center justify-between gap-3">
              <small className="text-[10px] text-[#969b97]">
                {hasSupabase ? 'Connected to Supabase' : 'Offline demo store'}
              </small>
              {mode === 'pin' ? (
                <button
                  type="button"
                  className="border-0 bg-transparent p-0 text-[10px] text-[#b0b5b1] underline-offset-2 hover:text-[#7a807c] hover:underline"
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
                  className="border-0 bg-transparent p-0 text-[10px] text-[#b0b5b1] underline-offset-2 hover:text-[#7a807c] hover:underline"
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
