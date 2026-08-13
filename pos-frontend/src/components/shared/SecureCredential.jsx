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
 * Provides visually hidden decoy fields to redirect password-manager autofill.
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
