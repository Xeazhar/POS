import { useEffect, useState } from 'react'
import { fetchAnnouncements, hasSupabase, markAnnouncementsSeen } from '../../lib/api'
import { useSyncStore } from '../../stores/syncStore'
import { ANNOUNCEMENT_EMOJI } from '../../utils/announcements'
import { formatShiftWhen } from '../../utils/format'
import { TableCard } from '../ui'

/**
 * Compact staff-announcements feed — shared by CashierDashboard and the supervisor branch
 * Dashboard. Online-only, no local cache (informational, not core POS operation); re-fetches
 * whenever connectivity flips back on so reconnecting picks up anything posted while offline.
 * Collapses to a single compact row when there's nothing to show — never reserves space for
 * more than `limit` items.
 */
export default function AnnouncementsCard({ limit = 3 }) {
  const online = useSyncStore((state) => state.online)
  const [items, setItems] = useState([])
  const [seenAt, setSeenAt] = useState(undefined)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!hasSupabase || !online) return undefined
    let active = true
    Promise.all([fetchAnnouncements({ limit }), markAnnouncementsSeen()])
      .then(([rows, prevSeenAt]) => {
        if (!active) return
        setItems(rows)
        setSeenAt(prevSeenAt)
        setError(false)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [online, limit])

  const isUnread = (row) => (seenAt != null ? new Date(row.createdAt) > new Date(seenAt) : true)

  const emptyLabel = !online ? 'Needs a connection' : error ? 'Could not load' : 'No announcements right now'

  return (
    <TableCard className="max-h-none overflow-hidden p-0">
      {items.length === 0 ? (
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          <h2 className="m-0 text-sm font-semibold text-brand-ink">Announcements</h2>
          <span className="text-[11px] text-brand-subtle">{emptyLabel}</span>
        </div>
      ) : (
        <>
          <div className="border-b border-brand-line bg-brand-card px-4 py-2.5">
            <h2 className="m-0 text-sm font-semibold text-brand-ink">Announcements</h2>
          </div>
          {items.map((row) => (
            <div
              key={row.id}
              className="flex items-start gap-2 border-t border-brand-softline px-4 py-2 text-xs"
            >
              <span className="mt-0.5 shrink-0 text-sm leading-none" aria-hidden>
                {ANNOUNCEMENT_EMOJI[row.kind] || '📌'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <strong className="truncate text-brand-ink">{row.title}</strong>
                  {isUnread(row) && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-gold" aria-label="Unread" />
                  )}
                </div>
                <p className="m-0 mt-0.5 truncate text-[11px] text-brand-muted">{row.body}</p>
              </div>
              <span className="shrink-0 text-[10px] text-brand-subtle">{formatShiftWhen(row.createdAt)}</span>
            </div>
          ))}
        </>
      )}
    </TableCard>
  )
}
