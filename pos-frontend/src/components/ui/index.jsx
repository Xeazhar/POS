import { FiX } from 'react-icons/fi'

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
      className={`inline-flex items-center justify-center gap-1.5 rounded-[5px] border border-[#d8dbd5] bg-[#f4f5f1] font-bold text-[#4d534f] hover:bg-[#eaebe6] hover:border-[#cfd3cc] active:bg-[#e4e6e0] disabled:cursor-not-allowed disabled:opacity-35 ${
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
    <label className={`block text-[11px] font-bold text-[#646a66] ${className}`}>
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
    <label className={`block text-[11px] font-bold text-[#646a66] ${className}`}>
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

export function SearchBox({ icon, className = '', ...props }) {
  return (
    <div
      className={`flex h-10 items-center gap-2.5 rounded-md border border-brand-search-border bg-brand-search px-3 text-[#5f6561] shadow-[0_1px_0_#00000008] ${className}`}
    >
      <span className="shrink-0 text-[#7a807c]">{icon}</span>
      <input
        className="min-w-0 w-full border-0 bg-transparent text-[13px] text-brand-ink outline-none placeholder:text-[#9aa09c]"
        {...props}
      />
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
  'bg-brand-dark text-[9px] font-bold tracking-[1.2px] text-[#c8ceca] uppercase'

/** Standard table body row — zebra + soft hover. */
export const tableRowClass =
  'border-t border-brand-softline even:bg-brand-sheet-alt hover:bg-[#fafaf7] active:bg-[#f0f1ec]'

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
  neutral: 'bg-[#eceee9] text-brand-muted',
}

/** Status pill — tones: success | warn | danger | neutral (brand tokens). */
export function StatusBadge({ tone = 'neutral', children, className = '' }) {
  return (
    <span
      className={`inline-block min-w-[62px] rounded-[20px] px-2 py-[5px] text-center text-[10px] font-bold ${
        STATUS_TONES[tone] || STATUS_TONES.neutral
      } ${className}`}
    >
      {children}
    </span>
  )
}

/** Paid=success, Partial (refunded)=warn, Voided=danger. */
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
  if (Number(item.refundedAmount || 0) > 0) return 'Partial'
  return item.status || '—'
}

/** Cash variance: zero=success, short=danger, over=warn. */
export function varianceToneClass(variance) {
  const v = Number(variance)
  if (!Number.isFinite(v) || v === 0) return 'text-brand-success'
  if (v < 0) return 'text-brand-danger'
  return 'text-brand-warn'
}

export function Modal({ wide = false, layer = false, className = '', onClose, children }) {
  return (
    <div
      className={`fixed inset-0 flex items-center justify-center bg-[#202426aa] p-3 max-[700px]:items-end max-[700px]:p-0 max-[700px]:pt-8 ${
        layer ? 'z-[6]' : 'z-[4]'
      }`}
    >
      <div
        className={`relative flex max-h-full w-full flex-col overflow-hidden rounded-[10px] bg-white max-[700px]:max-h-[min(100%,calc(100dvh-2rem))] max-[700px]:rounded-b-none max-[700px]:rounded-t-[12px] ${
          wide ? 'sm:w-[min(460px,100%)]' : 'sm:w-[min(420px,100%)]'
        } ${className}`}
      >
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            className="absolute top-3 right-3 z-[1] border-0 bg-transparent text-lg text-[#6e7470] transition-[transform,color] duration-100 hover:text-brand-ink active:scale-90"
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

/** Shows a support code so staff can text/call you with the exact failure. */
export function ErrorBanner({ error, className = '', onDismiss }) {
  if (!error) return null
  const text = typeof error === 'string' ? error : error.message || String(error)
  const codeMatch = text.match(/\bCode\s+([A-Z]{2,5}\d{2})\b/i) || text.match(/\b([A-Z]{2,5}\d{2})\b/)
  const code = codeMatch?.[1] || null
  const alreadyLabeled = /\bCode\s+[A-Z]{2,5}\d{2}\b/i.test(text)
  return (
    <div
      className={`mb-3 rounded-md bg-brand-danger-bg px-3 py-2.5 text-xs text-brand-danger ${className}`}
      role="alert"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 font-medium">{text}</p>
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
    <div className="fixed inset-0 z-[8] grid place-items-center bg-[#202426aa] p-4">
      <div className="w-[min(340px,100%)] rounded-[10px] bg-white px-6 py-7 text-center shadow-sm">
        {!done && (
          <div
            className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-[#e4e6e0] border-t-brand-dark"
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
            <div className="h-1.5 overflow-hidden rounded-full bg-[#eceee9]">
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
    <div className="flex items-center justify-between gap-3 border-t border-brand-softline bg-[#f7f7f4] px-4 py-2">
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
        checked ? 'bg-brand-success' : 'bg-[#c5cac4]'
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
      className={`animate-pulse rounded-md bg-[#e6e8e3] ${className}`}
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
