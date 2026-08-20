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
import {
  fetchCashMovements,
  fetchPettyCash,
  fetchSoldLineItems,
  fetchStaffShifts,
  submitDayEnd,
} from '../../lib/api'
import { computeDayEndFigures, countUnreviewedSelfRecorded } from '../../utils/dayEndClose'
import { buildDayEndReport } from '../../utils/dayEndReport'
import { formatSupportError } from '../../utils/errors'
import { money, rowBusinessDate } from '../../utils/format'
import { decimalOnly, formatMoneyOnBlur } from '../../utils/validate'

/**
 * Lets a manager who is NOT physically at the branch close a "request manager" day end —
 * cash figures reported by phone from whoever is on-site, instead of counting in person.
 * Server-side `submit_day_end` already allows a manager to act cross-branch
 * (`is_manager()`); this is the client screen for that path. Reuses the exact same money
 * math as the on-site counting screen (`computeDayEndFigures`, `DayEnd.jsx`) and enforces
 * the same open-shift / pending-handoff / unreviewed-movement gates — no fiscal control is
 * skipped just because the manager isn't standing at the till.
 */
export default function RemoteDayEndClose({
  branchId,
  dayOpenHour,
  isRestaurant,
  date,
  entry,
  products,
  transactions,
  staffId,
  onClose,
  onSubmitted,
}) {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [movements, setMovements] = useState([])
  const [shifts, setShifts] = useState([])
  const [petty, setPetty] = useState([])
  const [soldItemRows, setSoldItemRows] = useState([])
  const [cashOnHand, setCashOnHand] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError('')
    const windowStart = new Date(`${date}T00:00:00`)
    windowStart.setDate(windowStart.getDate() - 1)
    const windowEnd = new Date(`${date}T00:00:00`)
    windowEnd.setDate(windowEnd.getDate() + 2)
    Promise.all([
      fetchCashMovements({ branchId, start: date, end: date }),
      fetchStaffShifts({ branchId, start: date, end: date }),
      fetchPettyCash(branchId, date),
      fetchSoldLineItems({ branchId, startIso: windowStart.toISOString(), endIso: windowEnd.toISOString() }),
    ])
      .then(([moveRows, shiftRows, pettyRows, soldRows]) => {
        if (!active) return
        setMovements(moveRows || [])
        setShifts(shiftRows || [])
        setPetty(pettyRows || [])
        setSoldItemRows((soldRows || []).filter((row) => rowBusinessDate(row, dayOpenHour) === date))
      })
      .catch((err) => {
        if (active) setLoadError(err.message || 'Could not load day-end data for that branch.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [branchId, date, dayOpenHour])

  const {
    recorded,
    cashSales,
    cardSales,
    ewalletSales,
    expectedCash,
    openDrawerShifts,
    pendingHandoffs,
    pettyCashHandedOver,
  } = computeDayEndFigures({ transactions, movements, shifts, petty, date, dayOpenHour })

  const unreviewedMoves = countUnreviewedSelfRecorded(movements)
  const hasCashOnHand = cashOnHand !== ''
  const variance = Number(cashOnHand || 0) - expectedCash
  const noteRequired = hasCashOnHand && variance !== 0

  // Pending shift handoffs do NOT block a remote close — that gate exists to make a
  // supervisor confirm receiving the drawer before Close Day, but there is no supervisor
  // on-site in this flow (that is the whole reason it's remote). The shift simply stays
  // pending (`ending_cash` null) and surfaces on the branch's Handoffs tab as a
  // cashier → manager handoff still owed, confirmable there whenever it's actually handed
  // over — same no-deadline pattern as the existing supervisor → manager handoff.
  const blockedReason = openDrawerShifts.length
    ? `${openDrawerShifts.length} open cashier shift${openDrawerShifts.length === 1 ? '' : 's'} at that branch — must be ended on-site first.`
    : unreviewedMoves
      ? `${unreviewedMoves} cash movement${unreviewedMoves === 1 ? '' : 's'} still need review on-site first.`
      : ''

  const handleSubmit = async () => {
    setError('')
    if (noteRequired && !note.trim()) {
      setError('A note is required when variance is not zero.')
      return
    }
    setBusy(true)
    try {
      const dayReport = buildDayEndReport({
        date,
        transactions,
        soldItemRows,
        products,
        isRestaurant,
        dayOpenHour,
      })
      await submitDayEnd({
        branchId,
        staffId,
        entry: {
          id: entry?.id,
          date,
          recordedCash: recorded,
          cashOnHand: Number(cashOnHand || 0),
          variance,
          expectedCash,
          note: [note.trim(), pettyCashHandedOver ? `Petty cash ${pettyCashHandedOver}` : '']
            .filter(Boolean)
            .join(' · '),
          dayReport: { ...dayReport, pettyCashTotal: pettyCashHandedOver, expectedCash },
        },
      })
      onSubmitted?.()
    } catch (err) {
      setError(formatSupportError(err, 'TILL02'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal wide onClose={onClose}>
      <Eyebrow>REMOTE COUNT &amp; CLOSE</Eyebrow>
      <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Close day end for {date}</h2>
      <p className="mb-3 text-xs text-brand-muted">
        Enter the cash figure reported by phone from the branch. This closes the day the same
        as counting in person — the same gates and math apply.
      </p>
      {loading ? (
        <p className="text-xs text-brand-muted">Loading branch figures…</p>
      ) : loadError ? (
        <p className="text-xs text-brand-danger">{loadError}</p>
      ) : (
        <>
          {blockedReason && (
            <p className="mb-3 rounded-md bg-brand-warn-bg px-3 py-2 text-xs text-brand-warn">{blockedReason}</p>
          )}
          {pendingHandoffs.length > 0 && (
            <p className="mb-3 rounded-md bg-brand-n200 px-3 py-2 text-xs text-brand-muted">
              {pendingHandoffs.length} shift{pendingHandoffs.length === 1 ? '' : 's'} still waiting on handoff
              confirmation — this stays open as a cashier → manager handoff on the Handoffs tab, confirm it there
              once the cash actually changes hands. It does not block closing the day.
            </p>
          )}
          <div className="mb-3">
            <span className="block text-[11px] text-brand-subtle">Recorded sales (POS)</span>
            <strong className={`my-1 block text-[20px] ${moneyClass} text-brand-ink`}>{money(recorded)}</strong>
            <small className="block text-[11px] text-brand-subtle">
              Cash {money(cashSales)} · Card {money(cardSales)} · E-wallet {money(ewalletSales)} · Expected in
              drawer {money(expectedCash)}
            </small>
          </div>
          <Field
            label="Cash on hand (reported)"
            inputMode="decimal"
            value={cashOnHand}
            onChange={(event) => setCashOnHand(decimalOnly(event.target.value))}
            onBlur={(event) => setCashOnHand(formatMoneyOnBlur(event.target.value))}
            placeholder="0.00"
            disabled={Boolean(blockedReason)}
          />
          {hasCashOnHand && (
            <p className={`mt-1 text-xs font-bold ${varianceToneClass(variance)}`}>Variance {money(variance)}</p>
          )}
          <Field
            label={noteRequired ? 'Note (required — variance is not zero)' : 'Note (optional)'}
            value={note}
            onChange={(event) => setNote(event.target.value.replace(/[<>]/g, ''))}
            placeholder="e.g. counted and read over the phone by the supervisor"
            disabled={Boolean(blockedReason)}
          />
          {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
        </>
      )}
      <ModalActions>
        <SecondaryButton compact type="button" onClick={onClose}>
          Cancel
        </SecondaryButton>
        <PrimaryButton
          compact
          type="button"
          disabled={loading || Boolean(loadError) || Boolean(blockedReason) || !hasCashOnHand || busy}
          onClick={handleSubmit}
        >
          {busy ? 'Closing…' : 'Close day'}
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}
