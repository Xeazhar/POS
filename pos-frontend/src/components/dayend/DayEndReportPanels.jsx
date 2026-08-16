import { useState } from 'react'
import { Link } from 'react-router-dom'
import { SectionHeading, TableCard, tableHeadClass } from '../ui'
import { money, qty } from '../../utils/format'

const SOLD_GRID =
  'grid-cols-[2.25rem_minmax(0,1.8fr)_minmax(0,0.85fr)_minmax(0,0.9fr)_minmax(0,0.95fr)_minmax(0,0.65fr)]'
const SOLD_GRID_NARROW = 'max-[700px]:grid-cols-[2.25rem_minmax(0,1.8fr)_minmax(0,0.85fr)_minmax(0,0.95fr)]'
const PAGE_SIZE = 10

function Pager({ page, pageCount, onPrev, onNext }) {
  if (pageCount <= 1) return null
  return (
    <div className="flex items-center justify-between border-t border-brand-softline px-4 py-2 text-[11px] text-brand-subtle">
      <span>
        Page {page + 1}/{pageCount}
      </span>
      <span className="flex gap-3">
        <button
          type="button"
          disabled={page <= 0}
          onClick={onPrev}
          className="border-0 bg-transparent p-0 font-bold text-brand-ink disabled:text-brand-subtle disabled:opacity-50"
        >
          ‹ Prev
        </button>
        <button
          type="button"
          disabled={page >= pageCount - 1}
          onClick={onNext}
          className="border-0 bg-transparent p-0 font-bold text-brand-ink disabled:text-brand-subtle disabled:opacity-50"
        >
          Next ›
        </button>
      </span>
    </div>
  )
}

