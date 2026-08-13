import { useEffect, useRef, useState } from 'react'
import { Eyebrow, Modal, PrimaryButton, SecondaryButton } from '../ui'
import {
  CART_REMOVE_WAIT_SEC,
  ManagerWaitPanel,
  SupervisorPinPanel,
} from '../shared/SupervisorPinWait'
import {
  allowDemoMode,
  createTillActionRequest,
  dismissPendingTillActionsOnSite,
  fetchTillActionRequestById,
  hasSupabase,
  logApprovalEvent,
  resolveTillActionRequest,
  verifySupervisorPin,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { useSyncStore } from '../../stores/syncStore'
import { formatSupportError } from '../../utils/errors'
import { lineTotal } from '../../utils/ulam'
import { isManagerRole } from '../../utils/roles'

/**
 * Authorizes removing a cart item through supervisor or manager approval, or after a timed self-approval acknowledgment.
 * Offline mode verifies supervisor credentials on the device and queues the audit record for synchronization.
 * @param {Object} item - The cart item to remove.
 * @param {string|null} [cartId=null] - The identifier of the cart containing the item.
 * @param {Function} onCancel - Called when the approval modal is canceled or closed.
 * @param {Function} onAllowed - Called after authorization with the approver identity, role, approval method, and request identifier.
 */
export default function CartRemoveApprove({ item, cartId = null, onCancel, onAllowed }) {
  const user = useAuthStore((s) => s.user)
  const deviceSessionId = useAuthStore((s) => s.deviceSessionId)
  const backendReachable = useSyncStore((s) => s.backendReachable)
  const online = useSyncStore((s) => s.online)
  const offlineAuth = hasSupabase && !backendReachable
  const managerCanApprove = isManagerRole(user?.role)

  const [loginCode, setLoginCode] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('pin') // pin | waiting | self | denied
  const [requestId, setRequestId] = useState(null)
  const [secondsLeft, setSecondsLeft] = useState(CART_REMOVE_WAIT_SEC)
  const [notifyConfirm, setNotifyConfirm] = useState(false)
  const [ack, setAck] = useState(false)
  const pollRef = useRef(null)
  const tickRef = useRef(null)

  const stopTimers = () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (tickRef.current) window.clearInterval(tickRef.current)
    pollRef.current = null
    tickRef.current = null
  }

  useEffect(() => () => stopTimers(), [])

  const auditBase = () => ({
    branchId: user?.branchId,
    requestedBy: user?.id,
    deviceId: deviceSessionId || null,
    meta: {
      action: 'REMOVE_CART_ITEM',
      cart_id: cartId || null,
      product_id: item?.id || null,
      product_name: item?.name || null,
      quantity_removed: item?.quantity ?? item?.weight ?? null,
      unit_price: item?.unitPrice ?? item?.price ?? null,
      line_total: item ? Number(lineTotal(item).toFixed(2)) : null,
    },
  })

  const logPinFailure = () => {
    void logApprovalEvent({
      ...auditBase(),
      approvedBy: null,
      action: 'cart_pin_failure',
      detail: 'Failed supervisor PIN for cart line remove',
      meta: {
        ...auditBase().meta,
        action: 'SUPERVISOR_PIN_FAILURE',
        offline: offlineAuth,
      },
    }).catch(() => {})
  }

  const finishAllowed = async ({ staffId, name, role, via }) => {
    stopTimers()
    if (hasSupabase && user?.branchId && staffId && backendReachable) {
      const isSelf = via === 'self_allowed'
      await dismissPendingTillActionsOnSite({
        requestId,
        branchId: user.branchId,
        requestedBy: user.id,
        resolvedBy: isSelf ? user.id : staffId,
        productId: item?.id || null,
        status: isSelf ? 'self_allowed' : 'approved',
        ack: isSelf,
      })
    }
    await onAllowed({ staffId, name, role, via, requestId })
  }

  const approveAsManager = async () => {
    setError('')
    setBusy(true)
    try {
      if (!user?.id) throw new Error('Not signed in')
      await finishAllowed({
        staffId: user.id,
        name: user.name || 'Manager',
        role: user.role || 'manager',
        via: 'manager_session',
      })
    } catch (err) {
      setError(formatSupportError(err, 'AUTH09'))
      setBusy(false)
    }
  }

  const tryPin = async () => {
    setError('')
    setBusy(true)
    try {
      if (!hasSupabase && allowDemoMode) {
        await finishAllowed({
          staffId: 'demo-supervisor',
          name: 'Demo Supervisor',
          role: 'supervisor',
          via: 'pin',
        })
        return
      }
      if (!hasSupabase) {
        throw new Error('Supervisor PIN verification requires Supabase.')
      }
      const approved = await verifySupervisorPin(user.branchId, loginCode, pin)
      const staffId = approved?.staffId || approved?.staff_id
      if (!staffId) throw new Error('Invalid supervisor code or PIN')
      if (staffId === user.id) {
        throw new Error('MOVE04: You cannot approve your own request.')
      }
      await finishAllowed({
        staffId,
        name: approved.fullName || approved.full_name || approved.name || 'Supervisor',
        role: approved.role || 'supervisor',
        via: offlineAuth ? 'pin_offline' : 'pin',
      })
    } catch (err) {
      logPinFailure()
      setError(formatSupportError(err, 'AUTH09'))
      setBusy(false)
    }
  }

  const cancelAndClose = () => {
    const pendingId = requestId
    const wasWaiting = phase === 'waiting' || phase === 'self'
    stopTimers()
    onCancel()
    if (wasWaiting && pendingId && pendingId !== 'demo' && user?.id && hasSupabase && backendReachable) {
      void resolveTillActionRequest({
        id: pendingId,
        resolvedBy: user.id,
        status: 'cancelled',
      }).catch(() => {})
    }
  }

  const startWait = (id) => {
    setRequestId(id)
    setPhase('waiting')
    setSecondsLeft(CART_REMOVE_WAIT_SEC)
    setNotifyConfirm(false)
    stopTimers()

    tickRef.current = window.setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          window.clearInterval(tickRef.current)
          tickRef.current = null
          return 0
        }
        return s - 1
      })
    }, 1000)

    pollRef.current = window.setInterval(async () => {
      try {
        const row = await fetchTillActionRequestById(id)
        if (!row) return
        if (row.status === 'approved') {
          stopTimers()
          await finishAllowed({
            staffId: row.resolvedBy,
            name: row.resolvedByName || 'Manager',
            role: 'manager',
            via: 'remote',
          })
        } else if (row.status === 'denied') {
          stopTimers()
          setPhase('denied')
          setError('Manager denied — item stays in the cart.')
        }
      } catch {
        /* keep waiting */
      }
    }, 2000)
  }

  const sendNotify = async () => {
    setError('')
    setBusy(true)
    try {
      if (!backendReachable) {
        setError('Offline — use a supervisor PIN on site. Remote manager notify needs a connection.')
        setNotifyConfirm(false)
        return
      }
      if (!hasSupabase) {
        startWait('demo')
        return
      }
      const row = await createTillActionRequest({
        branchId: user.branchId,
        requestedBy: user.id,
        action: 'cart_line_remove',
        detail: `Remove ${item?.name || 'item'} from cart`,
        meta: {
          product_id: item?.id || null,
          product_name: item?.name || null,
          quantity: item?.quantity ?? item?.weight ?? null,
          unit_price: item?.unitPrice ?? item?.price ?? null,
          line_total: item ? Number(lineTotal(item).toFixed(2)) : null,
          cart_id: cartId || null,
        },
      })
      startWait(row.id)
    } catch (err) {
      setError(formatSupportError(err, 'TILL_ACT01'))
      setNotifyConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  const selfAllow = async () => {
    if (!ack) {
      setError('Tick the acknowledgment to continue without approval.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await logApprovalEvent({
        ...auditBase(),
        approvedBy: user?.id,
        approverName: user?.name,
        approverRole: user?.role,
        action: 'cart_line_remove_self',
        detail: `Self-allowed remove ${item?.name || 'item'} after manager wait`,
        meta: {
          ...auditBase().meta,
          till_action_id: requestId,
          via: 'self_allowed',
        },
      }).catch(() => {})
      await finishAllowed({
        staffId: user.id,
        name: user.name || 'Cashier',
        role: user.role || 'cashier',
        via: 'self_allowed',
      })
    } catch (err) {
      setError(formatSupportError(err, 'TILL_ACT01'))
      setBusy(false)
    }
  }

  return (
    <Modal onClose={cancelAndClose}>
      <Eyebrow>APPROVAL REQUIRED</Eyebrow>
      <h2 className="mb-1 text-lg">Remove cart item</h2>
      <p className="mb-3 text-xs text-brand-muted">
        Remove <strong className="text-brand-ink">{item?.name || 'this item'}</strong> from the cart.
      </p>

      {offlineAuth && (
        <p className="mb-3 rounded-md border border-brand-warn bg-brand-warn-bg px-3 py-2 text-xs text-brand-warn">
          Offline mode — supervisor PIN is verified on this device. Approval will sync when connection returns.
        </p>
      )}

      {phase === 'denied' && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-3 py-2 text-xs text-brand-danger">
          {error || 'Denied.'}
        </p>
      )}

      {phase === 'waiting' && (
        <div className="mb-3">
          <ManagerWaitPanel
            secondsLeft={secondsLeft}
            totalSec={CART_REMOVE_WAIT_SEC}
            proceedLabel="Remove without approval"
            onProceedWithoutApproval={() => {
              setAck(false)
              setPhase('self')
            }}
          />
        </div>
      )}

      {phase === 'self' && (
        <div className="mb-3 rounded-lg border-2 border-brand-danger px-3.5 py-3">
          <strong className="block text-sm text-brand-danger">Remove without approval</strong>
          <p className="m-0 mt-1 text-[11px] text-brand-muted">
            No manager responded in {CART_REMOVE_WAIT_SEC}s. This is logged for review.
          </p>
          <label className="mt-3 flex items-start gap-2 text-xs text-brand-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>I understand this removal is unapproved and will be logged</span>
          </label>
          <PrimaryButton
            type="button"
            className="mt-3 w-full"
            disabled={busy || !ack}
            onClick={() => void selfAllow()}
          >
            Remove item
          </PrimaryButton>
        </div>
      )}

      {phase !== 'denied' && (
        <>
          {managerCanApprove && phase === 'pin' && (
            <div className="mb-3 rounded-md border border-brand-line bg-brand-n100 px-3 py-3">
              <p className="m-0 text-[12px] text-brand-muted">
                Signed in as <strong className="text-brand-ink">{user?.name || 'manager'}</strong>.
              </p>
              <PrimaryButton
                compact
                type="button"
                className="mt-2"
                disabled={busy}
                onClick={() => void approveAsManager()}
              >
                Approve as manager
              </PrimaryButton>
            </div>
          )}

          <SupervisorPinPanel
            loginCode={loginCode}
            pin={pin}
            onLoginCode={setLoginCode}
            onPin={setPin}
            busy={busy}
            autoFocusCode={phase === 'pin'}
            submitLabel={phase === 'waiting' || phase === 'self' ? 'Approve with PIN' : 'Approve'}
            hint={
              offlineAuth
                ? 'Offline — verified on this device'
                : phase === 'waiting' || phase === 'self'
                  ? 'Still works while waiting'
                  : null
            }
            onSubmit={() => void tryPin()}
          />

          {phase === 'pin' && (
            <div className="mt-3">
              {!notifyConfirm ? (
                <button
                  type="button"
                  className="w-full border-0 bg-transparent py-2 text-center text-xs font-bold text-brand-muted underline underline-offset-2 disabled:opacity-40"
                  disabled={!online || !backendReachable}
                  onClick={() => setNotifyConfirm(true)}
                >
                  No supervisor here? Notify manager
                </button>
              ) : (
                <div className="rounded-lg bg-brand-warn-bg px-3 py-3">
                  <p className="m-0 text-xs text-brand-warn">
                    Alert managers. Wait up to {CART_REMOVE_WAIT_SEC}s for Approve / Deny.
                  </p>
                  <div className="mt-2.5 flex gap-2">
                    <PrimaryButton
                      compact
                      type="button"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => void sendNotify()}
                    >
                      {busy ? 'Sending…' : 'Send alert'}
                    </PrimaryButton>
                    <SecondaryButton compact type="button" onClick={() => setNotifyConfirm(false)}>
                      Never mind
                    </SecondaryButton>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && phase !== 'denied' && (
        <p className="mt-2 text-xs text-brand-danger">{error}</p>
      )}

      {phase !== 'waiting' && (
        <div className="mt-4">
          <SecondaryButton type="button" onClick={cancelAndClose}>
            {phase === 'denied' ? 'Close' : 'Cancel'}
          </SecondaryButton>
        </div>
      )}
      {phase === 'waiting' && (
        <div className="mt-4">
          <SecondaryButton type="button" onClick={cancelAndClose}>
            Cancel request
          </SecondaryButton>
        </div>
      )}
    </Modal>
  )
}
