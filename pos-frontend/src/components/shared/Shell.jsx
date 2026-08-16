import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FiChevronLeft, FiChevronRight, FiLock, FiLogOut, FiMenu, FiRefreshCw, FiX } from 'react-icons/fi'
import { navLinksFor } from '../../constants/nav'
import { fetchCompanyProfile, hasSupabase, heartbeatStaffSession, isSessionRevokedError } from '../../lib/api'
import { useAppVersion } from '../../hooks/useAppVersion'
import { useBranchOperationsLive } from '../../hooks/useBranchOperationsLive'
import { subscribeBroadcast } from '../../offline/realtime'
import { useAuthStore, useCartStore } from '../../stores/posStore'
import { useShiftStore } from '../../stores/shiftStore'
import { useSyncStore } from '../../stores/syncStore'
import { formatSupportError } from '../../utils/errors'
import { isManagerRole, usesPinLogin } from '../../utils/roles'
import { syncCopy, syncToneDot, syncToneText } from '../../utils/syncStatus'
import { APP_VERSION_LABEL, IS_PRERELEASE } from '../../utils/version'
import { hardReload } from '../../utils/hardReload'
import { SHOW_ENV_BADGE, environmentCaption } from '../../utils/environment'
import Clock from './Clock'
import LockScreen from './LockScreen'
import RequestNotifications from './RequestNotifications'
import ShiftGate from './ShiftGate'
import SidebarNav from './SidebarNav'
import { applyIdleLockMinutes, getIdleLockMs, subscribeIdleLock } from '../../utils/sessionPolicy'
import { applyNavOrder, clearNavOrder, loadNavOrder, saveNavOrder } from '../../utils/navOrder'
const HEARTBEAT_MS = 2.5 * 60 * 1000
const SIDEBAR_COLLAPSED_KEY = 'cale-sidebar-collapsed'

/**
 * Render the application shell with navigation, session controls, synchronization status, and route content.
 * @param {React.ReactNode} children - The content displayed within the application shell.
 * @return {JSX.Element} The application layout and its session or synchronization overlays.
 */
