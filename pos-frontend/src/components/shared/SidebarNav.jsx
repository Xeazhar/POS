import { useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { FiCheck, FiMove, FiRotateCcw } from 'react-icons/fi'
import { isSettingsNavActive } from '../../constants/nav'
import { moveNavPath } from '../../utils/navOrder'

const rowClass = (active, reorderMode, isPlaceholder) =>
  `mb-2 grid w-full justify-items-center gap-1.5 overflow-hidden rounded-lg px-1 py-3 text-[10px] leading-tight no-underline transition-[background-color,color,box-shadow,transform,opacity] duration-150 max-[700px]:mb-0 max-[700px]:flex max-[700px]:items-center max-[700px]:justify-start max-[700px]:gap-3 max-[700px]:px-3 max-[700px]:py-3 max-[700px]:text-xs compact:mb-0 compact:flex compact:items-center compact:justify-start compact:gap-3 compact:px-3 compact:py-3 compact:text-xs ${
    isPlaceholder
      ? 'border border-dashed border-brand-gold/50 bg-brand-gold/10 opacity-40'
      : ''
  } ${
    reorderMode && !isPlaceholder
      ? 'cursor-grab touch-none select-none active:cursor-grabbing'
      : !reorderMode
        ? 'active:scale-[0.96] active:bg-brand-dark-active'
        : ''
  } ${
    isPlaceholder
      ? 'text-transparent'
      : active
        ? 'bg-brand-gold text-brand-on-gold'
        : 'text-brand-ondark-dim hover:bg-brand-dark-hover hover:text-brand-ondark'
  }`

function NavIconLabel({ Icon, label, iconOnly }) {
  return (
    <>
      <Icon className="text-xl shrink-0" />
      {!iconOnly && (
        <span className="max-w-full break-words text-center max-[700px]:inline max-[700px]:text-left compact:inline compact:text-left">
          {label}
        </span>
      )}
    </>
  )
}

export default function SidebarNav({
  links,
  collapsed: iconOnly = false,
  onNavigate,
  onReorder,
  onReset,
  onRequestExpand,
}) {
  const location = useLocation()
  const listRef = useRef(null)
  const [reorderMode, setReorderMode] = useState(false)
  const [dragIndex, setDragIndex] = useState(null)
  const [ghost, setGhost] = useState(null)
  const dragOriginRef = useRef(null)

  const clearDrag = () => {
    setDragIndex(null)
    setGhost(null)
    dragOriginRef.current = null
  }

  const enterRearrange = () => {
    onRequestExpand?.()
    setReorderMode(true)
  }

  const exitRearrange = () => {
    clearDrag()
    setReorderMode(false)
  }

  const indexFromClientY = (clientY) => {
    const rows = listRef.current?.querySelectorAll('[data-nav-index]')
    if (!rows?.length) return 0
    let over = 0
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      const i = Number(row.dataset.navIndex)
      if (clientY < rect.top + rect.height / 2) return i
      over = i
    }
    return over
  }

  const onPointerDown = (event, index) => {
    if (!reorderMode) return
    if (event.button != null && event.button !== 0) return
    event.preventDefault()
    const el = event.currentTarget
    el.setPointerCapture(event.pointerId)
    const rect = el.getBoundingClientRect()
    const [path, label, Icon] = links[index]
    dragOriginRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      path,
      label,
      Icon,
    }
    setDragIndex(index)
    setGhost({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      label,
      Icon,
      active:
        path === '/settings'
          ? isSettingsNavActive(location.pathname)
          : location.pathname === path ||
            (path !== '/' && path !== '/settings' && location.pathname.startsWith(`${path}/`)),
    })
  }

  const onPointerMove = (event) => {
    if (dragIndex == null || !dragOriginRef.current) return
    const { offsetX, offsetY, width, height, label, Icon, path } = dragOriginRef.current
    setGhost({
      x: event.clientX - offsetX,
      y: event.clientY - offsetY,
      width,
      height,
      label,
      Icon,
      active:
        path === '/settings'
          ? isSettingsNavActive(location.pathname)
          : location.pathname === path ||
            (path !== '/' && path !== '/settings' && location.pathname.startsWith(`${path}/`)),
    })
    const over = indexFromClientY(event.clientY)
    if (over === dragIndex) return
    onReorder(moveNavPath(links.map((link) => link[0]), dragIndex, over))
    setDragIndex(over)
  }

  const endDrag = (event) => {
    if (dragIndex == null) return
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* already released */
    }
    clearDrag()
  }

  const onKeyDown = (event, index) => {
    if (!reorderMode) return
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const to = event.key === 'ArrowUp' ? index - 1 : index + 1
    onReorder(moveNavPath(links.map((link) => link[0]), index, to))
  }

  const controls = (
    <div className="mt-2 shrink-0 border-t border-white/10 pt-2">
      <button
        type="button"
        onClick={() => (reorderMode ? exitRearrange() : enterRearrange())}
        aria-label={reorderMode ? 'Done rearranging' : 'Rearrange menu order'}
        aria-pressed={reorderMode}
        className={`grid w-full place-items-center rounded-lg px-1 py-1.5 text-brand-ondark-dim hover:bg-brand-dark-hover hover:text-brand-ondark max-[700px]:flex max-[700px]:items-center max-[700px]:gap-2 max-[700px]:px-3 compact:flex compact:items-center compact:gap-2 compact:px-3 ${
          reorderMode ? 'bg-brand-gold/15 text-brand-gold' : ''
        }`}
      >
        {reorderMode ? <FiCheck size={13} /> : <FiMove size={13} />}
        {!iconOnly && (
          <span className="mt-0.5 text-[8px] font-bold tracking-wide uppercase max-[700px]:mt-0 compact:mt-0">
            {reorderMode ? 'Done' : 'Order'}
          </span>
        )}
      </button>
      {reorderMode && (
        <button
          type="button"
          onClick={() => {
            onReset()
            exitRearrange()
          }}
          aria-label="Reset menu to default order"
          className="mt-1 grid w-full place-items-center rounded-lg px-1 py-1.5 text-brand-ondark-dim hover:bg-brand-dark-hover hover:text-brand-ondark max-[700px]:flex max-[700px]:items-center max-[700px]:gap-2 max-[700px]:px-3 compact:flex compact:items-center compact:gap-2 compact:px-3"
        >
          <FiRotateCcw size={12} />
          {!iconOnly && (
            <span className="mt-0.5 text-[8px] font-bold tracking-wide uppercase max-[700px]:mt-0 compact:mt-0">
              Reset
            </span>
          )}
        </button>
      )}
      {reorderMode && !iconOnly && (
        <p className="m-0 mt-1.5 px-1 text-center text-[8px] leading-snug text-brand-n600 max-[700px]:px-3 max-[700px]:text-left compact:px-3 compact:text-left">
          Drag a tab — it follows your finger. Saved on this till.
        </p>
      )}
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav
        ref={listRef}
        aria-label="Main"
        className="sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      >
        {links.map(([path, label, Icon], index) => {
          const active =
            path === '/settings'
              ? isSettingsNavActive(location.pathname)
              : location.pathname === path ||
                (path !== '/' && path !== '/settings' && location.pathname.startsWith(`${path}/`))
          const isPlaceholder = reorderMode && dragIndex === index

          if (reorderMode) {
            return (
              <div
                key={path}
                data-nav-index={index}
                role="button"
                tabIndex={0}
                aria-grabbed={dragIndex === index}
                aria-label={`Move ${label}`}
                className={rowClass(active, true, isPlaceholder)}
                onPointerDown={(event) => onPointerDown(event, index)}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                <NavIconLabel Icon={Icon} label={label} iconOnly={iconOnly} />
              </div>
            )
          }

          return (
            <NavLink
              key={path}
              to={path}
              end={path === '/' || path === '/settings'}
              onClick={() => onNavigate?.()}
              className={({ isActive }) =>
                rowClass(
                  path === '/settings' ? isSettingsNavActive(location.pathname) : isActive,
                  false,
                  false,
                )
              }
            >
              <NavIconLabel Icon={Icon} label={label} iconOnly={iconOnly} />
            </NavLink>
          )
        })}
      </nav>

      {controls}

      {ghost && (
        <div
          aria-hidden="true"
          className={`pointer-events-none fixed z-[80] grid justify-items-center gap-1.5 rounded-lg px-1 py-3 text-[10px] leading-tight shadow-[0_12px_28px_rgba(0,0,0,0.45)] ring-2 ring-brand-gold max-[700px]:flex max-[700px]:items-center max-[700px]:gap-3 max-[700px]:px-3 max-[700px]:py-3 max-[700px]:text-xs compact:flex compact:items-center compact:gap-3 compact:px-3 compact:py-3 compact:text-xs ${
            ghost.active ? 'bg-brand-gold text-brand-on-gold' : 'bg-brand-panel text-brand-ondark-dim'
          }`}
          style={{
            left: ghost.x,
            top: ghost.y,
            width: ghost.width,
            minHeight: ghost.height,
            transform: 'scale(1.06) rotate(-2deg)',
          }}
        >
          <NavIconLabel Icon={ghost.Icon} label={ghost.label} iconOnly={iconOnly} />
        </div>
      )}
    </div>
  )
}
