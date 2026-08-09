import { useEffect, useState } from 'react'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PrimaryButton,
  SecondaryButton,
  moneyClass,
  varianceToneClass,
} from '../ui'
import { useShiftStore } from '../../stores/shiftStore'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'
import { decimalOnly } from '../../utils/validate'

/**
 * Cash out: count the drawer, end the shift, hand it over.
 *
 * The expected figure is fetched, not typed — the cashier being counted does not get to
 * supply the number they are counted against. Offline it falls back to what this device
 * knows and says so, because a sale rung on another terminal against the same shift would
 * not be in the local total.
 */
function ShiftCashOut({ user, shift, onCancel, onDone }) {
  const cashPosition = useShiftStore((state) => state.cashPosition)
  const endShift = useShiftStore((state) => state.endShift)

  const [position, setPosition] = useState(null)
  const [loading, setLoading] = useState(true)
  const [counted, setCounted] = useState('')
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

  const expected = position ? Number(position.expectedCash || 0) : null
  const countedNumber = Number(counted || 0)
  const variance = expected == null || counted === '' ? null : Number((countedNumber - expected).toFixed(2))
  const noteRequired = variance != null && variance !== 0
  const estimateOnly = position?.source === 'local'

  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      await endShift(user, { endingCash: countedNumber, note })
      await onDone?.()
    } catch (err) {
      setError(formatSupportError(err, 'SHIFT01'))
      setBusy(false)
    }
  }

  return (
    <Modal wide onClose={() => !busy && onCancel?.()}>
      <Eyebrow>CASH OUT</Eyebrow>
      <h2 className="mb-1 text-lg">End shift · {shift.drawerLabel || 'drawer'}</h2>
      <p className="m-0 text-xs text-brand-muted">
        Count everything in the drawer, including the change fund. Once this is submitted the
        shift is closed and only a supervisor can correct it — as a logged adjustment, never a
        silent edit.
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
          <span className="font-bold">Drawer should hold</span>
          <strong className={`text-right font-bold ${moneyClass}`}>{money(expected)}</strong>
        </div>
      )}

      {estimateOnly && (
        <p className="mb-3 rounded-md bg-brand-warn-bg px-2.5 py-2 text-[11px] text-brand-warn">
          Offline — this total covers sales made on this device only. The server recalculates it
          when the shift syncs, so the final variance may differ.
        </p>
      )}

      <Field
        label="Cash counted in the drawer"
        value={counted}
        onChange={(e) => {
          setCounted(decimalOnly(e.target.value))
          setError('')
        }}
        inputMode="decimal"
        required
        placeholder="0.00"
      />

      {variance != null && (
        <p className="mt-2 text-[13px]">
          Variance{' '}
          <strong className={`${moneyClass} ${varianceToneClass(variance)}`}>{money(variance)}</strong>{' '}
          <span className="text-brand-subtle">
            {variance === 0 ? '· balanced' : variance < 0 ? '· short' : '· over'}
          </span>
        </p>
      )}

      <Field
        className="mt-3"
        label={noteRequired ? 'Note (required — drawer does not balance)' : 'Note'}
        value={note}
        onChange={(e) => setNote(e.target.value.replace(/[<>]/g, ''))}
        placeholder={noteRequired ? 'Explain the difference' : 'Optional'}
      />

      {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
      <ModalActions>
        <SecondaryButton compact type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </SecondaryButton>
        <PrimaryButton
          compact
          type="button"
          disabled={busy || counted === '' || (noteRequired && !note.trim())}
          onClick={() => void submit()}
        >
          {busy ? 'Closing…' : 'End shift'}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}

export default ShiftCashOut
