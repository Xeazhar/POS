import { Fragment } from 'react'
import { moneyClass } from '../ui'

/**
 * One compact report line: a lead figure (the number that matters most — pass it FIRST
 * in `items`) plus the rest of the breakdown as small supporting figures beside it, all
 * inside a single light card instead of a grid of big dark tiles.
 *
 * Built as a real 2-row CSS grid (label row, value row), not a flexbox of independently-
 * sized boxes — a flex version bottom-aligned each item's box, so the one item with an
 * extra hint line (taller box) dragged its label/value out of line with every other
 * item's label/value. A grid row is shared across all columns by construction: every
 * label sits in row 1, every value in row 2, no matter how tall any one cell's hint text
 * makes that single cell.
 */
function StatTiles({ title = null, subtitle = null, items = [], embedded = false, variant = 'default', todayBadge = false }) {
  if (!items.length) return null
  const isToday = variant === 'today'
  const showTodayBadge = isToday || todayBadge
  const toneClass = (tone) => {
    if (tone === 'danger') return isToday ? 'text-brand-danger-ondark' : 'text-brand-danger'
    return isToday ? 'text-brand-gold' : 'text-brand-ink'
  }

  if (embedded) {
    return (
      <div>
        {(title || subtitle) && (
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            {title && <h3 className="m-0 text-sm font-bold text-brand-ink">{title}</h3>}
            {subtitle && <span className="text-[11px] text-brand-muted">{subtitle}</span>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {items.map((item) => (
            <div key={item.label} className="min-w-0">
              <span className="block text-[9px] font-semibold tracking-wide text-brand-subtle uppercase">
                {item.label}
              </span>
              <strong className={`mt-0.5 block text-sm font-bold tabular-nums ${toneClass(item.tone)}`}>
                {item.value}
              </strong>
              {item.hint ? (
                <span className="mt-0.5 block text-[9px] font-normal text-brand-subtle">{item.hint}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const cardClass = isToday
    ? 'flex h-full min-w-0 flex-col rounded-[10px] border border-brand-gold/50 bg-brand-dark px-3.5 py-2.5 shadow-[0_0_0_1px_rgba(233,185,73,0.12)]'
    : 'mb-2.5 min-w-0 rounded-[10px] border border-brand-line bg-brand-card px-3.5 py-2.5'
  const labelMutedClass = isToday ? 'text-brand-ondark-dim' : 'text-brand-subtle'
  const dividerClass = isToday
    ? 'border-l border-brand-gold/25 pl-4 max-[900px]:border-l-0 max-[900px]:pl-0'
    : 'border-l border-brand-softline pl-4 max-[900px]:border-l-0 max-[900px]:pl-0'

  return (
    <div className={cardClass}>
      {(title || subtitle || showTodayBadge) && (
        <div className="mb-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {title && (
                <h3
                  className={`m-0 text-[10px] font-bold tracking-wide uppercase ${
                    isToday ? 'text-brand-gold' : 'text-brand-subtle'
                  }`}
                >
                  {title}
                </h3>
              )}
              {!isToday && subtitle && <span className={`text-[10px] ${labelMutedClass}`}>{subtitle}</span>}
            </div>
            {showTodayBadge && (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-bold tracking-wide uppercase ${
                  isToday
                    ? 'border-brand-gold/60 bg-brand-gold/15 text-brand-gold'
                    : 'border-brand-line bg-brand-subtle/10 text-brand-subtle'
                }`}
              >
                Today only
              </span>
            )}
          </div>
          {isToday && subtitle && (
            <span className={`mt-0.5 block text-[10px] ${labelMutedClass}`}>{subtitle}</span>
          )}
        </div>
      )}
      <div
        className="grid grid-flow-col grid-rows-2 items-start justify-start gap-x-4 gap-y-1 overflow-x-auto max-[900px]:grid-flow-row max-[900px]:grid-cols-[auto_1fr] max-[900px]:gap-x-3"
        style={{ gridAutoColumns: 'max-content' }}
      >
        {items.map((item, index) => (
          <Fragment key={item.label}>
            <span
              className={`row-start-1 self-end text-[9px] font-semibold tracking-wide uppercase max-[900px]:row-auto ${labelMutedClass} ${
                index > 0 ? dividerClass : ''
              }`}
            >
              {item.label}
            </span>
            <span
              className={`row-start-2 self-start leading-tight max-[900px]:row-auto max-[900px]:text-right ${
                index > 0 ? dividerClass : ''
              }`}
            >
              <strong
                className={`block ${index === 0 ? 'text-lg' : 'text-xs'} font-bold ${moneyClass} ${toneClass(item.tone)}`}
              >
                {item.value}
              </strong>
              {item.hint ? (
                <span className={`block text-[9px] font-normal ${labelMutedClass}`}>{item.hint}</span>
              ) : null}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export default StatTiles
