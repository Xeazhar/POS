import { FiX } from 'react-icons/fi'

export function PrimaryButton({ className = '', compact = false, children, ...props }) {
  return (
    <button
      className={`inline-flex items-center justify-between gap-2 rounded-[5px] border-0 bg-brand-gold font-bold text-brand-dark disabled:cursor-not-allowed disabled:opacity-35 ${
        compact ? 'h-10 w-auto justify-center px-4 text-xs' : 'w-full px-4 py-[13px]'
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
      className={`inline-flex items-center justify-center gap-1.5 rounded-[5px] border border-[#d8dbd5] bg-[#f4f5f1] font-bold text-[#4d534f] ${
        compact ? 'h-10 w-auto px-4 text-xs' : 'px-3.5 py-[11px]'
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
    <p className={`mb-2 text-[10px] font-bold tracking-[1.4px] text-brand-eyebrow ${className}`}>
      {children}
    </p>
  )
}

export function PageHeader({ eyebrow, title, children, className = '' }) {
  return (
    <div className={`mb-3.5 flex items-end justify-between gap-3 max-[700px]:flex-col max-[700px]:items-start ${className}`}>
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="m-0 text-[30px] tracking-[-1px] max-[700px]:text-[24px]">{title}</h1>
      </div>
      {children}
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

export function TableCard({ className = '', children }) {
  return (
    <section
      className={`max-h-[calc(100vh-165px)] overflow-auto rounded-[10px] border border-brand-line bg-white ${className}`}
    >
      {children}
    </section>
  )
}

export function Modal({ wide = false, layer = false, className = '', onClose, children }) {
  return (
    <div className={`fixed inset-0 grid place-items-center bg-[#202426aa] ${layer ? 'z-[6]' : 'z-[4]'}`}>
      <div
        className={`relative rounded-[10px] bg-white ${
          wide ? 'w-[min(460px,calc(100%-32px))] p-6' : 'w-[min(420px,calc(100%-32px))] p-[30px]'
        } ${className}`}
      >
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            className="absolute top-[17px] right-[17px] border-0 bg-transparent text-lg text-[#6e7470]"
            onClick={onClose}
          >
            <FiX />
          </button>
        )}
        {children}
      </div>
    </div>
  )
}

export function ModalActions({ children }) {
  return <div className="mt-5 flex items-center justify-end gap-2">{children}</div>
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
