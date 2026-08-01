import { money } from '../../utils/format'
import { TableCard } from '../ui'

function SalesMixBar({ mix = [], title = 'Sales mix', subtitle = 'By category' }) {
  const max = Math.max(...mix.map((item) => item.value), 1)

  return (
    <TableCard className="h-auto min-h-full max-h-none p-4 px-[18px]">
      <div className="flex items-center justify-between pb-3">
        <h2 className="m-0 text-lg capitalize">{title}</h2>
        <span className="text-[11px] text-brand-subtle">{subtitle}</span>
      </div>
      <div className="grid gap-3 pt-1">
        {mix.length === 0 ? (
          <p className="m-0 py-6 text-center text-xs text-brand-subtle">No sales in this period yet.</p>
        ) : (
          mix.map((item) => (
            <div className="grid gap-[5px]" key={item.category}>
              <div className="flex justify-between text-[11px] text-brand-slate">
                <span>{item.category}</span>
                <strong className="text-brand-ink">{money(item.value)}</strong>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[#eceee9]">
                <div className="h-full rounded-full bg-brand-gold" style={{ width: `${(item.value / max) * 100}%` }} />
              </div>
            </div>
          ))
        )}
      </div>
    </TableCard>
  )
}

export default SalesMixBar
