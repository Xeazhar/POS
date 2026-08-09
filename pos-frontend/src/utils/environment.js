/**
 * Which database is this build pointed at?
 *
 * Local dev and the deployed site were pointing at the SAME Supabase project, so a
 * test sale rung up on a laptop landed in the real branch's fiscal records — records
 * that are append-only for BIR reasons and cannot simply be deleted afterwards. The
 * split is enforced by configuration, but configuration is silent, so this module makes
 * it visible: anything that is not production is labelled, loudly, on every screen.
 *
 * `VITE_APP_ENV` is the declared tier. The project ref is derived from the Supabase URL
 * and shown alongside it, because the declaration can be wrong (a .env copied between
 * machines) and the ref cannot — it is literally the database being written to.
 */

const RAW_ENV = String(import.meta.env.VITE_APP_ENV || '').trim().toLowerCase()

/** production | staging | development. Unset is treated as development, never production. */
export const APP_ENV = ['production', 'staging', 'development'].includes(RAW_ENV)
  ? RAW_ENV
  : // Defaulting an unset value to "production" would make the dangerous case the quiet
    // one. An unlabelled build is assumed to be a dev build and says so.
    'development'

export const IS_PRODUCTION_ENV = APP_ENV === 'production'

/**
 * The Supabase project ref — the `abcdefgh` in `https://abcdefgh.supabase.co`.
 * This is the ground truth about which database is being written to.
 */
export function supabaseProjectRef(url = import.meta.env.VITE_SUPABASE_URL) {
  const raw = String(url || '').trim()
  if (!raw) return null
  try {
    const host = new URL(raw).hostname
    const [ref] = host.split('.')
    return ref || null
  } catch {
    return null
  }
}

export const SUPABASE_PROJECT_REF = supabaseProjectRef()

/** Short label for the environment chip, e.g. "DEVELOPMENT · abcdefgh". */
export function environmentLabel() {
  const ref = SUPABASE_PROJECT_REF
  return ref ? `${APP_ENV.toUpperCase()} · ${ref}` : APP_ENV.toUpperCase()
}

/**
 * True when this build should shout about which database it is on — i.e. anything that
 * is not production. Production stays unlabelled so the badge means something.
 */
export const SHOW_ENV_BADGE = !IS_PRODUCTION_ENV
