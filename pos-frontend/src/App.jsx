import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Shell from './components/shared/Shell'
import { PageSkeleton } from './components/ui'
import { useBranchHeartbeat } from './hooks/useBranchHeartbeat'
import { hasSupabase } from './lib/api'
import { startConnectivityWatcher } from './offline'
import { installSessionLifecycle, consumeBrowserClosedFlag } from './offline/sessionLifecycle'
import { useAuthStore, useInventoryStore, useProductStore } from './stores/posStore'
import { bindSyncStore } from './stores/syncStore'
import { canAccessModule, isManagerRole, isSupervisorOrAbove } from './utils/roles'
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

function ManagerOnly({ children }) {
  const user = useAuthStore((state) => state.user)
  if (!isManagerRole(user?.role)) return <Navigate to={firstHomePath(user)} replace />
  return children
}

function SupervisorOrAboveOnly({ children }) {
  const user = useAuthStore((state) => state.user)
  if (!isSupervisorOrAbove(user?.role)) return <Navigate to={firstHomePath(user)} replace />
  return children
}

function StaffOnly({ children }) {
  const user = useAuthStore((state) => state.user)
  // Managers (except master) stay in manager shell; cashiers/supervisors/master can use staff routes
  if (isManagerRole(user?.role) && user?.role !== 'master') {
    return <Navigate to={firstHomePath(user)} replace />
  }
  return children
}

function SupervisorOnly({ children }) {
  const user = useAuthStore((state) => state.user)
  if (user?.role !== 'supervisor' && user?.role !== 'master') {
    return <Navigate to={firstHomePath(user)} replace />
  }
  return children
}

function Home() {
  const user = useAuthStore((state) => state.user)
  const first = firstHomePath(user)
  // Cashiers / anyone whose home isn't "/" — send them to their first screen
  if (first && first !== '/') return <Navigate to={first} replace />
  if (isManagerRole(user?.role) && user?.role !== 'master') return <ManagerOverview />
  if (user?.role === 'master' && canAccessModule(user, 'manager_overview')) return <ManagerOverview />
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
                  <StaffOnly>
                    <RequireModule moduleId="pos">
                      <POS />
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route
                path="/transactions"
                element={
                  <StaffOnly>
                    <RequireModule moduleId="transactions">
                      <Transactions />
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route
                path="/inventory"
                element={
                  <StaffOnly>
                    <RequireModule moduleId="inventory">
                      <Products />
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route path="/products" element={<Navigate to="/inventory" replace />} />
              <Route
                path="/inventory/*"
                element={
                  <StaffOnly>
                    <RequireModule moduleId="inventory">
                      <Products />
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route
                path="/data"
                element={
                  <StaffOnly>
                    <RequireModule moduleId="catalog">
                      <ManagerData />
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route
                path="/day-end"
                element={
                  <StaffOnly>
                    <RequireModule moduleId="day_end">
                      <DayEnd />
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route
                path="/settings/devices"
                element={
                  <StaffOnly>
                    <RequireModule moduleId="devices">
                      <Devices />
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route
                path="/shifts"
                element={
                  <StaffOnly>
                    <RequireModule moduleId="shifts">
                      <SupervisorOrAboveOnly>
                        <Shifts />
                      </SupervisorOrAboveOnly>
                    </RequireModule>
                  </StaffOnly>
                }
              />
              <Route
                path="/promos"
                element={
                  <StaffOnly>
                    <SupervisorOnly>
                      <ManagerPromos />
                    </SupervisorOnly>
                  </StaffOnly>
                }
              />
              <Route
                path="/manager"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="manager_overview">
                      <ManagerOverview />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route
                path="/manager/branches"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="manager_branches">
                      <ManagerBranches />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route
                path="/manager/branches/:branchId"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="manager_branches">
                      <ManagerBranchDashboard />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route
                path="/manager/staff"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="manager_staff">
                      <ManagerStaff />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route
                path="/manager/shifts"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="shifts">
                      <Shifts />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route
                path="/manager/data"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="manager_data">
                      <ManagerData />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route
                path="/manager/promos"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="manager_promos">
                      <ManagerPromos />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route
                path="/manager/reports"
                element={
                  <ManagerOnly>
                    <RequireModule moduleId="manager_reports">
                      <ManagerReports />
                    </RequireModule>
                  </ManagerOnly>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        ) : (
          <Routes>
            <Route path="*" element={<Login />} />
          </Routes>
        )}
      </Suspense>
    </BrowserRouter>
  )
}

export default App
