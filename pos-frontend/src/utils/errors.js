/**
 * Support error codes — the single catalog every user-facing failure is described by.
 *
 * WHY EACH ENTRY IS AN OBJECT, NOT A STRING
 * -----------------------------------------
 * At a till, "something went wrong" is not the useful part. The useful part is:
 *
 *   1. Did the customer's money move, and was the sale recorded?
 *   2. Can the cashier try again, or does someone else have to fix something?
 *
 * A bare message answers neither, so staff guess — and the two guesses available are
 * "ring it again" (double-charges the customer) and "let them go" (loses the sale and
 * breaks the OR sequence). `saleImpact` exists so nobody has to guess: it states whether
 * the sale is recorded, not recorded, saved locally, or genuinely unknown. `unknown` is
 * a real value and must stay one — pretending a failure is safe to retry when it might
 * have gone through is how a customer gets charged twice.
 *
 * `severity`, `retry` and `fix` drive the same decision for the non-money failures.
 *
 * RULES FOR EDITING
 * -----------------
 *  - Codes are quoted to support by staff over the phone. Keep them STABLE. Change the
 *    message text freely; never reassign a code to a different meaning.
 *  - Add a new code rather than reusing one across unrelated failures — a code that
 *    means two things is a code that diagnoses neither.
 *  - Every code referenced anywhere in src/ must exist here. `npm run check:errors`
 *    fails the build if one doesn't, because a code with no entry prints a number that
 *    support cannot look up — which is worse than no code at all.
 *  - docs/ERROR_CODES.md is GENERATED from this file (`npm run docs:errors`). Edit here,
 *    regenerate; never hand-edit the doc.
 */

export const SUPPORT_HINT = 'Text or call CalePOS support and give them this code.'

/**
 * How bad is it?
 *  blocking — the task cannot continue until it is resolved.
 *  degraded — the app carried on in a reduced mode; work was not lost.
 *  config   — the environment or database is wrong. Retrying will never help; an admin
 *             must apply a migration or set a key.
 *  warning  — informational; the user can proceed.
 */
export const SEVERITY = {
  blocking: 'blocking',
  degraded: 'degraded',
  config: 'config',
  warning: 'warning',
}

/**
 * What happened to the money. THE most important field on this page.
 *  none          — no sale involved.
 *  notRecorded   — the sale definitely did not go through. Safe to ring again.
 *  savedOffline  — recorded on this device, will sync. Do NOT ring again.
 *  atRisk        — recorded locally but repeatedly failed to reach the server. Escalate.
 *  unknown       — may or may not have gone through. CHECK before re-ringing.
 */
export const SALE_IMPACT = {
  none: 'none',
  notRecorded: 'notRecorded',
  savedOffline: 'savedOffline',
  atRisk: 'atRisk',
  unknown: 'unknown',
}

/** One-line instruction shown to whoever is standing at the terminal. */
export const SALE_IMPACT_GUIDANCE = {
  none: '',
  notRecorded: 'The sale was NOT recorded. Do not hand over goods — ring it up again.',
  savedOffline: 'The sale IS saved on this device and will sync. Do not ring it up again.',
  atRisk:
    'Saved on this device but not yet on the server. Keep this device on and call support — do not clear browser data.',
  unknown:
    'It is not certain whether this sale went through. Check Transactions for the OR number BEFORE ringing it again, or the customer may be charged twice.',
}

const B = SEVERITY.blocking
const D = SEVERITY.degraded
const C = SEVERITY.config
const W = SEVERITY.warning

/**
 * The catalog. Prefix by area: AUTH / TILL / SALE / INV / CAT / DEV / SYNC / DATA /
 * PRINT / SEC / GEN.
 */
