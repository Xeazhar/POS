import { useEffect, useMemo, useState } from 'react'
import {
  ErrorBanner,
  Field,
  PageHeader,
  SecondaryButton,
  SelectField,
  SkeletonRows,
  StatusBadge,
  TableCard,
  tableRowClass,
} from '../components/ui'
import { fetchBranches, fetchStaffShifts, hasSupabase } from '../lib/api'
import { useAuthStore } from '../stores/posStore'
import { formatSupportError } from '../utils/errors'
import { today } from '../utils/format'
import { isManagerRole } from '../utils/roles'

function formatWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(clockIn, clockOut) {
  if (!clockIn) return '—'
  const start = new Date(clockIn).getTime()
  const end = clockOut ? new Date(clockOut).getTime() : Date.now()
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return '—'
  const mins = Math.round((end - start) / 60000)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  if (h <= 0) return `${m}m`
  return `${h}h ${m}m`
}

function Shifts() {
  const user = useAuthStore((state) => state.user)
  const isManager = isManagerRole(user?.role)
  const lockedBranchId = isManager ? null : user?.branchId || null

  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState(lockedBranchId || '')
  const [start, setStart] = useState(today())
  const [end, setEnd] = useState(today())
  const [status, setStatus] = useState('all') // all | open | closed
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!hasSupabase || !isManager) return
    fetchBranches()
      .then(setBranches)
      .catch((err) => setError(formatSupportError(err, 'SHIFT01')))
  }, [isManager])

  const load = async () => {
    setError('')
    setLoading(true)
    try {
      if (!hasSupabase) {
        setRows([])
        setError('Connect Supabase to view shifts.')
        return
      }
      const effectiveBranch = lockedBranchId || branchId || null
      if (!isManager && !effectiveBranch) {
        setRows([])
        setError('No branch assigned to this account.')
        return
      }
      const data = await fetchStaffShifts({
        branchId: effectiveBranch,
        start: start || null,
        end: end || null,
      })
      setRows(data)
    } catch (err) {
      setError(formatSupportError(err, 'SHIFT01'))
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on filter identity
  }, [lockedBranchId, branchId, start, end, isManager])

  const visible = useMemo(() => {
    if (status === 'open') return rows.filter((r) => r.open)
    if (status === 'closed') return rows.filter((r) => !r.open)
    return rows
  }, [rows, status])

  const openCount = rows.filter((r) => r.open).length

  return (
    <div>
      <PageHeader
        eyebrow={isManager ? 'ALL BRANCHES' : 'BRANCH'}
        title="Staff shifts"
      >
        <span className="text-xs text-brand-subtle">
          {isManager
            ? 'Clock-in / clock-out across branches'
            : `Shifts at ${user?.branchName || 'your branch'}`}
        </span>
      </PageHeader>

      {error && <ErrorBanner className="mb-3" error={error} onDismiss={() => setError('')} />}

      <TableCard className="mb-3.5 max-h-none p-4">
        <div className="flex flex-wrap items-end gap-3">
          {isManager && (
            <SelectField
              label="Branch"
              className="min-w-[160px]"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </SelectField>
          )}
          <Field
            label="From"
            type="date"
            className="min-w-[140px]"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <Field
            label="To"
            type="date"
            className="min-w-[140px]"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
          <SelectField
            label="Status"
            className="min-w-[120px]"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All</option>
            <option value="open">Open now</option>
            <option value="closed">Ended</option>
          </SelectField>
          <SecondaryButton compact type="button" disabled={loading} onClick={load}>
            {loading ? 'Loading…' : 'Refresh'}
          </SecondaryButton>
        </div>
        <p className="m-0 mt-3 text-[11px] text-brand-subtle">
          {visible.length} shown
          {openCount > 0 ? ` · ${openCount} open now` : ''}
        </p>
      </TableCard>

      <TableCard className="max-h-none">
        <div
          className={`grid gap-2 bg-brand-dark px-4 py-2.5 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase ${
            isManager
              ? 'grid-cols-[1.2fr_1.1fr_0.7fr_0.55fr_1fr_1fr_0.7fr_0.7fr]'
              : 'grid-cols-[1.3fr_0.8fr_0.55fr_1fr_1fr_0.7fr_0.7fr]'
          } max-[900px]:grid-cols-[1.2fr_0.55fr_1fr_0.8fr]`}
        >
          <span>Staff</span>
          {isManager && <span className="max-[900px]:hidden">Branch</span>}
          <span className="max-[900px]:hidden">Role</span>
          <span>Shift</span>
          <span>Clock in</span>
          <span className="max-[900px]:hidden">Clock out</span>
          <span className="max-[900px]:hidden">Duration</span>
          <span>Status</span>
        </div>
        {loading ? (
          <SkeletonRows rows={8} cols={isManager ? 5 : 4} />
        ) : (
          visible.map((row) => (
          <div
            key={row.id}
            className={`grid items-center gap-2 px-4 py-3 text-xs ${tableRowClass} ${
              isManager
                ? 'grid-cols-[1.2fr_1.1fr_0.7fr_0.55fr_1fr_1fr_0.7fr_0.7fr]'
                : 'grid-cols-[1.3fr_0.8fr_0.55fr_1fr_1fr_0.7fr_0.7fr]'
            } max-[900px]:grid-cols-[1.2fr_0.55fr_1fr_0.8fr]`}
          >
            <strong className="truncate text-brand-ink">{row.staffName}</strong>
            {isManager && (
              <span className="truncate text-brand-muted max-[900px]:hidden">{row.branchName}</span>
            )}
            <span className="capitalize text-brand-muted max-[900px]:hidden">
              {row.staffRole || '—'}
            </span>
            <span className="font-bold tabular-nums text-brand-ink">
              {row.shiftPeriod ? row.shiftPeriod.toUpperCase() : '—'}
            </span>
            <span className="tabular-nums">{formatWhen(row.clockIn)}</span>
            <span className="tabular-nums text-brand-muted max-[900px]:hidden">
              {formatWhen(row.clockOut)}
            </span>
            <span className="tabular-nums max-[900px]:hidden">
              {formatDuration(row.clockIn, row.clockOut)}
            </span>
            <StatusBadge tone={row.open ? 'success' : 'neutral'}>
              {row.open ? 'Open' : 'Ended'}
            </StatusBadge>
          </div>
          ))
        )}
        {!loading && visible.length === 0 && (
          <div className="px-4 py-8 text-xs text-brand-subtle">No shifts in this range.</div>
        )}
      </TableCard>
    </div>
  )
}

export default Shifts
