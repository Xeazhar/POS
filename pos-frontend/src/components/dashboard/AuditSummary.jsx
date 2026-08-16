import { useState } from 'react'
import { Link } from 'react-router-dom'
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
 * relying on a precise dot. Performed-by/approved-by/reason detail is one click away via
 * `linkHref` → Reports.
 *
 * Styled to match `StatTiles` (light bordered card) for the header, but row content is
 * deliberately much smaller — this is a dense supporting list, not a primary table.
 */
function AuditSummary({ events = [], linkHref = null, subtitle = null, showBranch = false, fill = false }) {
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

  // A full item-by-item refund that empties a sale auto-voids it (refund_sale_items in
  // migrate_refund_sale_items.sql) and logs BOTH a 'refund' event for the amount AND a
  // separate 'void' event (flagged payload.from_full_item_refund) once the sale locks —
  // same peso, told twice. Sales performance's Voided sales / Refunds tiles never double
  // it: transactions.status ends 'voided', which excludes the row from their refunds
  // bucket and counts it once, as voided. Dropping the paired 'refund' event here keeps
  // this panel agreeing with those tiles instead of inflating both totals.
  const autoVoidedTxnIds = new Set(
    events
      .filter((e) => e.event_type === 'void' && e.payload?.from_full_item_refund === true)
      .map((e) => e.transaction_id),
  )
  const dedupedEvents = events.filter(
    (e) => !(e.event_type === 'refund' && autoVoidedTxnIds.has(e.transaction_id)),
  )

  const voidEvents = dedupedEvents.filter((e) => e.event_type === 'void')
  const refundEvents = dedupedEvents.filter((e) => e.event_type === 'refund')
  const voidTotal = voidEvents.reduce((sum, e) => sum + Number(e.amount || 0), 0)
  const refundTotal = refundEvents.reduce((sum, e) => sum + Number(e.amount || 0), 0)
  const sorted = [...dedupedEvents].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = sorted.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  return (
    <div
      className={`min-w-0 rounded-[10px] border border-brand-line bg-brand-card px-3.5 py-2.5 ${
        fill ? 'flex h-full flex-col' : 'mb-2.5'
      }`}
    >
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <h3 className="m-0 text-xs font-bold tracking-wide text-brand-subtle uppercase">Audit</h3>
        <div className="flex items-baseline gap-2">
          {subtitle && <span className="text-[11px] text-brand-subtle">{subtitle}</span>}
          {linkHref && (
            <Link to={linkHref} className="text-[11px] font-bold text-brand-ink no-underline hover:underline">
              Full log →
            </Link>
          )}
        </div>
      </div>

      <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
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
        <p
          className={`m-0 text-[11px] text-brand-subtle ${
            fill ? 'flex flex-1 items-center justify-center text-center' : ''
          }`}
        >
          No voids or refunds in this range.
        </p>
      ) : (
        <div className={`border-t border-brand-softline ${fill ? 'flex flex-1 flex-col' : ''}`}>
          {pageRows.map((row) => (
            <div
              key={row.id}
              className={`grid items-center gap-1.5 border-b border-brand-softline py-1.5 text-[11px] leading-[1.4] max-[560px]:grid-cols-[3.4rem_2.1rem_1fr] ${
                showBranch
                  ? 'grid-cols-[3.4rem_2.1rem_5rem_1fr_1fr]'
                  : 'grid-cols-[3.4rem_2.1rem_1fr_1fr]'
              }`}
            >
              <span className="text-brand-slate">
                {row.created_at ? (
                  <>
                    <span className="block">
                      {new Date(row.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </span>
                    <span className="block text-[10px] text-brand-subtle">
                      {new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </>
                ) : (
                  '—'
                )}
              </span>
              <span
                className={`justify-self-start rounded-[3px] px-1 py-px text-[9px] font-bold uppercase ${
                  row.event_type === 'void' ? 'bg-brand-danger-bg text-brand-danger' : 'bg-brand-warn-bg text-brand-warn'
                }`}
              >
                {row.event_type === 'void' ? 'Void' : 'Rfnd'}
              </span>
              {showBranch && (
                <span className="truncate text-brand-subtle max-[560px]:hidden">
                  {row.branches?.name || '—'}
                </span>
              )}
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
            <div className="flex items-center justify-between pt-1 text-[11px] text-brand-subtle">
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
