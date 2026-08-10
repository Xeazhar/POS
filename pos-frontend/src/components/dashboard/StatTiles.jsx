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
function StatTiles({ title = null, subtitle = null, items = [] }) {
  if (!items.length) return null
  const toneClass = (tone) => (tone === 'danger' ? 'text-brand-danger' : 'text-brand-ink')

  return (
    <div className="mb-2.5 rounded-[10px] border border-brand-line bg-white px-3.5 py-2.5">
      {(title || subtitle) && (
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          {title && <h3 className="m-0 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">{title}</h3>}
          {subtitle && <span className="text-[10px] text-brand-subtle">{subtitle}</span>}
        </div>
      )}
      <div
        className="grid grid-flow-col grid-rows-2 items-start justify-start gap-x-4 gap-y-1 overflow-x-auto max-[560px]:grid-flow-row max-[560px]:grid-cols-[auto_1fr] max-[560px]:gap-x-3"
        style={{ gridAutoColumns: 'max-content' }}
      >
        {items.map((item, index) => (
          <Fragment key={item.label}>
            <span
              className={`row-start-1 self-end text-[9px] font-semibold tracking-wide text-brand-subtle uppercase max-[560px]:row-auto ${
                index > 0 ? 'border-l border-brand-softline pl-4 max-[560px]:border-l-0 max-[560px]:pl-0' : ''
              }`}
            >
              {item.label}
            </span>
            <span
              className={`row-start-2 self-start leading-tight max-[560px]:row-auto max-[560px]:text-right ${
                index > 0 ? 'border-l border-brand-softline pl-4 max-[560px]:border-l-0 max-[560px]:pl-0' : ''
              }`}
            >
              <strong
                className={`block ${index === 0 ? 'text-lg' : 'text-xs'} font-bold ${moneyClass} ${toneClass(item.tone)}`}
              >
                {item.value}
              </strong>
              {item.hint ? (
                <span className="block text-[9px] font-normal text-brand-subtle">{item.hint}</span>
              ) : null}
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export default StatTiles