export const ERROR_CATALOG = {
  // ── AUTH — signing in and staying signed in ──────────────────────────────
  AUTH01: {
    message: 'Sign-in failed — wrong email/password or account inactive.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'Credentials rejected by Supabase Auth, or the staff row is marked inactive.',
    fix: 'Re-type the password. If it still fails, check the account is Active on Manager → Staff.',
  },
  AUTH02: {
    message: 'No staff profile linked to this login.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'The Auth user exists but no row in `staff` has a matching auth_user_id, so the app cannot tell which branch or role they have.',
    fix: 'Manager → Staff: re-save the person to relink, or recreate the login.',
  },
  AUTH03: {
    message: 'Offline and no saved session — connect once to sign in.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'First sign-in on this device with no network. There is nothing cached to verify against.',
    fix: 'Get the device online once. After that, sign-in works offline.',
  },
  AUTH04: {
    message: 'Day was closed — sign in again with password to open the till.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'A Z-Read / day-end closed the trading day. Reopening deliberately requires a full sign-in.',
    fix: 'Sign in with the email + password account, not the PIN.',
  },
  AUTH05: {
    message: 'App not configured — missing Supabase environment keys.',
    severity: C,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is absent from the build.',
    fix: 'Set both in the deploy environment and rebuild. Never use the service role key here.',
  },
  AUTH06: {
    message: 'Complete the captcha, then try signing in again.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'Turnstile/captcha challenge not solved or expired.',
    fix: 'Solve the challenge. If it never appears, check the captcha domain is allowed in the CSP.',
  },
  AUTH07: {
    message: 'Too many failed PIN attempts — wait and try again.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'The brute-force lockout in migrate_pin_security_hardening.sql tripped: 5 failed attempts within 15 minutes for this login code.',
    fix: 'Wait out the lockout, or have a manager reveal/reset the PIN on Manager → Staff.',
  },
  AUTH08: {
    message: 'Session expired — sign in again.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The Supabase access token could not be refreshed (token revoked, or offline past its lifetime).',
    fix: 'Sign in again. If it recurs constantly, check the device clock is correct.',
  },

  // ── TILL — opening and closing the drawer ────────────────────────────────
  TILL01: {
    message: 'Till is closed — ask a manager to reopen.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'Day-end has been run for this branch and business date. Selling into a closed day would corrupt the Z-Read.',
    fix: 'Manager reopens the till from Day end, or start the next business day.',
  },
  TILL02: {
    message: 'Could not reopen till.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The day_ends update was rejected — usually RLS (wrong branch) or a missing dual-control column.',
    fix: 'Confirm the manager is scoped to this branch, then run migrate_day_end_dual_control.sql if it is not yet applied.',
  },
  TILL03: {
    message: 'Day end failed to save.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'Writing the day_ends row failed. The count is still on screen and has not been lost.',
    fix: 'Retry. If it keeps failing, screenshot the counted figures before leaving the page.',
  },

  // ── SALE — taking money ──────────────────────────────────────────────────
  SALE01: {
    message: 'Sale failed — payment was not recorded.',
    severity: B,
    saleImpact: SALE_IMPACT.notRecorded,
    retry: true,
    cause: 'The transaction insert was rejected before any row was written.',
    fix: 'Ring the sale up again. It is safe — nothing was saved.',
  },
  SALE02: {
    message: 'Sale queued offline — will sync when online.',
    severity: D,
    saleImpact: SALE_IMPACT.savedOffline,
    retry: false,
    cause: 'Normal offline-first behaviour: the sale is in the IndexedDB outbox awaiting sync.',
    fix: 'Nothing to do. Confirm the sidebar returns to "Synced" once the network is back.',
  },
  SALE03: {
    message: 'Refund failed.',
    severity: B,
    saleImpact: SALE_IMPACT.unknown,
    retry: false,
    cause: 'The refund write was rejected. It may or may not have partially applied.',
    fix: 'Open the transaction and check whether the refund is already listed BEFORE refunding again.',
  },
  SALE04: {
    message: 'Void failed — the sale is unchanged.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The void update was rejected, usually by RLS or a missing supervisor approval.',
    fix: 'Get supervisor approval and retry. The original sale is still valid and unmodified.',
  },
  SALE05: {
    message: 'This sale was already recorded — not charged again.',
    severity: W,
    saleImpact: SALE_IMPACT.savedOffline,
    retry: false,
    cause:
      'The duplicate guard in migrate_sale_dedupe_hardening.sql matched an existing client_id. A retry reached the server twice.',
    fix: 'Nothing to do — this is the protection working. The customer was charged once.',
  },
  SALE06: {
    message: 'Refund request failed.',
    severity: W,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'Creating, cancelling, or rejecting the remote manager approval request was rejected.',
    fix: 'Nothing has been refunded yet — retry, or fall back to in-person supervisor approval.',
  },

  // ── INV — products and stock ─────────────────────────────────────────────
  INV01: {
    message: 'Product save failed.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The products insert/update was rejected — RLS, a missing column, or a duplicate SKU.',
    fix: 'Check the SKU is not already used in this branch, then retry.',
  },
  INV02: {
    message: 'Stock adjustment failed.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The branch_inventory write or its stock_movements audit row was rejected.',
    fix: 'Retry. If it persists, confirm the product is actually adopted by this branch.',
  },
  INV03: {
    message: 'Could not toggle menu availability.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The available_today update failed, or the column is missing on an older database.',
    fix: 'Retry. If the column is missing, apply the pending migrate_*.sql.',
  },
  INV04: {
    message: 'Not enough stock for this quantity.',
    severity: W,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'The requested quantity exceeds quantity_on_hand for this branch.',
    fix: 'Count the shelf and adjust stock, or reduce the quantity.',
  },
  INV05: {
    message: 'Could not load the stock movement history.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The stock_movements read failed. Stock counts themselves are unaffected.',
    fix: 'Retry, or narrow the date range. Selling and stock adjustments still work.',
  },
  INV06: {
    message: 'Could not export the movement history.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The xlsx library failed to load, or the file could not be written.',
    fix: 'Retry. The movements already on screen are unaffected either way.',
  },

  // ── CAT — shared network catalog vs. branch products ─────────────────────
  CAT01: {
    message: 'Could not adopt this catalog item into the branch.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'Copying a catalog_products template into this branch’s products table failed — commonly a SKU already used locally.',
    fix: 'Check whether the branch already has that SKU. If so, edit the existing product instead of adopting again.',
  },
  CAT02: {
    message: 'Could not add the item to the network catalog.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The catalog_products insert was rejected — usually a duplicate SKU across the network.',
    fix: 'Search the catalog for that SKU first; network SKUs must be unique.',
  },
  CAT03: {
    message: 'Could not save catalog changes.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The catalog_products update was rejected.',
    fix: 'Retry. Remember this edits the shared TEMPLATE — it does not change products a branch already adopted.',
  },
  CAT04: {
    message: 'Bulk catalog update failed — some items may not have changed.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'A multi-row catalog write failed partway. Rows before the failure are already saved.',
    fix: 'Re-run the same selection. The update is idempotent, so re-applying it is safe.',
  },
  CAT05: {
    message: 'Could not load the network catalog.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The catalog_products read failed or timed out.',
    fix: 'Check the connection and retry.',
  },
  CAT06: {
    message: 'Could not import the catalog file.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'The import was rejected during validation, so nothing was written — the file is checked in full before any row is saved.',
    fix: 'Fix the row named in the message and import the whole file again.',
  },
  CAT07: {
    message: 'Could not re-sync discountable settings to branches.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'The cascade from catalog_products.discount_eligible down to adopted products failed, so some branches still hold the old value.',
    fix: 'Retry from Manager → Data. If branches stay out of step, run migrate_sync_discount_eligible.sql.',
  },

  // ── DEV — printers, drawers, terminals ───────────────────────────────────
  DEV01: {
    message: 'Device settings DB column missing — run migrate_device_settings.sql in Supabase.',
    severity: C,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'The branch_devices/device settings columns do not exist in this database yet.',
    fix: 'Apply migrate_device_settings.sql in the Supabase SQL editor.',
  },
  DEV02: {
    message: 'Could not save device on/off setting.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The device settings write was rejected.',
    fix: 'Retry. Confirm the signed-in user manages this branch.',
  },
  DEV03: {
    message: 'Receipt printer is disabled for this branch.',
    severity: W,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'Deliberate configuration — printing is switched off in Devices.',
    fix: 'Enable the printer in Settings → Devices if a receipt is required.',
  },
  DEV04: {
    message: 'Receipt print failed.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The print window was refused or the printer did not respond. The SALE IS STILL RECORDED.',
    fix: 'Reprint from Transactions. Never re-ring the sale to get a receipt.',
  },
  DEV05: {
    message: 'Could not reach the device.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'A terminal, drawer or printer did not answer within the timeout.',
    fix: 'Check power and cabling, then retry. Sales continue without it.',
  },

  // ── SYNC — offline queue and replication ─────────────────────────────────
  SYNC01: {
    message: 'Branch sync failed.',
    severity: D,
    saleImpact: SALE_IMPACT.savedOffline,
    retry: true,
    cause: 'The queue push or remote pull failed. Local data is intact; the queue preserves order and will resume.',
    fix: 'Check the connection. Sync retries by itself — no action needed unless it persists for hours.',
  },
  SYNC02: {
    message: 'Could not load branch data.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The initial branch fetch failed, so products and inventory are unavailable.',
    fix: 'Retry. If offline, the app falls back to the last cached copy.',
  },
  SYNC09: {
    message: 'Records could not sync after repeated attempts — saved on this device only.',
    severity: B,
    saleImpact: SALE_IMPACT.atRisk,
    retry: true,
    cause:
      'A queue item hit MAX_SYNC_ATTEMPTS and was blocked so it cannot stall everything behind it. These are completed sales that never reached Supabase.',
    fix: 'Use "Retry now" on the banner. DO NOT clear browser data or reinstall — that destroys the only copy. Call support.',
  },

  // ── DATA — import / export / bulk edits ──────────────────────────────────
  DATA01: {
    message: 'Import failed.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The file was rejected during validation — nothing was written.',
    fix: 'Correct the row named in the message and re-import the whole file.',
  },
  DATA02: {
    message: 'Could not add product.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The product insert was rejected, commonly a duplicate SKU or a missing category.',
    fix: 'Check the SKU and category, then retry.',
  },
  DATA03: {
    message: 'Price update failed.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The price write was rejected. The old price is still in force and still being charged.',
    fix: 'Retry, then confirm the shelf price matches what the POS charges.',
  },
  DATA04: {
    message: 'Select a branch first.',
    severity: W,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'The action needs a branch scope and none was chosen.',
    fix: 'Pick a branch in the filter and repeat the action.',
  },
  DATA05: {
    message: 'Report could not be generated.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'A report query failed or timed out — most often a very wide date range.',
    fix: 'Narrow the date range and retry. Export month by month for long periods.',
  },

  // ── IMP — spreadsheet import ─────────────────────────────────────────────
  IMP01: {
    message: 'Could not read that spreadsheet.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'The file could not be parsed — wrong format, corrupt, or renamed to .xlsx without actually being one. Nothing was imported.',
    fix: 'Re-export as .xlsx or .csv from the original program and try again. Keep files under 20MB.',
  },
  IMP02: {
    message: 'Import failed — nothing was saved.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'The rows were rejected during validation, so no products were written. The whole file is checked before any row is saved.',
    fix: 'Fix the row named in the message and import the whole file again.',
  },

  // ── PETTY — cash drawer / petty cash ─────────────────────────────────────
  PETTY01: {
    message: 'Could not save the cash drawer entry.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause:
      'The cash_drawer_entries write was rejected. On older databases this table is still named petty_cash.',
    fix: 'Retry. Apply migrate_rename_petty_cash_to_cash_drawer_entries.sql and migrate_schema_cleanup_v1.sql — the app no longer falls back to petty_cash.',
  },
  PETTY02: {
    message: 'Could not load cash drawer entries.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The cash drawer history read failed. Recorded entries are unaffected.',
    fix: 'Retry. The day-end count can still be entered without this list.',
  },
  PETTY03: {
    message: 'Cannot hand over cash without an approval.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'Petty cash can only be marked as handed over once a supervisor or manager has approved it, and only once.',
    fix: 'Get the request approved first, or refresh — it may already be marked as handed over.',
  },

  // ── SESS — active-session locks (single sign-in per staff) ───────────────
  SESS01: {
    message: 'Session tools are not installed on this database yet.',
    severity: C,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'The admin session functions from migrate_admin_session_release.sql are missing.',
    fix: 'Run migrate_admin_session_release.sql in the Supabase SQL editor.',
  },
  SESS02: {
    message: 'Only a master account can force someone to sign out.',
    severity: C,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'Forcing a sign-out can eject a cashier mid-sale, so it is restricted to master accounts.',
    fix: 'Ask a master account to clear the session, or wait 15 minutes for it to expire on its own.',
  },

  // ── PRICE — till-side price override ─────────────────────────────────────
  PRICE01: {
    message: 'Price override failed — the original price still applies.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The override was rejected, usually because supervisor approval was missing or expired.',
    fix: 'Get supervisor approval and try again. Check the price on screen before taking payment.',
  },

  // ── SHIFT — shifts, change fund, cash-out ────────────────────────────────
  SHIFT01: {
    message: 'Could not load or save shift records.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The staff_shifts read or write failed.',
    fix: 'Retry. If starting a shift will not save, note the time and your change fund on paper and tell a manager.',
  },
  SHIFT02: {
    message: 'This drawer still has an open shift for another cashier.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'One drawer holds one shift at a time — otherwise a shortage cannot be traced to whoever was actually holding the cash.',
    fix: 'The previous cashier cashes out on this terminal. If they have gone, a supervisor counts the drawer and closes their shift.',
  },
  SHIFT03: {
    message: 'Enter the counted cash amount.',
    severity: W,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'A change fund or ending count was missing, negative, or an adjustment had no reason written.',
    fix: 'Count the drawer and type the figure. Zero is allowed; blank is not.',
  },
  SHIFT04: {
    message: 'That shift is closed — record an adjustment instead of editing it.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'Closed shift figures are frozen, like sales records: the original count has to stay readable for BIR and for any dispute about it.',
    fix: 'Manager → Shifts: use Adjust on that shift. The old value, the new value and your reason are all kept.',
  },
  SHIFT05: {
    message: 'Only a supervisor or manager can change a shift’s cash figures.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'adjust_shift_cash() refused the caller — either the role is too low or the shift is at another branch.',
    fix: 'Ask a supervisor at that branch, or a manager.',
  },

  // ── PRINT ────────────────────────────────────────────────────────────────
  PRINT01: {
    message: 'Pop-up blocked — allow pop-ups to print receipts.',
    severity: D,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'The browser blocked the print window. The sale is unaffected.',
    fix: 'Allow pop-ups for this site, then reprint from Transactions.',
  },

  // ── SEC — authorisation refusals (mirrors the database triggers) ─────────
  SEC01: {
    message: 'You cannot assign a role at or above your own.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause:
      'The role ceiling in migrate_role_assignment_ceiling.sql refused the write. Managers may only create roles strictly below their own.',
    fix: 'Ask an admin or master to create this account. This is working as intended.',
  },
  SEC02: {
    message: 'You cannot modify an account at or above your own role.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'The role ceiling refused an edit to a peer or senior account.',
    fix: 'Ask someone above that account’s role to make the change.',
  },
  SEC03: {
    message: 'You cannot change your own role, access, branch or active status.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: false,
    cause: 'Self-service privilege change is blocked outright — it is the shortest escalation path there is.',
    fix: 'Ask someone above you to make the change. This is working as intended.',
  },
  SEC04: {
    message: 'A supervisor must approve this action.',
    severity: B,
    saleImpact: SALE_IMPACT.none,
    retry: true,
    cause: 'A supervisor-gated action (void, price override, refund) ran without approval.',
    fix: 'Have a supervisor approve on the terminal, then repeat.',
  },

  // ── GEN ──────────────────────────────────────────────────────────────────
  GEN01: {
    message: 'Unexpected error.',
    severity: B,
    saleImpact: SALE_IMPACT.unknown,
    retry: false,
    cause: 'An unclassified failure. If this is common, the failing path needs its own code.',
    fix: 'Screenshot the whole screen and send it to support with what you were doing.',
  },
}

