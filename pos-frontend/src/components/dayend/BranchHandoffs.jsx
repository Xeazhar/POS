import { useEffect, useMemo, useState } from 'react'
import { PrimaryButton, SectionHeading, StatusBadge, TableCard, moneyClass, tableRowDenseClass } from '../ui'
import { confirmDayEndHandoff, fetchShiftAdjustments, receiveShiftHandoff } from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { money } from '../../utils/format'
import { isManagerRole } from '../../utils/roles'

const FILTER_SELECT_CLASS = 'h-7 rounded border border-brand-line bg-brand-card px-1.5 text-[10px] font-medium text-brand-ink'

/**
 * A branch's cash-custody trail as one filterable table — every drawer-to-drawer handoff,
 * both legs:
 *   - Cashier → supervisor (or → manager, when no supervisor was on-site to receive it —
 *     see RemoteDayEndClose.jsx): a drawer shift, confirmed via `receiveShiftHandoff`.
 *   - Supervisor → manager: a closed day_end's cash total, confirmed via
 *     `confirmDayEndHandoff` — no deadline, pure record-keeping.
 * Both legs can be confirmed from here, whenever the cash actually changes hands.
 */
function BranchHandoffs({ dayEnds = [], staffShifts = [], currentStaffId = null, onReload }) {
  const shiftRows = useMemo(
    () => (staffShifts || []).filter((row) => row.holdsDrawer && !row.open),
    [staffShifts],
  )
  const shiftIds = useMemo(
    () => shiftRows.map((row) => row.serverId || row.id).filter(Boolean),
    [shiftRows],
  )
  const shiftIdsKey = shiftIds.join(',')

  const [adjustments, setAdjustments] = useState([])
  useEffect(() => {
    let cancelled = false
    if (!shiftIds.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const [typeFilter, setTypeFilter] = useState('all') // all | shift | dayend
  const [statusFilter, setStatusFilter] = useState('all') // all | pending | confirmed

  const rows = useMemo(() => {
    const shift = shiftRows.map((row) => {
      const received = receivedByShiftId.get(row.serverId || row.id)
      const confirmed = row.endingCash != null
      const receiverIsManager = confirmed && isManagerRole(received?.adjustedByRole)
      return {
        key: `shift:${row.serverId || row.id}`,
        actionId: row.serverId || row.id,
        type: 'shift',
        date: row.businessDate || '—',
        direction: confirmed ? (receiverIsManager ? 'Cashier → Manager' : 'Cashier → Supervisor') : 'Cashier → Supervisor',
        person: row.staffName || 'Cashier',
        amount: confirmed ? row.endingCash : null,
        status: confirmed ? 'confirmed' : 'pending',
        confirmedBy: received?.adjustedByName || '',
        sortAt: row.clockOut || row.businessDate || '',
      }
    })
    const dayend = (dayEnds || [])
      .filter((row) => row.status === 'closed')
      .map((row) => ({
        key: `dayend:${row.id}`,
        actionId: row.id,
        type: 'dayend',
        date: row.date || '—',
        direction: 'Supervisor → Manager',
        person: row.cashier || 'Supervisor',
        amount: row.cashOnHand,
        status: row.handoffConfirmedAt ? 'confirmed' : 'pending',
        confirmedBy: row.handoffConfirmedByName || '',
        sortAt: row.date || '',
      }))
    return [...shift, ...dayend].sort((a, b) => String(b.sortAt).localeCompare(String(a.sortAt)))
  }, [shiftRows, receivedByShiftId, dayEnds])

  const filteredRows = rows.filter(
    (row) => (typeFilter === 'all' || row.type === typeFilter) && (statusFilter === 'all' || row.status === statusFilter),
  )

  const [selected, setSelected] = useState(() => new Set())
  const toggle = (key) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const confirmSelected = async () => {
    if (!selected.size) return
    setBusy(true)
    setError('')
    try {
      for (const row of filteredRows) {
        if (!selected.has(row.key)) continue
        if (row.type === 'shift') {
          await receiveShiftHandoff({ shiftId: row.actionId, receivedBy: currentStaffId })
        } else {
          await confirmDayEndHandoff(row.actionId)
        }
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
    <TableCard className="max-h-none overflow-hidden">
      <SectionHeading
        title="Cash handoffs"
        meta={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <select className={FILTER_SELECT_CLASS} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All legs</option>
              <option value="shift">Cashier → supervisor/manager</option>
              <option value="dayend">Supervisor → manager</option>
            </select>
            <select className={FILTER_SELECT_CLASS} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">All statuses</option>
              <option value="pending">Pending</option>
              <option value="confirmed">Confirmed</option>
            </select>
          </div>
        }
        subtitle="Every drawer-to-drawer cash handoff for this branch — confirm whenever the cash actually changes hands, no deadline"
      />
      <div className="grid grid-cols-[5.5rem_minmax(0,1.3fr)_minmax(0,1fr)_5.5rem_6.5rem_2rem] items-center gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[900px]:grid-cols-[5.5rem_minmax(0,1fr)_5.5rem_2rem]">
        <span>Date</span>
        <span className="max-[900px]:hidden">Direction</span>
        <span>Person</span>
        <span className="text-right">Amount</span>
        <span className="max-[900px]:hidden">Status</span>
        <span />
      </div>
      {filteredRows.length === 0 && <div className="px-4 py-6 text-xs text-brand-subtle">No handoffs match this filter.</div>}
      {filteredRows.map((row) => (
        <div
          key={row.key}
          className={`grid grid-cols-[5.5rem_minmax(0,1.3fr)_minmax(0,1fr)_5.5rem_6.5rem_2rem] items-center gap-2 text-xs max-[900px]:grid-cols-[5.5rem_minmax(0,1fr)_5.5rem_2rem] ${tableRowDenseClass}`}
        >
          <span className="truncate text-brand-ink">{row.date}</span>
          <span className="truncate text-brand-muted max-[900px]:hidden">{row.direction}</span>
          <div className="min-w-0">
            <span className="block truncate text-brand-ink">{row.person}</span>
            <small className="block truncate text-[10px] text-brand-subtle max-[900px]:block">
              {row.direction}
              {row.status === 'confirmed' && row.confirmedBy ? ` · received by ${row.confirmedBy}` : ''}
            </small>
          </div>
          <span className={`text-right ${moneyClass}`}>{row.amount == null ? '—' : money(row.amount)}</span>
          <span className="max-[900px]:hidden">
            <StatusBadge compact tone={row.status === 'confirmed' ? 'success' : 'warn'}>
              {row.status === 'confirmed' ? 'Confirmed' : 'Pending'}
            </StatusBadge>
          </span>
          <span className="text-right">
            {row.status === 'pending' && (
              <input type="checkbox" checked={selected.has(row.key)} onChange={() => toggle(row.key)} />
            )}
          </span>
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 border-t border-brand-softline px-4 py-3">
        {error && <p className="m-0 text-xs text-brand-danger">{error}</p>}
        <PrimaryButton
          compact
          type="button"
          disabled={busy || !selected.size}
          onClick={() => void confirmSelected()}
          className="ml-auto"
        >
          {busy ? 'Confirming…' : `Confirm received (${selected.size})`}
        </PrimaryButton>
      </div>
    </TableCard>
  )
}

export default BranchHandoffs
