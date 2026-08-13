import { useEffect, useMemo, useState } from 'react'
import {
  Eyebrow,
  Modal,
  ModalActions,
  PageSkeleton,
  SecondaryButton,
  StatusBadge,
  moneyClass,
  varianceToneClass,
} from '../ui'
import {
  CASH_MOVEMENT_COUNTING_STATUSES,
  fetchCashMovements,
  fetchPettyCashTimeline,
  fetchStaffShifts,
  hasSupabase,
} from '../../lib/api'
import { money } from '../../utils/format'

function timeLabel(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function movementTypeLabel(type) {
  if (type === 'pickup') return 'Cash pickup'
  if (type === 'cash_in') return 'Cash in'
  if (type === 'opening_float') return 'Opening float'
  return 'Paid-out'
}

function movementStatusLabel(status) {
  const map = {
    pending_remote: 'Waiting manager',
    approved: 'Approved',
    remote_approved: 'Approved',
    denied: 'Denied',
    self_recorded: 'Unauthorized',
    confirmed: 'Resolved',
    flagged_for_investigation: 'Flagged',
    voided: 'Cancelled',
  }
  return map[status] || status || '—'
}

function legacyKindLabel(row) {
  if (row.kind === 'change_fund') return 'Change fund'
  if (row.kind === 'pickup') return 'Cash pickup'
  if (row.status === 'pending') return 'Petty (pending)'
  if (row.status === 'rejected') return 'Petty (rejected)'
  if (row.status === 'approved') return 'Petty (approved, not handed over)'
  return 'Paid-out'
}

function statusTone(status) {
  if (status === 'closed') return 'success'
  if (status === 'submitted' || status === 'requested') return 'warn'
  if (status === 'rejected') return 'danger'
  return 'neutral'
}

/**
 * Manager BranchDashboard — full picture of one filed day-end: count vs expected,
 * shift cash-outs, and petty / pickup / cash-in for that business date.
 */
export default function DayEndClosingDetail({ entry, branchId, onClose }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [shifts, setShifts] = useState([])
  const [cashMovements, setCashMovements] = useState([])
  const [pettyTimeline, setPettyTimeline] = useState([])

  const date = entry?.date

  useEffect(() => {
    if (!entry || !date) return
    let active = true
    setLoading(true)
    setError('')
    Promise.all([
      hasSupabase && branchId
        ? fetchStaffShifts({ branchId, start: date, end: date }).catch(() => [])
        : Promise.resolve([]),
      hasSupabase && branchId
        ? fetchCashMovements({ branchId, start: date, end: date }).catch(() => [])
        : Promise.resolve([]),
      hasSupabase && branchId
        ? fetchPettyCashTimeline(branchId, { startDate: date, endDate: date }).catch(() => [])
        : Promise.resolve([]),
    ])
      .then(([shiftRows, moveRows, pettyRows]) => {
        if (!active) return
        setShifts(shiftRows || [])
        setCashMovements((moveRows || []).filter((row) => row && row.status !== 'voided'))
        setPettyTimeline(pettyRows || [])
      })
      .catch((err) => {
        if (active) setError(err.message || 'Could not load day-end detail.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [entry, branchId, date])

  const drawerRows = useMemo(() => {
    const moveRows = cashMovements.map((movement) => ({
      key: `m-${movement.id}`,
      sortAt: movement.requestedAt || movement.createdAt || '',
      source: 'movement',
      movement,
    }))
    const legacyRows = pettyTimeline.map((row) => ({
      key: `p-${row.id}`,
      sortAt: row.createdAt || '',
      source: 'legacy',
      row,
    }))
    return [...moveRows, ...legacyRows].sort((a, b) =>
      String(b.sortAt || '').localeCompare(String(a.sortAt || '')),
    )
  }, [cashMovements, pettyTimeline])

  const cashStats = useMemo(() => {
    const acc = pettyTimeline.reduce(
      (next, row) => {
        if (row.kind === 'change_fund') next.changeFund += Number(row.amount || 0)
        else if (row.kind === 'pickup') next.pickup += Number(row.amount || 0)
        else if (row.kind === 'paid_out' && row.status === 'fulfilled') {
          next.paidOut += Number(row.amount || 0)
        }
        return next
      },
      { changeFund: 0, pickup: 0, paidOut: 0 },
    )
    for (const row of cashMovements) {
      if (!CASH_MOVEMENT_COUNTING_STATUSES.includes(row.status)) continue
      if (row.type === 'pickup') acc.pickup += Number(row.amount || 0)
      else if (row.type === 'petty_cash') acc.paidOut += Number(row.amount || 0)
      else if (row.type === 'cash_in' || row.type === 'opening_float') {
        acc.changeFund += Number(row.amount || 0)
      }
    }
    return acc
  }, [pettyTimeline, cashMovements])

  if (!entry) return null

  const expected = Number(entry.expectedCash || entry.recordedCash || 0)
  const counted = Number(entry.cashOnHand || 0)
  const variance = Number(entry.variance || 0)
  const report = entry.dayReport

  return (
    <Modal xl onClose={onClose}>
      <Eyebrow>DAY-END CLOSING</Eyebrow>
      <h2 className="mb-1 text-[22px] max-[700px]:text-lg">{entry.date}</h2>
      <p className="m-0 mb-3 text-xs text-brand-muted">
        {entry.closedAt ? `Closed ${entry.closedAt}` : entry.submittedAt ? `Submitted ${entry.submittedAt}` : '—'}
        {entry.cashier ? ` · ${entry.cashier}` : ''}
      </p>
      <div className="mb-3">
        <StatusBadge compact tone={statusTone(entry.status)}>
          {entry.status || 'closed'}
        </StatusBadge>
      </div>

      {error && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>
      )}

      {loading ? (
        <PageSkeleton variant="detail" />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-3 gap-2 max-[700px]:grid-cols-1">
            <div className="rounded-md bg-brand-n100 px-3 py-2.5">
              <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Expected
              </span>
              <strong className={`text-sm ${moneyClass}`}>{money(expected)}</strong>
            </div>
            <div className="rounded-md bg-brand-n100 px-3 py-2.5">
              <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Counted
              </span>
              <strong className={`text-sm ${moneyClass}`}>{money(counted)}</strong>
            </div>
            <div className="rounded-md bg-brand-n100 px-3 py-2.5">
              <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Variance
              </span>
              <strong className={`text-sm ${moneyClass} ${varianceToneClass(variance)}`}>
                {money(variance)}
              </strong>
            </div>
          </div>

          {entry.note ? (
            <p className="mb-4 rounded-md border border-brand-softline bg-brand-n50 px-3 py-2 text-xs text-brand-muted">
              <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Note
              </span>
              {entry.note}
            </p>
          ) : null}

          {report && (report.orderCount > 0 || report.revenue > 0) && (
            <p className="mb-4 text-xs text-brand-muted">
              Sales snapshot: {report.orderCount || 0} paid order
              {report.orderCount === 1 ? '' : 's'} · {money(report.revenue || 0)}
              {Number(report.refunded || 0) > 0 ? ` · ${money(report.refunded)} refunded` : ''}
            </p>
          )}

          <h3 className="m-0 mb-1.5 text-[11px] font-bold tracking-wide text-brand-label uppercase">
            Shift cash-outs
          </h3>
          <div className="mb-4 overflow-hidden rounded-md border border-brand-softline">
            <div className="grid grid-cols-[minmax(0,1.2fr)_5.5rem_5.5rem_5.5rem] gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[minmax(0,1fr)_5rem]">
              <span>Staff</span>
              <span className="text-right max-[700px]:hidden">Start</span>
              <span className="text-right">Ended</span>
              <span className="text-right max-[700px]:hidden">Variance</span>
            </div>
            {shifts.map((row) => (
              <div
                key={row.id}
                className="grid grid-cols-[minmax(0,1.2fr)_5.5rem_5.5rem_5.5rem] gap-2 border-t border-brand-softline px-3 py-2.5 text-xs max-[700px]:grid-cols-[minmax(0,1fr)_5rem]"
              >
                <div className="min-w-0">
                  <strong className="block truncate text-brand-ink">{row.staffName || 'Staff'}</strong>
                  <small className="block truncate text-[10px] text-brand-subtle">
                    {row.drawerLabel || row.drawerId || 'Drawer'}
                    {row.clockIn ? ` · in ${timeLabel(row.clockIn)}` : ''}
                    {row.clockOut ? ` · out ${timeLabel(row.clockOut)}` : ' · still open'}
                    {row.closeNote ? ` · ${row.closeNote}` : ''}
                  </small>
                </div>
                <span className={`text-right max-[700px]:hidden ${moneyClass}`}>
                  {row.startingCash == null ? '—' : money(row.startingCash)}
                </span>
                <span className={`text-right ${moneyClass}`}>
                  {row.endingCash == null ? (row.open ? 'Open' : '—') : money(row.endingCash)}
                </span>
                <span
                  className={`text-right max-[700px]:hidden ${moneyClass} ${
                    row.variance == null ? '' : varianceToneClass(row.variance)
                  }`}
                >
                  {row.variance == null ? '—' : money(row.variance)}
                </span>
              </div>
            ))}
            {shifts.length === 0 && (
              <div className="px-3 py-4 text-xs text-brand-subtle">No shifts recorded for this business day.</div>
            )}
          </div>

          <h3 className="m-0 mb-1.5 text-[11px] font-bold tracking-wide text-brand-label uppercase">
            Cash drawer · petty / pickups
          </h3>
          <div className="mb-1 grid grid-cols-3 gap-2 max-[700px]:grid-cols-1">
            <div className="rounded-md border border-brand-softline px-3 py-2 text-xs">
              <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Change fund
              </span>
              <strong className={moneyClass}>{money(cashStats.changeFund)}</strong>
            </div>
            <div className="rounded-md border border-brand-softline px-3 py-2 text-xs">
              <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Cash pickups
              </span>
              <strong className={moneyClass}>{money(cashStats.pickup)}</strong>
            </div>
            <div className="rounded-md border border-brand-softline px-3 py-2 text-xs">
              <span className="block text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Paid-out
              </span>
              <strong className={moneyClass}>{money(cashStats.paidOut)}</strong>
            </div>
          </div>
          <div className="overflow-hidden rounded-md border border-brand-softline">
            <div className="grid grid-cols-[4.5rem_minmax(0,1fr)_5.5rem_minmax(0,1.2fr)] gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[4.5rem_minmax(0,1fr)_5.5rem]">
              <span>Time</span>
              <span>Type</span>
              <span className="text-right">Amount</span>
              <span className="max-[700px]:hidden">Who / note</span>
            </div>
            {drawerRows.map((entryRow) => {
              if (entryRow.source === 'movement') {
                const row = entryRow.movement
                return (
                  <div
                    key={entryRow.key}
                    className="grid grid-cols-[4.5rem_minmax(0,1fr)_5.5rem_minmax(0,1.2fr)] gap-2 border-t border-brand-softline px-3 py-2.5 text-xs max-[700px]:grid-cols-[4.5rem_minmax(0,1fr)_5.5rem]"
                  >
                    <span className="text-brand-slate">{timeLabel(row.requestedAt || row.createdAt)}</span>
                    <strong className="min-w-0 truncate text-brand-ink">
                      {movementTypeLabel(row.type)}
                      <span className="mt-0.5 block text-[10px] font-normal text-brand-subtle">
                        {movementStatusLabel(row.status)}
                      </span>
                    </strong>
                    <span className={`text-right ${moneyClass}`}>{money(row.amount)}</span>
                    <span
                      className="min-w-0 truncate text-brand-slate max-[700px]:hidden"
                      title={[row.requestedByName, row.reason, row.reviewNotes].filter(Boolean).join(' · ')}
                    >
                      {row.requestedByName || '—'}
                      {row.reason ? ` · ${row.reason}` : ''}
                    </span>
                  </div>
                )
              }
              const row = entryRow.row
              return (
                <div
                  key={entryRow.key}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)_5.5rem_minmax(0,1.2fr)] gap-2 border-t border-brand-softline px-3 py-2.5 text-xs max-[700px]:grid-cols-[4.5rem_minmax(0,1fr)_5.5rem]"
                >
                  <span className="text-brand-slate">{timeLabel(row.createdAt)}</span>
                  <strong className="min-w-0 truncate text-brand-ink">{legacyKindLabel(row)}</strong>
                  <span className={`text-right ${moneyClass}`}>{money(row.amount)}</span>
                  <span
                    className="min-w-0 truncate text-brand-slate max-[700px]:hidden"
                    title={[row.staffName, row.reason, row.receiptRef].filter(Boolean).join(' · ')}
                  >
                    {row.staffName || '—'}
                    {row.reason ? ` · ${row.reason}` : ''}
                    {row.receiptRef ? ` · ${row.receiptRef}` : ''}
                  </span>
                </div>
              )
            })}
            {drawerRows.length === 0 && (
              <div className="px-3 py-4 text-xs text-brand-subtle">
                No petty cash, pickups, or cash-in recorded for this business day.
              </div>
            )}
          </div>
        </>
      )}

      <ModalActions>
        <SecondaryButton compact type="button" onClick={onClose}>
          Close
        </SecondaryButton>
      </ModalActions>
    </Modal>
  )
}
