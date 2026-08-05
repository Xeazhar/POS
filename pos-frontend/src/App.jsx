import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import Shell from './components/shared/Shell'
import { useBranchHeartbeat } from './hooks/useBranchHeartbeat'
import { hasSupabase } from './lib/api'
import { startConnectivityWatcher } from './offline'
import {
  Dashboard,
  DayEnd,
  Devices,
  Login,
  ManagerBranchDashboard,
  ManagerBranches,
  ManagerData,
  ManagerOverview,
  ManagerReports,
  ManagerStaff,
  ManagerPromos,
  POS,
  Products,
  Shifts,
  Transactions,
} from './pages'
import { useAuthStore, useInventoryStore, useProductStore } from './stores/posStore'
import { bindSyncStore } from './stores/syncStore'
import { canAccessModule, isManagerRole, isSupervisorOrAbove } from './utils/roles'
import { staffHomePath } from './constants/nav'

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
  const restoreSession = useAuthStore((state) => state.restoreSession)
  const hydrate = useInventoryStore((state) => state.hydrate)
  const loadBranch = useProductStore((state) => state.loadBranch)

  useBranchHeartbeat(user)

  useEffect(() => {
    bindSyncStore()
    startConnectivityWatcher()
  }, [])

  useEffect(() => {
    if (!hasSupabase) return
    restoreSession().then(async (sessionUser) => {
      if (sessionUser?.branchId) {
        const data = await loadBranch(sessionUser.branchId)
        if (data) hydrate(data)
      }
    })
  }, [restoreSession, loadBranch, hydrate])

  return (
    <BrowserRouter>
      {user ? (
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
                    <Shifts />
                  </RequireModule>
                </StaffOnly>
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
                <SupervisorOrAboveOnly>
                  <RequireModule moduleId="manager_promos">
                    <ManagerPromos />
                  </RequireModule>
                </SupervisorOrAboveOnly>
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
            <Route path="/reports" element={<Navigate to="/manager/reports" replace />} />
            <Route path="*" element={<HomeRedirect />} />
          </Routes>
        </Shell>
      ) : (
        <Routes>
          <Route path="*" element={<Login />} />
        </Routes>
      )}
    </BrowserRouter>
  )
}

function HomeRedirect() {
  const user = useAuthStore((state) => state.user)
  return <Navigate to={firstHomePath(user)} replace />
}

export default App
