import { useEffect, useState } from 'react'
import { FiLock } from 'react-icons/fi'
import { hasSupabase, verifyAccountPassword, verifyOwnPin } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { usesPinLogin } from '../../utils/roles'
import { sanitizePinInput } from '../../utils/pin'
import { Eyebrow, Field, PrimaryButton, SecondaryButton, ErrorBanner } from '../ui'

/**
 * Full-screen lock — keeps auth session + shift + cart intact.
 * Unlock with till PIN (cashier/supervisor) or account password (manager/admin).
 * No Turnstile: this is not a new sign-in.
 */
function LockScreen({ onUnlock, onLogout }) {
  const user = useAuthStore((s) => s.user)
  const pinMode = usesPinLogin(user?.role)
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    setSecret('')
    setError('')
  }, [pinMode])

  const dateLabel = now.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
  const timeLabel = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const unlock = async (event) => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (!hasSupabase) {
        onUnlock?.()
        return
      }
      if (pinMode) {
        await verifyOwnPin(user.id, secret)
      } else {
        await verifyAccountPassword(user.email, secret, { staffId: user.id })
      }
      setSecret('')
      onUnlock?.()
    } catch (err) {
      setError(err?.message || (pinMode ? 'Incorrect PIN' : 'Incorrect password'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex flex-col items-center justify-center bg-brand-dark px-6 text-white">
      <div className="mb-8 flex flex-col items-center text-center">
        <span className="mb-4 inline-grid h-14 w-14 place-items-center rounded-2xl bg-brand-gold text-2xl font-bold text-brand-dark">
          C
        </span>
        <strong className="text-xl tracking-tight">CalePOS</strong>
        <p className="mt-1 text-sm text-[#a8aeaa]">{user?.branchName || 'Branch'}</p>
      </div>

      <div className="mb-8 text-center">
        <div className="text-4xl font-bold tabular-nums text-brand-gold max-[700px]:text-3xl">{timeLabel}</div>
        <div className="mt-2 text-sm text-[#c8ceca]">{dateLabel}</div>
      </div>

      <div className="mb-6 flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-xs text-[#d7ddd9]">
        <FiLock />
        Locked · {user?.name || 'Staff'}
      </div>

      <form onSubmit={unlock} className="w-full max-w-xs rounded-xl bg-white p-5 text-brand-ink shadow-lg">
        <Eyebrow>UNLOCK</Eyebrow>
        <h2 className="mb-3 text-lg">{pinMode ? 'Enter your PIN' : 'Enter your password'}</h2>
        <Field
          label={pinMode ? 'PIN' : 'Password'}
          type="password"
          autoComplete="current-password"
          value={secret}
          onChange={(e) =>
            setSecret(pinMode ? sanitizePinInput(e.target.value) : e.target.value)
          }
          autoFocus
          required
        />
        {error && <ErrorBanner className="mt-3 mb-0" error={error} />}
        <div className="mt-4 flex flex-col gap-2">
          <PrimaryButton type="submit" disabled={busy || !secret}>
            {busy ? 'Checking…' : 'Unlock'}
          </PrimaryButton>
          <SecondaryButton
            type="button"
            disabled={busy}
            onClick={() => onLogout?.()}
          >
            Sign out completely
          </SecondaryButton>
        </div>
      </form>
    </div>
  )
}

export default LockScreen
