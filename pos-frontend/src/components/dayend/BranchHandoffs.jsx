import { useEffect, useMemo, useState } from 'react'
import { TableCard, PrimaryButton } from '../ui'
import { confirmDayEndHandoff, fetchShiftAdjustments } from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'

/**
 * Two read/act sections for a branch's cash custody trail:
 *   - Cashier → supervisor: read-only. A drawer shift only carries `endingCash` once a
 *     supervisor has already run Confirm received handoff at Day End — so every row here
 *     is already confirmed by construction, nothing left to act on.
 *   - Supervisor → manager: each closed day_end's cash total, individually checkable,
 *     confirmed via confirmDayEndHandoff — no deadline, no blocking, pure record-keeping.
 */
function BranchHandoffs({ dayEnds = [], staffShifts = [], onReload }) {
  const shiftHandoffs = useMemo(
    () =>
      (staffShifts || [])
        .filter((row) => row.holdsDrawer && !row.open && row.endingCash != null)
        .sort((a, b) => new Date(b.clockOut || 0) - new Date(a.clockOut || 0)),
    [staffShifts],
  )
  const shiftIds = useMemo(
    () => shiftHandoffs.map((row) => row.serverId || row.id).filter(Boolean),
    [shiftHandoffs],
  )
  const shiftIdsKey = shiftIds.join(',')

  const [adjustments, setAdjustments] = useState([])
  useEffect(() => {
    let cancelled = false
    if (!shiftIds.length) {
      setAdjustments([])
      return undefined
    }
    fetchShiftAdjustments(shiftIds).then((rows) => {
      if (!cancelled) setAdjustments(rows)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftIdsKey])

  const receivedByShiftId = useMemo(() => {
    const map = new Map()
    for (const row of adjustments) {
      if (row.field !== 'ending_cash') continue
      if (!map.has(row.shiftId)) map.set(row.shiftId, row)
    }
    return map
  }, [adjustments])

  const dayEndHandoffs = useMemo(() => (dayEnds || []).filter((row) => row.status === 'closed'), [dayEnds])

  const [selected, setSelected] = useState(() => new Set())
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const confirmSelected = async () => {
    if (!selected.size) return
    setBusy(true)
    setError('')
    try {
      for (const id of selected) {
        await confirmDayEndHandoff(id)
      }
      setSelected(new Set())
      await onReload?.()
    } catch (err) {
      setError(formatSupportError(err, 'TILL05'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <TableCard className="mb-3.5 max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Cashier → supervisor</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Drawer shifts a supervisor already confirmed received at Day End. Read-only —
          confirm this from Day end, not here.
        </p>
        {shiftHandoffs.length === 0 ? (
          <p className="m-0 text-xs text-brand-subtle">No received handoffs yet.</p>
        ) : (
          <ul className="m-0 list-disc space-y-1 pl-5 text-xs text-brand-muted">
            {shiftHandoffs.map((row) => {
              const received = receivedByShiftId.get(row.serverId || row.id)
              return (
                <li key={row.id}>
                  {row.staffName} · {row.businessDate} · {money(row.endingCash)}
                  {received ? ` · received by ${received.adjustedByName || 'supervisor'}` : ''}
                </li>
              )
            })}
          </ul>
        )}
      </TableCard>

      <TableCard className="max-h-none p-5">
        <h2 className="m-0 mb-1 text-base">Supervisor → manager</h2>
        <p className="m-0 mb-3 text-xs text-brand-muted">
          Closed business days for this branch. Select the ones you have physically
          received cash for — no deadline, confirm whenever the cash actually arrives.
        </p>
        {dayEndHandoffs.length === 0 ? (
          <p className="m-0 text-xs text-brand-subtle">No closed days yet.</p>
        ) : (
          <ul className="m-0 mb-3 space-y-1.5 text-xs">
            {dayEndHandoffs.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-2 border-b border-brand-softline pb-1.5"
              >
                <label className="flex min-w-0 items-center gap-2">
                  {!row.handoffConfirmedAt && (
                    <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                  )}
                  <span className="truncate text-brand-ink">{row.date}</span>
                </label>
                <span className="shrink-0 text-brand-muted">
                  {money(row.cashOnHand)}
                  {row.handoffConfirmedAt
                    ? ` · received by ${row.handoffConfirmedByName || 'manager'}`
                    : ' · pending'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="mb-2 text-xs text-brand-danger">{error}</p>}
        <PrimaryButton compact type="button" disabled={busy || !selected.size} onClick={() => void confirmSelected()}>
          {busy ? 'Confirming…' : `Confirm received (${selected.size})`}
        </PrimaryButton>
      </TableCard>
    </div>
  )
}

export default BranchHandoffs
