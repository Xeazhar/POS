import { useEffect, useState } from 'react'
import { ErrorBanner, Pager, PrimaryButton, TableCard, tableHeadClass, tableRowClass } from '../../components/ui'
import { fetchCompanyProfile, fetchSecurityAuditEvents, hasSupabase, logAuditEvent, saveCompanyProfile } from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import {
  IDLE_LOCK_CHOICES,
  applyIdleLockMinutes,
  clampIdleLockMinutes,
  getIdleLockMinutes,
} from '../../utils/sessionPolicy'

const EVENT_LABELS = {
  login: 'Sign-in',
  logout: 'Sign-out',
  day_end_lock: 'Day-end lock',
  pin_viewed: 'Staff PIN revealed',
  company_profile_updated: 'Company profile updated',
}

const ACTIVITY_PAGE_SIZE = 10

export function SessionLockPanel() {
  const user = useAuthStore((s) => s.user)
  const [minutes, setMinutes] = useState(getIdleLockMinutes)
  const [savedMinutes, setSavedMinutes] = useState(getIdleLockMinutes)
  const [loading, setLoading] = useState(() => hasSupabase)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!hasSupabase) return undefined
    let active = true
    fetchCompanyProfile({ force: true })
      .then((row) => {
        if (!active) return
        const next = clampIdleLockMinutes(row?.idle_lock_minutes)
        setMinutes(next)
        setSavedMinutes(next)
        applyIdleLockMinutes(next)
      })
      .catch((err) => {
        if (active) setError(formatSupportError(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const onSave = async (event) => {
    event.preventDefault()
    setError('')
    setSaved(false)
    const next = clampIdleLockMinutes(minutes)
    setSaving(true)
    try {
      if (hasSupabase) {
        await saveCompanyProfile({ idleLockMinutes: next })
        await logAuditEvent({
          branchId: user?.branchId || null,
          staffId: user?.id || null,
          eventType: 'company_profile_updated',
          detail: `Updated idle auto-lock to ${next} minutes`,
        })
      }
      applyIdleLockMinutes(next)
      setMinutes(next)
      setSavedMinutes(next)
      setSaved(true)
    } catch (err) {
      setError(formatSupportError(err))
    } finally {
      setSaving(false)
    }
  }

  const dirty = minutes !== savedMinutes

  return (
    <TableCard className="max-h-none p-5">
      <h2 className="m-0 mb-1 text-base font-bold">Session &amp; Auto-lock</h2>
      <p className="m-0 mb-4 text-xs text-brand-muted">
        Applies to every till after the next sign-in or profile pull. 5 minutes is the floor;
        15 is the ceiling. Auto-lock cannot be turned off.
      </p>
      {error && <ErrorBanner error={error} className="mb-3" />}
      {saved && <p className="mb-3 text-xs text-brand-success">Saved. This till uses the new delay now.</p>}
      {loading ? (
        <p className="m-0 text-xs text-brand-muted">Loading…</p>
      ) : (
        <form className="grid max-w-xl gap-3" onSubmit={onSave}>
          <div>
            <p className="m-0 mb-1.5 text-[10px] font-bold tracking-wide text-brand-label uppercase">
              Auto-lock after
            </p>
            <div className="flex flex-wrap gap-2">
              {IDLE_LOCK_CHOICES.map((choice) => {
                const selected = minutes === choice
                return (
                  <button
                    key={choice}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setMinutes(choice)}
                    className={`h-10 min-w-[4.5rem] rounded-[5px] border px-3 text-xs font-semibold ${
                      selected
                        ? 'border-brand-gold bg-brand-gold text-brand-dark'
                        : 'border-brand-n400 bg-brand-n100 text-brand-n800 hover:bg-brand-n200'
                    }`}
                  >
                    {choice} min
                  </button>
                )
              })}
            </div>
          </div>
          <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <p className="m-0 text-[10px] font-bold tracking-wide text-brand-label uppercase">Lock screen</p>
            <p className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
              Header lock icon, or auto-lock, shows the existing lock screen. Cashiers and
              supervisors unlock with their PIN; managers unlock with their password. Offline
              unlock uses the on-device PBKDF2 verifier — that is not changed here.
            </p>
          </div>
          <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <p className="m-0 text-[10px] font-bold tracking-wide text-brand-label uppercase">Closing the browser</p>
            <p className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
              Closing the tab or browser requires sign-in again. A reload keeps the session.
              The open cash shift is not closed by lock or sign-out.
            </p>
          </div>
          <div className="rounded-md border border-brand-softline bg-brand-n50 px-3 py-2.5">
            <p className="m-0 text-[10px] font-bold tracking-wide text-brand-label uppercase">Employee PINs</p>
            <p className="m-0 mt-0.5 text-xs leading-relaxed text-brand-muted">
              Cashiers and supervisors cannot change their own PIN. Reset PINs from Staff after
              re-entering the manager password. PINs are never shown on this page.
            </p>
          </div>
          <div>
            <PrimaryButton compact type="submit" disabled={saving || !dirty}>
              {saving ? 'Saving…' : 'Save auto-lock'}
            </PrimaryButton>
          </div>
        </form>
      )}
    </TableCard>
  )
}

function formatWhen(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function SecurityActivityPanel() {
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(() => hasSupabase)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!hasSupabase) return undefined
    let active = true
    fetchSecurityAuditEvents({ limit: ACTIVITY_PAGE_SIZE, offset: (page - 1) * ACTIVITY_PAGE_SIZE })
      .then(({ rows: data, total: count }) => {
        if (!active) return
        setRows(data)
        setTotal(count)
      })
      .catch((err) => {
        if (active) setError(formatSupportError(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [page])

  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE))

  return (
    <TableCard className="max-h-none">
      <div className="border-b border-brand-softline px-5 py-4">
        <h2 className="m-0 mb-1 text-base font-bold">Security Activity</h2>
        <p className="m-0 text-xs text-brand-muted">
          Recent sign-in, lock, and PIN-reveal events. Credentials and PIN values are never
          listed. Failed PIN lockouts are enforced in the database; they appear here only if
          an audit row was written.
        </p>
      </div>
      {error && (
        <div className="px-5 py-3">
          <ErrorBanner error={error} />
        </div>
      )}
      {loading ? (
        <p className="px-5 py-4 text-xs text-brand-muted">Loading…</p>
      ) : !rows.length ? (
        <p className="px-5 py-4 text-xs text-brand-muted">No recent security events.</p>
      ) : (
        <>
          <table className="w-full text-left text-xs">
            <thead>
              <tr>
                <th className={`${tableHeadClass} px-5 py-2`}>When</th>
                <th className={`${tableHeadClass} px-3 py-2`}>Event</th>
                <th className={`${tableHeadClass} px-3 py-2`}>Staff</th>
                <th className={`${tableHeadClass} px-5 py-2`}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={tableRowClass}>
                  <td className="whitespace-nowrap px-5 py-2.5 text-brand-muted">{formatWhen(row.created_at)}</td>
                  <td className="px-3 py-2.5 font-semibold">
                    {EVENT_LABELS[row.event_type] || row.event_type}
                  </td>
                  <td className="px-3 py-2.5">{row.staff?.full_name || '—'}</td>
                  <td className="px-5 py-2.5 text-brand-muted">{row.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager
            page={page}
            pageCount={pageCount}
            total={total}
            label="events"
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount, p + 1))}
          />
        </>
      )}
    </TableCard>
  )
}
