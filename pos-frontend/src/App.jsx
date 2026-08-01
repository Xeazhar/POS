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
  POS,
  Products,
  Transactions,
} from './pages'
import { useAuthStore, useInventoryStore, useProductStore } from './stores/posStore'
import { bindSyncStore } from './stores/syncStore'

function useIsManager() {
  const role = useAuthStore((state) => state.user?.role)
  return role === 'manager' || role === 'admin'
}

function ManagerOnly({ children }) {
  const isManager = useIsManager()
  if (!isManager) return <Navigate to="/" replace />
  return children
}

function StaffOnly({ children }) {
  const isManager = useIsManager()
  if (isManager) return <Navigate to="/" replace />
  return children
}

function Home() {
  const isManager = useIsManager()
  return isManager ? <ManagerOverview /> : <Dashboard />
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
            <Route path="/pos" element={<StaffOnly><POS /></StaffOnly>} />
            <Route path="/transactions" element={<StaffOnly><Transactions /></StaffOnly>} />
            <Route path="/inventory" element={<StaffOnly><Products /></StaffOnly>} />
            <Route path="/products" element={<Navigate to="/inventory" replace />} />
            <Route path="/inventory/*" element={<StaffOnly><Products /></StaffOnly>} />
            <Route path="/day-end" element={<StaffOnly><DayEnd /></StaffOnly>} />
            <Route path="/settings/devices" element={<StaffOnly><Devices /></StaffOnly>} />
            <Route path="/manager/branches" element={<ManagerOnly><ManagerBranches /></ManagerOnly>} />
            <Route path="/manager/branches/:branchId" element={<ManagerOnly><ManagerBranchDashboard /></ManagerOnly>} />
            <Route path="/manager/staff" element={<ManagerOnly><ManagerStaff /></ManagerOnly>} />
            <Route path="/manager/data" element={<ManagerOnly><ManagerData /></ManagerOnly>} />
            <Route path="/manager/reports" element={<ManagerOnly><ManagerReports /></ManagerOnly>} />
            <Route path="/reports" element={<Navigate to="/manager/reports" replace />} />
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

export default App
