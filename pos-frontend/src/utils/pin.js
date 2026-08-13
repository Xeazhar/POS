/**
 * Staff till PIN helpers (cashier / supervisor).
 * Staff codes stay numeric. PINs are exactly 6 digits — no letters or symbols.
 */

export const PIN_LENGTH = 6

/** Digits only, capped at PIN_LENGTH. */
export function sanitizePinInput(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .slice(0, PIN_LENGTH)
}

/** Returns an error message, or '' when the PIN is valid. */
export function validateComplexPin(pin) {
  const value = String(pin || '')
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(value)) {
    return `PIN must be exactly ${PIN_LENGTH} digits.`
  }
  return ''
}

export function isComplexPin(pin) {
  return !validateComplexPin(pin)
}

/** Generate a random 6-digit PIN (leading zeros allowed). */
export function randomComplexPin(length = PIN_LENGTH) {
  const len = Math.max(1, Math.min(PIN_LENGTH, Number(length) || PIN_LENGTH))
  let out = ''
  for (let i = 0; i < len; i += 1) {
    out += String(Math.floor(Math.random() * 10))
  }
  return out
}

export const PIN_RULES_HINT = `Exactly ${PIN_LENGTH} digits (0–9). No letters or symbols.`
