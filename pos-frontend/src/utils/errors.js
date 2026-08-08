/** Support error codes — quote the code when calling / texting for help. */

export const SUPPORT_HINT = 'Text or call CalePOS support and give them this code.'

/**
 * Catalog of known errors. Keep codes stable; change messages freely.
 * Prefix: AUTH / SALE / INV / DEV / SYNC / DATA / TILL / PRINT / GEN
 */
export const ERROR_CATALOG = {
  AUTH01: 'Sign-in failed — wrong email/password or account inactive.',
  AUTH02: 'No staff profile linked to this login.',
  AUTH03: 'Offline and no saved session — connect once to sign in.',
  AUTH04: 'Day was closed — sign in again with password to open the till.',
  AUTH05: 'App not configured — missing Supabase environment keys.',
  AUTH06: 'Complete the captcha, then try signing in again.',
  AUTH07: 'Too many failed PIN attempts — wait and try again.',


  TILL01: 'Till is closed — ask a manager to reopen.',
  TILL02: 'Could not reopen till.',

  SALE01: 'Sale failed — payment was not recorded.',
  SALE02: 'Sale queued offline — will sync when online.',
  SALE03: 'Refund failed.',

  INV01: 'Product save failed.',
  INV02: 'Stock adjustment failed.',
  INV03: 'Could not toggle menu availability.',

  DEV01: 'Device settings DB column missing — run migrate_device_settings.sql in Supabase.',
  DEV02: 'Could not save device on/off setting.',
  DEV03: 'Receipt printer is disabled for this branch.',
  DEV04: 'Receipt print failed.',

  CAT07: 'Could not re-sync discountable settings to branches.',
  SYNC01: 'Branch sync failed.',
  SYNC02: 'Could not load branch data.',
  SYNC09: 'Records could not sync after repeated attempts — saved on this device only.',

  DATA01: 'Import failed.',
  DATA02: 'Could not add product.',
  DATA03: 'Price update failed.',
  DATA04: 'Select a branch first.',

  PRINT01: 'Pop-up blocked — allow pop-ups to print receipts.',

  GEN01: 'Unexpected error.',
}

/**
 * @param {string} code — e.g. 'DEV01'
 * @param {string} [detail] — extra context (DB message, etc.)
 * @returns {Error & { code: string, supportCode: string }}
 */
export function appError(code, detail = '') {
  const base = ERROR_CATALOG[code] || ERROR_CATALOG.GEN01
  const safeCode = ERROR_CATALOG[code] ? code : 'GEN01'
  const message = detail ? `${base} (${detail})` : base
  const err = new Error(message)
  err.code = safeCode
  err.supportCode = safeCode
  err.detail = detail || ''
  return err
}

/** Pull a CALE/XX99-style code from an error or string. */
export function errorCodeOf(err) {
  if (!err) return null
  if (err.code && ERROR_CATALOG[err.code]) return err.code
  if (err.supportCode && ERROR_CATALOG[err.supportCode]) return err.supportCode
  const match = String(err.message || err).match(/\b([A-Z]{2,5}\d{2})\b/)
  return match && ERROR_CATALOG[match[1]] ? match[1] : null
}

/** User-facing one-liner with support code. */
export function formatSupportError(err, fallbackCode = 'GEN01') {
  if (!err) return `${ERROR_CATALOG[fallbackCode]} · Code ${fallbackCode}`
  const raw = typeof err === 'string' ? err : err.message || ''
  if (/captcha|turnstile/i.test(raw)) {
    const msg = raw || ERROR_CATALOG.AUTH06
    return `${msg} · Code AUTH06`
  }
  if (/Too many failed PIN|locked/i.test(raw)) {
    return `${ERROR_CATALOG.AUTH07} · Code AUTH07`
  }
  if (typeof err === 'string') {
    const code = errorCodeOf({ message: err }) || fallbackCode
    const known = ERROR_CATALOG[code]
    if (known && err.includes(known)) return `${err} · Code ${code}`
    return `${err} · Code ${code}`
  }
  const code = errorCodeOf(err) || fallbackCode
  const msg = err.message || ERROR_CATALOG[code] || ERROR_CATALOG.GEN01
  if (/\bCode [A-Z]{2,5}\d{2}\b/.test(msg)) return msg
  return `${msg} · Code ${code}`
}

/** Map common Supabase / network failures to a support code. */
export function classifyError(err, fallbackCode = 'GEN01') {
  const raw = String(err?.message || err || '')
  if (/device_settings|migrate_device_settings/i.test(raw)) return appError('DEV01', raw)
  if (/Invalid login|invalid_credentials|Email not confirmed/i.test(raw)) return appError('AUTH01', raw)
  if (/captcha|turnstile/i.test(raw)) return appError('AUTH06', raw)
  if (/Too many failed PIN|locked/i.test(raw)) return appError('AUTH07', raw)
  if (/pop-?up|blocked/i.test(raw)) return appError('PRINT01', raw)
  if (/Failed to fetch|NetworkError|offline/i.test(raw)) return appError('SYNC01', raw)
  if (err?.code && ERROR_CATALOG[err.code]) return err
  return appError(fallbackCode, raw)
}

/**
 * User-facing sync status copy (sidebar + banner). Prefer readable guidance over raw Postgres text.
 * @returns {{ title: string, body: string, hint?: string }}
 */
export function formatSyncError(raw) {
  const msg = String(raw?.message || raw || '').trim()
  if (!msg) {
    return {
      title: 'Sync issue',
      body: 'Something went wrong while syncing. Check your connection and try again.',
    }
  }

  const col = msg.match(/column\s+([\w."]+)\s+does not exist/i)
  if (col) {
    const column = col[1].replace(/"/g, '')
    const hint = /day_ends\.expected_cash|expected_cash/i.test(column)
      ? 'Run migrate_day_end_dual_control.sql in the Supabase SQL editor.'
      : 'Run the matching migrate_*.sql for this column in Supabase.'
    return {
      title: 'Database needs an update',
      body: `Missing column ${column}.`,
      hint,
    }
  }

  const table = msg.match(/relation\s+"?([\w.]+)"?\s+does not exist/i)
  if (table) {
    return {
      title: 'Database needs an update',
      body: `Missing table ${table[1]}.`,
      hint: 'Run the matching migrate_*.sql in the Supabase SQL editor.',
    }
  }

  if (/schema cache/i.test(msg)) {
    return {
      title: 'Database needs an update',
      body: 'Supabase schema is out of date with the app.',
      hint: 'Apply pending migrate_*.sql files, then wait a minute or reload the API schema.',
    }
  }

  if (/Failed to fetch|NetworkError|offline|timeout/i.test(msg)) {
    return {
      title: 'Connection problem',
      body: 'Could not reach the server. Sales are saved on this device until you are back online.',
    }
  }

  return {
    title: 'Sync issue',
    body: msg,
  }
}