function Shell({ children }) {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const screenLocked = useAuthStore((state) => state.screenLocked)
  const lockScreen = useAuthStore((state) => state.lockScreen)
  const unlockScreen = useAuthStore((state) => state.unlockScreen)
  const online = useSyncStore((state) => state.online)
  const backendReachable = useSyncStore((state) => state.backendReachable)
  const pending = useSyncStore((state) => state.pending)
  const status = useSyncStore((state) => state.status)
  const lastError = useSyncStore((state) => state.lastError)
  const blockedOps = useSyncStore((state) => state.blocked)
  const navigate = useNavigate()
  const location = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  // Desktop-only icon-rail preference. Phones keep the full slide-over menu regardless —
  // this never affects `max-[700px]` layout, only the persistent `w-[88px]` aside.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [collapsed])
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [syncBannerDismissed, setSyncBannerDismissed] = useState(false)
  const shiftGate = useShiftStore((state) => state.gate)
  const resolveShift = useShiftStore((state) => state.resolve)
  useBranchOperationsLive(user?.branchId)
  const isManager = isManagerRole(user?.role) && user?.role !== 'master'
  const defaultLinks = navLinksFor(user)
  const userId = user?.id
  const [navDraft, setNavDraft] = useState(null)
  const orderPaths = navDraft && navDraft.userId === userId ? navDraft.paths : loadNavOrder(userId)
  const links = applyNavOrder(defaultLinks, orderPaths)
  const commitNavOrder = (paths) => {
    setNavDraft({ userId, paths })
    saveNavOrder(userId, paths)
  }
  const resetNavOrder = () => {
    setNavDraft({ userId, paths: null })
    clearNavOrder(userId)
  }
  const sync = syncCopy({ online, backendReachable, pending, status, lastError })
  const isPosPage = location.pathname === '/pos'
  const idleTimerRef = useRef(null)
  const [idleLockMs, setIdleLockMs] = useState(getIdleLockMs)
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
    }, idleLockMs)
  }

  useEffect(() => subscribeIdleLock((minutes) => setIdleLockMs(minutes * 60 * 1000)), [])

  useEffect(() => {
    if (!hasSupabase || !user?.id) return undefined
    fetchCompanyProfile()
      .then((row) => {
        if (row?.idle_lock_minutes != null) applyIdleLockMinutes(row.idle_lock_minutes)
      })
      .catch(() => {})
    return undefined
  }, [user?.id])

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
  }, [user?.id, screenLocked, idleLockMs])

  useEffect(() => {
    if (!hasSupabase || !user?.id) return undefined
    const tick = async () => {
      try {
        await heartbeatStaffSession()
      } catch (err) {
        if (isSessionRevokedError(err)) void useAuthStore.getState().sessionRevoked()
        // Any other failure (offline, transient blip) — do nothing, same as before; the
        // next tick or the next RLS-gated action will catch a real revocation.
      }
    }
    tick()
    const t = window.setInterval(tick, HEARTBEAT_MS)
    return () => window.clearInterval(t)
  }, [user?.id])

  useEffect(() => {
    if (!hasSupabase || !user?.id || !user?.branchId) return undefined
    return subscribeBroadcast({
      topic: `pos:branch:${user.branchId}:operations`,
      events: ['OPERATIONS_CHANGED'],
      onEvent: (payload) => {
        if (payload?.kind !== 'session_revoked' || payload?.staff_id !== user.id) return
        // Never trust the broadcast payload as truth (see CODEMAP.md Realtime section) —
        // it only triggers an authoritative re-check against Postgres.
        heartbeatStaffSession().catch((err) => {
          if (isSessionRevokedError(err)) void useAuthStore.getState().sessionRevoked()
        })
      },
    })
  }, [user?.id, user?.branchId])

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

  // A just-ended shift still needs Day End reachable — Request day end lives there, and
  // it must stay possible right up until sign-out (see CashierEndShift). Every other
  // gate/route combination still gets the full-screen block, including 'ended' anywhere
  // other than this one page.
  const onDayEndRoute = location.pathname === '/day-end'
  const shiftEndedOnDayEnd = shiftGate === 'ended' && onDayEndRoute
  const shiftGateActive = worksShifts && shiftGate !== 'ready'
  const hideAppContent = (shiftGateActive && !shiftEndedOnDayEnd) || screenLocked

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

  const sidebarNav = (iconOnly, onNavigate) => (
    <SidebarNav
      links={links}
      collapsed={iconOnly}
      onNavigate={onNavigate}
      onReorder={commitNavOrder}
      onReset={resetNavOrder}
      onRequestExpand={() => setCollapsed(false)}
    />
  )

  return (
    <div className="min-h-screen bg-brand-canvas">
      {worksShifts && shiftGate === 'checking' && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-brand-canvas">
          <p className="m-0 text-sm text-brand-muted">Checking shift…</p>
        </div>
      )}
      {worksShifts && shiftGate !== 'ready' && shiftGate !== 'checking' && !shiftEndedOnDayEnd && (
        <ShiftGate
          user={user}
          holdsDrawer={holdsDrawer}
          onSignOut={async () => {
            await logout()
            navigate('/')
          }}
        />
      )}
      {logoutError && (
        <div
          role="alert"
          className="fixed top-[70px] left-1/2 z-[30] -translate-x-1/2 rounded-md bg-brand-danger-bg px-3 py-2 text-xs text-brand-danger shadow-lg"
        >
          {logoutError}
        </div>
      )}
      {!hideAppContent && (
      <>
      <header className="flex h-[62px] items-center justify-between gap-3 bg-brand-dark px-6 text-brand-ondark max-[700px]:px-4 compact:px-4">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <button
            type="button"
            className="hidden border-0 bg-transparent p-1 text-xl text-brand-ondark max-[700px]:inline-grid compact:inline-grid"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <FiMenu />
          </button>
          <div className="flex items-center text-[21px] font-bold tracking-[-0.5px]">
            <span className="mr-2 inline-grid h-[31px] w-[31px] place-items-center rounded-lg bg-brand-gold text-brand-on-gold">
              C
            </span>
            <span className="max-[700px]:hidden compact:hidden font-display">CalePOS</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-2.5 px-2">
          <small className="max-w-[40%] truncate text-[11px] font-semibold text-brand-gold">
            {isManagerRole(user?.role)
              ? 'All branches'
              : user?.branchName || 'Branch'}
          </small>
          <Clock className="text-[12px]" />
          {/* Non-production builds say so, always visible — but as one small chip, not a
              vertical stack. Local dev used to point at the live database and the only way
              to notice was to spot real branch data in a test, so this can't be silent. */}
          {SHOW_ENV_BADGE && (
            <span className="max-w-[30%] shrink-0 truncate rounded-[4px] bg-brand-warn px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-brand-dark uppercase">
              {environmentCaption()}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2.5 text-[13px]">
          {/* Refresh and Lock live up here with the other whole-session controls
              (notifications, sign out) rather than at the foot of the sidebar — and they
              stay reachable on mobile, where the sidebar is behind a menu. */}
          <button
            type="button"
            className="border-0 bg-transparent text-lg text-inherit transition-[transform,opacity] duration-100 hover:opacity-80 active:scale-90 active:opacity-70"
            aria-label="Refresh"
            onClick={() => void hardReload({ online })}
          >
            <FiRefreshCw />
          </button>
          <button
            type="button"
            className="border-0 bg-transparent text-lg text-inherit transition-[transform,opacity] duration-100 hover:opacity-80 active:scale-90 active:opacity-70"
            aria-label="Lock screen"
            onClick={() => lockScreen()}
          >
            <FiLock />
          </button>
          <RequestNotifications />
          <div className="grid h-[35px] w-[35px] place-items-center rounded-full bg-brand-gold font-bold text-brand-on-gold">
            {user?.name?.[0] || 'A'}
          </div>
          <div className="max-[700px]:hidden compact:hidden">
            <strong className="block">{user?.name}</strong>
            <small className="mt-[3px] block text-[10px] text-brand-soft capitalize">{user?.role || 'staff'}</small>
          </div>
          <button
            className="ml-1 border-0 bg-transparent text-lg text-inherit transition-[transform,opacity] duration-100 hover:opacity-80 active:scale-90 active:opacity-70 disabled:opacity-40"
            aria-label="Sign out"
            disabled={logoutBusy}
            onClick={requestLogout}
          >
            <FiLogOut />
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-[20] hidden max-[700px]:block compact:block">
          <button
            type="button"
            className="absolute inset-0 border-0 bg-brand-scrim"
            aria-label="Close menu"
            onClick={() => setMenuOpen(false)}
          />
          <aside className="absolute top-0 left-0 flex h-full w-[min(280px,85vw)] flex-col bg-brand-panel px-3 py-4 text-brand-ondark shadow-lg">
            <div className="mb-4 flex items-center justify-between px-2">
              <strong className="text-sm">Menu</strong>
              <button
                type="button"
                className="border-0 bg-transparent text-xl text-brand-ondark"
                aria-label="Close menu"
                onClick={() => setMenuOpen(false)}
              >
                <FiX />
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {sidebarNav(false, () => setMenuOpen(false))}
            </div>
          </aside>
        </div>
      )}

      <div className="flex h-[calc(100vh-62px)]">
        <aside
          className={`flex flex-col overflow-hidden bg-brand-panel px-3 py-[25px] max-[700px]:hidden compact:hidden ${
            collapsed ? 'w-[64px] px-2' : 'w-[88px]'
          }`}
        >
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="mb-3 grid h-7 w-full shrink-0 place-items-center rounded-lg text-brand-ondark-dim hover:bg-brand-dark-hover hover:text-brand-ondark"
          >
            {collapsed ? <FiChevronRight size={14} /> : <FiChevronLeft size={14} />}
          </button>
          {!collapsed && isManager && (
            <div className="mb-3 text-center text-[9px] tracking-wide text-brand-n600 uppercase">
              Manager
            </div>
          )}
          {!collapsed && user?.role === 'supervisor' && (
            <div className="mb-3 text-center text-[9px] tracking-wide text-brand-n600 uppercase">
              Supervisor
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {sidebarNav(collapsed)}
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
            <span className={`mx-auto mb-1 block h-1.5 w-1.5 rounded-full ${syncToneDot[sync.tone]}`} />
            {!collapsed && (
              <>
                <strong className={`block text-[9px] font-bold leading-tight ${syncToneText[sync.tone]}`}>
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
              </>
            )}
          </div>
          {/* Always visible so a support call can start with "what version are you on?"
              instead of a guess. */}
          <div className="mt-2 text-center text-[9px] tracking-wide text-brand-n700 select-text">
            {APP_VERSION_LABEL}
          </div>
          {/* Pre-1.0 = still under test. Kept visible (restyled, not removed) so someone
              never mistakes this for a finished system — disappears on its own at 1.0.0,
              since it keys off the version, not a flag someone must remember to flip. */}
          {IS_PRERELEASE && (
            <div className="mt-1 text-center text-[8px] leading-tight font-bold tracking-wide text-brand-warn uppercase">
              In development
              {!collapsed && (
                <span className="mt-0.5 block font-normal normal-case tracking-normal">
                  Not for live sales
                </span>
              )}
            </div>
          )}
        </aside>

        <section
          className={`min-h-0 min-w-0 flex-1 px-[22px] py-3.5 max-[700px]:px-3.5 max-[700px]:py-[22px] compact:px-3.5 compact:py-[22px] ${
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
                className="shrink-0 rounded-[5px] border border-brand-danger bg-brand-card px-2.5 py-1.5 text-[11px] font-semibold text-brand-danger"
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
                className="shrink-0 rounded-[5px] border border-brand-gold bg-brand-gold px-2.5 py-1.5 text-[11px] font-semibold text-brand-on-gold"
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
      </>
      )}
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
  )
}

export default Shell
