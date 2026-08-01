import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eyebrow, Field, PrimaryButton } from '../components/ui'
import { allowDemoMode, hasSupabase } from '../lib/api'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'

function Login() {
  const configured = hasSupabase || allowDemoMode
  const [email, setEmail] = useState(hasSupabase ? '' : allowDemoMode ? 'demo@calepos.local' : '')
  const [password, setPassword] = useState(hasSupabase ? '' : allowDemoMode ? 'demo' : '')
  const login = useAuthStore((state) => state.login)
  const error = useAuthStore((state) => state.error)
  const booting = useAuthStore((state) => state.booting)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const loadBranch = useProductStore((state) => state.loadBranch)
  const navigate = useNavigate()

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
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] text-brand-muted">
              {hasSupabase ? 'Sign in with your CalePOS account.' : 'Demo mode — any email/PIN works offline.'}
            </p>
            <form
              className="mt-[30px]"
              onSubmit={async (event) => {
                event.preventDefault()
                try {
                  const user = await login(email, password)
                  if (hasSupabase && user?.branchId) {
                    const data = await loadBranch(user.branchId)
                    if (data) hydrate(data)
                  }
                  navigate('/')
                } catch {
                  /* error in store */
                }
              }}
            >
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
                label="Password / PIN"
                className="mt-[15px]"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                required
              />
              {error && <p className="mt-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>}
              <PrimaryButton className="mt-[25px]" type="submit" disabled={booting}>
                {booting ? 'Signing in…' : 'Enter CalePOS'} <span>→</span>
              </PrimaryButton>
            </form>
            <small className="mt-[25px] block text-center text-[10px] text-[#969b97]">
              {hasSupabase ? 'Connected to Supabase' : 'Offline demo store'}
            </small>
          </>
        )}
      </div>
    </main>
  )
}

export default Login
