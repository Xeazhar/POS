import { NavLink, useNavigate } from 'react-router-dom'
import { FiLogOut } from 'react-icons/fi'
import { managerLinks, staffLinks } from '../../constants/nav'
import { useAuthStore } from '../../stores/posStore'
import Clock from './Clock'

function Shell({ children }) {
  const user = useAuthStore((state) => state.user)
  const logout = useAuthStore((state) => state.logout)
  const navigate = useNavigate()
  const isManager = user?.role === 'manager' || user?.role === 'admin'
  const links = isManager ? managerLinks : staffLinks

  return (
    <div className="min-h-screen bg-brand-canvas">
      <header className="flex h-[62px] items-center justify-between bg-brand-dark px-6 text-white max-[700px]:px-4">
        <div>
          <div className="text-[21px] font-bold tracking-[-0.5px]">
            <span className="mr-2 inline-grid h-[31px] w-[31px] place-items-center rounded-lg bg-brand-gold text-brand-dark">
              C
            </span>
            CalePOS
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <small className="text-[11px] font-semibold text-brand-gold">
            {user?.branchName || 'Bayombong Branch #001'}
          </small>
          <Clock />
        </div>
        <div className="flex items-center gap-2.5 text-[13px]">
          <div className="grid h-[35px] w-[35px] place-items-center rounded-full bg-brand-gold font-bold text-brand-dark">
            {user?.name?.[0] || 'A'}
          </div>
          <div className="max-[700px]:hidden">
            <strong className="block">{user?.name}</strong>
            <small className="mt-[3px] block text-[10px] text-brand-soft capitalize">{user?.role || 'staff'}</small>
          </div>
          <button
            className="ml-[15px] border-0 bg-transparent text-lg text-inherit"
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
