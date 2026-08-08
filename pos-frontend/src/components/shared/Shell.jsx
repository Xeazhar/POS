import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { FiLock, FiLogOut, FiMenu, FiRefreshCw, FiX } from 'react-icons/fi'
import { navLinksFor } from '../../constants/nav'
import {
  hasSupabase,
  clockIn,
  clockOut,
  fetchOpenShift,
  heartbeatStaffSession,
  recordChangeFund,
} from '../../lib/api'
import { useAppVersion } from '../../hooks/useAppVersion'
import { useAuthStore, useCartStore, useInventoryStore } from '../../stores/posStore'
import { useSyncStore } from '../../stores/syncStore'
import { formatSyncError } from '../../utils/errors'
import { isManagerRole, usesPinLogin } from '../../utils/roles'
import { businessDate } from '../../utils/format'
import { decimalOnly } from '../../utils/validate'
import { Eyebrow, Field, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import Clock from './Clock'
import LockScreen from './LockScreen'
import RequestNotifications from './RequestNotifications'

const IDLE_LOCK_MS = 10 * 60 * 1000
const HEARTBEAT_MS = 2.5 * 60 * 1000

function defaultShiftPeriod() {
  return new Date().getHours() < 12 ? 'am' : 'pm'
}

function syncCopy({ online, pending, status, lastError }) {
  const syncing = status === 'syncing' || status === 'pushing'
  if (!online) {
    return {
      label: pending ? `Offline · ${pending}` : 'Offline',
      detail: pending ? `${pending} saved locally` : 'No network',
      tone: 'off',
      isError: false,
    }
  }
  if (syncing) {
    return {
      label: 'Syncing…',
      detail: pending ? `${pending} queued` : 'Updating',
      tone: 'sync',
      isError: false,
    }
  }
  if (status === 'error' || lastError) {
    const formatted = formatSyncError(lastError)
    return {
      label: formatted.title,
      detail: formatted.body,
      hint: formatted.hint || '',
      tone: 'warn',
      isError: true,
    }
  }
  if (pending) {
    return {
      label: `${pending} queued`,
      detail: 'Waiting to sync',
      tone: 'warn',
      isError: false,
    }
  }
  return {
    label: 'Synced',
    detail: 'Up to date',
    tone: 'ok',
    isError: false,
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
  const screenLocked = useAuthStore((state) => state.screenLocked)
  const lockScreen = useAuthStore((state) => state.lockScreen)
  const unlockScreen = useAuthStore((state) => state.unlockScreen)
  const deviceSessionId = useAuthStore((state) => state.deviceSessionId)
  const online = useSyncStore((state) => state.online)
  const pending = useSyncStore((state) => state.pending)
  const status = useSyncStore((state) => state.status)
  const lastError = useSyncStore((state) => state.lastError)
  const blockedOps = useSyncStore((state) => state.blocked)
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [clockBusy, setClockBusy] = useState(false)
  const [shiftPeriod, setShiftPeriod] = useState(defaultShiftPeriod)
  const [changeFundAmount, setChangeFundAmount] = useState('')
  const [changeFundError, setChangeFundError] = useState('')
  const [logoutPrompt, setLogoutPrompt] = useState(null) // { shift } | true (no shift info yet) | null
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [syncBannerDismissed, setSyncBannerDismissed] = useState(false)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const isManager = isManagerRole(user?.role) && user?.role !== 'master'
  const links = navLinksFor(user)
  const sync = syncCopy({ online, pending, status, lastError })
  const isPosPage = location.pathname === '/pos'
  const idleTimerRef = useRef(null)
  const showSyncBanner = sync.isError && lastError && !syncBannerDismissed
  // A reload mid-sale would throw away the cashier's cart, and unsynced local writes
  // still need this tab alive to push them — so only auto-refresh when neither is true.
  const cartItemCount = useCartStore((state) => state.items.length)
  const { updateReady, reload } = useAppVersion({
    safeToReload: cartItemCount === 0 && !pending && !logoutPrompt,
  })

  useEffect(() => {
    // New sync error → show banner again
    if (lastError) setSyncBannerDismissed(false)
  }, [lastError])

  const bumpIdle = () => {
    if (screenLocked) return
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => {
      lockScreen()
    }, IDLE_LOCK_MS)
  }

  useEffect(() => {
    if (!user) return undefined
    bumpIdle()
    const events = ['pointerdown', 'keydown', 'touchstart', 'mousemove']
    const onActivity = () => bumpIdle()
    events.forEach((ev) => window.addEventListener(ev, onActivity, { passive: true }))
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, onActivity))
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bumpIdle closes over screenLocked
  }, [user?.id, screenLocked])

  useEffect(() => {
    if (!hasSupabase || !user?.id) return undefined
    const sid = deviceSessionId || user.deviceSessionId
    if (!sid) return undefined
    const tick = () => {
      heartbeatStaffSession(user.id, sid).catch(() => {})
    }
    tick()
    const t = window.setInterval(tick, HEARTBEAT_MS)
    return () => window.clearInterval(t)
  }, [user?.id, deviceSessionId, user?.deviceSessionId])

  useEffect(() => {
    if (!hasSupabase || !user?.id || !user?.branchId) return undefined
    if (!usesPinLogin(user?.role)) return undefined
    let active = true
    fetchOpenShift(user.id)
      .then((open) => {
        if (!active) return
        if (!open) useAuthStore.setState({ pendingClockIn: true })
      })
      .catch(() => {
        /* clock-in gate soft-fails if shifts table/migration missing */
      })
    return () => {
      active = false
    }
  }, [user?.id, user?.branchId, user?.role])

  const clearClockForm = () => {
    setChangeFundAmount('')
    setChangeFundError('')
  }

  const isSupervisorClockIn = user?.role === 'supervisor' || user?.role === 'master'

  const finishClockIn = async () => {
    setClockBusy(true)
    setChangeFundError('')
    try {
      if (hasSupabase && user?.id && user?.branchId) {
        const shift = await clockIn({
          staffId: user.id,
          branchId: user.branchId,
          shiftPeriod: shiftPeriod === 'pm' ? 'pm' : 'am',
        })
        const amt = Number(changeFundAmount)
        // Cashiers record opening float; supervisors skip (drawer already set by cashier).
        if (!isSupervisorClockIn && amt > 0 && shift?.id) {
          await recordChangeFund({
            branchId: user.branchId,
            staffId: user.id,
            shiftId: shift.id,
            amount: amt,
            note: 'Opening float',
            confirmedBy: user.id,
            businessDate: businessDate(new Date(), dayOpenHour),
          })
        }
      }
      useAuthStore.setState({ pendingClockIn: false })
      clearClockForm()
    } catch (err) {
      setChangeFundError(err?.message || 'Could not clock in / record change fund.')
    } finally {
      setClockBusy(false)
    }
  }

  const signOutWithoutShift = async () => {
    await logout()
    clearClockForm()
    navigate('/')
  }

  const doClockIn = async () => {
    if (!isSupervisorClockIn) {
      const amt = Number(changeFundAmount)
      if (!changeFundAmount || Number.isNaN(amt) || amt <= 0) {
        setChangeFundError('Enter the change fund (starting cash) counted into the drawer.')
        return
      }
    }
    await finishClockIn()
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
        <Modal>
          <Eyebrow>SHIFT</Eyebrow>
          <h2 className="mb-1 text-lg">Clock in required</h2>
          <p className="m-0 text-xs text-brand-muted">
            {isSupervisorClockIn
              ? 'Choose AM/PM to start your shift. Change fund is entered by the cashier on their clock-in.'
              : 'Choose AM/PM, then enter the change fund counted into your drawer. You cannot use POS or other tools until you clock in.'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              { id: 'am', label: 'AM', hint: 'Morning' },
              { id: 'pm', label: 'PM', hint: 'Afternoon' },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`rounded-[5px] border px-3 py-2.5 text-left transition-colors ${
                  shiftPeriod === opt.id
                    ? 'border-brand-dark bg-brand-dark text-white'
                    : 'border-brand-border bg-white text-brand-ink'
                }`}
                onClick={() => setShiftPeriod(opt.id)}
              >
                <strong className="block text-sm">{opt.label}</strong>
                <span
                  className={`mt-0.5 block text-[10px] ${
                    shiftPeriod === opt.id ? 'text-white/70' : 'text-brand-subtle'
                  }`}
                >
                  {opt.hint}
                </span>
              </button>
            ))}
          </div>
          {!isSupervisorClockIn && (
            <Field
              className="mt-3"
              label="Change fund (starting cash)"
              value={changeFundAmount}
              onChange={(e) => {
                setChangeFundAmount(decimalOnly(e.target.value))
                setChangeFundError('')
              }}
              inputMode="decimal"
              required
              placeholder="0.00"
            />
          )}
          {changeFundError && <p className="mt-2 text-xs text-brand-danger">{changeFundError}</p>}
          <ModalActions>
            <SecondaryButton compact type="button" disabled={clockBusy} onClick={signOutWithoutShift}>
              Sign out
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={clockBusy} onClick={doClockIn}>
              {clockBusy ? 'Working…' : `Clock in · ${shiftPeriod.toUpperCase()}`}
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
      <div
        aria-hidden={pendingClockIn || undefined}
        className={pendingClockIn ? 'pointer-events-none select-none' : undefined}
      >
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
          <RequestNotifications />
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

          <button
            type="button"
            className="mt-2 flex w-full flex-col items-center gap-1 rounded-lg border-0 bg-transparent px-1 py-2 text-[#a8aeaa] hover:bg-white/5 hover:text-white"
            title="Refresh page"
            onClick={() => window.location.reload()}
          >
            <FiRefreshCw className="text-base" />
            <span className="text-[9px] font-bold">Refresh</span>
          </button>

          <button
            type="button"
            className="mt-1 flex w-full flex-col items-center gap-1 rounded-lg border-0 bg-transparent px-1 py-2 text-[#a8aeaa] hover:bg-white/5 hover:text-white"
            title="Lock screen"
            onClick={() => lockScreen()}
          >
            <FiLock className="text-base" />
            <span className="text-[9px] font-bold">Lock</span>
          </button>

          <div
            className={`mt-1 shrink-0 rounded-lg px-1.5 py-2.5 text-center ${
              sync.isError ? 'bg-[#3a3228] ring-1 ring-[#c9a45a]/40' : 'bg-brand-panel'
            }`}
          >
            <span className={`mx-auto mb-1 block h-1.5 w-1.5 rounded-full ${toneDot[sync.tone]}`} />
            <strong className={`block text-[9px] font-bold leading-tight ${toneText[sync.tone]}`}>
              {sync.label}
            </strong>
            <span
              className={`mt-0.5 block text-[8px] leading-snug break-words ${
                sync.isError ? 'text-[#e8d9b8]' : 'text-[#8a908c]'
              }`}
            >
              {sync.detail}
            </span>
            {sync.hint ? (
              <span className="mt-1 block text-[8px] leading-snug text-[#c9a45a] break-words">
                {sync.hint}
              </span>
            ) : null}
          </div>
        </aside>

        <section
          className={`min-h-0 min-w-0 flex-1 px-[22px] py-3.5 max-[700px]:px-3.5 max-[700px]:py-[22px] ${
            isPosPage ? 'flex flex-col overflow-hidden' : 'overflow-auto'
          }`}
        >
          {/* Not dismissible, and deliberately louder than the sync banner: each blocked
              item is a completed sale that never reached Supabase. Staying quiet about that
              is how a day's fiscal records go missing without anyone noticing. */}
          {blockedOps > 0 && (
            <div
              role="alert"
              className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-[10px] border-2 border-brand-danger bg-brand-danger-bg px-3.5 py-3"
            >
              <p className="m-0 min-w-0 text-xs leading-snug text-brand-danger">
                <strong>
                  {blockedOps} record{blockedOps === 1 ? '' : 's'} could not sync — needs attention.
                </strong>{' '}
                <span>
                  These sales are saved on this device only and are NOT on the server. Do not clear
                  this browser&apos;s data. Contact support with code SYNC09.
                </span>
              </p>
              <button
                type="button"
                className="shrink-0 rounded-[5px] border border-brand-danger bg-white px-2.5 py-1.5 text-[11px] font-bold text-brand-danger"
                onClick={async () => {
                  const { retryBlocked } = await import('../../offline/syncQueue')
                  await retryBlocked(user?.branchId || null)
                  const { syncBranch } = await import('../../offline')
                  if (user?.branchId) await syncBranch(user.branchId)
                  await useSyncStore.getState().refresh(user?.branchId)
                }}
              >
                Retry now
              </button>
            </div>
          )}
          {updateReady && (
            <div
              role="status"
              className="mb-3 flex shrink-0 items-center justify-between gap-3 rounded-[10px] border border-brand-gold/50 bg-brand-gold/10 px-3.5 py-2.5 text-left"
            >
              <p className="m-0 min-w-0 text-xs leading-snug text-brand-ink">
                <strong>Update available.</strong>{' '}
                <span className="text-brand-muted">
                  A newer version of CalePOS has been released — refresh to get it.
                </span>
              </p>
              <button
                type="button"
                className="shrink-0 rounded-[5px] border border-brand-dark bg-brand-dark px-2.5 py-1.5 text-[11px] font-bold text-white"
                onClick={reload}
              >
                Refresh now
              </button>
            </div>
          )}
          {showSyncBanner && (
            <div
              role="alert"
              className="mb-3 flex shrink-0 items-start gap-3 rounded-[10px] border border-[#e8d4a8] bg-[#fff8ea] px-3.5 py-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <strong className="block text-sm text-[#6a5520]">{sync.label}</strong>
                <p className="m-0 mt-1 text-xs leading-snug text-[#6a5520] break-words">{sync.detail}</p>
                {sync.hint ? (
                  <p className="m-0 mt-1.5 text-xs font-semibold leading-snug text-[#6a5520] break-words">
                    {sync.hint}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="shrink-0 border-0 bg-transparent p-1 text-base leading-none text-[#6a5520]"
                aria-label="Dismiss sync message"
                onClick={() => setSyncBannerDismissed(true)}
              >
                <FiX />
              </button>
            </div>
          )}
          {isPosPage ? <div className="flex min-h-0 flex-1 flex-col">{children}</div> : children}
        </section>
      </div>

      {/* Mobile lock affordance */}
      <button
        type="button"
        className="fixed bottom-4 left-4 z-[15] hidden h-11 w-11 place-items-center rounded-full border-0 bg-brand-dark text-white shadow-lg max-[700px]:grid"
        title="Lock screen"
        onClick={() => lockScreen()}
      >
        <FiLock />
      </button>

      {screenLocked && (
        <LockScreen
          onUnlock={() => {
            unlockScreen()
            bumpIdle()
          }}
          onLogout={() => {
            unlockScreen()
            void requestLogout()
          }}
        />
      )}
      </div>
    </div>
  )
}

export default Shell
