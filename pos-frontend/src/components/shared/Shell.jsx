import { NavLink, useNavigate } from 'react-router-dom'
import { FiLogOut } from 'react-icons/fi'
import { managerLinks, staffLinks } from '../../constants/nav'
import { useAuthStore } from '../../stores/posStore'
import { useSyncStore } from '../../stores/syncStore'
import Clock from './Clock'

function syncCopy({ online, pending, status, lastError }) {
  const syncing = status === 'syncing' || status === 'pushing'
  if (!online) {
    return {
      label: pending ? `Offline · ${pending}` : 'Offline',
      detail: pending ? `${pending} saved locally` : 'No network',
      tone: 'off',
    }
  }
  if (syncing) {
    return {
      label: 'Syncing…',
      detail: pending ? `${pending} queued` : 'Updating',
      tone: 'sync',
    }
  }
  if (pending) {
    return {
      label: `${pending} queued`,
      detail: 'Waiting to sync',
      tone: 'warn',
    }
  }
  if (status === 'error' || lastError) {
    return {
      label: 'Sync issue',
      detail: String(lastError || 'Retrying').slice(0, 28),
      tone: 'warn',
    }
  }
  return {
    label: 'Synced',
    detail: 'Up to date',
    tone: 'ok',
  }
}

const toneDot = {
  ok: 'bg-[#6f9b78]',
  sync: 'bg-[#7a9cc8] animate-pulse',
  warn: 'bg-[#c9a45a]',
  off: 'bg-[#c48978]',
}

const toneText = {
  ok: 'text-[#6f9b78]',
  sync: 'text-[#5a7fa8]',
  warn: 'text-[#a8843a]',
  off: 'text-[#a86a5a]',
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
  const sync = syncCopy({ online, pending, status, lastError })

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
          <Clock className="text-[12px]" />
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

      <div className="flex h-[calc(100vh-62px)]">
        <aside className="flex w-[88px] flex-col overflow-hidden bg-brand-panel px-3 py-[25px] max-[700px]:w-[62px] max-[700px]:px-1.5 max-[700px]:py-3">
          {isManager && (
            <div className="mb-3 text-center text-[9px] tracking-wide text-[#7c827f] uppercase max-[700px]:hidden">
              Manager
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto">
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
          </div>

          <div
            className="mt-2 shrink-0 rounded-lg bg-[#e8e9e4] px-1.5 py-2.5 text-center max-[700px]:px-1"
            title={lastError || sync.detail}
          >
            <span className={`mx-auto mb-1 block h-1.5 w-1.5 rounded-full ${toneDot[sync.tone]}`} />
            <strong className={`block text-[9px] font-bold leading-tight ${toneText[sync.tone]}`}>
              {sync.label}
            </strong>
            <span className="mt-0.5 hidden text-[8px] leading-tight text-[#8a908c] max-[700px]:hidden min-[701px]:block">
              {sync.detail}
            </span>
          </div>
        </aside>

        <section className="min-h-0 min-w-0 flex-1 overflow-auto px-[22px] py-3.5 max-[700px]:px-3.5 max-[700px]:py-[22px]">
          {children}
        </section>
      </div>
    </div>
  )
}

export default Shell
