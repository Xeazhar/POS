import { useEffect, useRef, useState } from 'react'
import { FiChevronLeft } from 'react-icons/fi'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PrimaryButton,
  SecondaryButton,
} from '../ui'
import {
  ManagerWaitPanel,
  OPEN_DRAWER_WAIT_SEC,
  SupervisorPinPanel,
} from '../shared/SupervisorPinWait'
import {
  approveCashMovementPin,
  cancelCashMovement,
  createCashMovementApproved,
  createCashMovementPending,
  fetchCashMovementById,
  hasSupabase,
  selfRecordCashMovement,
  verifySupervisorPin,
} from '../../lib/api'
import { saveLocalShift } from '../../offline/shifts'
import { enqueue, newUuidClientId, putLocalCashMovement, QUEUE_TYPES } from '../../offline'
import { useAuthStore } from '../../stores/posStore'
import { useShiftStore } from '../../stores/shiftStore'
import { useSyncStore } from '../../stores/syncStore'
import { formatSupportError, appError } from '../../utils/errors'
import { money } from '../../utils/format'
import { isSupervisorOrAbove } from '../../utils/roles'
import { decimalOnly, formatMoneyOnBlur } from '../../utils/validate'

/**
 * POS → Open Drawer — petty/pickup out, cash-in / opening float in.
 * Flow: type → details → PIN (hero) / notify manager → 60s wait → optional self-record.
 * Offline: supervisor PIN verified on-device; movement queued until connection returns.
 */
