import { money } from '../../utils/format'
import { SectionHeading, TableCard } from '../ui'

function SalesMixBar({ mix = [], title = 'Sales mix', subtitle = 'By category' }) {
  const max = Math.max(...mix.map((item) => item.value), 1)

  return (
    <TableCard className="h-auto min-h-full max-h-none overflow-hidden p-0">
      <SectionHeading title={title} subtitle={subtitle} />
      <div className="grid gap-3 px-4 py-4">
        {mix.length === 0 ? (
          <p className="m-0 py-6 text-center text-xs text-brand-muted">No sales in this period yet.</p>
        ) : (
          mix.map((item) => (
            <div className="grid gap-[5px]" key={item.category}>
              <div className="flex justify-between text-[11px] text-brand-slate">
                <span>{item.category}</span>
                <strong className="text-brand-ink">{money(item.value)}</strong>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[#e4e6e0]">
                <div
                  className="h-full rounded-full bg-brand-gold"
                  style={{ width: `${(item.value / max) * 100}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </TableCard>
  )
}

export default SalesMixBar
