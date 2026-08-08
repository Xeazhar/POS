import { FiBarChart2, FiClipboard, FiClock, FiCpu, FiDatabase, FiGrid, FiMoon, FiPackage, FiUsers, FiMapPin, FiFileText, FiCoffee, FiTag } from 'react-icons/fi'
import { canAccessModule, isManagerRole } from '../utils/roles'

export const staffLinks = [
  ['/', 'Dashboard', FiBarChart2, 'dashboard'],
  ['/pos', 'POS', FiGrid, 'pos'],
  ['/transactions', 'Transactions', FiClipboard, 'transactions'],
  ['/inventory', 'Inventory', FiPackage, 'inventory'],
  ['/data', 'Catalog', FiDatabase, 'catalog'],
  ['/day-end', 'Day end', FiMoon, 'day_end'],
  ['/promos', 'Promos', FiTag, 'manager_promos'],
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
          ['/data', 'Catalog', FiDatabase, 'catalog'],
          ['/day-end', 'Day end', FiMoon, 'day_end'],
          ['/promos', 'Promos', FiTag, 'manager_promos'],
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
    // Managers already get these under the manager nav below (avoid duplicate tabs) —
    // shifts/promos share a moduleId with their manager-nav counterpart.
    if ((moduleId === 'shifts' || moduleId === 'manager_promos') && isManagerRole(user.role)) return false
    return true
  })
}

export const managerLinks = [
  ['/', 'Overview', FiBarChart2, 'manager_overview'],
  ['/manager/branches', 'Branches', FiMapPin, 'manager_branches'],
  ['/manager/staff', 'Staff', FiUsers, 'manager_staff'],
  ['/manager/shifts', 'Shifts', FiClock, 'shifts'],
  ['/manager/data', 'Data', FiDatabase, 'manager_data'],
  ['/manager/promos', 'Promos', FiTag, 'manager_promos'],
  ['/manager/reports', 'Reports', FiFileText, 'manager_reports'],
]

export function managerLinksFor(user) {
  // This is the manager-nav section specifically — supervisors reach the same
  // pages (shifts, promos) through their staff-nav paths (/shifts, /promos)
  // above, not through /manager/*, even though they share a moduleId.
  if (!isManagerRole(user?.role)) return []
  return managerLinks.filter(([, , , moduleId]) => canAccessModule(user, moduleId))
}

export function navLinksFor(user) {
  if (!user) return []
  const staff = staffLinksFor(user)
  const mgr = managerLinksFor(user)
  const seen = new Set()
  const combined = [...mgr, ...staff]
  return combined.filter(([path]) => {
    if (seen.has(path)) return false
    seen.add(path)
    return true
  })
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