/** Sold lines + restock list for day-end / next-day alert. */
export function DayEndReportPanels({
  report,
  title = 'Sold',
  showSold = true,
  showRestock = true,
  compact = false,
  alert = false,
  fromDate = null,
  restockSubtitle = null,
  inventoryHref = '/inventory',
  thirdPanel = null,
}) {
  const [soldPage, setSoldPage] = useState(0)
  const [restockPage, setRestockPage] = useState(0)
  // A fresh report (date/branch change) hands this component new sold/restock arrays —
  // land back on page 1 rather than leaving the reader stranded on a now-stale page.
  const [prevReport, setPrevReport] = useState(report)
  if (report !== prevReport) {
    setPrevReport(report)
    setSoldPage(0)
    setRestockPage(0)
  }
  if (!report) return null
  const sold = report.sold || []
  const restock = report.restock || []
  const unit = (row) => (row.pricingMode === 'kg' ? 'kg' : 'pc')
  const totalRevenue = Number(report.revenue || 0)
  const refunded = Number(report.refunded || 0)
  const soldSubtitle = [
    `${report.orderCount || 0} order${report.orderCount === 1 ? '' : 's'}`,
    money(totalRevenue),
    refunded > 0 ? `${money(refunded)} refunded` : null,
    fromDate || null,
  ]
    .filter(Boolean)
    .join(' · ')

  const soldPageCount = Math.max(1, Math.ceil(sold.length / PAGE_SIZE))
  const soldPageRows = sold.slice(soldPage * PAGE_SIZE, soldPage * PAGE_SIZE + PAGE_SIZE)
  const restockPageCount = Math.max(1, Math.ceil(restock.length / PAGE_SIZE))
  const restockPageRows = restock.slice(restockPage * PAGE_SIZE, restockPage * PAGE_SIZE + PAGE_SIZE)

  // Full (non-compact) view is the whole-day close-out report — a real data table with
  // every line, not the truncated card list used for the small dashboard restock-alert
  // widgets. Ten rows per page, Prev/Next below the table.
  const soldTable = compact ? (
    <>
      {sold.length === 0 ? (
        <div className="border-t border-brand-softline px-4 py-4 text-xs text-brand-muted">
          No sold items recorded for this day.
        </div>
      ) : (
        sold.slice(0, 8).map((row) => (
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
      {sold.length > 8 && (
        <div className="border-t border-brand-softline px-4 py-2 text-[11px] text-brand-muted">
          +{sold.length - 8} more
        </div>
      )}
    </>
  ) : (
    <>
      {sold.length === 0 ? (
        <div className="border-t border-brand-softline px-4 py-4 text-xs text-brand-muted">
          No sold items recorded for this day.
        </div>
      ) : (
        <>
          <div
            className={`grid ${SOLD_GRID} ${SOLD_GRID_NARROW} items-center gap-2 px-4 py-2 ${tableHeadClass}`}
          >
            <span>#</span>
            <span>Item</span>
            <span className="text-right">Qty</span>
            <span className="text-right max-[700px]:hidden">Avg price</span>
            <span className="text-right">Revenue</span>
            <span className="text-right max-[700px]:hidden">Share</span>
          </div>
          {soldPageRows.map((row, index) => {
            const avgPrice = row.qty ? row.revenue / row.qty : 0
            const share = totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0
            return (
              <div
                key={row.productId || row.name}
                className={`grid ${SOLD_GRID} ${SOLD_GRID_NARROW} items-center gap-2 border-t border-brand-softline px-4 py-2.5 text-xs`}
              >
                <span className="text-[11px] text-brand-muted tabular-nums">
                  {soldPage * PAGE_SIZE + index + 1}
                </span>
                <div className="min-w-0">
                  <strong className="block truncate text-brand-ink">{row.name}</strong>
                  <small className="block truncate text-[10px] text-brand-muted">{row.sku || '—'}</small>
                </div>
                <span className="text-right tabular-nums text-brand-ink">{qty(row.qty, unit(row))}</span>
                <span className="text-right tabular-nums text-brand-muted max-[700px]:hidden">
                  {money(avgPrice)}
                </span>
                <strong className="text-right tabular-nums text-brand-ink">{money(row.revenue)}</strong>
                <span className="text-right tabular-nums text-brand-muted max-[700px]:hidden">
                  {share.toFixed(1)}%
                </span>
              </div>
            )
          })}
          <Pager
            page={soldPage}
            pageCount={soldPageCount}
            onPrev={() => setSoldPage((p) => Math.max(0, p - 1))}
            onNext={() => setSoldPage((p) => Math.min(soldPageCount - 1, p + 1))}
          />
          <div
            className={`grid ${SOLD_GRID} ${SOLD_GRID_NARROW} items-center gap-2 border-t-2 border-brand-line bg-brand-sheet-alt px-4 py-2.5 text-xs`}
          >
            <span />
            <strong className="text-brand-ink">Total</strong>
            <span />
            <span className="max-[700px]:hidden" />
            <strong className="text-right tabular-nums text-brand-ink">{money(totalRevenue)}</strong>
            <span className="text-right tabular-nums text-brand-muted max-[700px]:hidden">100%</span>
          </div>
        </>
      )}
    </>
  )

  const panelCount = (showSold ? 1 : 0) + (showRestock ? 1 : 0) + (thirdPanel ? 1 : 0)
  const columnsClass = panelCount === 3 ? 'grid-cols-3' : panelCount === 2 ? 'grid-cols-2' : 'grid-cols-1'
  const narrowBreakpoint = compact ? 'max-[900px]:grid-cols-1' : 'max-[1100px]:grid-cols-1'

  return (
    <div className={`mb-4 grid gap-4 ${narrowBreakpoint} ${columnsClass}`}>
      {showSold && (
        <TableCard className="max-h-none overflow-hidden">
          <SectionHeading title={title} subtitle={soldSubtitle} meta={`${sold.length} items`} />
          {soldTable}
        </TableCard>
      )}

      {showRestock && (
        <TableCard className="max-h-none overflow-hidden">
          <SectionHeading
            title="Need to restock"
            subtitle={
              restockSubtitle ||
              (alert
                ? fromDate
                  ? `From day end ${fromDate}`
                  : 'Carry-over from last close'
                : "Low on hand after today's sales")
            }
            meta={restock.length}
            tone={restock.length ? 'warn' : 'default'}
          />
          {restock.length === 0 ? (
            <div className="border-t border-brand-softline px-4 py-4 text-xs text-brand-muted">
              Nothing flagged for restock.
            </div>
          ) : (
            <>
              {(compact ? restock.slice(0, 8) : restockPageRows).map((row) => (
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
              ))}
              {!compact && (
                <Pager
                  page={restockPage}
                  pageCount={restockPageCount}
                  onPrev={() => setRestockPage((p) => Math.max(0, p - 1))}
                  onNext={() => setRestockPage((p) => Math.min(restockPageCount - 1, p + 1))}
                />
              )}
            </>
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

      {thirdPanel}
    </div>
  )
}
