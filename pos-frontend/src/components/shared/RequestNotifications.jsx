import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FiBell } from 'react-icons/fi'
import {
  approveCashMovementManager,
  approveCashMovementPin,
  denyCashMovement,
  dismissNotificationItem,
  fetchPendingApprovals,
  hasSupabase,
  resolveTillActionRequest,
} from '../../lib/api'
import {
  NETWORK_OPERATIONS_TOPIC,
  branchOperationsTopic,
  debounce,
  subscribeBroadcast,
} from '../../offline/realtime'
import { useAuthStore, useInventoryStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { isManagerRole, isSupervisorOrAbove } from '../../utils/roles'
import { Skeleton } from '../ui'

const POLL_MS = 30_000

/**
 * Displays pending approval requests for managers and supervisors.
 * Managers see network-wide requests, while supervisors see requests for their branch.
 * Supports inline approval, denial, and dismissal of actionable notifications.
 * @returns {JSX.Element|null} The notification bell and request menu, or `null` for unauthorized users.
 */
export default function RequestNotifications() {
  const user = useAuthStore((s) => s.user)
  const dayOpenHour = useInventoryStore((s) => s.dayOpenHour)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(null)
  const [actionError, setActionError] = useState('')
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
        dayOpenHour,
        reconcileStaffId: user.id,
      })
      setItems(rows)
    } catch {
      /* keep last list */
    } finally {
      setLoading(false)
    }
  }, [canSee, user, dayOpenHour])

  useEffect(() => {
    if (!canSee || !hasSupabase || !user) return undefined
    refresh()
    const debouncedRefresh = debounce(refresh, 400)
    // Private Broadcast only — channel auth is RLS on realtime.messages, not the topic string.
    const topic = manager
      ? NETWORK_OPERATIONS_TOPIC
      : branchOperationsTopic(user.branchId)
    const unsubscribe = topic
      ? subscribeBroadcast({
          topic,
          events: ['OPERATIONS_CHANGED'],
          onEvent: debouncedRefresh,
          onStatus: (status) => {
            if (status === 'SUBSCRIBED') debouncedRefresh()
          },
        })
      : () => {}
    const timer = window.setInterval(refresh, POLL_MS)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', refresh)
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

  const actOnMovement = async (item, action) => {
    if (!user?.id || !item.movementId) return
    setActionBusy(`${item.id}-${action}`)
    setActionError('')
    try {
      if (action === 'approve') {
        if (manager) {
          await approveCashMovementManager({ id: item.movementId, approvedBy: user.id })
        } else {
          await approveCashMovementPin({ id: item.movementId, approvedBy: user.id })
        }
      } else {
        await denyCashMovement({ id: item.movementId, deniedBy: user.id })
      }
      setItems((prev) => prev.filter((row) => row.id !== item.id))
      await refresh()
    } catch (err) {
      setActionError(formatSupportError(err, 'MOVE01'))
    } finally {
      setActionBusy(null)
    }
  }

  const actOnTillAction = async (item, action) => {
    if (!user?.id || !item.tillActionId) return
    setActionBusy(`${item.id}-${action}`)
    setActionError('')
    try {
      await resolveTillActionRequest({
        id: item.tillActionId,
        resolvedBy: user.id,
        status: action === 'approve' ? 'approved' : 'denied',
      })
      setItems((prev) => prev.filter((row) => row.id !== item.id))
      await refresh()
    } catch (err) {
      setActionError(formatSupportError(err, 'TILL_ACT01'))
    } finally {
      setActionBusy(null)
    }
  }

  const dismissItem = async (item) => {
    if (!user?.id || !item?.dismissable) return
    setActionBusy(`${item.id}-dismiss`)
    setActionError('')
    try {
      await dismissNotificationItem({ item, staffId: user.id })
      setItems((prev) => prev.filter((row) => row.id !== item.id))
      await refresh()
    } catch (err) {
      setActionError(formatSupportError(err, 'TILL_ACT01'))
    } finally {
      setActionBusy(null)
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        className="relative grid h-[35px] w-[35px] place-items-center rounded-full border-0 bg-brand-ondark/10 text-brand-ondark transition-[transform,opacity] hover:bg-brand-ondark/15 active:scale-95"
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
          refresh()
        }}
      >
        <FiBell className="text-base" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 grid min-w-[16px] place-items-center rounded-full bg-brand-gold px-1 text-[9px] font-bold text-brand-on-gold">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute top-[42px] right-0 z-40 w-[min(340px,calc(100vw-24px))] overflow-hidden rounded-lg border border-brand-border bg-brand-card text-brand-ink shadow-lg">
          <div className="border-b border-brand-softline px-3 py-2.5">
            <strong className="block text-xs">{label}</strong>
            {loading && !items.length ? (
              <Skeleton className="mt-1.5 h-2.5 w-28" />
            ) : (
              <span className="text-[10px] text-brand-subtle">
                {loading ? 'Updating…' : count ? `${count} awaiting action` : 'No pending requests'}
              </span>
            )}
            {actionError && <p className="m-0 mt-1 text-[10px] text-brand-danger">{actionError}</p>}
          </div>
          <div className="max-h-[320px] overflow-auto">
            {loading && !items.length ? (
              <div className="space-y-2 px-3 py-3" role="status" aria-label="Loading">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-2.5 w-56" />
              </div>
            ) : (
              items.map((item) => (
                <div
                  key={item.id}
                  className="border-t border-brand-softline bg-brand-card px-3 py-2.5"
                >
                  <button
                    type="button"
                    className="block w-full border-0 bg-transparent p-0 text-left hover:opacity-90"
                    onClick={() => {
                      if (
                        (item.kind === 'cash_movement_pending' || item.kind === 'till_action_pending') &&
                        item.actionable
                      ) {
                        return
                      }
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
                  {item.kind === 'till_action_pending' && item.actionable && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-[4px] border-0 bg-brand-gold px-2.5 py-1 text-[10px] font-bold text-brand-on-gold disabled:opacity-50"
                        disabled={Boolean(actionBusy)}
                        onClick={() => void actOnTillAction(item, 'approve')}
                      >
                        {actionBusy === `${item.id}-approve` ? '…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="rounded-[4px] border border-brand-danger bg-brand-danger-bg px-2.5 py-1 text-[10px] font-bold text-brand-danger disabled:opacity-50"
                        disabled={Boolean(actionBusy)}
                        onClick={() => void actOnTillAction(item, 'deny')}
                      >
                        {actionBusy === `${item.id}-deny` ? '…' : 'Deny'}
                      </button>
                      <button
                        type="button"
                        className="rounded-[4px] border border-brand-line bg-brand-card px-2.5 py-1 text-[10px] font-bold text-brand-muted disabled:opacity-50"
                        disabled={Boolean(actionBusy)}
                        onClick={() => void dismissItem(item)}
                      >
                        {actionBusy === `${item.id}-dismiss` ? '…' : 'Clear'}
                      </button>
                    </div>
                  )}
                  {item.kind === 'cash_movement_pending' && item.actionable && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="rounded-[4px] border-0 bg-brand-gold px-2.5 py-1 text-[10px] font-bold text-brand-on-gold disabled:opacity-50"
                        disabled={Boolean(actionBusy)}
                        onClick={() => void actOnMovement(item, 'approve')}
                      >
                        {actionBusy === `${item.id}-approve` ? '…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        className="rounded-[4px] border border-brand-danger bg-brand-danger-bg px-2.5 py-1 text-[10px] font-bold text-brand-danger disabled:opacity-50"
                        disabled={Boolean(actionBusy)}
                        onClick={() => void actOnMovement(item, 'deny')}
                      >
                        {actionBusy === `${item.id}-deny` ? '…' : 'Deny'}
                      </button>
                      {item.dismissable && (
                        <button
                          type="button"
                          className="rounded-[4px] border border-brand-line bg-brand-card px-2.5 py-1 text-[10px] font-bold text-brand-muted disabled:opacity-50"
                          disabled={Boolean(actionBusy)}
                          onClick={() => void dismissItem(item)}
                        >
                          {actionBusy === `${item.id}-dismiss` ? '…' : 'Clear'}
                        </button>
                      )}
                    </div>
                  )}
                  {item.dismissable &&
                    item.kind !== 'till_action_pending' &&
                    item.kind !== 'cash_movement_pending' && (
                    <div className="mt-2">
                      <button
                        type="button"
                        className="rounded-[4px] border border-brand-line bg-brand-card px-2.5 py-1 text-[10px] font-bold text-brand-muted disabled:opacity-50"
                        disabled={Boolean(actionBusy)}
                        onClick={() => void dismissItem(item)}
                      >
                        {actionBusy === `${item.id}-dismiss` ? '…' : 'Clear'}
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
            {!loading && items.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-brand-subtle">
                {manager
                  ? 'No day-end, promo, refund, cash, or cart requests right now.'
                  : 'No day-end, cash, or cart requests waiting for approval.'}
              </div>
            )}
          </div>
          <div className="border-t border-brand-softline px-3 py-2">
            <button
              type="button"
              className="w-full border-0 bg-transparent p-0 text-left text-[11px] font-bold text-brand-gold hover:opacity-80"
              onClick={() => {
                setOpen(false)
                navigate('/notifications/history')
              }}
            >
              View history →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
