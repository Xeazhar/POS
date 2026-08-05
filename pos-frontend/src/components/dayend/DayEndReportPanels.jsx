import { Link } from 'react-router-dom'
import { SectionHeading, TableCard } from '../ui'
import { money, qty } from '../../utils/format'

/** Sold lines + restock list for day-end / next-day alert. */
export function DayEndReportPanels({
  report,
  title = 'Sold',
  showRestock = true,
  compact = false,
  alert = false,
  fromDate = null,
  inventoryHref = '/inventory',
}) {
  if (!report) return null
  const sold = report.sold || []
  const restock = report.restock || []
  const unit = (row) => (row.pricingMode === 'kg' ? 'kg' : 'pc')
  const soldSubtitle = [
    `${report.orderCount || 0} orders`,
    money(report.revenue || 0),
    fromDate || null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className={`mb-4 grid gap-4 max-[900px]:grid-cols-1 ${showRestock ? 'grid-cols-2' : 'grid-cols-1'}`}
    >
      <TableCard className="max-h-none overflow-hidden">
        <SectionHeading title={title} subtitle={soldSubtitle} meta={`${sold.length} items`} />
        {sold.length === 0 ? (
          <div className="border-t border-brand-softline px-4 py-4 text-xs text-brand-muted">
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
                <small className="text-[10px] text-brand-muted">
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
          <div className="border-t border-brand-softline px-4 py-2 text-[11px] text-brand-muted">
            +{sold.length - (compact ? 8 : 40)} more
          </div>
        )}
      </TableCard>

      {showRestock && (
        <TableCard className="max-h-none overflow-hidden">
          <SectionHeading
            title="Need to restock"
            subtitle={
              alert
                ? fromDate
                  ? `From day end ${fromDate}`
                  : 'Carry-over from last close'
                : "Low on hand after today's sales"
            }
            meta={restock.length}
            tone={restock.length ? 'warn' : 'default'}
          />
          {restock.length === 0 ? (
            <div className="border-t border-brand-softline px-4 py-4 text-xs text-brand-muted">
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
                  <small className="text-[10px] text-brand-muted">
                    On hand {qty(row.onHand, unit(row))}
                    {row.soldQty ? ` · sold ${qty(row.soldQty, unit(row))}` : ''}
                  </small>
                </div>
                <div className="shrink-0 text-right">
                  <strong className="block text-brand-danger">
                    +{qty(row.suggestedQty, unit(row))}
                  </strong>
                  <small className="text-[10px] text-brand-muted">suggest</small>
                </div>
              </div>
            ))
          )}
          {alert && inventoryHref && (
            <div className="border-t border-brand-softline px-4 py-2.5 text-[11px]">
              <Link to={inventoryHref} className="font-bold text-brand-ink no-underline hover:underline">
                Open inventory →
              </Link>
            </div>
          )}
        </TableCard>
      )}
    </div>
  )
}
