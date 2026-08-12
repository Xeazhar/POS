import { useEffect, useRef, useState } from 'react'
import { money } from '../../utils/format'
import { TableCard } from '../ui'

/** Plot height used on Branch / Overview / supervisor dashboards (wide card, readable labels). */
export const REVENUE_CHART_PLOT_HEIGHT = 420

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
 * Width is measured; height is a fixed plot size so axis/label fonts never scale up when
 * the card stretches beside the metrics column (`fill` only grows the card chrome).
 */
function RevenueChart({
  points = [],
  period,
  height: chartHeight = REVENUE_CHART_PLOT_HEIGHT,
  fill = false,
}) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const containerRef = useRef(null)
  const [width, setWidth] = useState(640)

  useEffect(() => {
    const node = containerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const nextW = Math.round(entry.contentRect.width)
      if (nextW > 0) setWidth(nextW)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const height = chartHeight
  const left = 56
  const bottom = 28
  const top = 16
  const plotHeight = Math.max(80, height - top - bottom)
  const plotWidth = Math.max(120, width - left - 16)
  const max = Math.max(...points.map((item) => item.total), 1)
  const coords = points.map((item, index) => ({
    item,
    x: left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth),
    y: top + plotHeight - (item.total / max) * plotHeight,
  }))

  const active = hoverIndex != null ? coords[hoverIndex] : null
  const tooltipWidth = 148
  const tooltipFlips = active ? active.x + tooltipWidth + 12 > width : false

  const plot = points.length === 0 ? (
    <div
      className="flex w-full items-center justify-center text-xs text-brand-muted"
      style={{ height }}
    >
      No paid sales in this period.
    </div>
  ) : (
    <div ref={containerRef} className="w-full min-w-0" style={{ height }}>
      {/*
        Explicit width/height attributes (= viewBox) — never h-full/w-full + meet.
        Percentage SVG sizing was scaling axis labels when the card stretched.
      */}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="line-chart block max-w-full"
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
                <text x="4" y={y + 3} fontSize="9">
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
            <circle cx={x} cy={y} r={hoverIndex === index ? 6.5 : 4.5} className="chart-dot">
              <title>
                {`${item.full || item.label}: ${money(item.total)}${
                  item.orders != null ? ` · ${item.orders} orders` : ''
                }`}
              </title>
            </circle>
            <text x={x} y={height - 8} textAnchor="middle" fontSize="9">
              {item.short}
            </text>
          </g>
        ))}

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
  )

  return (
    <TableCard
      className={`max-h-none overflow-hidden p-0 ${fill ? 'flex h-full min-h-0 flex-col' : ''}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 border-b border-brand-line bg-white px-3.5 py-2.5">
        <h3 className="m-0 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
          Revenue over time
        </h3>
        <span className="text-[10px] text-brand-subtle">{period} · PHP</span>
      </div>
      <div
        className={`px-4 pt-3 pb-4 ${fill ? 'flex min-h-0 flex-1 flex-col justify-center' : ''}`}
      >
        {plot}
      </div>
    </TableCard>
  )
}

export default RevenueChart
