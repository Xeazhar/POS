import { useState } from 'react'
import { money } from '../../utils/format'
import { SectionHeading, TableCard } from '../ui'

/**
 * Revenue line with a hover tooltip showing the exact date, revenue and order count.
 *
 * Hand-rolled rather than pulled from a charting library because the project has none —
 * every chart here is plain SVG, and adding Recharts (~500KB with its D3 dependencies)
 * for one tooltip would cost more than the whole rest of the dashboard on a shop tablet.
 *
 * The hit targets are invisible full-height <rect> bands, one per point, not the 4.5px
 * dots. Requiring a cashier to land on a 9px circle on a touchscreen is not a usable
 * chart; the band means anywhere in that column works.
 *
 * The <title> elements are kept alongside the custom tooltip on purpose: they are what a
 * screen reader and a native long-press actually surface, and they keep working if the
 * pointer handlers do not.
 */
function RevenueChart({ points = [], period }) {
  const [hoverIndex, setHoverIndex] = useState(null)

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

  const active = hoverIndex != null ? coords[hoverIndex] : null
  // Flip the tooltip to the left of the point once it gets near the right edge, so it
  // never spills outside the viewBox and clips.
  const tooltipWidth = 148
  const tooltipFlips = active ? active.x + tooltipWidth + 12 > width : false

  return (
    <TableCard className="h-auto max-h-none overflow-hidden p-0">
      <SectionHeading title="Revenue over time" subtitle={`${period} · PHP`} />
      <div className="px-4 pt-3 pb-4">
        {points.length === 0 ? (
          <div className="py-9 text-xs text-brand-muted">No paid sales in this period.</div>
        ) : (
          <div className="w-full max-w-[640px]">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="line-chart block aspect-[640/220] h-auto w-full"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Revenue over time"
              onPointerLeave={() => setHoverIndex(null)}
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
                stroke="var(--color-brand-gold)"
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              {/* Crosshair for the hovered column, drawn under the dots. */}
              {active && (
                <line
                  x1={active.x}
                  x2={active.x}
                  y1={top}
                  y2={top + plotHeight}
                  stroke="var(--color-brand-n400)"
                  strokeWidth="1"
                  strokeDasharray="3 3"
                />
              )}

              {coords.map(({ item, x, y }, index) => (
                <g key={item.label}>
                  <circle
                    cx={x}
                    cy={y}
                    r={hoverIndex === index ? 6.5 : 4.5}
                    className="chart-dot"
                  >
                    <title>
                      {`${item.full || item.label}: ${money(item.total)}${
                        item.orders != null ? ` · ${item.orders} orders` : ''
                      }`}
                    </title>
                  </circle>
                  <text x={x} y={height - 8} textAnchor="middle">
                    {item.short}
                  </text>
                </g>
              ))}

              {/* Invisible hover bands — the actual hit targets. Full plot height and half
                  the gap to each neighbour, so every pixel of the chart belongs to a point. */}
              {coords.map(({ item, x }, index) => {
                const step = coords.length > 1 ? plotWidth / (coords.length - 1) : plotWidth
                return (
                  <rect
                    key={`hit-${item.label}`}
                    x={x - step / 2}
                    y={top}
                    width={step}
                    height={plotHeight}
                    fill="transparent"
                    onPointerEnter={() => setHoverIndex(index)}
                    onPointerDown={() => setHoverIndex(index)}
                  />
                )
              })}

              {active && (
                <g pointerEvents="none">
                  <rect
                    x={tooltipFlips ? active.x - tooltipWidth - 10 : active.x + 10}
                    y={Math.min(Math.max(active.y - 34, top), top + plotHeight - 62)}
                    width={tooltipWidth}
                    height="58"
                    rx="6"
                    fill="var(--color-brand-dark)"
                    opacity="0.96"
                  />
                  <text
                    x={(tooltipFlips ? active.x - tooltipWidth - 10 : active.x + 10) + 10}
                    y={Math.min(Math.max(active.y - 34, top), top + plotHeight - 62) + 18}
                    fill="var(--color-brand-ondark)"
                    fontSize="10"
                  >
                    {active.item.full || active.item.label}
                  </text>
                  <text
                    x={(tooltipFlips ? active.x - tooltipWidth - 10 : active.x + 10) + 10}
                    y={Math.min(Math.max(active.y - 34, top), top + plotHeight - 62) + 35}
                    fill="var(--color-brand-gold)"
                    fontSize="13"
                    fontWeight="bold"
                  >
                    {money(active.item.total)}
                  </text>
                  <text
                    x={(tooltipFlips ? active.x - tooltipWidth - 10 : active.x + 10) + 10}
                    y={Math.min(Math.max(active.y - 34, top), top + plotHeight - 62) + 50}
                    fill="var(--color-brand-ondark-dim)"
                    fontSize="10"
                  >
                    {active.item.orders != null
                      ? `${active.item.orders} order${active.item.orders === 1 ? '' : 's'}`
                      : '—'}
                  </text>
                </g>
              )}
            </svg>
          </div>
        )}
      </div>
    </TableCard>
  )
}

export default RevenueChart
