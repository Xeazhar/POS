import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { FiLock, FiLogOut, FiMenu, FiRefreshCw, FiX } from 'react-icons/fi'
import { navLinksFor } from '../../constants/nav'
import { hasSupabase, heartbeatStaffSession } from '../../lib/api'
import { useAppVersion } from '../../hooks/useAppVersion'
import { useAuthStore, useCartStore } from '../../stores/posStore'
import { useShiftStore } from '../../stores/shiftStore'
import { useSyncStore } from '../../stores/syncStore'
import { formatSupportError, formatSyncError } from '../../utils/errors'
import { isManagerRole, usesPinLogin } from '../../utils/roles'
import { APP_VERSION_LABEL, IS_PRERELEASE, buildStamp } from '../../utils/version'
import { hardReload } from '../../utils/hardReload'
import { SHOW_ENV_BADGE, environmentLabel } from '../../utils/environment'
import Clock from './Clock'
import LockScreen from './LockScreen'
import RequestNotifications from './RequestNotifications'
import ShiftGate from './ShiftGate'

const IDLE_LOCK_MS = 10 * 60 * 1000
const HEARTBEAT_MS = 2.5 * 60 * 1000

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
  ok: 'bg-brand-sync-ok',
  sync: 'bg-brand-sync-busy animate-pulse',
  warn: 'bg-brand-sync-warn',
  off: 'bg-brand-sync-off',
}

const toneText = {
  ok: 'text-brand-sync-ok',
  sync: 'text-brand-sync-busy-ink',
  warn: 'text-brand-sync-warn-ink',
  off: 'text-brand-sync-off-ink',
}

