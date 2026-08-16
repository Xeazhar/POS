import { canAccessModule, isManagerRole } from '../../utils/roles'

/** Manager / master Settings tree. Devices is not here — manager/master keep it as their
 *  own separate sidebar tab (see constants/nav.js managerLinks). */
export const MANAGER_SETTINGS_SECTIONS = [
  {
    group: 'General',
    items: [
      { id: 'business', path: '/settings/general/business', label: 'Business Information' },
      { id: 'tax', path: '/settings/general/tax', label: 'Tax & VAT' },
      { id: 'receipts', path: '/settings/general/receipts', label: 'Receipts & Invoices' },
    ],
  },
  {
    group: 'Security',
    items: [
      { id: 'session', path: '/settings/security/session', label: 'Session & Auto-lock' },
      { id: 'activity', path: '/settings/security/activity', label: 'Security Activity' },
    ],
  },
  {
    group: 'Appearance',
    items: [{ id: 'appearance', path: '/settings/appearance', label: 'Appearance' }],
  },
  {
    group: 'Synchronization',
    items: [{ id: 'sync', path: '/settings/sync', label: 'Sync Status' }],
  },
  {
    group: 'About',
    items: [{ id: 'about', path: '/settings/about', label: 'CalePOS' }],
  },
]

/** Cashier / supervisor Settings tree. Devices is listed here (moduleId-gated, so only
 *  supervisors who actually have the module see it) rather than as its own sidebar tab. */
export const STAFF_SETTINGS_SECTIONS = [
  {
    group: 'My Account',
    items: [{ id: 'account', path: '/settings/account', label: 'Employee Information' }],
  },
  {
    group: 'Devices',
    items: [{ id: 'devices', path: '/settings/devices', label: 'Devices', moduleId: 'devices' }],
  },
  {
    group: 'Appearance',
    items: [{ id: 'appearance', path: '/settings/appearance', label: 'Appearance' }],
  },
  {
    group: 'Synchronization',
    items: [{ id: 'sync', path: '/settings/sync', label: 'Sync Status' }],
  },
  {
    group: 'About',
    items: [{ id: 'about', path: '/settings/about', label: 'CalePOS' }],
  },
]

export function settingsSectionsFor(user) {
  const tree = isManagerRole(user?.role) ? MANAGER_SETTINGS_SECTIONS : STAFF_SETTINGS_SECTIONS
  return tree
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.moduleId || canAccessModule(user, item.moduleId)),
    }))
    .filter((group) => group.items.length > 0)
}

export function settingsHomePath(user) {
  return settingsSectionsFor(user)[0]?.items[0]?.path || '/settings/about'
}

export function isAllowedSettingsPath(user, pathname) {
  return settingsSectionsFor(user).some((group) => group.items.some((item) => item.path === pathname))
}
