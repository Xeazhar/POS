/**
 * Staff till PIN helpers (cashier / supervisor).
 * Staff codes stay numeric. PINs are exactly 6 digits — no letters or symbols.
 */

export const PIN_LENGTH = 6

/**
 * Sanitizes a PIN input to contain at most six digits.
 * @param {*} value - The input value to sanitize.
 * @return {string} The first six digits found in the input.
 */
export function sanitizePinInput(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .slice(0, PIN_LENGTH)
}

/**
 * Validates a PIN against the required six-digit format.
 * @param {*} pin - The PIN to validate.
 * @return {string} An error message when the PIN is invalid, or an empty string when valid.
 */
export function validateComplexPin(pin) {
  const value = String(pin || '')
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(value)) {
    return `PIN must be exactly ${PIN_LENGTH} digits.`
  }
  return ''
}

/**
 * Determines whether a PIN meets the six-digit numeric requirement.
 * @param {string} pin - The PIN to validate.
 * @return {boolean} `true` if the PIN contains exactly six digits, `false` otherwise.
 */
export function isComplexPin(pin) {
  return !validateComplexPin(pin)
}

/**
 * Generates a random numeric PIN with a length between one and six digits.
 * @param {number} [length=6] - The desired PIN length.
 * @return {string} A numeric PIN that may include leading zeros.
 */
export function randomComplexPin(length = PIN_LENGTH) {
  const len = Math.max(1, Math.min(PIN_LENGTH, Number(length) || PIN_LENGTH))
  let out = ''
  for (let i = 0; i < len; i += 1) {
    out += String(Math.floor(Math.random() * 10))
  }
  return out
}

export const PIN_RULES_HINT = `Exactly ${PIN_LENGTH} digits (0–9). No letters or symbols.`
