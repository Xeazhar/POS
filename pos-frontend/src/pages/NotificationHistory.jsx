import { useEffect, useState } from 'react'
import { fetchBranches, fetchNotificationHistory, hasSupabase } from '../lib/api'
import { useAuthStore } from '../stores/posStore'
import { isManagerRole } from '../utils/roles'
import { Field, PageHeader, PageSkeleton, SelectField } from '../components/ui'

function today() {
  return new Date().toISOString().slice(0, 10)
}

/** event_type → plain-language label for the history table. */
const EVENT_TYPE_LABELS = {
  day_end_approved: 'Day-end approved',
  day_end_reopen: 'Day-end reopened',
  day_end_reopen_requested: 'Day-end reopen requested',
  day_end_request_declined: 'Day-end request declined',
  day_end_request_cleared: 'Day-end request cleared',
  cash_movement_approved: 'Cash movement approved',
  cash_movement_pending: 'Cash movement requested',
  cash_movement_remote_approved: 'Cash movement approved (remote)',
  cash_movement_self_recorded: 'Cash movement self-recorded',
  cash_movement_denied: 'Cash movement denied',
  cash_movement_self_approved: 'Cash movement self-approved',
  cash_movement_resolved: 'Cash movement resolved',
  cash_movement_cancelled: 'Cash movement cancelled',
  cash_movement_reviewed: 'Cash movement reviewed',
  till_action_requested: 'Cart removal requested',
  till_action_approved: 'Cart removal approved',
  till_action_denied: 'Cart removal denied',
  till_action_self_allowed: 'Cart removal self-allowed',
  till_action_cancelled: 'Cart removal cancelled',
  promo_approved: 'Promo approved',
  promo_rejected: 'Promo rejected',
  promo_stopped: 'Promo stopped',
  promo_stop_requested: 'Promo stop requested',
  promo_edit_requested: 'Promo edit requested',
  refund_requested: 'Refund requested',
  refund_request_approved: 'Refund approved',
  refund_request_rejected: 'Refund rejected',
  import_revert_requested: 'Import revert requested',
  import_revert_dismissed: 'Import revert dismissed',
  import_reverted: 'Import reverted',
}

function humanizeEventType(type) {
  return EVENT_TYPE_LABELS[type] || String(type || '').replace(/_/g, ' ')
}

/**
 * Read-only history of every manager/supervisor notification (day-end, cash movement,
 * cart removal, promo, refund, import revert) — requested and resolved — pulled from
 * audit_events. Reached from the bell (RequestNotifications.jsx), gated by role like the
 * bell itself rather than the `manager_reports` module, so supervisors (who don't have
 * that module) can still see their branch's history.
 */
function NotificationHistory() {
  const user = useAuthStore((s) => s.user)
  const manager = isManagerRole(user?.role)
  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [start, setStart] = useState(today())
  const [end, setEnd] = useState(today())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(hasSupabase)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!hasSupabase || !manager) return
    fetchBranches().then(setBranches).catch(() => {})
  }, [manager])

  useEffect(() => {
    if (!hasSupabase || !user) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- filters (start/end/branchId) changing mid-fetch needs a fresh busy state
    setLoading(true)
    setError('')
    fetchNotificationHistory({ start, end, branchId: manager ? branchId || null : user.branchId })
      .then(setRows)
      .catch((err) => setError(err.message || 'Could not load notification history'))
      .finally(() => setLoading(false))
  }, [user, manager, branchId, start, end])

  return (
    <div className="overflow-auto pt-2.5 pb-[18px]">
      <PageHeader
        eyebrow="NOTIFICATIONS"
        title="Notification History"
      />

      <div className="mb-3.5 flex flex-wrap items-end gap-2.5">
        <Field label="From" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <Field label="To" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        {manager && (
          <SelectField label="Branch" value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
        )}
      </div>

      {error && (
        <div className="mb-3.5 rounded-[10px] border border-brand-danger bg-brand-danger-bg px-4 py-3 text-xs text-brand-danger">
          {error}
        </div>
      )}

      {loading ? (
        <PageSkeleton variant="table" />
      ) : rows.length === 0 ? (
        <div className="rounded-[10px] border border-brand-border bg-brand-card p-4 text-xs text-brand-subtle">
          No day-end, cash movement, cart removal, promo, refund, or import-revert notifications in this range.
        </div>
      ) : (
        <div className="max-h-[70vh] overflow-auto rounded-[10px] border border-brand-border">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-brand-dark bg-brand-n900 text-brand-ondark">
                <th className="px-2 py-1.5 font-bold whitespace-nowrap">When</th>
                <th className="px-2 py-1.5 font-bold whitespace-nowrap">Type</th>
                <th className="px-2 py-1.5 font-bold">Detail</th>
                <th className="px-2 py-1.5 font-bold whitespace-nowrap">Staff</th>
                {manager && <th className="px-2 py-1.5 font-bold whitespace-nowrap">Branch</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-brand-softline">
                  <td className="px-2 py-1.5 whitespace-nowrap">{new Date(row.created_at).toLocaleString()}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{humanizeEventType(row.event_type)}</td>
                  <td className="px-2 py-1.5">{row.detail || '—'}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">{row.staff?.full_name || '—'}</td>
                  {manager && (
                    <td className="px-2 py-1.5 whitespace-nowrap">{row.branches?.name || '—'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default NotificationHistory
