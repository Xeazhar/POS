/** Props for forms that must never trigger browser password managers. */
export const secureFormProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
  'data-lpignore': 'true',
  'data-1p-ignore': 'true',
  'data-bwignore': 'true',
}

/**
 * Hidden decoy fields — password managers often fill these instead of real inputs.
 * Place once at the top of a credential form.
 */
export function CredentialAutofillTrap() {
  return (
    <div
      className="pointer-events-none absolute -left-[9999px] h-0 w-0 overflow-hidden opacity-0"
      aria-hidden="true"
    >
      <input tabIndex={-1} name="username" autoComplete="username" defaultValue="" />
      <input tabIndex={-1} name="password" type="password" autoComplete="current-password" defaultValue="" />
    </div>
  )
}
