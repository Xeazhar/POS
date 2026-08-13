import {
  Field,
  PrimaryButton,
} from '../ui'
import { CredentialAutofillTrap, secureFormProps } from './SecureCredential'
import { sanitizePinInput } from '../../utils/pin'

/** Cash drawer Open Drawer — manager wait before self-record. */
export const OPEN_DRAWER_WAIT_SEC = 60

/** Cart line remove / void-from-cart — shorter; customer is at the counter. */
export const CART_REMOVE_WAIT_SEC = 30

/**
 * Render a supervisor authorization form for protected operations.
 * @param {Object} props - Component properties.
 * @param {string} props.loginCode - Staff code entered by the supervisor.
 * @param {string} props.pin - Supervisor PIN entered by the supervisor.
 * @param {Function} props.onLoginCode - Handles staff code changes.
 * @param {Function} props.onPin - Handles PIN changes.
 * @param {Function} props.onSubmit - Handles form submission.
 * @param {boolean} [props.busy=false] - Disables submission while authorization is being checked.
 * @param {string} [props.submitLabel='Approve'] - Label displayed on the submit button when idle.
 * @param {string|null} [props.hint=null] - Optional hint displayed beside the form title.
 * @param {boolean} [props.autoFocusCode=true] - Whether to focus the staff-code field initially.
 * @returns {JSX.Element} The supervisor authorization form.
 */
export function SupervisorPinPanel({
  loginCode,
  pin,
  onLoginCode,
  onPin,
  onSubmit,
  busy = false,
  submitLabel = 'Approve',
  hint = null,
  autoFocusCode = true,
}) {
  return (
    <form
      className="relative rounded-lg border border-brand-softline bg-brand-n50 px-3.5 py-3.5"
      {...secureFormProps}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit?.()
      }}
    >
      <CredentialAutofillTrap />
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <strong className="text-sm text-brand-ink">Supervisor PIN</strong>
        {hint ? <span className="text-[10px] text-brand-subtle">{hint}</span> : null}
      </div>
      <div className="grid grid-cols-1 gap-2.5">
        <Field
          label="Staff code"
          noSave
          value={loginCode}
          onChange={(e) => onLoginCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          autoFocus={autoFocusCode}
          inputClassName="h-12 text-base tracking-wider"
        />
        <Field
          label="PIN"
          noSave
          secret
          value={pin}
          onChange={(e) => onPin(sanitizePinInput(e.target.value))}
          inputMode="numeric"
          maxLength={6}
          inputClassName="h-12 text-base"
        />
      </div>
      <PrimaryButton
        type="submit"
        className="mt-3 w-full"
        disabled={busy || !loginCode || !pin}
      >
        {busy ? 'Checking…' : submitLabel}
      </PrimaryButton>
    </form>
  )
}

/**
 * Countdown while waiting on remote manager. PIN stays usable above/below.
 */
export function ManagerWaitPanel({
  secondsLeft,
  totalSec,
  onProceedWithoutApproval,
  proceedLabel = 'Proceed without approval',
}) {
  const progress = totalSec > 0 ? Math.max(0, Math.min(1, secondsLeft / totalSec)) : 0
  const ss = String(secondsLeft).padStart(2, '0')

  return (
    <div className="rounded-lg border border-brand-softline bg-white px-4 py-4 text-center">
      <p className="m-0 text-[11px] font-bold tracking-wide text-brand-subtle uppercase">
        Waiting for manager
      </p>
      <p
        className="m-0 mt-1 font-mono text-[42px] leading-none tracking-tight text-brand-ink tabular-nums"
        aria-live="polite"
      >
        0:{ss}
      </p>
      <div className="mx-auto mt-3 h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-brand-n150">
        <div
          className="h-full rounded-full bg-brand-dark transition-[width] duration-1000 ease-linear"
          style={{ width: `${progress * 100}%` }}
        />
      </div>
      <p className="m-0 mt-2.5 text-[11px] text-brand-subtle">
        Stops only when a manager Approves or Denies — not when they open the alert.
      </p>
      {secondsLeft === 0 && onProceedWithoutApproval && (
        <button
          type="button"
          className="mt-4 w-full rounded-md border-2 border-brand-danger bg-brand-danger-bg px-3 py-3 text-sm font-bold text-brand-danger"
          onClick={onProceedWithoutApproval}
        >
          {proceedLabel}
        </button>
      )}
    </div>
  )
}
