import { useRef, useState } from 'react'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back']

/** Append / edit a numeric string from pad keys. */
export function applyNumPadKey(current, key, { allowDecimal = true, maxDecimals = 2 } = {}) {
  const value = String(current ?? '')
  if (key === 'back') return value.slice(0, -1)
  if (key === 'clear') return ''
  if (key === '.') {
    if (!allowDecimal || value.includes('.')) return value
    return value === '' ? '0.' : `${value}.`
  }
  if (!/^\d$/.test(key)) return value
  if (value === '0') return key
  const dot = value.indexOf('.')
  if (dot !== -1 && value.length - dot - 1 >= maxDecimals) return value
  if (value.replace('.', '').length >= 10) return value
  return `${value}${key}`
}

function tapFeedback() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(8)
    }
  } catch {
    /* ignore */
  }
}

function PadButton({ label, className = '', onPress }) {
  const [pressed, setPressed] = useState(false)
  const timer = useRef(null)

  const flash = () => {
    setPressed(true)
    tapFeedback()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPressed(false), 90)
  }

  return (
    <button
      type="button"
      className={`relative h-14 rounded-[8px] text-[22px] font-bold touch-manipulation transition-[transform,filter,background-color] duration-75 ease-out max-[700px]:h-11 max-[700px]:text-lg [@media(max-height:780px)]:h-10 [@media(max-height:780px)]:text-base ${
        pressed ? 'scale-[0.98] brightness-110' : 'scale-100'
      } ${className}`}
      onPointerDown={(event) => {
        event.preventDefault()
        flash()
        onPress?.()
      }}
    >
      {label}
    </button>
  )
}

function NumPad({
  value,
  onChange,
  allowDecimal = true,
  maxDecimals = 2,
  variant = 'light',
  className = '',
  quickAmounts = null,
  onQuickAmount = null,
}) {
  const dark = variant === 'dark'
  const keyClass = dark
    ? 'border border-brand-cart-border bg-brand-cart-input text-white'
    : 'border border-brand-border bg-white text-brand-ink'
  const specialClass = dark
    ? 'border border-brand-cart-border bg-brand-dark-inset text-brand-n400'
    : 'border border-brand-border bg-brand-n150 text-brand-n800'
  const quickClass = dark
    ? 'border border-brand-cart-border bg-brand-dark-inset text-brand-gold'
    : 'border border-brand-border bg-brand-n100 text-brand-n800'

  const press = (key) => {
    if (key === '.' && !allowDecimal) return
    onChange(applyNumPadKey(value, key, { allowDecimal, maxDecimals }))
  }

  return (
    <div className={`select-none ${className}`}>
      {quickAmounts?.length > 0 && (
        <div className="mb-3 grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          {quickAmounts.map((item) => (
            <PadButton
              key={item.label}
              label={item.label}
              className={`!h-11 px-2 text-sm max-[700px]:!h-10 max-[700px]:text-xs sm:px-3 ${quickClass}`}
              onPress={() => onQuickAmount?.(item)}
            />
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map((key) => {
          if (key === '.' && !allowDecimal) {
            return (
              <div
                key="blank"
                className="h-14 rounded-[8px] opacity-0 max-[700px]:h-11 [@media(max-height:780px)]:h-10"
                aria-hidden
              />
            )
          }
          const label = key === 'back' ? '⌫' : key
          const isSpecial = key === 'back' || key === '.'
          return (
            <PadButton
              key={key}
              label={label}
              className={isSpecial ? specialClass : keyClass}
              onPress={() => press(key)}
            />
          )
        })}
      </div>
      <PadButton
        label="Clear"
        className={`mt-2 !h-12 w-full text-sm max-[700px]:!h-10 [@media(max-height:780px)]:!h-9 ${specialClass}`}
        onPress={() => press('clear')}
      />
    </div>
  )
}

export default NumPad
