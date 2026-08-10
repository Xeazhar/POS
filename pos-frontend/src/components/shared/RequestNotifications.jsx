import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FiBell } from 'react-icons/fi'
import { fetchPendingApprovals, hasSupabase } from '../../lib/api'
import { debounce, subscribeMany } from '../../offline/realtime'
import { useAuthStore } from '../../stores/posStore'
import { isManagerRole, isSupervisorOrAbove } from '../../utils/roles'
import { Skeleton } from '../ui'

// Realtime keeps the badge current; this is only a slow fallback in case a
// subscription silently drops (long session, network blip) — not the primary path.
const POLL_MS = 5 * 60_000

/**
 * Header inbox for important approval requests.
 * Manager: day-end submitted + promo pending / stop pending + refund requests.
 * Supervisor: day-end submitted on their branch.
 */
export default function RequestNotifications() {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const rootRef = useRef(null)

  const canSee = isSupervisorOrAbove(user?.role)
  const manager = isManagerRole(user?.role)

  const refresh = useCallback(async () => {
    if (!hasSupabase || !canSee || !user) {
      setItems([])
      return
    }
    setLoading(true)
    try {
      const rows = await fetchPendingApprovals({
        role: user.role,
        branchId: user.branchId,
      })
      setItems(rows)
    } catch {
      /* keep last list */
    } finally {
      setLoading(false)
    }
  }, [canSee, user])

  useEffect(() => {
    if (!canSee || !hasSupabase || !user) return undefined
    refresh()
    const debouncedRefresh = debounce(refresh, 400)
    // Live: a day-end submission, petty cash request, or promo approval request
    // updates the badge immediately, whether or not the inbox is open.
    const subs = [
      { table: 'day_ends', onChange: debouncedRefresh },
      { table: 'cash_drawer_entries', onChange: debouncedRefresh },
      { table: 'petty_cash', onChange: debouncedRefresh }, // legacy table name, harmless if it doesn't exist
    ]
    if (manager) {
      subs.push({ table: 'promo_events', onChange: debouncedRefresh })
      subs.push({ table: 'refund_requests', onChange: debouncedRefresh })
    }
    else if (user.branchId) {
      subs[0] = { table: 'day_ends', filter: `branch_id=eq.${user.branchId}`, onChange: debouncedRefresh }
      subs[1] = { table: 'cash_drawer_entries', filter: `branch_id=eq.${user.branchId}`, onChange: debouncedRefresh }
      subs[2] = { table: 'petty_cash', filter: `branch_id=eq.${user.branchId}`, onChange: debouncedRefresh }
    }
    const unsubscribe = subscribeMany(subs)
    // Slow fallback only — see POLL_MS comment above.
    const timer = window.setInterval(refresh, POLL_MS)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      debouncedRefresh.cancel()
      unsubscribe()
    }
  }, [canSee, manager, user, refresh])

  useEffect(() => {
    if (!open) return undefined
    const onDoc = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!canSee) return null

  const count = items.length
  const label = manager ? 'Manager requests' : 'Branch requests'

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="relative grid h-[35px] w-[35px] place-items-center rounded-full border-0 bg-white/10 text-white transition-[transform,opacity] hover:bg-white/15 active:scale-95"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
          refresh()
        }}
      >
        <FiBell className="text-base" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-[16px] place-items-center rounded-full bg-brand-gold px-1 text-[9px] font-bold text-brand-dark">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-[42px] right-0 z-40 w-[min(320px,calc(100vw-24px))] overflow-hidden rounded-lg border border-brand-border bg-white text-brand-ink shadow-lg">
          <div className="border-b border-brand-softline px-3 py-2.5">
            <strong className="block text-xs">{label}</strong>
            {loading && !items.length ? (
              <Skeleton className="mt-1.5 h-2.5 w-28" />
            ) : (
              <span className="text-[10px] text-brand-subtle">
                {loading ? 'Updating…' : count ? `${count} awaiting action` : 'No pending requests'}
              </span>
            )}
          </div>
          <div className="max-h-[280px] overflow-auto">
            {loading && !items.length ? (
              <div className="space-y-2 px-3 py-3" role="status" aria-label="Loading">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-2.5 w-56" />
                <Skeleton className="mt-2 h-3 w-36" />
                <Skeleton className="h-2.5 w-48" />
              </div>
            ) : (
              items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="block w-full border-0 border-t border-brand-softline bg-white px-3 py-2.5 text-left hover:bg-brand-n50"
                onClick={() => {
                  setOpen(false)
                  navigate(item.href)
                }}
              >
                <strong className="block text-[12px] text-brand-ink">{item.title}</strong>
                <span className="mt-0.5 block text-[11px] text-brand-muted">{item.detail}</span>
                {item.createdAt && (
                  <span className="mt-1 block text-[10px] text-brand-subtle">
                    {new Date(item.createdAt).toLocaleString()}
                  </span>
                )}
              </button>
            ))
            )}
            {!loading && items.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-brand-subtle">
                {manager
                  ? 'No day-end, promo, refund, or petty cash requests right now.'
                  : 'No day-end or petty cash requests waiting for approval.'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
