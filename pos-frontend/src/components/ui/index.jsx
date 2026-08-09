import { FiX } from 'react-icons/fi'
import { isKnownErrorCode, saleImpactGuidance } from '../../utils/errors'

export function PrimaryButton({ className = '', compact = false, children, ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-[5px] border-0 bg-brand-gold font-bold text-brand-dark hover:brightness-105 active:brightness-97 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:brightness-100 ${
        compact
          ? 'h-10 w-auto min-w-0 px-3 text-xs whitespace-nowrap max-[700px]:h-9 max-[700px]:px-2.5 max-[700px]:text-[11px]'
          : 'w-full px-4 py-[13px] max-[700px]:px-3 max-[700px]:py-3 max-[700px]:text-sm'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ className = '', compact = false, children, ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-[5px] border border-brand-n400 bg-brand-n100 font-bold text-brand-n800 hover:bg-brand-n200 hover:border-brand-n400 active:bg-brand-n300 disabled:cursor-not-allowed disabled:opacity-35 ${
        compact
          ? 'h-10 w-auto min-w-0 px-3 text-xs whitespace-nowrap max-[700px]:h-9 max-[700px]:px-2.5 max-[700px]:text-[11px]'
          : 'px-3.5 py-[11px] max-[700px]:px-3 max-[700px]:text-sm'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Field({ label, className = '', inputClassName = '', ...props }) {
  return (
    <label className={`block text-[11px] font-bold text-brand-n700 ${className}`}>
      {label}
      <input
        className={`mt-[7px] block w-full rounded-[5px] border border-brand-input bg-white p-2.5 text-[13px] font-normal outline-none ${inputClassName}`}
        {...props}
      />
    </label>
  )
}

export function SelectField({ label, className = '', children, ...props }) {
  return (
    <label className={`block text-[11px] font-bold text-brand-n700 ${className}`}>
      {label}
      <select
        className="mt-[7px] block w-full rounded-[5px] border border-brand-input bg-white p-2.5 text-[13px] font-normal outline-none"
        {...props}
      >
        {children}
      </select>
    </label>
  )
}

export function Eyebrow({ children, className = '' }) {
  return (
    <p className={`mb-2 text-[10px] font-bold tracking-[1.4px] text-brand-eyebrow uppercase ${className}`}>
      {children}
    </p>
  )
}

/** Panel section title — clean type above card content. */
export function SectionHeading({ title, subtitle, meta, className = '', tone = 'default' }) {
  const accent =
    tone === 'warn'
      ? 'text-brand-warn'
      : tone === 'danger'
        ? 'text-brand-danger'
        : 'text-brand-ink'
  return (
    <div
      className={`flex items-end justify-between gap-3 border-b border-brand-line bg-white px-4 py-3.5 ${className}`}
    >
      <div className="min-w-0">
        <h2 className={`m-0 text-lg font-bold tracking-[-0.02em] ${accent}`}>{title}</h2>
        {subtitle ? (
          <p className="m-0 mt-1 text-[12px] leading-snug text-brand-muted">{subtitle}</p>
        ) : null}
      </div>
      {meta != null ? (
        <span className="shrink-0 pb-0.5 text-xs font-semibold text-brand-muted">{meta}</span>
      ) : null}
    </div>
  )
}

export function PageHeader({ eyebrow, title, children, className = '' }) {
  return (
    <div className={`mb-4 flex items-end justify-between gap-3 max-[700px]:flex-col max-[700px]:items-stretch ${className}`}>
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="m-0 text-[30px] font-bold tracking-[-1px] text-brand-ink max-[700px]:text-[22px]">{title}</h1>
      </div>
      {children ? <div className="min-w-0 shrink-0 max-[700px]:w-full">{children}</div> : null}
    </div>
  )
}

/**
 * Search input.
 *
 * `label` exists so a search box can sit in a filter row next to `SelectField`s and line
 * up with them. Without it the labelled controls carry ~18px of label above the input and
 * the search box does not, so the row reads as two different heights. When labelled, the
 * box is `h-10` — the exact height a `SelectField` select renders at (`p-2.5 text-[13px]`).
 */
export function SearchBox({ icon, className = '', label = null, ...props }) {
  const { value, onChange } = props
  const hasValue = value != null && String(value).length > 0
  const clear = () => {
    if (!onChange) return
    onChange({ target: { value: '' } })
  }
  const box = (
    <div
      className={`flex ${
        label ? 'mt-[7px] h-10' : 'h-[42px]'
      } min-w-0 flex-1 items-center gap-2.5 rounded-[5px] border border-brand-search-border bg-brand-search px-3 text-[13px] font-normal text-brand-n700 shadow-[0_1px_0_#00000008] ${
        label ? '' : className
      }`}
    >
      <span className="shrink-0 text-brand-n600">{icon}</span>
      {/* 13px to match every other input in the kit, and w-full/flex-1 so the field
          actually fills the box. It was 8px and auto-width, which is why the search
          bar looked shrunken next to the filters beside it. */}
      <input
        className="w-full min-w-0 flex-1 border-0 bg-transparent text-[13px] text-brand-ink outline-none placeholder:text-brand-n500"
        {...props}
      />
      {hasValue && (
        <button
          type="button"
          aria-label="Clear search"
          className="shrink-0 rounded-full p-0.5 text-brand-n600 hover:text-brand-ink"
          onClick={clear}
        >
          <FiX size={14} />
        </button>
      )}
    </div>
  )
  if (!label) return box
  return (
    <label className={`block text-[11px] font-bold text-brand-n700 ${className}`}>
      {label}
      {box}
    </label>
  )
}

/**
 * Browser-tab style switcher. Click to change view — not an anchor to a section further
 * down the page, which is what a "tab" that only scrolls actually is.
 *
 * `tabs`: [{ id, label, count? }]
 */
export function Tabs({ tabs = [], value, onChange, className = '' }) {
  return (
    <div role="tablist" className={`flex gap-1 border-b border-brand-line ${className}`}>
      {tabs.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            className={`-mb-px inline-flex items-center gap-2 rounded-t-[6px] border border-b-0 px-4 py-2.5 text-xs font-bold ${
              active
                ? 'border-brand-line bg-white text-brand-ink'
                : 'border-transparent bg-transparent text-brand-muted hover:text-brand-ink'
            }`}
            onClick={() => onChange?.(tab.id)}
          >
            {tab.label}
            {tab.count != null && (
              <span
                className={`rounded-full px-1.5 py-px text-[10px] tabular-nums ${
                  active ? 'bg-brand-n200 text-brand-n700' : 'bg-brand-n100 text-brand-muted'
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function TableCard({ className = '', children, ...rest }) {
  return (
    <section
      className={`max-h-[calc(100vh-165px)] overflow-auto rounded-[10px] border border-brand-line bg-white ${className}`}
      {...rest}
    >
      {children}
    </section>
  )
}

/** Shared column-header look — dark strip so headers don't blend into white rows. */
export const tableHeadClass =
  'bg-brand-dark text-[9px] font-bold tracking-[1.2px] text-brand-ondark uppercase'

/** Standard table body row — zebra + soft hover. */
export const tableRowClass =
  'border-t border-brand-softline even:bg-brand-sheet-alt hover:bg-brand-n50 active:bg-brand-n150'

/** Comfortable padding for list pages (Products, Transactions, DayEnd history). */
export const tableRowComfortableClass = `${tableRowClass} px-5 py-[17px]`

/** Dense padding for manager dashboards / compact tables. */
export const tableRowDenseClass = `${tableRowClass} px-4 py-2.5`

/** Tabular figures for money / qty columns. */
export const moneyClass = 'tabular-nums'

/** Thin money display — prefer className={moneyClass} when already formatting with money(). */
export function Money({ value, className = '', children, ...props }) {
  return (
    <span className={`${moneyClass} ${className}`} {...props}>
      {children != null ? children : value}
    </span>
  )
}

function normalizeUnitMode(mode) {
  const m = String(mode || '')
    .toLowerCase()
    .trim()
  if (m === 'kg' || m === 'per_kg' || m.endsWith('_kg') || m.includes('kg')) return 'kg'
  return 'pc'
}

/** Color classes for KG (meat) / PC (success) unit badges. */
export function unitBadgeClass(mode) {
  return normalizeUnitMode(mode) === 'kg'
    ? 'bg-brand-meat text-brand-meat-text'
    : 'bg-brand-success-bg text-brand-success-text'
}

/**
 * Unit badge — KG = brand-meat, PC = brand-success.
 * `size="tile"` matches POS product tiles (h-14 w-14).
 */
export function UnitBadge({ mode, className = '', size = 'sm' }) {
  const label = normalizeUnitMode(mode) === 'kg' ? 'KG' : 'PC'
  const sizeCls =
    size === 'tile' || size === 'lg'
      ? 'grid h-14 w-14 place-items-center rounded-lg text-xs font-bold'
      : 'inline-flex min-w-[2rem] items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-bold'
  return <span className={`${sizeCls} ${unitBadgeClass(mode)} ${className}`}>{label}</span>
}

const STATUS_TONES = {
  success: 'bg-brand-success-bg text-brand-success-text',
  warn: 'bg-brand-warn-bg text-brand-warn',
  danger: 'bg-brand-danger-bg text-brand-danger',
  neutral: 'bg-brand-n200 text-brand-muted',
}

/** Status pill — tones: success | warn | danger | neutral (brand tokens). */
export function StatusBadge({ tone = 'neutral', compact = false, children, className = '', title }) {
  // `compact` for dense table rows: the default pill's min-width + tall padding makes a
  // short label like "Paid" float in an oversized lozenge and sit taller than the row's
  // other cells. Compact sizes to its text and matches the row's line height.
  const shape = compact
    ? 'rounded-[4px] px-1.5 py-0.5 text-[10px] leading-[1.4]'
    : 'min-w-[62px] rounded-[20px] px-2 py-[5px] text-center text-[10px]'
  return (
    <span
      title={title}
      className={`inline-block font-bold whitespace-nowrap ${shape} ${
        STATUS_TONES[tone] || STATUS_TONES.neutral
      } ${className}`}
    >
      {children}
    </span>
  )
}

/** Paid=success, Partial Refund=warn, Voided=danger. */
export function statusToneFromTxn(item) {
  if (!item) return 'neutral'
  if (item.status === 'Voided') return 'danger'
  if (Number(item.refundedAmount || 0) > 0) return 'warn'
  if (item.status === 'Paid') return 'success'
  return 'neutral'
}

export function statusLabelFromTxn(item) {
  if (!item) return '—'
  if (item.status === 'Voided') return 'Voided'
  if (Number(item.refundedAmount || 0) > 0) return 'Partial Refund'
  return item.status || '—'
}

/** Cash variance: zero=success, short=danger, over=warn. */
export function varianceToneClass(variance) {
  const v = Number(variance)
  if (!Number.isFinite(v) || v === 0) return 'text-brand-success'
  if (v < 0) return 'text-brand-danger'
  return 'text-brand-warn'
}

/**
 * Period-over-period change badge for a KPI ("+12.4%" against last week).
 *
 * Designed to sit on the dark KPI cards, so the tones are the on-dark status colours.
 *
 * Two cases deliberately do NOT get a percentage:
 *   - No prior period at all (a new shop's first week). 0 → 200 is not "+∞%" or "+100%",
 *     it is simply the first data there has ever been, so it reads "New".
 *   - Previous period existed but was exactly zero revenue. Same divide-by-zero problem.
 * Both are shown as neutral, because inventing a number here would put a green arrow on
 * a shop that has no trend to report.
 */
export function DeltaBadge({ current, previous, hasPrevious = true, className = '' }) {
  const cur = Number(current) || 0
  const prev = Number(previous) || 0
  if (!hasPrevious || prev === 0) {
    return (
      <span
        className={`inline-flex items-center rounded-[4px] bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-n500 ${className}`}
        title="No comparable earlier period yet"
      >
        New
      </span>
    )
  }
  const pct = ((cur - prev) / Math.abs(prev)) * 100
  // Round before comparing, so a change of +0.04% is not shown as an upward trend.
  const rounded = Math.round(pct * 10) / 10
  const tone =
    rounded > 0
      ? 'bg-brand-sync-ok/20 text-brand-sync-ok'
      : rounded < 0
        ? 'bg-brand-danger-ondark/15 text-brand-danger-ondark'
        : 'bg-white/10 text-brand-n500'
  const arrow = rounded > 0 ? '▲' : rounded < 0 ? '▼' : '—'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${tone} ${className}`}
      title={`vs. previous period (${prev.toLocaleString()})`}
    >
      <span aria-hidden>{arrow}</span>
      {rounded > 0 ? '+' : ''}
      {rounded}%
    </span>
  )
}

export function Modal({ wide = false, xl = false, layer = false, className = '', onClose, children }) {
  // `xl` is for content that genuinely needs two columns (checkout). Cramming a long
  // breakdown into the 460px `wide` column made it scroll under the sticky action bar.
  const width = xl
    ? 'sm:w-[min(920px,100%)]'
    : wide
      ? 'sm:w-[min(460px,100%)]'
      : 'sm:w-[min(420px,100%)]'
  return (
    <div
      className={`fixed inset-0 flex items-center justify-center bg-brand-scrim p-3 max-[700px]:items-end max-[700px]:p-0 max-[700px]:pt-8 ${
        layer ? 'z-[6]' : 'z-[4]'
      }`}
    >
      <div
        className={`relative flex max-h-full w-full flex-col overflow-hidden rounded-[10px] bg-white max-[700px]:max-h-[min(100%,calc(100dvh-2rem))] max-[700px]:rounded-b-none max-[700px]:rounded-t-[12px] ${width} ${className}`}
      >
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            className="absolute top-3 right-3 z-[1] border-0 bg-transparent text-lg text-brand-n700 transition-[transform,color] duration-100 hover:text-brand-ink active:scale-90"
            onClick={onClose}
          >
            <FiX />
          </button>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 max-[700px]:p-4">
          {children}
        </div>
      </div>
    </div>
  )
}

export function ModalActions({ children, className = '' }) {
  return (
    <div
      className={`sticky bottom-0 -mx-5 -mb-1 mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-brand-softline bg-white px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-[700px]:-mx-4 max-[700px]:px-4 max-[700px]:[&>button]:min-w-0 max-[700px]:[&>button]:flex-1 ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * Shows a support code so staff can text/call you with the exact failure — and, when the
 * failure touched a sale, says outright whether the money went through.
 *
 * That second line is the point. Without it a cashier facing a failed payment has two
 * options and no basis to choose between them: ring it again (and risk double-charging a
 * customer) or wave the customer off (and lose the sale plus break the OR sequence). The
 * catalog in utils/errors.js knows which is correct for every code, so it says so instead
 * of leaving it to nerve.
 */
export function ErrorBanner({ error, className = '', onDismiss }) {
  if (!error) return null
  const text = typeof error === 'string' ? error : error.message || String(error)
  // An explicit "Code ..." label wins. The bare-token fallback is only trusted when the
  // token is genuinely in the catalog — otherwise a product SKU sitting in a free-text
  // database message gets presented to staff as a support code they can quote, and
  // support then has nothing to look it up against.
  const labelled = text.match(/\bCode\s+([A-Z]{2,6}\d{2})\b/i)?.[1]
  const bare = text.match(/\b([A-Z]{2,6}\d{2})\b/)?.[1]
  const code = labelled || (bare && isKnownErrorCode(bare) ? bare : null)
  const alreadyLabeled = Boolean(labelled)
  const impact = code ? saleImpactGuidance(code) : ''
  return (
    <div
      className={`mb-3 rounded-md bg-brand-danger-bg px-3 py-2.5 text-xs text-brand-danger ${className}`}
      role="alert"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 font-medium">{text}</p>
          {impact && (
            <p className="m-0 mt-1.5 rounded-[4px] bg-white/60 px-2 py-1.5 text-[11px] leading-snug font-bold text-brand-danger">
              {impact}
            </p>
          )}
          {code && !alreadyLabeled && (
            <p className="m-0 mt-1 text-[11px] text-brand-danger/90">
              Support code <strong className="tracking-wide">{code}</strong> — text or call support with this code.
            </p>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            className="shrink-0 border-0 bg-transparent text-[11px] font-bold text-brand-danger underline"
            onClick={onDismiss}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  )
}

/** Minimal centered status / progress overlay */
export function StatusOverlay({
  title,
  message,
  progress = null,
  done = false,
  onClose,
  closeLabel = 'Done',
  actions = null,
}) {
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : null

  return (
    <div className="fixed inset-0 z-[8] grid place-items-center bg-brand-scrim p-4">
      <div className="w-[min(340px,100%)] rounded-[10px] bg-white px-6 py-7 text-center shadow-sm">
        {!done && (
          <div
            className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-brand-n300 border-t-brand-dark"
            aria-hidden
          />
        )}
        {done && (
          <div className="mx-auto mb-4 grid h-8 w-8 place-items-center rounded-full bg-brand-success-bg text-sm font-bold text-brand-success">
            ✓
          </div>
        )}
        <h2 className="m-0 text-base text-brand-ink">{title}</h2>
        {message && <p className="mt-2 mb-0 text-xs text-brand-muted">{message}</p>}
        {pct != null && !done && (
          <div className="mt-4">
            <div className="h-1.5 overflow-hidden rounded-full bg-brand-n200">
              <div
                className="h-full rounded-full bg-brand-dark transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-2 mb-0 text-[11px] tabular-nums text-brand-subtle">
              {progress.current} / {progress.total}
              {progress.label ? ` · ${progress.label}` : ''}
            </p>
          </div>
        )}
        {done && actions && <div className="mt-5 flex flex-col gap-2">{actions}</div>}
        {done && onClose && (
          <button
            type="button"
            className={
              actions
                ? 'mt-2 h-10 w-full rounded-[5px] border border-brand-line bg-white text-xs font-bold text-brand-ink'
                : 'mt-5 h-10 w-full rounded-[5px] border-0 bg-brand-dark text-xs font-bold text-white'
            }
            onClick={onClose}
          >
            {closeLabel}
          </button>
        )}
      </div>
    </div>
  )
}

/** Table footer pagination — quiet text controls that match table actions. */
export function Pager({ page, pageCount, total, label = 'items', onPrev, onNext }) {
  const link =
    'border-0 bg-transparent p-0 text-[11px] font-bold text-brand-ink underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-brand-subtle disabled:no-underline'
  return (
    <div className="flex items-center justify-between gap-3 border-t border-brand-softline bg-brand-n100 px-4 py-2">
      <span className="text-[11px] text-brand-subtle">
        Page {page} of {pageCount}
        {total != null ? ` · ${total} ${label}` : ''}
      </span>
      <div className="flex items-center gap-3">
        <button type="button" disabled={page <= 1} onClick={onPrev} className={link}>
          Previous
        </button>
        <button type="button" disabled={page >= pageCount} onClick={onNext} className={link}>
          Next
        </button>
      </div>
    </div>
  )
}

export function StockBadge({ tone, children }) {
  const tones = {
    low: 'bg-brand-danger-bg text-brand-danger',
    fair: 'bg-brand-warn-bg text-brand-warn',
    medium: 'bg-brand-warn-bg text-brand-warn',
    good: 'bg-brand-success-bg text-brand-success-text',
    healthy: 'bg-brand-success-bg text-brand-success-text',
  }
  return (
    <span
      className={`inline-flex min-w-[52px] items-center justify-center whitespace-nowrap rounded-[15px] px-[9px] py-[5px] text-[10px] font-bold ${tones[tone] || tones.good}`}
    >
      {children}
    </span>
  )
}

/** Clear on/off control — looks like a switch, not a text pill. */
export function ToggleSwitch({
  checked = false,
  disabled = false,
  busy = false,
  onChange,
  label = 'Toggle',
  className = '',
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled || busy}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-0 p-0.5 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-55 ${
        checked ? 'bg-brand-success' : 'bg-brand-n400'
      } ${className}`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-[0_1px_2px_#20242633] transition-transform duration-150 ${
          checked ? 'translate-x-5' : 'translate-x-0'
        } ${busy ? 'opacity-70' : ''}`}
      />
    </button>
  )
}

/** Pulsing placeholder block for loading states. */
export function Skeleton({ className = '' }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-md bg-brand-n200 ${className}`}
    />
  )
}

/** Table-style skeleton rows (list pages). */
export function SkeletonRows({ rows = 6, cols = 4, className = '' }) {
  return (
    <div className={className} role="status" aria-live="polite" aria-label="Loading">
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="grid items-center gap-3 border-t border-brand-softline px-4 py-3.5"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: cols }, (_, col) => (
            <Skeleton
              key={col}
              className={`h-3 ${col === 0 ? 'w-[72%]' : col === cols - 1 ? 'w-10 justify-self-end' : 'w-[55%]'}`}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** Stat / card grid skeleton. */
export function SkeletonCards({ count = 4, className = '' }) {
  return (
    <div
      className={`grid grid-cols-4 gap-3.5 max-[900px]:grid-cols-2 max-[700px]:grid-cols-1 ${className}`}
      role="status"
      aria-live="polite"
      aria-label="Loading"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-[10px] border border-brand-line bg-white p-4">
          <Skeleton className="mb-3 h-2.5 w-16" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="mt-2 h-2.5 w-20" />
        </div>
      ))}
    </div>
  )
}

/** Full page content skeleton (route loads / heavy fetches). */
export function PageSkeleton({ variant = 'table', className = '' }) {
  return (
    <div className={className} role="status" aria-live="polite" aria-label="Loading">
      <div className="mb-4">
        <Skeleton className="mb-2 h-2.5 w-20" />
        <Skeleton className="h-8 w-48 max-[700px]:w-36" />
      </div>
      {variant === 'cards' || variant === 'dashboard' ? (
        <>
          <SkeletonCards count={4} className="mb-4" />
          <div className="mb-4 grid grid-cols-2 gap-3.5 max-[900px]:grid-cols-1">
            <div className="rounded-[10px] border border-brand-line bg-white p-4">
              <Skeleton className="mb-4 h-3 w-28" />
              <Skeleton className="h-40 w-full" />
            </div>
            <div className="rounded-[10px] border border-brand-line bg-white p-4">
              <Skeleton className="mb-4 h-3 w-28" />
              <Skeleton className="h-40 w-full" />
            </div>
          </div>
          {variant === 'dashboard' && (
            <TableCard className="max-h-none">
              <div className="border-b border-brand-softline px-4 py-3">
                <Skeleton className="h-3 w-32" />
              </div>
              <SkeletonRows rows={5} cols={4} />
            </TableCard>
          )}
        </>
      ) : variant === 'detail' ? (
        <div className="space-y-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="mt-4 h-28 w-full" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      ) : (
        <TableCard className="max-h-none">
          <div className="border-b border-brand-softline px-4 py-3">
            <Skeleton className="h-3 w-36" />
          </div>
          <SkeletonRows rows={8} cols={4} />
        </TableCard>
      )}
    </div>
  )
}
