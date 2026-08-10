import { useState } from 'react'
import { Link } from 'react-router-dom'
import { approverLabel } from '../../lib/api'
import { moneyClass } from '../ui'
import { money } from '../../utils/format'

const PAGE_SIZE = 5

/**
 * Compact void/refund rollup for a dashboard — counts, total value, and a paginated
 * recent list. Reads `sale_events` rows (`fetchSaleEvents` in `lib/api.js`) — the same
 * source Reports → "Void / Refund Log" already reads, so this is a live summary of that
 * log, not a second bookkeeping system.
 *
 * Rows are NOT clickable. They were briefly a button opening a detail popup, but at the
 * size these rows need to be (7px text, near-zero padding) a tap target is genuinely bad
 * touchscreen UX — the same reason RevenueChart uses full-height hit bands instead of
 * relying on a precise dot. A `title` tooltip carries the same detail (performed by,
 * approved by, reason) for anyone hovering on desktop; the full history is still one
 * click away via `linkHref` → Reports.
 *
 * Styled to match `StatTiles` (light bordered card) for the header, but row content is
 * deliberately much smaller — this is a dense supporting list, not a primary table.
 */
function AuditSummary({ events = [], linkHref = null, subtitle = null }) {
  const [page, setPage] = useState(0)
  // A fresh fetch (branch/period change) hands this component a new `events` array —
  // land back on page 1 rather than leaving the reader stranded on a now-stale page.
  // Adjusting state during render (React's documented pattern for this) rather than in
  // an effect — no extra render, and no separate "sync after the fact" pass needed.
  const [prevEvents, setPrevEvents] = useState(events)
  if (events !== prevEvents) {
    setPrevEvents(events)
    setPage(0)
  }

  const voidEvents = events.filter((e) => e.event_type === 'void')
  const refundEvents = events.filter((e) => e.event_type === 'refund')
  const voidTotal = voidEvents.reduce((sum, e) => sum + Number(e.amount || 0), 0)
  const refundTotal = refundEvents.reduce((sum, e) => sum + Number(e.amount || 0), 0)
  const sorted = [...events].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  const rowTitle = (row) =>
    `${row.event_type === 'void' ? 'Void' : 'Refund'} · ${money(row.amount)}\n` +
    `Performed by: ${row.staff?.full_name || '—'}\n` +
    `Approved by: ${approverLabel(row.approver_name, row.approver_role) || '—'}\n` +
    `Reason: ${row.reason || 'No reason given'}`

  return (
    <div className="mb-2.5 rounded-[10px] border border-brand-line bg-white px-3.5 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <h3 className="m-0 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">Audit</h3>
        <div className="flex items-baseline gap-2">
          {subtitle && <span className="text-[10px] text-brand-subtle">{subtitle}</span>}
          {linkHref && (
            <Link to={linkHref} className="text-[10px] font-bold text-brand-ink no-underline hover:underline">
              Full log →
            </Link>
          )}
        </div>
      </div>

      <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[10px]">
        <span>
          <strong className={`text-brand-danger ${moneyClass}`}>{money(voidTotal)}</strong>
          <span className="ml-1 text-brand-subtle">voided ({voidEvents.length})</span>
        </span>
        <span>
          <strong className={`text-brand-danger ${moneyClass}`}>{money(refundTotal)}</strong>
          <span className="ml-1 text-brand-subtle">refunded ({refundEvents.length})</span>
        </span>
      </div>

      {pageRows.length === 0 ? (
        <p className="m-0 text-[10px] text-brand-subtle">No voids or refunds in this range.</p>
      ) : (
        <div className="border-t border-brand-softline">
          {pageRows.map((row) => (
            <div
              key={row.id}
              title={rowTitle(row)}
              className="grid grid-cols-[2.3rem_1.6rem_1fr_1fr] items-center gap-1.5 border-b border-brand-softline py-1 text-[9px] leading-[1.4] max-[560px]:grid-cols-[2.3rem_1.6rem_1fr]"
            >
              <span className="text-brand-slate">
                {row.created_at
                  ? new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </span>
              <span
                className={`justify-self-start rounded-[3px] px-1 py-px text-[8px] font-bold uppercase ${
                  row.event_type === 'void' ? 'bg-brand-danger-bg text-brand-danger' : 'bg-brand-warn-bg text-brand-warn'
                }`}
              >
                {row.event_type === 'void' ? 'Void' : 'Rfnd'}
              </span>
              <span className="truncate text-brand-ink">
                {row.staff?.full_name || '—'}
                <span className="text-brand-subtle"> · {row.reason || 'no reason given'}</span>
              </span>
              <span className={`text-right text-brand-danger max-[560px]:hidden ${moneyClass}`}>
                −{money(row.amount)}
              </span>
            </div>
          ))}
          {pageCount > 1 && (
            <div className="flex items-center justify-between pt-1 text-[9px] text-brand-subtle">
              <span>
                {pageIndex + 1}/{pageCount} · {sorted.length}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={pageIndex <= 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  className="border-0 bg-transparent p-0 font-bold text-brand-ink disabled:text-brand-subtle disabled:opacity-50"
                >
                  ‹ Prev
                </button>
                <button
                  type="button"
                  disabled={pageIndex >= pageCount - 1}
                  onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                  className="border-0 bg-transparent p-0 font-bold text-brand-ink disabled:text-brand-subtle disabled:opacity-50"
                >
                  Next ›
                </button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default AuditSummary
