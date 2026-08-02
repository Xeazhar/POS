import { FiBarChart2, FiClipboard, FiCpu, FiGrid, FiMoon, FiPackage, FiUsers, FiMapPin, FiFileText, FiDatabase, FiCoffee } from 'react-icons/fi'

export const staffLinks = [
  ['/', 'Dashboard', FiBarChart2],
  ['/pos', 'POS', FiGrid],
  ['/transactions', 'Transactions', FiClipboard],
  ['/inventory', 'Inventory', FiPackage],
  ['/day-end', 'Day end', FiMoon],
  ['/settings/devices', 'Devices', FiCpu],
]

export function staffLinksFor(user) {
  if (user?.branchType === 'restaurant') {
    return [
      ['/', 'Dashboard', FiBarChart2],
      ['/pos', 'POS', FiGrid],
      ['/transactions', 'Sales', FiClipboard],
      ['/inventory', 'Menu', FiCoffee],
      ['/day-end', 'Day end', FiMoon],
      ['/settings/devices', 'Devices', FiCpu],
    ]
  }
  return staffLinks
}

export const managerLinks = [
  ['/', 'Overview', FiBarChart2],
  ['/manager/branches', 'Branches', FiMapPin],
  ['/manager/staff', 'Staff', FiUsers],
  ['/manager/data', 'Data', FiDatabase],
  ['/manager/reports', 'Reports', FiFileText],
]
