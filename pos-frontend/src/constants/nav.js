import { FiBarChart2, FiClipboard, FiGrid, FiMoon, FiPackage, FiUsers, FiMapPin, FiFileText, FiDatabase } from 'react-icons/fi'

export const staffLinks = [
  ['/', 'Dashboard', FiBarChart2],
  ['/pos', 'POS', FiGrid],
  ['/transactions', 'Transactions', FiClipboard],
  ['/inventory', 'Inventory', FiPackage],
  ['/day-end', 'Day end', FiMoon],
]

export const managerLinks = [
  ['/', 'Overview', FiBarChart2],
  ['/manager/branches', 'Branches', FiMapPin],
  ['/manager/staff', 'Staff', FiUsers],
  ['/manager/data', 'Data', FiDatabase],
  ['/manager/reports', 'Reports', FiFileText],
]
