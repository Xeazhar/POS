import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Shell from './components/shared/Shell'
import { PageSkeleton } from './components/ui'
import { useAppVersion } from './hooks/useAppVersion'
import { useBranchHeartbeat } from './hooks/useBranchHeartbeat'
import { hasSupabase } from './lib/api'
import { startConnectivityWatcher } from './offline'
import { installSessionLifecycle, consumeBrowserClosedFlag } from './offline/sessionLifecycle'
import { useAuthStore, useInventoryStore, useProductStore } from './stores/posStore'
import { bindSyncStore } from './stores/syncStore'
import { canAccessModule } from './utils/roles'
import { staffHomePath } from './constants/nav'

const Login = lazy(() => import('./pages/Login.jsx'))
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'))
const POS = lazy(() => import('./pages/POS.jsx'))
const Transactions = lazy(() => import('./pages/Transactions.jsx'))
const Products = lazy(() => import('./pages/Products.jsx'))
const DayEnd = lazy(() => import('./pages/DayEnd.jsx'))
const Devices = lazy(() => import('./pages/Devices.jsx'))
const Shifts = lazy(() => import('./pages/Shifts.jsx'))
const ManagerOverview = lazy(() => import('./pages/manager/Overview.jsx'))
const ManagerBranches = lazy(() => import('./pages/manager/Branches.jsx'))
const ManagerBranchDashboard = lazy(() => import('./pages/manager/BranchDashboard.jsx'))
const ManagerStaff = lazy(() => import('./pages/manager/Staff.jsx'))
const ManagerData = lazy(() => import('./pages/manager/Data.jsx'))
const ManagerPromos = lazy(() => import('./pages/manager/Promos.jsx'))
const ManagerReports = lazy(() => import('./pages/manager/Reports.jsx'))

function PageFallback() {
  return <PageSkeleton variant="table" className="px-1 py-2" />
}

/**
 * Keeps the build fresh while nobody is signed in.
 *
 * This is the most valuable place in the app to apply an update and the only one that had
 * no watchdog: the terminal sits on the login screen all night and between shifts, and
 * Shell — which owns the other watchdog — isn't mounted then. So a shop that never closed
 * its browser could open on a week-old bundle every morning.
 *
 * Signed out there is no cart, no open shift and no unsynced work on screen, so it
 * reloads on its own without asking. Rendered as a component rather than a hook call in
 * App so the poll only runs while logged out, instead of duplicating Shell's.
 */
function LoggedOutUpdateWatchdog() {
  useAppVersion({ safeToReload: true, autoReload: true })
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

function Home() {
  const user = useAuthStore((state) => state.user)
  const first = firstHomePath(user)
  // Cashiers / anyone whose home isn't "/" — send them to their first screen
  if (first && first !== '/') return <Navigate to={first} replace />
  if (canAccessModule(user, 'manager_overview')) return <ManagerOverview />
  return <Dashboard />
}

function App() {
  const user = useAuthStore((state) => state.user)
  const booting = useAuthStore((state) => state.booting)
  const restoreSession = useAuthStore((state) => state.restoreSession)
  const logout = useAuthStore((state) => state.logout)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const loadBranch = useProductStore((state) => state.loadBranch)

  useBranchHeartbeat(user)

  useEffect(() => {
    bindSyncStore()
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
      return
    }
    restoreSession().then(async (sessionUser) => {
      if (sessionUser?.branchId) {
        const data = await loadBranch(sessionUser.branchId)
        if (data) hydrate(data)
      }
    })
  }, [restoreSession, loadBranch, hydrate, logout])

  return (
    <BrowserRouter>
      <Suspense fallback={<PageFallback />}>
        {booting ? (
          <div className="min-h-screen bg-brand-canvas px-[22px] py-6">
            <PageSkeleton variant="dashboard" />
          </div>
        ) : user ? (
          <Shell>
            <Routes>
              <Route path="/" element={<Home />} />
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
              <Route
                path="/shifts"
                element={
                  <RequireModule moduleId="shifts">
                    <Shifts />
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
              <Route
                path="/manager/shifts"
                element={
                  <RequireModule moduleId="shifts">
                    <Shifts />
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
    </BrowserRouter>
  )
}

export default App
