import { money } from '../../utils/format'
import { SectionHeading, TableCard } from '../ui'

const COLORS = {
  cash: '#2f6f4e',
  card: '#b8892f',
  ewallet: '#3d6a99',
}

function PaymentMethodPie({ mix = [], title = 'Payment methods', subtitle = 'Cash · Card · E-wallet' }) {
  const slices = (mix.length
    ? mix
    : [
        { id: 'cash', label: 'Cash', value: 0 },
        { id: 'card', label: 'Card', value: 0 },
        { id: 'ewallet', label: 'E-wallet', value: 0 },
      ]
  ).map((row) => ({
    ...row,
    id: row.id || String(row.label || '').toLowerCase().replace(/\s+/g, ''),
    value: Number(row.value) || 0,
  }))

  const total = slices.reduce((sum, row) => sum + row.value, 0)
  const radius = 58
  const cx = 70
  const cy = 70
  let angle = -Math.PI / 2

  const arcs =
    total <= 0
      ? []
      : slices
          .filter((row) => row.value > 0)
          .map((row) => {
            const portion = row.value / total
            const sweep = portion * Math.PI * 2
            const start = angle
            const end = angle + sweep
            angle = end
            const large = sweep > Math.PI ? 1 : 0
            const x1 = cx + radius * Math.cos(start)
            const y1 = cy + radius * Math.sin(start)
            const x2 = cx + radius * Math.cos(end)
            const y2 = cy + radius * Math.sin(end)
            const color = COLORS[row.id] || '#6a706c'
            if (portion >= 0.999) {
              return {
                ...row,
                color,
                path: `M ${cx} ${cy - radius} A ${radius} ${radius} 0 1 1 ${cx - 0.01} ${cy - radius} Z`,
              }
            }
            return {
              ...row,
              color,
              path: `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`,
            }
          })

  return (
    <TableCard className="h-auto min-h-full max-h-none overflow-hidden p-0">
      <SectionHeading title={title} subtitle={subtitle} />
      <div className="flex flex-col items-center gap-4 px-4 py-4">
        <svg viewBox="0 0 140 140" className="h-[140px] w-[140px]" aria-hidden>
          {total <= 0 ? (
            <circle cx={cx} cy={cy} r={radius} fill="#ecece8" />
          ) : (
            arcs.map((slice) => <path key={slice.id} d={slice.path} fill={slice.color} />)
          )}
        </svg>
        <div className="grid w-full gap-2.5">
          {slices.map((row) => {
            const pct = total > 0 ? Math.round((row.value / total) * 100) : 0
            return (
              <div key={row.id} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="flex min-w-0 items-center gap-2 text-brand-slate">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ background: COLORS[row.id] || '#6a706c' }}
                  />
                  <span className="truncate">{row.label}</span>
                </span>
                <strong className="shrink-0 tabular-nums text-brand-ink">
                  {money(row.value)}
                  <span className="ml-1 font-normal text-brand-muted">{pct}%</span>
                </strong>
              </div>
            )
          })}
        </div>
        {total <= 0 && (
          <p className="m-0 text-center text-xs text-brand-muted">No payments in this period yet.</p>
        )}
      </div>
    </TableCard>
  )
}

export default PaymentMethodPie
