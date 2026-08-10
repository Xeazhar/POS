import { useEffect, useState } from 'react'
import { Eyebrow, Field, Modal, ModalActions, PrimaryButton, SecondaryButton, moneyClass } from '../ui'
import { cashPositionNotice, useShiftStore } from '../../stores/shiftStore'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'

/**
 * End shift: a plain clock-out. No cash count, no supervisor witness — the drawer is
 * counted once per business day now, at Day End, not once per shift boundary. The
 * cash-sales-so-far figures below are shown as a courtesy (offline estimates may be
 * incomplete — a sale rung on another terminal against this shift is not in the local
 * total) — they are informational, not something the cashier has to confirm to proceed.
 */
function ShiftCashOut({ user, shift, onCancel, onDone }) {
  const cashPosition = useShiftStore((state) => state.cashPosition)
  const endShift = useShiftStore((state) => state.endShift)

  const [position, setPosition] = useState(null)
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    cashPosition()
      .then((result) => {
        if (active) setPosition(result)
      })
      .catch(() => {
        if (active) setPosition(null)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [cashPosition])

  const notice = cashPositionNotice(position)

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await endShift(user, { note })
      await onDone?.()
    } catch (err) {
      setError(formatSupportError(err, 'SHIFT01'))
      setBusy(false)
    }
  }

  return (
    <Modal wide onClose={() => !busy && onCancel?.()}>
      <Eyebrow>END SHIFT</Eyebrow>
      <h2 className="mb-1 text-lg">End shift · {shift.drawerLabel || 'drawer'}</h2>
      <p className="m-0 text-xs text-brand-muted">
        This just clocks you out — the drawer is not counted here. Cash gets counted once for
        the whole business day, at Day End.
      </p>

      {loading ? (
        <p className="mt-4 text-xs text-brand-subtle">Totalling this shift…</p>
      ) : (
        <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2 border-y border-brand-n300 py-3 text-[13px]">
          <span>Change fund in</span>
          <strong className={`text-right ${moneyClass}`}>{money(position?.startingCash)}</strong>
          <span>Cash sales</span>
          <strong className={`text-right ${moneyClass}`}>{money(position?.cashSales)}</strong>
          {Number(position?.cashRefunds || 0) > 0 && (
            <>
              <span>Refunds / voids</span>
              <strong className={`text-right ${moneyClass}`}>−{money(position?.cashRefunds)}</strong>
            </>
          )}
          {Number(position?.cashPaidOut || 0) > 0 && (
            <>
              <span>Paid out</span>
              <strong className={`text-right ${moneyClass}`}>−{money(position?.cashPaidOut)}</strong>
            </>
          )}
          {Number(position?.cashPickups || 0) > 0 && (
            <>
              <span>Pickups to safe</span>
              <strong className={`text-right ${moneyClass}`}>−{money(position?.cashPickups)}</strong>
            </>
          )}
        </div>
      )}

      {notice && (
        <p
          className={`mb-3 rounded-md px-2.5 py-2 text-[11px] ${
            notice.tone === 'warn' ? 'bg-brand-warn-bg text-brand-warn' : 'bg-brand-n50 text-brand-muted'
          }`}
        >
          {notice.text}
        </p>
      )}

      <Field
        label="Note"
        value={note}
        onChange={(e) => setNote(e.target.value.replace(/[<>]/g, ''))}
        placeholder="Optional"
      />

      {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
      <ModalActions>
        <SecondaryButton compact type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </SecondaryButton>
        <PrimaryButton compact type="button" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Ending…' : 'End shift'}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}

export default ShiftCashOut
