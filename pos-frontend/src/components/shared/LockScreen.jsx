import { useEffect, useState } from 'react'
import { FiLock } from 'react-icons/fi'
import { hasSupabase, verifyAccountPassword, verifyOwnPin } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { usesPinLogin } from '../../utils/roles'
import { sanitizePinInput } from '../../utils/pin'
import { clearUnlockFailures, getUnlockLockout, recordUnlockFailure } from '../../offline/session'
import { Eyebrow, Field, PrimaryButton, SecondaryButton, ErrorBanner } from '../ui'
import { CredentialAutofillTrap, secureFormProps } from './SecureCredential'

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

  // Throttle survives reloads and power cycles (IndexedDB), so guessing at an unattended
  // terminal can't be reset by refreshing the page.
  const [lockedUntil, setLockedUntil] = useState(0)
  useEffect(() => {
    if (!user?.id) return
    void getUnlockLockout(user.id).then((s) => setLockedUntil(s.lockedUntil || 0))
  }, [user?.id])

  const lockRemainingMs = Math.max(0, lockedUntil - now.getTime())
  const throttled = lockRemainingMs > 0

  const unlock = async (event) => {
    event.preventDefault()
    if (throttled) return
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
      await clearUnlockFailures()
      setLockedUntil(0)
      setSecret('')
      onUnlock?.()
    } catch (err) {
      const state = await recordUnlockFailure(user.id)
      setLockedUntil(state.lockedUntil || 0)
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
        <p className="mt-1 text-sm text-brand-n500">{user?.branchName || 'Branch'}</p>
      </div>

      <div className="mb-8 text-center">
        <div className="text-4xl font-bold tabular-nums text-brand-gold max-[700px]:text-3xl">{timeLabel}</div>
        <div className="mt-2 text-sm text-brand-ondark">{dateLabel}</div>
      </div>

      <div className="mb-6 flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-xs text-brand-n400">
        <FiLock />
        Locked · {user?.name || 'Staff'}
      </div>

      <form
        onSubmit={unlock}
        className="relative w-full max-w-xs rounded-xl bg-white p-5 text-brand-ink shadow-lg"
        {...secureFormProps}
      >
        <CredentialAutofillTrap />
        <Eyebrow>UNLOCK</Eyebrow>
        <h2 className="mb-3 text-lg">{pinMode ? 'Enter your PIN' : 'Enter your password'}</h2>
        <Field
          label={pinMode ? 'PIN' : 'Password'}
          name="cale-unlock-secret"
          noSave
          secret
          inputMode={pinMode ? 'numeric' : undefined}
          maxLength={pinMode ? 6 : undefined}
          value={secret}
          onChange={(e) =>
            setSecret(pinMode ? sanitizePinInput(e.target.value) : e.target.value)
          }
          autoFocus
          required
        />
        {error && <ErrorBanner className="mt-3 mb-0" error={error} />}
        {throttled && (
          <p className="mt-3 mb-0 rounded bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">
            Too many attempts. Try again in {Math.ceil(lockRemainingMs / 1000)}s.
          </p>
        )}
        <div className="mt-4 flex flex-col gap-2">
          <PrimaryButton type="submit" disabled={busy || !secret || throttled}>
            {busy ? 'Checking…' : throttled ? `Locked ${Math.ceil(lockRemainingMs / 1000)}s` : 'Unlock'}
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
