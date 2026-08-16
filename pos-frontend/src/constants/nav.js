import { FiBarChart2, FiBell, FiClipboard, FiCpu, FiDatabase, FiGrid, FiMoon, FiPackage, FiSettings, FiUsers, FiMapPin, FiFileText, FiCoffee, FiTag } from 'react-icons/fi'
import { canAccessModule, isManagerRole, isSupervisorOrAbove } from '../utils/roles'
import { isRestaurantBranchType } from '../utils/features'

export const staffLinks = [
  ['/', 'Dashboard', FiBarChart2, 'dashboard'],
  ['/pos', 'POS', FiGrid, 'pos'],
  ['/transactions', 'Transactions', FiClipboard, 'transactions'],
  ['/inventory', 'Inventory', FiPackage, 'inventory'],
  ['/data', 'Catalog', FiDatabase, 'catalog'],
  ['/day-end', 'Day end', FiMoon, 'day_end'], // relabelled per role in staffLinksFor
  ['/promos', 'Promos', FiTag, 'manager_promos'],
  // Shifts and Staff are one tab now — the shift log lives inside each person's row.
  ['/shifts', 'Staff', FiUsers, 'shifts'],
  ['/settings/devices', 'Devices', FiCpu, 'devices'],
]

export function staffLinksFor(user) {
  const base =
    isRestaurantBranchType(user?.branchType)
      ? [
          ['/', 'Dashboard', FiBarChart2, 'dashboard'],
          ['/pos', 'POS', FiGrid, 'pos'],
          ['/transactions', 'Sales', FiClipboard, 'transactions'],
          ['/inventory', 'Menu', FiCoffee, 'inventory'],
          ['/data', 'Catalog', FiDatabase, 'catalog'],
          ['/day-end', 'Day end', FiMoon, 'day_end'], // relabelled per role in staffLinksFor
          ['/promos', 'Promos', FiTag, 'manager_promos'],
          ['/shifts', 'Staff', FiUsers, 'shifts'],
          ['/settings/devices', 'Devices', FiCpu, 'devices'],
        ]
      : [...staffLinks]

  // Cashiers get their own operational dashboard (own-shift figures only, module
  // `cashier_dashboard`) instead of the branch-wide Dashboard at '/' (module `dashboard`,
  // never granted to cashiers by default — see DEFAULTS above).
  if (user?.role === 'cashier') {
    const dashIdx = base.findIndex(([path, , , moduleId]) => path === '/' && moduleId === 'dashboard')
    if (dashIdx >= 0) {
      const [, label, icon] = base[dashIdx]
      base[dashIdx] = ['/cashier-dashboard', label, icon, 'cashier_dashboard']
    }
  }

  // Below supervisor, /day-end is that cashier's own drawer, not the branch's day —
  // "Day end" would promise a close they cannot perform.
  if (!isSupervisorOrAbove(user?.role)) {
    const dayEndIdx = base.findIndex(([path]) => path === '/day-end')
    if (dayEndIdx >= 0) {
      const [p, , icon, moduleId] = base[dayEndIdx]
      base[dayEndIdx] = [p, 'End shift', icon, moduleId]
    }
  }

  return base.filter(([, , , moduleId]) => {
    if (!canAccessModule(user, moduleId)) return false
    // Managers already get these under the manager nav below (avoid duplicate tabs) —
    // shifts/promos/catalog all render the exact same page as their manager-nav counterpart
    // ('catalog' here and 'manager_data' below both route to Data.jsx).
    // Day end stays reachable via /day-end when a cashier requested a manager close, but
    // managers work day ops from Branch dashboard — no Day end sidebar tab.
    if (
      (moduleId === 'shifts' ||
        moduleId === 'manager_promos' ||
        moduleId === 'catalog' ||
        moduleId === 'day_end' ||
        moduleId === 'devices') &&
      isManagerRole(user.role)
    )
      return false
    return true
  })
}

export const managerLinks = [
  ['/', 'Overview', FiBarChart2, 'manager_overview'],
  ['/manager/branches', 'Branches', FiMapPin, 'manager_branches'],
  // One Staff tab: roster, module access, and each person's shift/drawer history.
  ['/manager/staff', 'Staff', FiUsers, 'manager_staff'],
  ['/manager/data', 'Data', FiDatabase, 'manager_data'],
  ['/manager/promos', 'Promos', FiTag, 'manager_promos'],
  ['/manager/reports', 'Reports', FiFileText, 'manager_reports'],
  // Nav label is short ("Notices") to fit the fixed-width sidebar rail alongside Promos/
  // Reports/Devices — the page itself still says "Announcements".
  ['/manager/announcements', 'Notices', FiBell, 'manager_announcements'],
  ['/settings/devices', 'Devices', FiCpu, 'devices'],
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
  const links = combined.filter(([path]) => {
    if (seen.has(path)) return false
    seen.add(path)
    return true
  })
  // Default last. Not a MODULES flag — every signed-in role gets Settings; the page
  // itself hides manager-only sections. Devices stays its own `/settings/devices` tab.
  // Staff may drag this (and every other tab) via SidebarNav; custom order is per login
  // on this till (`utils/navOrder.js`) and does not change staffHomePath.
  links.push(['/settings', 'Settings', FiSettings])
  return links
}

/** Sidebar Settings is active on Settings pages, but never on Devices. */
export function isSettingsNavActive(pathname) {
  if (pathname === '/settings/devices' || pathname.startsWith('/settings/devices/')) return false
  return pathname === '/settings' || pathname.startsWith('/settings/')
}

/** Default landing path after login / unknown URLs. Not the first sidebar item — custom
 *  menu order must not send a cashier to Reports because they dragged it to the top. */
export function staffHomePath(user) {
  if (!user) return '/'
  if (user.role === 'cashier') {
    // Their own operational dashboard is the intended landing screen — falls back to POS
    // only if that module was explicitly removed from this cashier's permissions.
    if (canAccessModule(user, 'cashier_dashboard')) return '/cashier-dashboard'
    if (canAccessModule(user, 'pos')) {
      return isRestaurantBranchType(user.branchType) ? '/pos?menu=1' : '/pos'
    }
  }
  const first = navLinksFor(user)[0]?.[0]
  return first || '/'
}