function Shell({ children }) {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
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
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [syncBannerDismissed, setSyncBannerDismissed] = useState(false)
  const shiftGate = useShiftStore((state) => state.gate)
  const resolveShift = useShiftStore((state) => state.resolve)
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
    safeToReload: cartItemCount === 0 && !pending,
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

  // Only cashiers and supervisors work shifts; managers sign in to look at reports.
  // `holdsDrawer` separates the two kinds: a cashier is accountable for a till and must
  // count it, a supervisor on the floor is not and would otherwise lock the cashier out
  // of the very drawer they are standing at.
  const worksShifts = usesPinLogin(user?.role)
  const holdsDrawer = user?.role === 'cashier'

  useEffect(() => {
    if (!user?.id || !user?.branchId || !worksShifts) return
    void resolveShift(user, { holdsDrawer })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-resolve on identity change only
  }, [user?.id, user?.branchId, user?.role])

  const shiftBlocking = worksShifts && shiftGate !== 'ready' && shiftGate !== 'checking'

  const finishLogout = async () => {
    await logout()
    setLogoutError('')
    navigate('/')
  }

  /**
   * Sign out. Nothing else.
   *
   * There is deliberately no "what about your shift?" prompt here. An open shift already
   * survives sign-out, a closed tab, a refresh and a crash — `useShiftStore.resolve()`
   * resumes it on the next sign-in without asking for the change fund again. So the
   * question had exactly one safe answer, and asking it every time trained cashiers to
   * dismiss a modal that occasionally offered to close their shift.
   *
   * A shift ends in exactly two ways: the cashier ends it from End shift, or day-end /
   * Z-reading closes the business day. Signing out is neither.
   */
  const requestLogout = async () => {
    setLogoutError('')
    setLogoutBusy(true)
    try {
      await finishLogout()
    } catch (err) {
      setLogoutError(formatSupportError(err, 'SHIFT01'))
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
              : 'text-brand-n500 hover:bg-brand-dark-hover hover:text-brand-n400 active:scale-[0.96] active:bg-brand-dark-active'
          }`
        }
      >
        <Icon className="text-xl shrink-0" />
        <span className="max-w-full break-words text-center max-[700px]:inline max-[700px]:text-left">{label}</span>
      </NavLink>
    ))

  return (
    <div className="min-h-screen bg-brand-canvas">
      {shiftBlocking && (
        <ShiftGate
          user={user}
          holdsDrawer={holdsDrawer}
          onSignOut={async () => {
            await logout()
            navigate('/')
          }}
        />
      )}
      {/* No cash-out modal here any more. Ending a shift lives on End shift, where the
          cashier is already looking at their own float, expected cash and variance —
          not bolted onto the sign-out button. */}
      {logoutError && (
        <div
          role="alert"
          className="fixed top-[70px] left-1/2 z-[30] -translate-x-1/2 rounded-md bg-brand-danger-bg px-3 py-2 text-xs text-brand-danger shadow-lg"
        >
          {logoutError}
        </div>
      )}
      <div
        aria-hidden={shiftBlocking || undefined}
        className={shiftBlocking ? 'pointer-events-none select-none' : undefined}
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
          {/* Non-production builds say so, permanently and in the middle of the screen.
              Local dev used to point at the live database, and the only way to notice was
              to spot real branch data in a test — by which point a test sale had already
              taken a real OR number. The project ref is shown because a copied .env can
              lie about the tier, but the ref is the database being written to. */}
          {SHOW_ENV_BADGE && (
            <span
              className="max-w-full truncate rounded-[4px] bg-brand-warn px-2 py-0.5 text-[10px] font-bold tracking-wide text-brand-dark uppercase"
              title="This build is NOT pointed at the live store database"
            >
              {environmentLabel()}
            </span>
          )}
          <small className="max-w-full truncate text-[11px] font-semibold text-brand-gold">
            {user?.branchName || 'Bayombong Branch #001'}
          </small>
          <Clock className="text-[12px]" />
        </div>

        <div className="flex shrink-0 items-center gap-2.5 text-[13px]">
          {/* Refresh and Lock live up here with the other whole-session controls
              (notifications, sign out) rather than at the foot of the sidebar — and they
              stay reachable on mobile, where the sidebar is behind a menu. */}
          <button
            type="button"
            className="border-0 bg-transparent text-lg text-inherit transition-[transform,opacity] duration-100 hover:opacity-80 active:scale-90 active:opacity-70"
            title="Refresh — clears cached app files and loads the newest version"
            aria-label="Refresh"
            onClick={() => void hardReload({ online })}
          >
            <FiRefreshCw />
          </button>
          <button
            type="button"
            className="border-0 bg-transparent text-lg text-inherit transition-[transform,opacity] duration-100 hover:opacity-80 active:scale-90 active:opacity-70"
            title="Lock screen"
            aria-label="Lock screen"
            onClick={() => lockScreen()}
          >
            <FiLock />
          </button>
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
            className="absolute inset-0 border-0 bg-brand-scrim"
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
            <div className="mb-3 text-center text-[9px] tracking-wide text-brand-n600 uppercase">
              Manager
            </div>
          )}
          {user?.role === 'supervisor' && (
            <div className="mb-3 text-center text-[9px] tracking-wide text-brand-n600 uppercase">
              Supervisor
            </div>
          )}
          <div className="sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            <NavItems />
          </div>

          {/* Refresh and Lock moved to the top navbar — see the header above. */}

          {/* The standalone Cash out button is gone: End shift is the one place a cashier
              closes their drawer, and it shows the float, expected cash and variance while
              they do it. Two entry points to the same irreversible cash action is one
              too many. */}

          <div
            className={`mt-1 shrink-0 rounded-lg px-1.5 py-2.5 text-center ${
              sync.isError ? 'bg-brand-sync-warn-bg ring-1 ring-brand-sync-warn/40' : 'bg-brand-panel'
            }`}
          >
            <span className={`mx-auto mb-1 block h-1.5 w-1.5 rounded-full ${toneDot[sync.tone]}`} />
            <strong className={`block text-[9px] font-bold leading-tight ${toneText[sync.tone]}`}>
              {sync.label}
            </strong>
            <span
              className={`mt-0.5 block text-[8px] leading-snug break-words ${
                sync.isError ? 'text-brand-sync-warn-body' : 'text-brand-ondark-dim'
              }`}
            >
              {sync.detail}
            </span>
            {sync.hint ? (
              <span className="mt-1 block text-[8px] leading-snug text-brand-sync-warn break-words">
                {sync.hint}
              </span>
            ) : null}
          </div>
          {/* Always visible so a support call can start with "what version are you on?"
              instead of a guess. Title carries the build timestamp for the same reason. */}
          <div
            className="mt-2 text-center text-[9px] tracking-wide text-brand-n700 select-text"
            title={buildStamp()}
          >
            {APP_VERSION_LABEL}
          </div>
          {/* Pre-1.0 = still under test. Deliberately hard to miss: someone must never
              mistake this for a finished system and trade on it unsupervised. Disappears
              on its own at 1.0.0 — it keys off the version, not a flag someone must
              remember to flip. */}
          {IS_PRERELEASE && (
            <div className="mt-1 rounded-[4px] bg-brand-warn-bg px-1.5 py-1 text-center text-[8px] leading-tight font-bold tracking-wide text-brand-warn uppercase">
              In development
              <span className="mt-0.5 block font-normal normal-case tracking-normal">
                Not for live sales
              </span>
            </div>
          )}
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
              className="mb-3 flex shrink-0 items-start gap-3 rounded-[10px] border border-brand-warn-line bg-brand-warn-surface px-3.5 py-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <strong className="block text-sm text-brand-warn">{sync.label}</strong>
                <p className="m-0 mt-1 text-xs leading-snug text-brand-warn break-words">{sync.detail}</p>
                {sync.hint ? (
                  <p className="m-0 mt-1.5 text-xs font-semibold leading-snug text-brand-warn break-words">
                    {sync.hint}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="shrink-0 border-0 bg-transparent p-1 text-base leading-none text-brand-warn"
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

      {/* The floating mobile lock button is gone: Lock now sits in the top navbar, which
          is visible on every screen size, so a second one just covered page content. */}

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
