import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { money } from '../../utils/format'
import { chartPointY, computeChartYScale, formatChartAxisPeso } from '../../utils/chartScale'
import { TableCard } from '../ui'

/** Plot height used on Branch / Overview / supervisor dashboards — 2/3 of the original 420px. */
export const REVENUE_CHART_PLOT_HEIGHT = 280

/**
 * Render a responsive revenue chart with interactive point details.
 * @param {Array} points - Revenue data points to plot.
 * @param {string} period - Selected reporting period displayed in the chart header.
 * @param {number} [chartHeight=REVENUE_CHART_PLOT_HEIGHT] - Plot height in pixels.
 * @param {boolean} [fill=false] - Whether the chart fills the available card height.
 * @param {number|null} [selectedIndex=null] - Index of the point currently pinned selected (click, not hover).
 * @param {function(number|null): void} [onSelectIndex] - Called with the clicked point's index, or `null` to clear the selection (clicking the already-selected point toggles it off).
 * @returns {JSX.Element} The revenue chart card.
 */
function RevenueChart({
  points = [],
  period,
  height: chartHeight = REVENUE_CHART_PLOT_HEIGHT,
  fill = false,
  selectedIndex = null,
  onSelectIndex,
}) {
  const [hoverIndex, setHoverIndex] = useState(null)
  const containerRef = useRef(null)
  const [width, setWidth] = useState(0)

  const measure = useCallback(() => {
    const node = containerRef.current
    if (!node) return
    const nextW = Math.round(node.getBoundingClientRect().width)
    if (nextW > 0) setWidth((prev) => (prev === nextW ? prev : nextW))
  }, [])

  useLayoutEffect(() => {
    measure()
  }, [measure])

  useEffect(() => {
    const node = containerRef.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => measure())
    observer.observe(node)
    return () => observer.disconnect()
  }, [measure])

  // On a narrow phone-width card, a tall fixed height (up to REVENUE_CHART_PLOT_HEIGHT) forces
  // extra scroll before the rest of the dashboard is reachable. Scale it down only below that
  // width — tablet/desktop callers keep the height they asked for.
  const height = width > 0 && width < 480 ? Math.min(chartHeight, 260) : chartHeight
  const left = 52
  const bottom = 28
  const top = 16
  const plotHeight = Math.max(80, height - top - bottom)
  const plotWidth = Math.max(120, width - left - 16)
  const dataMax = Math.max(...points.map((item) => Number(item.total) || 0), 0)
  const { yMax, ticks: yTicks } = computeChartYScale(dataMax)
  const coords = points.map((item, index) => ({
    item,
    x: left + (points.length <= 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth),
    y: chartPointY(item.total, yMax, top, plotHeight),
  }))

  const active = hoverIndex != null ? coords[hoverIndex] : selectedIndex != null ? coords[selectedIndex] : null
  const tooltipWidth = 148
  const tooltipFlips = active ? active.x + tooltipWidth + 12 > width : false

  const plotBody =
    points.length === 0 ? (
      <div
        className="flex w-full items-center justify-center text-xs text-brand-muted"
        style={{ height }}
      >
        No paid sales in this period.
      </div>
    ) : width > 0 ? (
      /*
       * Pixel width must match the container — viewBox width drives plot coords.
       * CSS-only stretch (w-full + fixed viewBox) letterboxes when the card is wider.
       */
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="line-chart block w-full"
        role="img"
        aria-label="Revenue over time"
        onPointerLeave={() => setHoverIndex(null)}
      >
        <g className="chart-grid-lines">
          {yTicks.map((tickValue) => {
            const y = chartPointY(tickValue, yMax, top, plotHeight)
            return (
              <g key={tickValue}>
                <line x1={left} x2={width - 16} y1={y} y2={y} />
                <text x="4" y={y + 3} fontSize="9">
                  {formatChartAxisPeso(tickValue)}
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
            {/* No native <title> here — it raced the custom hover box below (native
                tooltip has its own browser delay/position engine), so both would show
                at once, fighting each other for the same point. */}
            <circle
              cx={x}
              cy={y}
              r={hoverIndex === index ? 6.5 : selectedIndex === index ? 6 : 4.5}
              className={selectedIndex === index ? 'chart-dot chart-dot--selected' : 'chart-dot'}
            />
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
              style={{ cursor: onSelectIndex ? 'pointer' : 'default' }}
              onPointerEnter={() => setHoverIndex(index)}
              onPointerDown={() => setHoverIndex(index)}
              onClick={() => onSelectIndex?.(selectedIndex === index ? null : index)}
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
    ) : (
      <div className="w-full" style={{ height }} aria-hidden />
    )

  return (
    <TableCard
      className={`w-full max-h-none overflow-hidden p-0 ${fill ? 'flex h-full min-h-0 flex-col' : ''}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 border-b border-brand-line bg-brand-card px-3.5 py-2.5">
        <h3 className="m-0 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
          Revenue over time
        </h3>
        <span className="text-[10px] text-brand-subtle">{period} · PHP</span>
      </div>
      <div
        ref={containerRef}
        className={`w-full min-w-0 px-3 pt-3 pb-4 ${fill ? 'flex min-h-0 flex-1 flex-col' : ''}`}
      >
        {plotBody}
      </div>
    </TableCard>
  )
}

export default RevenueChart
