import { Navigate, NavLink, useLocation } from 'react-router-dom'
import { PageHeader } from '../components/ui'
import { useAuthStore } from '../stores/posStore'
import { BusinessInformationPanel, ReceiptsInvoicesPanel, TaxVatPanel } from './settings/GeneralPanels'
import { SecurityActivityPanel, SessionLockPanel } from './settings/SecurityPanels'
import { AboutPanel, AppearancePanel, MyAccountPanel, SyncStatusPanel } from './settings/SharedPanels'
import { isAllowedSettingsPath, settingsHomePath, settingsSectionsFor } from './settings/sections'

const PANELS = {
  '/settings/account': MyAccountPanel,
  '/settings/general/business': BusinessInformationPanel,
  '/settings/general/tax': TaxVatPanel,
  '/settings/general/receipts': ReceiptsInvoicesPanel,
  '/settings/security/session': SessionLockPanel,
  '/settings/security/activity': SecurityActivityPanel,
  '/settings/appearance': AppearancePanel,
  '/settings/sync': SyncStatusPanel,
  '/settings/about': AboutPanel,
}

function Settings() {
  const user = useAuthStore((s) => s.user)
  const { pathname } = useLocation()
  const sections = settingsSectionsFor(user)
  const home = settingsHomePath(user)

  if (pathname === '/settings' || pathname === '/settings/') {
    return <Navigate to={home} replace />
  }
  if (!isAllowedSettingsPath(user, pathname)) {
    return <Navigate to={home} replace />
  }

  const Panel = PANELS[pathname]
  const current = sections
    .flatMap((g) => g.items)
    .find((item) => item.path === pathname)

  return (
    <div>
      <PageHeader eyebrow="SETTINGS" title={current?.label || 'Settings'} />
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-4 max-[800px]:grid-cols-1">
        <nav aria-label="Settings sections" className="min-w-0 rounded-[10px] border border-brand-line bg-brand-card py-1">
          {sections.map((group, index) => (
            <div
              key={group.group}
              className={index === 0 ? '' : 'border-t border-brand-softline'}
            >
              <p className="m-0 cursor-default select-none px-4 pb-1 pt-3 text-[9px] font-bold tracking-[0.14em] text-brand-subtle uppercase">
                {group.group}
              </p>
              <ul className="m-0 list-none px-2 pb-2">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <NavLink
                      to={item.path}
                      className={({ isActive }) =>
                        `block cursor-pointer rounded-md px-2.5 py-2 text-[13px] no-underline ${
                          isActive
                            ? 'bg-brand-gold font-bold text-brand-on-gold'
                            : 'font-medium text-brand-ink hover:bg-brand-n50'
                        }`
                      }
                    >
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0">{Panel ? <Panel /> : null}</div>
      </div>
    </div>
  )
}

export default Settings
