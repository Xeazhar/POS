/** Role helpers + default module permissions */

export const ROLES = {
  cashier: 'cashier',
  supervisor: 'supervisor',
  manager: 'manager',
  admin: 'admin',
  master: 'master',
}

export const MODULES = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'pos', label: 'POS' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'inventory', label: 'Inventory / Menu' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'day_end', label: 'Day end' },
  { id: 'devices', label: 'Devices' },
  { id: 'shifts', label: 'Shifts' },
  { id: 'manager_overview', label: 'Manager overview' },
  { id: 'manager_branches', label: 'Branches' },
  { id: 'manager_staff', label: 'Staff' },
  { id: 'manager_data', label: 'Data' },
  { id: 'manager_promos', label: 'Promos' },
  { id: 'manager_reports', label: 'Reports' },
]

const DEFAULTS = {
  cashier: ['dashboard', 'pos', 'transactions', 'inventory', 'day_end', 'devices'],
  supervisor: [
    'dashboard',
    'pos',
    'transactions',
    'inventory',
    'catalog',
    'day_end',
    'devices',
    'shifts',
    'manager_promos',
  ],
  manager: [
    'manager_overview',
    'manager_branches',
    'manager_staff',
    'manager_data',
    'manager_promos',
    'manager_reports',
    'shifts',
  ],
  admin: [
    'manager_overview',
    'manager_branches',
    'manager_staff',
    'manager_data',
    'manager_promos',
    'manager_reports',
    'shifts',
  ],
  master: [
    'dashboard',
    'pos',
    'transactions',
    'inventory',
    'catalog',
    'day_end',
    'devices',
    'shifts',
    'manager_overview',
    'manager_branches',
    'manager_staff',
    'manager_data',
    'manager_promos',
    'manager_reports',
  ],
}

export function isManagerRole(role) {
  return role === 'manager' || role === 'admin' || role === 'master'
}

export function isSupervisorOrAbove(role) {
  return role === 'supervisor' || isManagerRole(role)
}

export function usesPinLogin(role) {
  return role === 'cashier' || role === 'supervisor'
}

export function defaultPermissionsFor(role) {
  return [...(DEFAULTS[role] || DEFAULTS.cashier)]
}

export function effectivePermissions(user) {
  if (!user) return []
  if (Array.isArray(user.permissions)) return user.permissions
  return defaultPermissionsFor(user.role)
}

export function canAccessModule(user, moduleId) {
  if (!user) return false
  if (user.role === 'master' || user.role === 'admin') return true
  return effectivePermissions(user).includes(moduleId)
}

export function pinAuthEmail(loginCode, branchId) {
  const code = String(loginCode || '').replace(/\D/g, '')
  const branch = String(branchId || 'x').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8)
  return `pin.${code}.${branch}@calepos.local`
}
