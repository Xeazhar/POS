/**
 * Local password verifier for the offline lock screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 * A terminal must unlock during a blackout or an ISP outage, so the check cannot go to
 * Supabase. That forces a verifier onto the device, and a verifier on a shop-floor device
 * is assumed stolen: physical access, malware, or a shared machine all yield the IndexedDB
 * file. The only real defence is making each guess expensive.
 *
 * The previous version stored a single unsalted SHA-256 of `staffId:password`. SHA-256 is
 * built to be fast — commodity hardware tries billions per second — so a short manager
 * password fell in minutes. staffId acted as a salt against precomputed tables but did
 * nothing against a targeted attack on one known staff id.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES
 * ─────────────────────────────────────────────────────────────────────────────
 *  - PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP Password Storage Cheat Sheet minimum),
 *    with 16 random bytes of per-device salt. Pure Web Crypto: no network, no library,
 *    works exactly the same offline.
 *  - Constant-time comparison, so a wrong guess leaks nothing through timing.
 *  - Verifier carries its own params, so iterations can be raised later without
 *    invalidating devices that are currently offline.
 *
 * PBKDF2 buys time proportional to password strength; it is not a substitute for one.
 * The attempt lockout in the lock screen is what stops the far more likely attack —
 * somebody standing at the counter guessing — and that matters more day to day.
 */

const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 16
const KEY_BITS = 256
export const VERIFIER_VERSION = 2

/**
 * How long a stored verifier stays usable without a fresh password sign-in.
 * Bounds how long a device that walked out of the shop keeps a crackable artifact.
 * Generous because a branch can legitimately run offline for days.
 */
export const VERIFIER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function fromHex(hex) {
  const clean = String(hex || '')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Length-independent, value-independent comparison — no early exit on first mismatch. */
export function constantTimeEqual(aHex, bHex) {
  const a = fromHex(aHex)
  const b = fromHex(bHex)
  if (a.length !== b.length || a.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

async function pbkdf2(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(password)),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    KEY_BITS,
  )
  return toHex(bits)
}

/** Build a fresh verifier record to persist. Never contains the password. */
export async function createVerifier(staffId, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iterations = PBKDF2_ITERATIONS
  // staffId stays in the derived input so a verifier lifted from one device cannot be
  // replayed against a different staff account that happens to share a password.
  const hash = await pbkdf2(`${staffId}:${password}`, salt, iterations)
  return {
    v: VERIFIER_VERSION,
    staffId,
    salt: toHex(salt),
    iterations,
    hash,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Check a password against a stored verifier.
 * Returns { ok, needsUpgrade } — `needsUpgrade` marks a legacy v1 record that verified
 * correctly and should be rewritten in the new format (see verifyAccountPassword).
 */
export async function verifyAgainst(record, staffId, password) {
  if (!record) return { ok: false, needsUpgrade: false }

  // Legacy v1: unsalted single-round SHA-256. Still accepted ONCE so a terminal that is
  // offline right now doesn't get locked out by this upgrade — it is re-hashed to v2
  // immediately on success and the weak form is gone from that device for good.
  if (!record.v || record.v < 2) {
    if (!record.digest) return { ok: false, needsUpgrade: false }
    const legacy = await crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(`${staffId}:${password}`))
      .then(toHex)
    return { ok: constantTimeEqual(legacy, record.digest), needsUpgrade: true }
  }

  if (!record.salt || !record.hash || !record.iterations) return { ok: false, needsUpgrade: false }
  const attempt = await pbkdf2(`${staffId}:${password}`, fromHex(record.salt), record.iterations)
  return {
    ok: constantTimeEqual(attempt, record.hash),
    // Re-derive if the cost floor has been raised since this verifier was written.
    needsUpgrade: record.iterations < PBKDF2_ITERATIONS,
  }
}

/** True once a verifier is old enough that a fresh password sign-in should be required. */
export function isVerifierExpired(record, now = Date.now()) {
  if (!record?.createdAt) return false // legacy records have no timestamp; upgrade will add one
  const created = new Date(record.createdAt).getTime()
  if (Number.isNaN(created)) return false
  return now - created > VERIFIER_MAX_AGE_MS
}
