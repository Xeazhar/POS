import { FiBarChart2, FiClipboard, FiClock, FiCpu, FiDatabase, FiGrid, FiMoon, FiPackage, FiUsers, FiMapPin, FiFileText, FiCoffee } from 'react-icons/fi'
import { canAccessModule, isManagerRole } from '../utils/roles'

export const staffLinks = [
  ['/', 'Dashboard', FiBarChart2, 'dashboard'],
  ['/pos', 'POS', FiGrid, 'pos'],
  ['/transactions', 'Transactions', FiClipboard, 'transactions'],
  ['/inventory', 'Inventory', FiPackage, 'inventory'],
  ['/data', 'Catalog', FiDatabase, 'inventory'],
  ['/day-end', 'Day end', FiMoon, 'day_end'],
  ['/shifts', 'Shifts', FiClock, 'shifts'],
  ['/settings/devices', 'Devices', FiCpu, 'devices'],
]

export function staffLinksFor(user) {
  const base =
    user?.branchType === 'restaurant'
      ? [
          ['/', 'Dashboard', FiBarChart2, 'dashboard'],
          ['/pos', 'POS', FiGrid, 'pos'],
          ['/transactions', 'Sales', FiClipboard, 'transactions'],
          ['/inventory', 'Menu', FiCoffee, 'inventory'],
          ['/data', 'Catalog', FiDatabase, 'inventory'],
          ['/day-end', 'Day end', FiMoon, 'day_end'],
          ['/shifts', 'Shifts', FiClock, 'shifts'],
          ['/settings/devices', 'Devices', FiCpu, 'devices'],
        ]
      : [...staffLinks]

  // Cashiers land on POS first
  if (user?.role === 'cashier') {
    const posIdx = base.findIndex(([path]) => path === '/pos')
    if (posIdx > 0) {
      const [pos] = base.splice(posIdx, 1)
      base.unshift(pos)
    }
  }

  return base.filter(([path, , , moduleId]) => {
    if (!canAccessModule(user, moduleId)) return false
    // Managers/master already have Shifts under manager nav
    if (moduleId === 'shifts' && isManagerRole(user.role)) return false
    // Add/import catalog is supervisor+ only (cashiers keep Inventory for stock view)
    if (path === '/data' && user?.role !== 'supervisor' && user?.role !== 'master') return false
    return true
  })
}

export const managerLinks = [
  ['/', 'Overview', FiBarChart2, 'manager_overview'],
  ['/manager/branches', 'Branches', FiMapPin, 'manager_branches'],
  ['/manager/staff', 'Staff', FiUsers, 'manager_staff'],
  ['/manager/shifts', 'Shifts', FiClock, 'shifts'],
  ['/manager/data', 'Data', FiDatabase, 'manager_data'],
  ['/manager/reports', 'Reports', FiFileText, 'manager_reports'],
]

export function managerLinksFor(user) {
  return managerLinks.filter(([, , , moduleId]) => canAccessModule(user, moduleId))
}

export function navLinksFor(user) {
  if (!user) return []
  if (user.role === 'master') {
    const staff = staffLinksFor(user)
    const mgr = managerLinksFor(user)
    // Avoid duplicate "/"
    return [...mgr, ...staff.filter(([path]) => path !== '/')]
  }
  if (isManagerRole(user.role)) return managerLinksFor(user)
  return staffLinksFor(user)
}

/** Default landing path after login / unknown URLs */
export function staffHomePath(user) {
  if (!user) return '/'
  // Cashiers open POS when they have access
  if (user.role === 'cashier' && canAccessModule(user, 'pos')) {
    return user.branchType === 'restaurant' ? '/pos?menu=1' : '/pos'
  }
  const first = navLinksFor(user)[0]?.[0]
  return first || '/'
}
