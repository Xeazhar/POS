import { money } from '../../utils/format'
import { TableCard } from '../ui'

function RevenueChart({ points = [], period }) {
  const max = Math.max(...points.map((item) => item.total), 1)
  const width = 640
  const height = 220
  const left = 56
  const bottom = 28
  const top = 16
  const plotHeight = height - top - bottom
  const plotWidth = width - left - 16
  const coords = points.map((item, index) => ({
    item,
    x: left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth),
    y: top + plotHeight - (item.total / max) * plotHeight,
  }))

  return (
    <TableCard className="h-auto max-h-none p-4 px-[18px]">
      <div className="flex items-center justify-between pb-3">
        <h2 className="m-0 text-lg capitalize">Revenue over time</h2>
        <span className="text-[11px] text-brand-subtle">{period} · PHP</span>
      </div>
      {points.length === 0 ? (
        <div className="py-9 text-xs text-brand-subtle">No paid sales in this period.</div>
      ) : (
        <div className="w-full max-w-[640px]">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="line-chart block aspect-[640/220] h-auto w-full"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Revenue over time"
          >
            <g className="chart-grid-lines">
              {[0, 1, 2, 3, 4].map((step) => {
                const y = top + (step / 4) * plotHeight
                return (
                  <g key={step}>
                    <line x1={left} x2={width - 16} y1={y} y2={y} />
                    <text x="4" y={y + 3}>
                      ₱{Math.round(max - (step / 4) * max)}
                    </text>
                  </g>
                )
              })}
            </g>
            <polyline
              points={coords.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke="#e9b949"
              strokeWidth="3"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {coords.map(({ item, x, y }) => (
              <g key={item.label}>
                <circle cx={x} cy={y} r="4.5" className="chart-dot">
                  <title>{`${item.label}: ${money(item.total)}`}</title>
                </circle>
                <text x={x} y={height - 8} textAnchor="middle">
                  {item.short}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
    </TableCard>
  )
}

export default RevenueChart