/** The staff-facing sentence for a code. */
export function errorMessage(code) {
  return ERROR_CATALOG[code]?.message || ERROR_CATALOG.GEN01.message
}

/** Full catalog entry, or the GEN01 entry when the code is unknown. */
export function errorInfo(code) {
  return ERROR_CATALOG[code] || ERROR_CATALOG.GEN01
}

/** True only for codes that actually exist — use before showing a code to staff. */
export function isKnownErrorCode(code) {
  return Boolean(ERROR_CATALOG[code])
}

/**
 * The "what do I do about the money right now" line for a code.
 *
 * Resolves ONLY against codes that are actually in the catalog. It must not fall through
 * to errorInfo()'s GEN01 default, because GEN01's saleImpact is `unknown` — so any
 * unrecognised code (or any code-shaped token scraped out of a message) would print
 * "the customer may be charged twice" on a failure that never involved a sale. A cashier
 * shown that after a failed petty-cash entry has been told something false about money,
 * which is worse than being told nothing.
 *
 * Silence is the right default here. GEN01 raised deliberately still gets its warning.
 */
export function saleImpactGuidance(code) {
  const entry = ERROR_CATALOG[code]
  if (!entry) return ''
  return SALE_IMPACT_GUIDANCE[entry.saleImpact] || ''
}