export default function OpenDrawer({ open, onClose, onDone }) {
  const user = useAuthStore((s) => s.user)
  const shift = useShiftStore((s) => s.shift)
  const syncShiftServerId = useShiftStore((s) => s.syncShiftServerId)
  const cashPosition = useShiftStore((s) => s.cashPosition)
  const online = useSyncStore((s) => s.online)
  const backendReachable = useSyncStore((s) => s.backendReachable)
  const offlineMode = hasSupabase && (!online || !backendReachable)

  const [step, setStep] = useState('sheet')
  const [moveType, setMoveType] = useState(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [loginCode, setLoginCode] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [movementId, setMovementId] = useState(null)
  const [secondsLeft, setSecondsLeft] = useState(OPEN_DRAWER_WAIT_SEC)
  const [ack, setAck] = useState(false)
  const [resultMsg, setResultMsg] = useState('')
  const [notifyConfirm, setNotifyConfirm] = useState(false)
  const [drawerCash, setDrawerCash] = useState(null)
  const pollRef = useRef(null)
  const tickRef = useRef(null)

  const reset = () => {
    setStep('sheet')
    setMoveType(null)
    setAmount('')
    setReason('')
    setLoginCode('')
    setPin('')
    setError('')
    setBusy(false)
    setMovementId(null)
    setSecondsLeft(OPEN_DRAWER_WAIT_SEC)
    setAck(false)
    setResultMsg('')
    setNotifyConfirm(false)
    setDrawerCash(null)
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (tickRef.current) window.clearInterval(tickRef.current)
    pollRef.current = null
    tickRef.current = null
  }

  useEffect(() => {
    if (!open) return undefined
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
      if (tickRef.current) window.clearInterval(tickRef.current)
      pollRef.current = null
      tickRef.current = null
    }
  }, [open])

  const handleClose = async () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (tickRef.current) window.clearInterval(tickRef.current)
    pollRef.current = null
    tickRef.current = null
    const pendingId = movementId
    const wasWaiting = step === 'waiting' || step === 'self'
    reset()
    onClose()
    if (wasWaiting && pendingId && user?.id && hasSupabase) {
      void cancelCashMovement({ id: pendingId, cancelledBy: user.id }).catch(() => {})
    }
  }

  const resolveShiftId = async () => {
    await syncShiftServerId?.().catch(() => {})
    const live = useShiftStore.getState().shift
    return live?.serverId || null
  }

  const typeLabel =
    moveType === 'pickup'
      ? 'Cash pickup'
      : moveType === 'cash_in'
        ? 'Additional float'
        : moveType === 'opening_float'
          ? 'Opening float'
          : 'Petty cash'
  const isCashIn = moveType === 'cash_in' || moveType === 'opening_float'
  const isOutflow = moveType === 'petty_cash' || moveType === 'pickup'
  const noOpeningFloat = Number(shift?.startingCash || 0) <= 0.004

  // Petty cash / pickup take cash out of a real drawer — fetch what it currently holds so
  // the form can block an amount that would leave it negative before a request even goes out.
  useEffect(() => {
    if (step !== 'form' || !isOutflow) return undefined
    let active = true
    cashPosition()
      .then((result) => {
        if (active) setDrawerCash(Number(result?.expectedCash ?? 0))
      })
      .catch(() => {
        if (active) setDrawerCash(null)
      })
    return () => {
      active = false
    }
  }, [step, isOutflow, cashPosition])

  const overDrawerLimit = isOutflow && drawerCash != null && Number(amount || 0) > drawerCash
  const movementReason = () => {
    const trimmed = reason.trim()
    if (trimmed) return trimmed
    if (moveType === 'opening_float') return 'Opening float'
    return ''
  }

  const patchOpeningFloatLocally = async () => {
    if (moveType !== 'opening_float') return
    const live = useShiftStore.getState().shift
    if (!live?.clientId) return
    const updated = { ...live, startingCash: Number(amount) }
    await saveLocalShift(updated)
    useShiftStore.setState({ shift: updated })
  }

  const stopWaiting = () => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    if (tickRef.current) window.clearInterval(tickRef.current)
    pollRef.current = null
    tickRef.current = null
  }

  const finishOk = async (msg) => {
    stopWaiting()
    await patchOpeningFloatLocally()
    setResultMsg(msg)
    setStep('done')
    window.dispatchEvent(new CustomEvent('cale-cash-movements-changed'))
    onDone?.()
  }

  const tryPinApprove = async (existingId = movementId) => {
    setError('')
    setBusy(true)
    try {
      if (!hasSupabase) {
        await finishOk('Demo: movement recorded as approved.')
        return
      }
      const approved = await verifySupervisorPin(user.branchId, loginCode, pin)
      const staffId = approved?.staffId || approved?.staff_id
      if (!staffId) throw new Error('Invalid supervisor code or PIN')
      if (staffId === user.id) {
        throw new Error('MOVE04: You cannot approve your own request.')
      }

      // Offline (or backend down): verify PIN locally, persist + queue for sync.
      if (offlineMode) {
        if (!user?.branchId || !shift?.clientId) {
          throw new Error('SHIFT01: Open a shift on this terminal before recording drawer cash.')
        }
        const clientId = newUuidClientId()
        const payload = {
          clientId,
          shiftClientId: shift.clientId,
          shiftId: shift.serverId || null,
          branchId: user.branchId,
          drawerId: shift.drawerId,
          drawerLabel: shift.drawerLabel,
          type: moveType,
          amount: Number(amount),
          reason: movementReason(),
          requestedBy: user.id,
          approvedBy: staffId,
          createdOffline: true,
        }
        await putLocalCashMovement({
          ...payload,
          status: 'approved',
          syncStatus: 'pending',
        })
        await enqueue(QUEUE_TYPES.CASH_MOVEMENT_APPROVED, payload, {
          branchId: user.branchId,
          clientId,
        })
        useSyncStore.getState().refresh(user.branchId)
        await finishOk(`${typeLabel} approved · ${money(amount)} · will sync when online`)
        return
      }

      const shiftId = await resolveShiftId()
      if (!shiftId) throw new Error('SHIFT01: Shift is not synced yet. Wait a moment and retry.')

      if (existingId) {
        await approveCashMovementPin({ id: existingId, approvedBy: staffId })
      } else {
        await createCashMovementApproved({
          shiftId,
          branchId: user.branchId,
          drawerId: shift?.drawerId,
          drawerLabel: shift?.drawerLabel,
          type: moveType,
          amount: Number(amount),
          reason: movementReason(),
          requestedBy: user.id,
          approvedBy: staffId,
        })
      }
      await finishOk(`${typeLabel} approved · ${money(amount)}`)
    } catch (err) {
      const raw = String(err?.message || err || '')
      setError(
        formatSupportError(
          err,
          /Invalid supervisor|MOVE04|wrong|PIN/i.test(raw) ? 'AUTH09' : 'MOVE01',
        ),
      )
    } finally {
      setBusy(false)
    }
  }

  // A supervisor/manager/master recording their OWN drawer needs no second person — the
  // dual-control PIN/notify dance exists to catch a lone actor moving cash unchecked, but
  // that actor IS the approval authority here. migrate_cash_movement_self_approve.sql is the
  // real control: it only accepts approvedBy === requestedBy when the CALLING session's own
  // staff row is supervisor+, so this cannot be spoofed by a cashier hitting this path.
  const canSelfApprove = isSupervisorOrAbove(user?.role)

  const submitSelfApprove = async () => {
    setError('')
    setBusy(true)
    try {
      if (!hasSupabase) {
        await finishOk('Demo: movement recorded as approved.')
        return
      }
      if (offlineMode) {
        if (!user?.branchId || !shift?.clientId) {
          throw new Error('SHIFT01: Open a shift on this terminal before recording drawer cash.')
        }
        const clientId = newUuidClientId()
        const payload = {
          clientId,
          shiftClientId: shift.clientId,
          shiftId: shift.serverId || null,
          branchId: user.branchId,
          drawerId: shift.drawerId,
          drawerLabel: shift.drawerLabel,
          type: moveType,
          amount: Number(amount),
          reason: movementReason(),
          requestedBy: user.id,
          approvedBy: user.id,
          createdOffline: true,
        }
        await putLocalCashMovement({
          ...payload,
          status: 'approved',
          syncStatus: 'pending',
        })
        await enqueue(QUEUE_TYPES.CASH_MOVEMENT_APPROVED, payload, {
          branchId: user.branchId,
          clientId,
        })
        useSyncStore.getState().refresh(user.branchId)
        await finishOk(`${typeLabel} recorded · ${money(amount)} · will sync when online`)
        return
      }

      const shiftId = await resolveShiftId()
      if (!shiftId) throw new Error('SHIFT01: Shift is not synced yet. Wait a moment and retry.')

      await createCashMovementApproved({
        shiftId,
        branchId: user.branchId,
        drawerId: shift?.drawerId,
        drawerLabel: shift?.drawerLabel,
        type: moveType,
        amount: Number(amount),
        reason: movementReason(),
        requestedBy: user.id,
        approvedBy: user.id,
      })
      await finishOk(`${typeLabel} recorded · ${money(amount)}`)
    } catch (err) {
      setError(formatSupportError(err, 'MOVE01'))
    } finally {
      setBusy(false)
    }
  }

  const startCountdown = (id) => {
    setMovementId(id)
    setNotifyConfirm(false)
    setStep('waiting')
    setSecondsLeft(OPEN_DRAWER_WAIT_SEC)
    stopWaiting()

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
        const row = await fetchCashMovementById(id)
        if (!row) return
        if (row.status === 'remote_approved' || row.status === 'approved') {
          void finishOk(`${typeLabel} approved · ${money(row.amount)}`)
        } else if (row.status === 'denied') {
          stopWaiting()
          setResultMsg(
            isCashIn
              ? 'Request denied by manager. No cash entered the drawer.'
              : 'Request denied by manager. No cash left the drawer.',
          )
          setStep('denied')
        }
      } catch {
        /* keep waiting */
      }
    }, 2000)
  }

  const confirmNotify = async () => {
    setError('')
    setBusy(true)
    try {
      if (offlineMode) {
        setError(formatSupportError(appError('MOVE23'), 'MOVE23'))
        setNotifyConfirm(false)
        return
      }
      const shiftId = await resolveShiftId()
      if (!shiftId) throw new Error('SHIFT01: Shift is not synced yet. Wait a moment and retry.')
      const row = await createCashMovementPending({
        shiftId,
        branchId: user.branchId,
        drawerId: shift?.drawerId,
        drawerLabel: shift?.drawerLabel,
        type: moveType,
        amount: Number(amount),
        reason: movementReason(),
        requestedBy: user.id,
      })
      startCountdown(row.id)
    } catch (err) {
      setError(formatSupportError(err, 'MOVE01'))
      setNotifyConfirm(false)
    } finally {
      setBusy(false)
    }
  }

  const submitSelfRecord = async () => {
    setError('')
    if (!ack) {
      setError(formatSupportError(new Error('MOVE15'), 'MOVE15'))
      return
    }
    if (!movementReason()) {
      setError(formatSupportError(new Error('MOVE03'), 'MOVE03'))
      return
    }
    setBusy(true)
    try {
      // Offline: no manager notify path — self-record locally and sync later (flagged).
      if (offlineMode && hasSupabase) {
        if (!user?.branchId || !shift?.clientId) {
          throw new Error('SHIFT01: Open a shift on this terminal before recording drawer cash.')
        }
        const clientId = newUuidClientId()
        const payload = {
          clientId,
          shiftClientId: shift.clientId,
          shiftId: shift.serverId || null,
          branchId: user.branchId,
          drawerId: shift.drawerId,
          drawerLabel: shift.drawerLabel,
          type: moveType,
          amount: Number(amount),
          reason: movementReason(),
          requestedBy: user.id,
          selfRecorded: true,
          ack: true,
          createdOffline: true,
        }
        await putLocalCashMovement({
          ...payload,
          status: 'self_recorded',
          syncStatus: 'pending',
        })
        await enqueue(QUEUE_TYPES.CASH_MOVEMENT_APPROVED, payload, {
          branchId: user.branchId,
          clientId,
        })
        useSyncStore.getState().refresh(user.branchId)
        await finishOk(
          `${typeLabel} self-recorded · ${money(amount)} · flagged, will sync when online`,
        )
        return
      }
      if (!movementId) throw new Error('No pending request. Retry from Get approval.')
      await selfRecordCashMovement({ id: movementId, staffId: user.id, ack: true })
      await finishOk(`${typeLabel} self-recorded · ${money(amount)} · flagged for day-end review`)
    } catch (err) {
      setError(formatSupportError(err, 'MOVE01'))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const amountOk = Number(amount) > 0 && !overDrawerLimit
  const reasonOk = movementReason().length > 0
  const drawerName = shift?.drawerLabel || shift?.drawerId || 'Drawer'

  return (
    <Modal onClose={() => void handleClose()}>
      <Eyebrow>OPEN DRAWER</Eyebrow>

      {step === 'sheet' && (
        <>
          {noOpeningFloat && (
            <>
              <h2 className="mb-1 text-lg">Cash entering the drawer</h2>
              <p className="mb-3 text-xs text-brand-muted">
                Shift started with no float. Record opening cash here, or add more later.
              </p>
              <div className="mb-4 flex flex-col gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-brand-success-line bg-brand-success-bg px-4 py-3.5 text-left transition-colors hover:border-brand-success"
                  onClick={() => {
                    setMoveType('opening_float')
                    setReason('Opening float')
                    setStep('form')
                  }}
                >
                  <strong className="block text-sm text-brand-success-text">Opening float</strong>
                  <span className="mt-0.5 block text-[11px] text-brand-subtle">
                    First change fund for this shift (currently ₱0.00)
                  </span>
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-brand-softline bg-brand-card px-4 py-3.5 text-left transition-colors hover:border-brand-ink hover:bg-brand-n50"
                  onClick={() => {
                    setMoveType('cash_in')
                    setStep('form')
                  }}
                >
                  <strong className="block text-sm text-brand-ink">Additional float</strong>
                  <span className="mt-0.5 block text-[11px] text-brand-subtle">
                    Extra change fund mid-shift
                  </span>
                </button>
              </div>
            </>
          )}
          {!noOpeningFloat && (
            <>
              <h2 className="mb-1 text-lg">Cash entering the drawer</h2>
              <p className="mb-3 text-xs text-brand-muted">
                Add change fund after shift start. Supervisor or manager approval required.
              </p>
              <div className="mb-4 flex flex-col gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-brand-success-line bg-brand-success-bg px-4 py-3.5 text-left transition-colors hover:border-brand-success"
                  onClick={() => {
                    setMoveType('cash_in')
                    setStep('form')
                  }}
                >
                  <strong className="block text-sm text-brand-success-text">Cash in / Additional float</strong>
                  <span className="mt-0.5 block text-[11px] text-brand-subtle">
                    Top up change in the drawer
                  </span>
                </button>
              </div>
            </>
          )}
          <h2 className="mb-1 text-base">Cash leaving the drawer</h2>
          <p className="mb-3 text-xs text-brand-muted">
            Supervisor PIN or manager approval required before expected cash changes.
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              className="rounded-lg border border-brand-softline bg-brand-card px-4 py-3.5 text-left transition-colors hover:border-brand-ink hover:bg-brand-n50"
              onClick={() => {
                setMoveType('petty_cash')
                setStep('form')
              }}
            >
              <strong className="block text-sm text-brand-ink">Petty cash</strong>
              <span className="mt-0.5 block text-[11px] text-brand-subtle">
                Supplies, change for customer, small paid-outs
              </span>
            </button>
            <button
              type="button"
              className="rounded-lg border border-brand-softline bg-brand-card px-4 py-3.5 text-left transition-colors hover:border-brand-ink hover:bg-brand-n50"
              onClick={() => {
                setMoveType('pickup')
                setStep('form')
              }}
            >
              <strong className="block text-sm text-brand-ink">Cash pickup / drop</strong>
              <span className="mt-0.5 block text-[11px] text-brand-subtle">
                Move cash to the safe
              </span>
            </button>
          </div>
          <ModalActions>
            <SecondaryButton type="button" onClick={handleClose}>
              Cancel
            </SecondaryButton>
          </ModalActions>
        </>
      )}

      {step === 'form' && (
        <>
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              aria-label="Back to type"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-md border-0 bg-brand-n50 text-brand-ink hover:bg-brand-n150"
              onClick={() => {
                setError('')
                setAmount('')
                setReason('')
                setStep('sheet')
              }}
            >
              <FiChevronLeft size={20} />
            </button>
            <div className="min-w-0">
              <h2 className="m-0 text-lg">{typeLabel}</h2>
              <p className="m-0 text-xs text-brand-muted">{drawerName}</p>
            </div>
          </div>
          <Field
            label="Amount"
            value={amount}
            onChange={(e) => setAmount(decimalOnly(e.target.value))}
            onBlur={(e) => setAmount(formatMoneyOnBlur(e.target.value))}
            inputMode="decimal"
            autoFocus
            inputClassName="h-12 text-lg"
          />
          {isOutflow && (
            <p
              className={`mt-1 text-[11px] ${overDrawerLimit ? 'text-brand-danger' : 'text-brand-subtle'}`}
            >
              {drawerCash == null
                ? 'Checking drawer total…'
                : overDrawerLimit
                  ? `Only ${money(drawerCash)} is in the drawer right now.`
                  : `${money(drawerCash)} currently in the drawer.`}
            </p>
          )}
          <Field
            label="Reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.replace(/[<>]/g, '').slice(0, 200))}
            className="mt-2.5"
            placeholder={
              moveType === 'opening_float'
                ? 'Optional, defaults to Opening float'
                : 'Required: what is this for?'
            }
          />
          {canSelfApprove && (
            <p className="mt-2 text-[11px] text-brand-subtle">
              You&apos;re a supervisor, so this records straight away, no PIN needed.
            </p>
          )}
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
          <ModalActions>
            <PrimaryButton
              type="button"
              disabled={!amountOk || !reasonOk || busy}
              onClick={() => {
                if (canSelfApprove) {
                  void submitSelfApprove()
                  return
                }
                setError('')
                setNotifyConfirm(false)
                setLoginCode('')
                setPin('')
                setStep('approve')
              }}
            >
              {canSelfApprove ? (busy ? 'Recording…' : 'Record') : 'Get approval'}
            </PrimaryButton>
          </ModalActions>
        </>
      )}

      {(step === 'approve' || step === 'waiting' || step === 'self') && (
        <>
          <div className="mb-3 flex items-start justify-between gap-3 rounded-lg bg-brand-n50 px-3 py-2.5">
            <div className="min-w-0">
              <strong className="block truncate text-sm text-brand-ink">
                {isCashIn ? '+' : '−'}
                {typeLabel} · {money(amount)}
              </strong>
              <span className="mt-0.5 block truncate text-[11px] text-brand-muted">{reason}</span>
            </div>
            {step === 'approve' && (
              <button
                type="button"
                className="shrink-0 border-0 bg-transparent p-0 text-[11px] font-bold text-brand-subtle underline underline-offset-2"
                onClick={() => {
                  setError('')
                  setStep('form')
                }}
              >
                Edit
              </button>
            )}
          </div>

          {step === 'waiting' && (
            <div className="mb-3">
              <ManagerWaitPanel
                secondsLeft={secondsLeft}
                totalSec={OPEN_DRAWER_WAIT_SEC}
                onProceedWithoutApproval={() => {
                  setAck(false)
                  setStep('self')
                }}
              />
            </div>
          )}

          {step === 'self' && (
            <div className="mb-3 rounded-lg border-2 border-brand-danger px-3.5 py-3">
              <strong className="block text-sm text-brand-danger">
                Proceed without approval
              </strong>
              <p className="m-0 mt-1 text-[11px] text-brand-muted">
                {offlineMode
                  ? isCashIn
                    ? 'Cash enters expected drawer now. Flagged for review; syncs when online.'
                    : 'Cash adjusts expected drawer now. Flagged for review; syncs when online.'
                  : isCashIn
                    ? 'Cash enters expected drawer now. Flagged for review at day end.'
                    : 'Cash adjusts expected drawer now. Flagged for review at day end.'}
              </p>
              <label className="mt-3 flex items-start gap-2 text-xs text-brand-ink">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                <span>I understand this is unapproved and will be flagged for review</span>
              </label>
              <PrimaryButton
                type="button"
                className="mt-3 w-full"
                disabled={busy || !ack}
                onClick={() => void submitSelfRecord()}
              >
                Submit unapproved
              </PrimaryButton>
            </div>
          )}

          <SupervisorPinPanel
            loginCode={loginCode}
            pin={pin}
            onLoginCode={setLoginCode}
            onPin={setPin}
            busy={busy}
            autoFocusCode={step === 'approve'}
            submitLabel={step === 'waiting' || step === 'self' ? 'Approve with PIN' : 'Approve'}
            hint={
              offlineMode
                ? 'Offline: verified on this device'
                : step === 'waiting' || step === 'self'
                  ? 'Still works while waiting'
                  : null
            }
            onSubmit={() =>
              void tryPinApprove(step === 'waiting' || step === 'self' ? movementId : null)
            }
          />

          {step === 'approve' && (
            <div className="mt-3">
              {offlineMode && (
                <p className="mb-2 text-[11px] text-brand-warn">
                  Offline: use a supervisor PIN on this device, or self-record (flagged). Both
                  sync when connection returns. Notify manager needs a connection.
                </p>
              )}
              {offlineMode ? (
                <button
                  type="button"
                  className="w-full border-0 bg-transparent py-2 text-center text-xs font-bold text-brand-danger underline underline-offset-2"
                  onClick={() => {
                    setError('')
                    setAck(false)
                    setStep('self')
                  }}
                >
                  No supervisor here? Proceed without approval
                </button>
              ) : !notifyConfirm ? (
                <button
                  type="button"
                  className="w-full border-0 bg-transparent py-2 text-center text-xs font-bold text-brand-muted underline underline-offset-2"
                  onClick={() => setNotifyConfirm(true)}
                >
                  No supervisor here? Notify manager
                </button>
              ) : (
                <div className="rounded-lg bg-brand-warn-bg px-3 py-3">
                  <p className="m-0 text-xs text-brand-warn">
                    Alert managers for this branch. First to respond Approves or Denies. Then wait
                    up to {OPEN_DRAWER_WAIT_SEC}s.
                  </p>
                  <div className="mt-2.5 flex gap-2">
                    <PrimaryButton
                      compact
                      type="button"
                      className="flex-1"
                      disabled={busy}
                      onClick={() => void confirmNotify()}
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

          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}

          {(step === 'approve' || step === 'waiting' || step === 'self') && (
            <ModalActions>
              <SecondaryButton type="button" disabled={busy} onClick={() => void handleClose()}>
                {step === 'waiting' || step === 'self' ? 'Cancel request' : 'Cancel'}
              </SecondaryButton>
            </ModalActions>
          )}
        </>
      )}

      {(step === 'done' || step === 'denied') && (
        <>
          <h2 className="mb-2 text-lg">{step === 'denied' ? 'Denied' : 'Done'}</h2>
          <p className="mb-4 text-sm text-brand-muted">{resultMsg}</p>
          <ModalActions>
            <PrimaryButton type="button" className="w-full sm:w-auto" onClick={handleClose}>
              Close
            </PrimaryButton>
          </ModalActions>
        </>
      )}
    </Modal>
  )
}
