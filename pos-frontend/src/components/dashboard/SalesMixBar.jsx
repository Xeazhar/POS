import { money } from '../../utils/format'
import { SectionHeading, TableCard } from '../ui'

/**
 * Horizontal bar list — the dashboard's one comparison chart, used for branch revenue,
 * top products, top categories and payment mix.
 *
 * Bars, not pies. Length on a common baseline is the easiest visual comparison there is;
 * angle is among the hardest, which is why the payment-method pie was replaced with this.
 * Reusing one component for all four panels also means they stay consistent by
 * construction rather than by somebody remembering.
 *
 * `showShare` adds a percent-of-total next to the value. It is on for payment mix, where
 * "how is the money arriving" is a question about proportion, and off for the ranking
 * panels, where the ordering already carries the comparison and a second number per row
 * is just noise.
 *
 * `barClassFor` optionally colours each row. Default is a single brand colour: these are
 * all one measure (pesos), and colouring identical things differently invites the reader
 * to look for a meaning that is not there. Payment mix is the exception — cash / card /
 * e-wallet are genuinely distinct categories.
 */
function SalesMixBar({
  mix = [],
  title = 'Sales mix',
  subtitle = 'By category',
  showShare = false,
  barClassFor = null,
  emptyMessage = 'No sales in this period yet.',
  embedded = false,
  className = '',
}) {
  const max = Math.max(...mix.map((item) => item.value), 1)
  const total = mix.reduce((sum, item) => sum + (Number(item.value) || 0), 0)

  const body = (
    <div className={`grid gap-3 ${embedded ? '' : 'px-4 py-4'}`}>
      {mix.length === 0 ? (
        <p className="m-0 py-4 text-center text-xs text-brand-muted">{emptyMessage}</p>
      ) : (
        mix.map((item) => {
          const value = Number(item.value) || 0
          const share = total > 0 ? (value / total) * 100 : 0
          return (
            <div className="grid gap-[5px]" key={item.category}>
              <div className="flex items-baseline justify-between gap-2 text-[11px] text-brand-slate">
                <span className="min-w-0 truncate">{item.category}</span>
                <span className="flex shrink-0 items-baseline gap-1.5">
                  {showShare && (
                    <span className="text-[10px] tabular-nums text-brand-subtle">
                      {share.toFixed(0)}%
                    </span>
                  )}
                  <strong className="text-brand-ink tabular-nums">{money(value)}</strong>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-brand-n300">
                <div
                  className={`h-full rounded-full ${barClassFor?.(item) || 'bg-brand-gold'}`}
                  style={{ width: `${(value / max) * 100}%` }}
                />
              </div>
            </div>
          )
        })
      )}
    </div>
  )

  if (embedded) {
    return (
      <div className={className}>
        <div className="mb-3">
          <h3 className="m-0 text-sm font-bold text-brand-ink">{title}</h3>
          {subtitle ? <p className="m-0 mt-0.5 text-[11px] text-brand-muted">{subtitle}</p> : null}
        </div>
        {body}
      </div>
    )
  }

  return (
    <TableCard className="h-auto min-h-full max-h-none overflow-hidden p-0">
      <SectionHeading title={title} subtitle={subtitle} />
      {body}
    </TableCard>
  )
}

export default SalesMixBar