/**
 * @param {string} code — e.g. 'DEV01'
 * @param {string} [detail] — extra context (DB message, etc.)
 * @returns {Error & { code: string, supportCode: string }}
 */
export function appError(code, detail = '') {
  const known = Boolean(ERROR_CATALOG[code])
  const safeCode = known ? code : 'GEN01'
  const base = errorMessage(safeCode)
  const message = detail ? `${base} (${detail})` : base
  const err = new Error(message)
  err.code = safeCode
  err.supportCode = safeCode
  err.detail = detail || ''
  err.severity = ERROR_CATALOG[safeCode].severity
  err.saleImpact = ERROR_CATALOG[safeCode].saleImpact
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
  // An unknown fallback code would print a number support cannot look up. Degrade to
  // GEN01 rather than quoting something meaningless.
  const fallback = ERROR_CATALOG[fallbackCode] ? fallbackCode : 'GEN01'
  if (!err) return `${errorMessage(fallback)} · Code ${fallback}`
  const raw = typeof err === 'string' ? err : err.message || ''
  if (/captcha|turnstile/i.test(raw)) {
    const msg = raw || errorMessage('AUTH06')
    return `${msg} · Code AUTH06`
  }
  if (/Too many failed PIN|locked/i.test(raw)) {
    return `${errorMessage('AUTH07')} · Code AUTH07`
  }
  // Role-ceiling refusals arrive as raw Postgres exceptions carrying their own code.
  const sec = raw.match(/\b(SEC0[1-4])\b/)
  if (sec) return `${errorMessage(sec[1])} · Code ${sec[1]}`
  if (typeof err === 'string') {
    const code = errorCodeOf({ message: err }) || fallback
    return `${err} · Code ${code}`
  }
  const code = errorCodeOf(err) || fallback
  const msg = err.message || errorMessage(code)
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
  if (/JWT expired|refresh_token_not_found|invalid JWT/i.test(raw)) return appError('AUTH08', raw)
  // Database-side authorisation refusals from migrate_role_assignment_ceiling.sql.
  if (/SEC01|Role ceiling.*assign/i.test(raw)) return appError('SEC01', raw)
  if (/SEC02|Role ceiling.*modify/i.test(raw)) return appError('SEC02', raw)
  if (/SEC03|your own role/i.test(raw)) return appError('SEC03', raw)
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
