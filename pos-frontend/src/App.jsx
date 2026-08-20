import { Suspense, useCallback, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Shell from './components/shared/Shell'
import LoginIntro from './components/shared/LoginIntro'
import { PageSkeleton } from './components/ui'
import { useAppVersion } from './hooks/useAppVersion'
import { useBranchHeartbeat } from './hooks/useBranchHeartbeat'
import { useCompactChrome } from './hooks/useCompactChrome'
import { hasSupabase } from './lib/api'
import { startConnectivityWatcher } from './offline'
import { installSessionLifecycle, consumeBrowserClosedFlag } from './offline/sessionLifecycle'
import { useAuthStore, useInventoryStore, useProductStore, bindSessionRevokedWatcher } from './stores/posStore'
import { bindSyncStore } from './stores/syncStore'
import { canAccessModule, isSupervisorOrAbove } from './utils/roles'
import { staffHomePath } from './constants/nav'
import { clearChunkReloadFlag, lazyWithRetry } from './utils/lazyWithRetry'


const Login = lazyWithRetry(() => import('./pages/Login.jsx'))
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard.jsx'))
const CashierDashboard = lazyWithRetry(() => import('./pages/CashierDashboard.jsx'))
const POS = lazyWithRetry(() => import('./pages/POS.jsx'))
const Transactions = lazyWithRetry(() => import('./pages/Transactions.jsx'))
const Products = lazyWithRetry(() => import('./pages/Products.jsx'))
const DayEnd = lazyWithRetry(() => import('./pages/DayEnd.jsx'))
const Devices = lazyWithRetry(() => import('./pages/Devices.jsx'))
const Settings = lazyWithRetry(() => import('./pages/Settings.jsx'))
const ManagerOverview = lazyWithRetry(() => import('./pages/manager/Overview.jsx'))
const ManagerBranches = lazyWithRetry(() => import('./pages/manager/Branches.jsx'))
const ManagerBranchDashboard = lazyWithRetry(() => import('./pages/manager/BranchDashboard.jsx'))
const ManagerStaff = lazyWithRetry(() => import('./pages/manager/Staff.jsx'))
const ManagerData = lazyWithRetry(() => import('./pages/manager/Data.jsx'))
const ManagerPromos = lazyWithRetry(() => import('./pages/manager/Promos.jsx'))
const ManagerReports = lazyWithRetry(() => import('./pages/manager/Reports.jsx'))
const ManagerAnnouncements = lazyWithRetry(() => import('./pages/manager/Announcements.jsx'))
const NotificationHistory = lazyWithRetry(() => import('./pages/NotificationHistory.jsx'))
const Legal = lazyWithRetry(() => import('./pages/Legal.jsx'))

/**
 * Renders a table-style loading skeleton for lazy-loaded pages.
 * @returns {JSX.Element} The table-style page skeleton.
 */
function PageFallback() {
  return <PageSkeleton variant="table" className="px-1 py-2" />
}

/** Treat the login screen as busy for this long after the last keystroke. */
const LOGIN_TYPING_GRACE_MS = 20_000

/**
 * Keeps the build fresh while nobody is signed in.
 *
 * This is the most valuable place in the app to apply an update and the only one that had
 * no watchdog: the terminal sits on the login screen all night and between shifts, and
 * Shell — which owns the other watchdog — isn't mounted then. So a shop that never closed
 * its browser could open on a week-old bundle every morning.
 *
 * Signed out there is no cart, no open shift and no unsynced work — but there IS the
 * credential someone is halfway through typing. A cashier eight characters into a PIN at
 * shift start having the page reload under them is a real interruption, so recent typing
 * counts as work in progress and holds the reload off until they stop. Idle is the normal
 * state here, so this costs nothing the rest of the time.
 *
 * Rendered as a component rather than a hook call in App so the poll only runs while
 * logged out, instead of duplicating Shell's.
 */
function LoggedOutUpdateWatchdog() {
  const [typing, setTyping] = useState(false)

  useEffect(() => {
    let timer = null
    const onKey = () => {
      setTyping(true)
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => setTyping(false), LOGIN_TYPING_GRACE_MS)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  useAppVersion({ safeToReload: !typing, autoReload: true })
  return null
}

function firstHomePath(user) {
  return staffHomePath(user)
}

function RequireModule({ moduleId, children, fallback }) {
  const user = useAuthStore((state) => state.user)
  if (!canAccessModule(user, moduleId)) {
    return <Navigate to={fallback || firstHomePath(user)} replace />
  }
  return children
}

// Gated by role, not the module list — RequestNotifications.jsx's bell (which links here)
// is itself shown to any supervisor-or-above regardless of their `permissions[]`, and
// supervisors don't carry `manager_reports`, so RequireModule would lock them out.
function RequireRole({ test, children, fallback }) {
  const user = useAuthStore((state) => state.user)
  if (!test(user?.role)) {
    return <Navigate to={fallback || firstHomePath(user)} replace />
  }
  return children
}

/**
 * Renders the user's home page or redirects them to their first available screen.
 *
 * @returns {JSX.Element} The user's home page or a redirect to their first screen.
 */
function Home() {
  const user = useAuthStore((state) => state.user)
  const first = firstHomePath(user)
  // Cashiers / anyone whose home isn't "/" — send them to their first screen
  if (first && first !== '/') return <Navigate to={first} replace />
  if (canAccessModule(user, 'manager_overview')) return <ManagerOverview />
  return <Dashboard />
}

/**
 * Displays the configured post-login introduction and navigates to the user's staff home when it is completed.
 */
function LoginIntroGate() {
  const loginIntroUser = useAuthStore((state) => state.loginIntroUser)
  const clearLoginIntro = useAuthStore((state) => state.clearLoginIntro)
  const navigate = useNavigate()

  const finishIntro = useCallback(() => {
    const user = useAuthStore.getState().loginIntroUser
    clearLoginIntro()
    if (user) navigate(staffHomePath(user), { replace: true })
  }, [clearLoginIntro, navigate])

  if (!loginIntroUser) return null
  return <LoginIntro staffName={loginIntroUser.name} onDone={finishIntro} />
}

/**
 * Coordinates application initialization and renders authenticated or login routes.
 * @returns {JSX.Element} The application route content.
 */
function AppRoutes() {
  const user = useAuthStore((state) => state.user)
  const restoreSession = useAuthStore((state) => state.restoreSession)
  const logout = useAuthStore((state) => state.logout)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const loadBranch = useProductStore((state) => state.loadBranch)
  const { pathname } = useLocation()
  const isLegal = pathname === '/legal' || pathname.startsWith('/legal/')
  // Distinct from the auth store's `booting` flag, which `login()` also flips true/false
  // on every submit (including a failed one) so the Login screen can show a "Signing
  // in…" busy state. Gating the full-page skeleton on that same flag meant a wrong
  // password briefly blew away the whole Login form for a skeleton before the error
  // could show. This only tracks the one-time startup session check.
  const [initialBootDone, setInitialBootDone] = useState(false)

  useCompactChrome()
  useBranchHeartbeat(user)

  useEffect(() => {
    clearChunkReloadFlag()
  }, [])

  useEffect(() => {
    bindSyncStore()
    bindSessionRevokedWatcher()
    startConnectivityWatcher()
  }, [])

  // Close tab/browser → next open needs login. Reload keeps session. Idle → Shell lock screen.
  useEffect(() => {
    if (!user) return undefined
    return installSessionLifecycle({ enabled: true })
  }, [user])

  useEffect(() => {
    if (!hasSupabase) {
      if (consumeBrowserClosedFlag()) {
        void logout()
      }
      useAuthStore.setState({ booting: false })
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time boot flag
      setInitialBootDone(true)
      return
    }
    restoreSession()
      .then((sessionUser) => {
        if (sessionUser?.branchId) {
          // loadBranch paints the product/inventory stores from IndexedDB synchronously
          // before it ever touches the network, then keeps syncing in the background.
          // Don't await the network tail here — that's what used to hold the whole app
          // behind the boot skeleton for up to ~45s (catalog + branch sync timeouts) on a
          // slow connection instead of showing the last-known UI immediately.
          loadBranch(sessionUser.branchId).then((data) => {
            if (data) hydrate(data)
          })
        }
      })
      .finally(() => setInitialBootDone(true))
  }, [restoreSession, loadBranch, hydrate, logout])

  return (
    <>
      {!isLegal && <LoginIntroGate />}
      <Suspense fallback={<PageFallback />}>
        {isLegal ? (
          <Routes>
            <Route path="/legal/terms" element={<Legal />} />
            <Route path="/legal/privacy" element={<Legal />} />
            <Route path="/legal" element={<Navigate to="/legal/terms" replace />} />
            <Route path="/legal/*" element={<Navigate to="/legal/terms" replace />} />
          </Routes>
        ) : !initialBootDone ? (
          <div className="min-h-screen bg-brand-canvas px-[22px] py-6">
            <PageSkeleton variant="dashboard" />
          </div>
        ) : user ? (
          <Shell>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route
                path="/cashier-dashboard"
                element={
                  <RequireModule moduleId="cashier_dashboard">
                    <CashierDashboard />
                  </RequireModule>
                }
              />
              <Route
                path="/pos"
                element={
                  <RequireModule moduleId="pos">
                    <POS />
                  </RequireModule>
                }
              />
              <Route
                path="/transactions"
                element={
                  <RequireModule moduleId="transactions">
                    <Transactions />
                  </RequireModule>
                }
              />
              <Route
                path="/inventory"
                element={
                  <RequireModule moduleId="inventory">
                    <Products />
                  </RequireModule>
                }
              />
              <Route path="/products" element={<Navigate to="/inventory" replace />} />
              <Route
                path="/inventory/*"
                element={
                  <RequireModule moduleId="inventory">
                    <Products />
                  </RequireModule>
                }
              />
              <Route
                path="/data"
                element={
                  <RequireModule moduleId="catalog">
                    <ManagerData />
                  </RequireModule>
                }
              />
              <Route
                path="/day-end"
                element={
                  <RequireModule moduleId="day_end">
                    <DayEnd />
                  </RequireModule>
                }
              />
              <Route
                path="/settings/devices"
                element={
                  <RequireModule moduleId="devices">
                    <Devices />
                  </RequireModule>
                }
              />
              <Route path="/settings/*" element={<Settings />} />
              <Route
                path="/shifts"
                element={
                  <RequireModule moduleId="shifts">
                    <ManagerStaff />
                  </RequireModule>
                }
              />
              <Route
                path="/promos"
                element={
                  <RequireModule moduleId="manager_promos">
                    <ManagerPromos />
                  </RequireModule>
                }
              />
              <Route
                path="/manager"
                element={
                  <RequireModule moduleId="manager_overview">
                    <ManagerOverview />
                  </RequireModule>
                }
              />
              <Route
                path="/manager/branches"
                element={
                  <RequireModule moduleId="manager_branches">
                    <ManagerBranches />
                  </RequireModule>
                }
              />
              <Route
                path="/manager/branches/:branchId"
                element={
                  <RequireModule moduleId="manager_branches">
                    <ManagerBranchDashboard />
                  </RequireModule>
                }
              />
              <Route
                path="/manager/staff"
                element={
                  <RequireModule moduleId="manager_staff">
                    <ManagerStaff />
                  </RequireModule>
                }
              />
              {/* Shifts merged into Staff. Kept as a route (not deleted) so a bookmark
                  or an old link still lands somewhere useful. */}
              <Route
                path="/manager/shifts"
                element={
                  <RequireModule moduleId="shifts">
                    <ManagerStaff />
                  </RequireModule>
                }
              />
              <Route
                path="/manager/data"
                element={
                  <RequireModule moduleId="manager_data">
                    <ManagerData />
                  </RequireModule>
                }
              />
              <Route
                path="/manager/promos"
                element={
                  <RequireModule moduleId="manager_promos">
                    <ManagerPromos />
                  </RequireModule>
                }
              />
              <Route
                path="/manager/reports"
                element={
                  <RequireModule moduleId="manager_reports">
                    <ManagerReports />
                  </RequireModule>
                }
              />
              <Route
                path="/manager/announcements"
                element={
                  <RequireModule moduleId="manager_announcements">
                    <ManagerAnnouncements />
                  </RequireModule>
                }
              />
              <Route
                path="/notifications/history"
                element={
                  <RequireRole test={isSupervisorOrAbove}>
                    <NotificationHistory />
                  </RequireRole>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        ) : (
          <>
            <LoggedOutUpdateWatchdog />
            <Routes>
              <Route path="*" element={<Login />} />
            </Routes>
          </>
        )}
      </Suspense>
    </>
  )
}

/**
 * Render the application within browser-based routing and desktop-mode guidance.
 * @returns {JSX.Element} The application router and desktop-mode hint.
 */
function App() {
  return (
    <BrowserRouter>
          <AppRoutes />
    </BrowserRouter>
  )
}

export default App
