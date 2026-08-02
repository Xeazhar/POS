import { Link } from 'react-router-dom'
import { TableCard } from '../ui'
import { money, qty } from '../../utils/format'

/** Sold lines + restock list for day-end / next-day alert. */
export function DayEndReportPanels({
  report,
  title = 'Day summary',
  showRestock = true,
  compact = false,
  alert = false,
  fromDate = null,
}) {
  if (!report) return null
  const sold = report.sold || []
  const restock = report.restock || []
  const unit = (row) => (row.pricingMode === 'kg' ? 'kg' : 'pc')

  return (
    <div className={`grid gap-3.5 ${compact ? '' : 'mb-3.5'} max-[900px]:grid-cols-1 ${showRestock ? 'grid-cols-2' : 'grid-cols-1'}`}>
      <TableCard className="max-h-none">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="min-w-0">
            <h2 className="m-0 text-base">{title}</h2>
            <p className="m-0 mt-0.5 text-[11px] text-brand-subtle">
              {report.orderCount || 0} orders · {money(report.revenue || 0)}
              {fromDate ? ` · ${fromDate}` : ''}
            </p>
          </div>
          <span className="shrink-0 text-[11px] text-brand-subtle">{sold.length} items</span>
        </div>
        {sold.length === 0 ? (
          <div className="border-t border-brand-softline px-4 py-3 text-xs text-brand-subtle">
            No sold items recorded for this day.
          </div>
        ) : (
          sold.slice(0, compact ? 8 : 40).map((row) => (
            <div
              key={row.productId || row.name}
              className="flex items-center justify-between gap-3 border-t border-brand-softline px-4 py-2.5 text-xs"
            >
              <div className="min-w-0">
                <strong className="block truncate text-brand-ink">{row.name}</strong>
                <small className="text-[10px] text-brand-subtle">
                  {row.sku || '—'}
                  {row.revenue ? ` · ${money(row.revenue)}` : ''}
                </small>
              </div>
              <strong className="shrink-0 tabular-nums text-brand-ink">
                {qty(row.qty, unit(row))}
              </strong>
            </div>
          ))
        )}
        {sold.length > (compact ? 8 : 40) && (
          <div className="border-t border-brand-softline px-4 py-2 text-[11px] text-brand-subtle">
            +{sold.length - (compact ? 8 : 40)} more
          </div>
        )}
      </TableCard>

      {showRestock && (
        <TableCard className={`max-h-none ${alert ? 'border border-[#e8d4a8]' : ''}`}>
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <div className="min-w-0">
              <h2 className="m-0 text-base">{alert ? 'Restock for today' : 'Needs restock'}</h2>
              <p className="m-0 mt-0.5 text-[11px] text-brand-subtle">
                {alert
                  ? fromDate
                    ? `From day end ${fromDate}`
                    : 'Carry-over from last close'
                  : 'Low on hand after today\'s sales'}
              </p>
            </div>
            <span className={`shrink-0 text-[11px] font-bold ${restock.length ? 'text-brand-danger' : 'text-brand-subtle'}`}>
              {restock.length}
            </span>
          </div>
          {restock.length === 0 ? (
            <div className="border-t border-brand-softline px-4 py-3 text-xs text-brand-subtle">
              Nothing flagged for restock.
            </div>
          ) : (
            restock.slice(0, compact ? 8 : 40).map((row) => (
              <div
                key={row.productId || row.name}
                className="flex items-center justify-between gap-3 border-t border-brand-softline px-4 py-2.5 text-xs"
              >
                <div className="min-w-0">
                  <strong className="block truncate text-brand-ink">{row.name}</strong>
                  <small className="text-[10px] text-brand-subtle">
                    On hand {qty(row.onHand, unit(row))}
                    {row.soldQty ? ` · sold ${qty(row.soldQty, unit(row))}` : ''}
                  </small>
                </div>
                <div className="shrink-0 text-right">
                  <strong className="block text-brand-danger">
                    +{qty(row.suggestedQty, unit(row))}
                  </strong>
                  <small className="text-[10px] text-brand-subtle">suggest</small>
                </div>
              </div>
            ))
          )}
          {alert && (
            <div className="border-t border-brand-softline px-4 py-2.5 text-[11px]">
              <Link to="/inventory" className="font-bold text-brand-ink no-underline hover:underline">
                Open inventory →
              </Link>
            </div>
          )}
        </TableCard>
      )}
    </div>
  )
}

/** Compact banner when there are restock items from yesterday. */
export function RestockAlertBanner({ entry, onDismiss }) {
  if (!entry?.dayReport?.restock?.length) return null
  const count = entry.dayReport.restock.length
  return (
    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3 rounded-[9px] border border-[#e8d4a8] bg-[#fff8ea] px-4 py-3 max-[700px]:px-3">
      <div className="min-w-0">
        <strong className="block text-sm text-[#6a5520]">
          Restock {count} item{count === 1 ? '' : 's'} for today
        </strong>
        <p className="m-0 mt-1 text-xs text-[#6a5520]">
          From day end {entry.date}
          {entry.dayReport.restock.length
            ? `: ${entry.dayReport.restock
                .slice(0, 3)
                .map((row) => row.name)
                .filter(Boolean)
                .join(', ')}${count > 3 ? ` +${count - 3} more` : ''}`
            : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          to="/inventory"
          className="inline-flex h-9 items-center rounded-[5px] bg-brand-dark px-3 text-[11px] font-bold text-white no-underline"
        >
          Review
        </Link>
        {onDismiss && (
          <button
            type="button"
            className="border-0 bg-transparent text-[11px] font-bold text-[#6a5520] underline"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}
