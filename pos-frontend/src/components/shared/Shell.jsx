import { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { FiLogOut, FiMenu, FiX } from 'react-icons/fi'
import { navLinksFor } from '../../constants/nav'
import { hasSupabase, clockIn, clockOut, fetchOpenShift } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { useSyncStore } from '../../stores/syncStore'
import { isManagerRole, usesPinLogin } from '../../utils/roles'
import { Eyebrow, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import Clock from './Clock'

function syncCopy({ online, pending, status, lastError }) {
  const syncing = status === 'syncing' || status === 'pushing'
  if (!online) {
    return {
      label: pending ? `Offline · ${pending}` : 'Offline',
      detail: pending ? `${pending} saved locally` : 'No network',
      tone: 'off',
    }
  }
  if (syncing) {
    return {
      label: 'Syncing…',
      detail: pending ? `${pending} queued` : 'Updating',
      tone: 'sync',
    }
  }
  if (pending) {
    return {
      label: `${pending} queued`,
      detail: 'Waiting to sync',
      tone: 'warn',
    }
  }
  if (status === 'error' || lastError) {
    return {
      label: 'Sync issue',
      detail: String(lastError || 'Retrying').slice(0, 28),
      tone: 'warn',
    }
  }
  return {
    label: 'Synced',
    detail: 'Up to date',
    tone: 'ok',
  }
}

const toneDot = {
  ok: 'bg-[#6f9b78]',
  sync: 'bg-[#7a9cc8] animate-pulse',
  warn: 'bg-[#c9a45a]',
  off: 'bg-[#c48978]',
}

const toneText = {
  ok: 'text-[#6f9b78]',
  sync: 'text-[#5a7fa8]',
  warn: 'text-[#a8843a]',
  off: 'text-[#a86a5a]',
}

function Shell({ children }) {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const pendingClockIn = useAuthStore((state) => state.pendingClockIn)
  const online = useSyncStore((state) => state.online)
  const pending = useSyncStore((state) => state.pending)
  const status = useSyncStore((state) => state.status)
  const lastError = useSyncStore((state) => state.lastError)
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [clockBusy, setClockBusy] = useState(false)
  const [logoutPrompt, setLogoutPrompt] = useState(null) // { shift } | true (no shift info yet) | null
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const isManager = isManagerRole(user?.role) && user?.role !== 'master'
  const links = navLinksFor(user)
  const sync = syncCopy({ online, pending, status, lastError })

  const dismissClock = () => useAuthStore.setState({ pendingClockIn: false })
  const doClockIn = async () => {
    setClockBusy(true)
    try {
      if (hasSupabase && user?.id && user?.branchId) {
        await clockIn({ staffId: user.id, branchId: user.branchId })
      }
    } catch {
      /* optional */
    } finally {
      setClockBusy(false)
      dismissClock()
    }
  }

  const finishLogout = async () => {
    await logout()
    setLogoutPrompt(null)
    setLogoutError('')
    navigate('/')
  }

  const requestLogout = async () => {
    setLogoutError('')
    // Managers / email roles can leave freely
    if (!usesPinLogin(user?.role) || !hasSupabase || !user?.id) {
      await finishLogout()
      return
    }
    setLogoutBusy(true)
    try {
      const open = await fetchOpenShift(user.id)
      if (open?.id) {
        setLogoutPrompt({ shift: open })
      } else {
        // No open shift on record — still confirm they mean to leave
        setLogoutPrompt({ shift: null })
      }
    } catch {
      setLogoutPrompt({ shift: null })
    } finally {
      setLogoutBusy(false)
    }
  }

  const endShiftAndLogout = async () => {
    setLogoutBusy(true)
    setLogoutError('')
    try {
      const shiftId = logoutPrompt?.shift?.id
      if (shiftId) {
        await clockOut(shiftId)
      } else if (hasSupabase && user?.id) {
        // Race: shift opened after prompt — try once more
        const open = await fetchOpenShift(user.id).catch(() => null)
        if (open?.id) await clockOut(open.id)
      }
      await finishLogout()
    } catch (err) {
      setLogoutError(err?.message || 'Could not end shift. Try again.')
    } finally {
      setLogoutBusy(false)
    }
  }

  const NavItems = ({ onNavigate }) =>
    links.map(([path, label, Icon]) => (
      <NavLink
        key={path}
        to={path}
        end={path === '/'}
        onClick={() => onNavigate?.()}
        className={({ isActive }) =>
          `mb-2 grid w-full justify-items-center gap-1.5 overflow-hidden rounded-lg px-1 py-3 text-[10px] leading-tight no-underline transition-[background-color,color,transform] duration-100 max-[700px]:mb-0 max-[700px]:flex max-[700px]:items-center max-[700px]:justify-start max-[700px]:gap-3 max-[700px]:px-3 max-[700px]:py-3 max-[700px]:text-xs ${
            isActive
              ? 'bg-brand-gold text-brand-dark'
              : 'text-[#9da4a1] hover:bg-[#343938] hover:text-[#d5dbd7] active:scale-[0.96] active:bg-[#3a403f]'
          }`
        }
      >
        <Icon className="text-xl shrink-0" />
        <span className="max-w-full break-words text-center max-[700px]:inline max-[700px]:text-left">{label}</span>
      </NavLink>
    ))

  return (
    <div className="min-h-screen bg-brand-canvas">
      {pendingClockIn && (
        <Modal onClose={dismissClock}>
          <Eyebrow>SHIFT</Eyebrow>
          <h2 className="mb-1 text-lg">Clock in?</h2>
          <p className="m-0 text-xs text-brand-muted">
            Hi {user?.name || 'there'}. Clock in before starting your shift?
          </p>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={dismissClock}>
              Skip for now
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={clockBusy} onClick={doClockIn}>
              {clockBusy ? 'Clocking in…' : 'Clock in'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
      {logoutPrompt && (
        <Modal onClose={() => !logoutBusy && setLogoutPrompt(null)}>
          <Eyebrow>END SHIFT</Eyebrow>
          <h2 className="mb-1 text-lg">
            {logoutPrompt.shift ? 'End shift before signing out?' : 'Sign out?'}
          </h2>
          <p className="m-0 text-xs text-brand-muted">
            {logoutPrompt.shift
              ? 'Your shift is still open. End it to clock out, then you’ll be signed out.'
              : 'No open shift found. You can sign out now.'}
          </p>
          {logoutError && <p className="mt-2 text-xs text-brand-danger">{logoutError}</p>}
          <ModalActions>
            <SecondaryButton
              compact
              type="button"
              disabled={logoutBusy}
              onClick={() => setLogoutPrompt(null)}
            >
              Stay signed in
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={logoutBusy}
              onClick={logoutPrompt.shift ? endShiftAndLogout : finishLogout}
            >
              {logoutBusy
                ? 'Working…'
                : logoutPrompt.shift
                  ? 'End shift & sign out'
                  : 'Sign out'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
      <header className="flex h-[62px] items-center justify-between gap-3 bg-brand-dark px-6 text-white max-[700px]:px-4">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <button
            type="button"
            className="hidden border-0 bg-transparent p-1 text-xl text-white max-[700px]:inline-grid"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <FiMenu />
          </button>
          <div className="flex items-center text-[21px] font-bold tracking-[-0.5px]">
            <span className="mr-2 inline-grid h-[31px] w-[31px] place-items-center rounded-lg bg-brand-gold text-brand-dark">
              C
            </span>
            <span className="max-[700px]:hidden">CalePOS</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2">
          <small className="max-w-full truncate text-[11px] font-semibold text-brand-gold">
            {user?.branchName || 'Bayombong Branch #001'}
          </small>
          <Clock className="text-[12px]" />
        </div>

        <div className="flex shrink-0 items-center gap-2.5 text-[13px]">
          <div className="grid h-[35px] w-[35px] place-items-center rounded-full bg-brand-gold font-bold text-brand-dark">
            {user?.name?.[0] || 'A'}
          </div>
          <div className="max-[700px]:hidden">
            <strong className="block">{user?.name}</strong>
            <small className="mt-[3px] block text-[10px] text-brand-soft capitalize">{user?.role || 'staff'}</small>
          </div>
          <button
            className="ml-1 border-0 bg-transparent text-lg text-inherit transition-[transform,opacity] duration-100 hover:opacity-80 active:scale-90 active:opacity-70 disabled:opacity-40"
            title="Sign out"
            disabled={logoutBusy}
            onClick={requestLogout}
          >
            <FiLogOut />
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-[20] hidden max-[700px]:block">
          <button
            type="button"
            className="absolute inset-0 border-0 bg-[#202426aa]"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="absolute top-0 left-0 flex h-full w-[min(280px,85vw)] flex-col bg-brand-panel px-3 py-4 text-white shadow-lg">
            <div className="mb-4 flex items-center justify-between px-2">
              <strong className="text-sm">Menu</strong>
              <button
                type="button"
                className="border-0 bg-transparent text-xl text-white"
                onClick={() => setMenuOpen(false)}
              >
                <FiX />
              </button>
            </div>
            <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
              <NavItems onNavigate={() => setMenuOpen(false)} />
            </div>
          </aside>
        </div>
      )}

      <div className="flex h-[calc(100vh-62px)]">
        <aside className="flex w-[88px] flex-col overflow-hidden bg-brand-panel px-3 py-[25px] max-[700px]:hidden">
          {isManager && (
            <div className="mb-3 text-center text-[9px] tracking-wide text-[#7c827f] uppercase">
              Manager
            </div>
          )}
          {user?.role === 'supervisor' && (
            <div className="mb-3 text-center text-[9px] tracking-wide text-[#7c827f] uppercase">
              Supervisor
            </div>
          )}
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <NavItems />
          </div>

          <div
            className="mt-2 shrink-0 rounded-lg bg-brand-panel px-1.5 py-2.5 text-center"
            title={lastError || sync.detail}
          >
            <span className={`mx-auto mb-1 block h-1.5 w-1.5 rounded-full ${toneDot[sync.tone]}`} />
            <strong className={`block text-[9px] font-bold leading-tight ${toneText[sync.tone]}`}>
              {sync.label}
            </strong>
            <span className="mt-0.5 block text-[8px] leading-tight text-[#8a908c]">{sync.detail}</span>
          </div>
        </aside>

        <section className="min-h-0 min-w-0 flex-1 overflow-auto px-[22px] py-3.5 max-[700px]:px-3.5 max-[700px]:py-[22px]">
          {children}
        </section>
      </div>
    </div>
  )
}

export default Shell
