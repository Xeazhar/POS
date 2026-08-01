import { NavLink, useNavigate } from 'react-router-dom'
import { FiLogOut } from 'react-icons/fi'
import { managerLinks, staffLinks } from '../../constants/nav'
import { useAuthStore } from '../../stores/posStore'
import { useSyncStore } from '../../stores/syncStore'
import Clock from './Clock'

function SyncPill({ online, pending, status, lastError }) {
  const syncing = status === 'syncing' || status === 'pushing'
  let label = 'Online'
  let title = 'Synced'
  let tone = 'ok'

  if (!online) {
    label = pending ? `Offline · ${pending}` : 'Offline'
    title = pending
      ? `Offline — ${pending} action(s) waiting to sync`
      : 'Offline'
    tone = 'off'
  } else if (syncing) {
    label = pending ? `Syncing · ${pending}` : 'Syncing…'
    title = pending ? `Uploading ${pending} queued action(s)…` : 'Syncing with server…'
    tone = 'sync'
  } else if (pending) {
    label = `${pending} queued`
    title = `${pending} action(s) waiting to sync`
    tone = 'warn'
  } else if (lastError) {
    label = 'Sync issue'
    title = lastError
    tone = 'warn'
  } else if (status === 'error') {
    label = 'Sync issue'
    title = lastError || 'Last sync failed'
    tone = 'warn'
  } else {
    label = 'Synced'
    title = 'All changes synced'
    tone = 'ok'
  }

  const tones = {
    ok: 'bg-[#2a332c] text-[#9dcea8]',
    sync: 'bg-[#2a3038] text-[#a8c4e8]',
    warn: 'bg-[#3d3830] text-[#e8c47a]',
    off: 'bg-[#3a2e2a] text-[#e8b4a0]',
  }
  const dots = {
    ok: 'bg-[#9dcea8]',
    sync: 'bg-[#a8c4e8] animate-pulse',
    warn: 'bg-[#e8c47a]',
    off: 'bg-[#e8b4a0]',
  }

  return (
    <span title={title} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide ${tones[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dots[tone]}`} />
      {label}
    </span>
  )
}

function Shell({ children }) {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const online = useSyncStore((state) => state.online)
  const pending = useSyncStore((state) => state.pending)
  const status = useSyncStore((state) => state.status)
  const lastError = useSyncStore((state) => state.lastError)
  const navigate = useNavigate()
  const isManager = user?.role === 'manager' || user?.role === 'admin'
  const links = isManager ? managerLinks : staffLinks
  const syncing = status === 'syncing' || status === 'pushing'

  return (
    <div className="min-h-screen bg-brand-canvas">
      <header className="flex h-[62px] items-center justify-between gap-3 bg-brand-dark px-6 text-white max-[700px]:px-4">
        <div className="min-w-0 shrink-0">
          <div className="flex items-center text-[21px] font-bold tracking-[-0.5px]">
            <span className="mr-2 inline-grid h-[31px] w-[31px] place-items-center rounded-lg bg-brand-gold text-brand-dark">
              C
            </span>
            <span className="max-[700px]:hidden">CalePOS</span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2">
          <small className="max-w-full truncate text-[11px] font-semibold text-brand-gold">
            {user?.branchName || 'Bayombong Branch #001'}
          </small>
          <div className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[12px]">
            <Clock className="text-[12px]" />
            <span className="hidden text-[#6d7470] min-[480px]:inline">·</span>
            <SyncPill online={online} pending={pending} status={status} lastError={lastError} />
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5 text-[13px]">
          <div className="grid h-[35px] w-[35px] place-items-center rounded-full bg-brand-gold font-bold text-brand-dark">
            {user?.name?.[0] || 'A'}
          </div>
          <div className="max-[700px]:hidden">
            <strong className="block">{user?.name}</strong>
            <small className="mt-[3px] block text-[10px] text-brand-soft capitalize">{user?.role || 'staff'}</small>
          </div>
          <button
            className="ml-1 border-0 bg-transparent text-lg text-inherit"
            title="Sign out"
            onClick={async () => {
              await logout()
              navigate('/login')
            }}
          >
            <FiLogOut />
          </button>
        </div>
      </header>
      {syncing && (
        <div className="bg-[#2a3038] px-4 py-1.5 text-center text-[11px] font-bold tracking-wide text-[#a8c4e8]">
          Syncing{pending ? ` ${pending} queued change${pending === 1 ? '' : 's'}` : ''}… Please keep the app open.
        </div>
      )}
      {!syncing && !online && pending > 0 && (
        <div className="bg-[#3a2e2a] px-4 py-1.5 text-center text-[11px] font-bold tracking-wide text-[#e8b4a0]">
          Offline — {pending} change{pending === 1 ? '' : 's'} saved on this device. Will sync when back online.
        </div>
      )}
      <div className={`flex ${syncing || (!online && pending > 0) ? 'h-[calc(100vh-62px-32px)]' : 'h-[calc(100vh-62px)]'}`}>
        <aside className="w-[88px] overflow-auto bg-brand-panel px-3 py-[25px] max-[700px]:w-[62px] max-[700px]:px-1.5 max-[700px]:py-3">
          {isManager && (
            <div className="mb-3 text-center text-[9px] tracking-wide text-[#7c827f] uppercase max-[700px]:hidden">
              Manager
            </div>
          )}
          {links.map(([path, label, Icon]) => (
            <NavLink
              key={path}
              to={path}
              end={path === '/'}
              className={({ isActive }) =>
                `mb-2 grid justify-items-center gap-2 rounded-lg px-1 py-4 text-[10px] no-underline ${
                  isActive ? 'bg-brand-gold text-brand-dark' : 'text-[#9da4a1]'
                }`
              }
            >
              <Icon className="text-xl" />
              <span className="max-[700px]:hidden">{label}</span>
            </NavLink>
          ))}
        </aside>
        <section className="min-h-0 min-w-0 flex-1 overflow-auto px-[22px] py-3.5 max-[700px]:px-3.5 max-[700px]:py-[22px]">
          {children}
        </section>
      </div>
    </div>
  )
}

export default Shell
