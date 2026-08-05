/**
 * Staff till PIN / passcode helpers.
 * Staff codes stay numeric. PINs must be complex (letters + numbers + symbols).
 */

const PIN_MIN = 8
const PIN_MAX = 64
const LETTER = /[A-Za-z]/
const DIGIT = /\d/
const SYMBOL = /[^A-Za-z0-9\s]/

/** Allowed printable ASCII (no spaces/control chars). */
export function sanitizePinInput(value) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F\s]/g, '')
    .slice(0, PIN_MAX)
}

export function validateComplexPin(pin) {
  const value = String(pin || '')
  if (value.length < PIN_MIN) {
    return `PIN must be at least ${PIN_MIN} characters.`
  }
  if (value.length > PIN_MAX) {
    return `PIN must be at most ${PIN_MAX} characters.`
  }
  if (/\s/.test(value)) {
    return 'PIN cannot contain spaces.'
  }
  if (!LETTER.test(value)) {
    return 'PIN must include at least one letter.'
  }
  if (!DIGIT.test(value)) {
    return 'PIN must include at least one number.'
  }
  if (!SYMBOL.test(value)) {
    return 'PIN must include at least one symbol (e.g. !@#$%).'
  }
  return ''
}

export function isComplexPin(pin) {
  return !validateComplexPin(pin)
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const DIGITS = '23456789'
const SYMBOLS = '!@#$%&*?'

function pick(charset) {
  return charset[Math.floor(Math.random() * charset.length)]
}

/** Generate a random complex PIN (not just digits). */
export function randomComplexPin(length = 10) {
  const len = Math.max(PIN_MIN, Math.min(PIN_MAX, Number(length) || 10))
  const chars = [pick(LETTERS), pick(DIGITS), pick(SYMBOLS)]
  const pool = LETTERS + DIGITS + SYMBOLS
  while (chars.length < len) chars.push(pick(pool))
  // Shuffle
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

export const PIN_RULES_HINT =
  'At least 8 characters with a letter, a number, and a symbol (e.g. Ka!9mP2$).'
