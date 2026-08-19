# CalePOS error codes

**Generated file — do not edit.** Source of truth is `src/utils/errors.js`; regenerate with `npm run docs:errors`.

## How to use this

Staff read a code off the screen (`… · Code SALE01`) and quote it. Look it up here.

Read the columns in this order:

1. **Sale impact** — settle the money question first. Everything else can wait.
2. **Severity** — decides whether this is a retry, a wait, or an admin job.
3. **Likely cause / First action** — the actual fix.

### Sale impact values

| Value | What it means at the till |
| --- | --- |
| `notRecorded` | The sale was NOT recorded. Do not hand over goods, ring it up again. |
| `savedOffline` | The sale IS saved on this device and will sync. Do not ring it up again. |
| `atRisk` | Saved on this device but not yet on the server. Keep this device on and call support. Do not clear browser data. |
| `unknown` | It is not certain whether this sale went through. Check Transactions for the invoice number BEFORE ringing it again, or the customer may be charged twice. |

### Severity values

| Value | Meaning |
| --- | --- |
| `blocking` | Blocking — the task cannot continue |
| `degraded` | Degraded — carried on in a reduced mode, nothing lost |
| `config` | Configuration — retrying will never help, an admin must fix it |
| `warning` | Warning — informational, the user can proceed |

### Prefixes

`AUTH` sign-in · `TILL` drawer open/close · `SALE` taking money · `INV` products & stock · `CAT` network catalog · `DEV` printers & devices · `SYNC` offline queue · `DATA` import/export/reports · `PRINT` printing · `SEC` authorisation refusals · `GEN` unclassified

---

## AUTH

### AUTH01 — Sign-in failed: wrong email/password or account inactive.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Credentials rejected by Supabase Auth, or the staff row is marked inactive.
- **First action:** Re-type the password. If it still fails, check the account is Active on Manager → Staff.
- **Raised from:** `src/legal/terms.js:111`, `src/pages/Login.jsx:208`

### AUTH02 — No staff profile linked to this login.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The Auth user exists but no row in `staff` has a matching auth_user_id, so the app cannot tell which branch or role they have.
- **First action:** Manager → Staff: re-save the person to relink, or recreate the login.
- **Raised from:** `src/stores/posStore.js:105`

### AUTH03 — Offline and no saved session. Connect once to sign in.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** First sign-in on this device with no network. There is nothing cached to verify against.
- **First action:** Get the device online once. After that, sign-in works offline.
- **Raised from:** `src/stores/posStore.js:99`

### AUTH04 — Day was closed. Sign in again with password to open the till.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A Z-Read / day-end closed the trading day. Reopening deliberately requires a full sign-in.
- **First action:** Sign in with the email + password account, not the PIN.
- **Raised from:** `src/stores/posStore.js:90`

### AUTH05 — App not configured: missing Supabase environment keys.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is absent from the build.
- **First action:** Set both in the deploy environment and rebuild. Never use the service role key here.
- **Raised from:** `src/pages/Login.jsx:89`, `src/stores/posStore.js:64`

### AUTH06 — Complete the captcha, then try signing in again.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Turnstile/captcha challenge not solved or expired.
- **First action:** Solve the challenge. If it never appears, check the captcha domain is allowed in the CSP.
- **Raised from:** `src/lib/api.js:3700`, `src/pages/Login.jsx:208`

### AUTH07 — Too many failed PIN attempts. Wait and try again.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The brute-force lockout in migrate_pin_security_hardening.sql tripped: 5 failed attempts within 15 minutes for this login code.
- **First action:** Wait out the lockout, or have a manager reveal/reset the PIN on Manager → Staff.
- **Raised from:** `src/pages/Transactions.jsx:309`

### AUTH08 — Session expired. Sign in again.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The Supabase access token could not be refreshed (token revoked, or offline past its lifetime).
- **First action:** Sign in again. If it recurs constantly, check the device clock is correct.
- **Raised from:** _not yet used in code_

### AUTH09 — Invalid supervisor code or PIN.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Staff code / PIN did not match an active supervisor or manager for this branch.
- **First action:** Re-enter the supervisor staff code and PIN. If the PIN is correct but keeps failing, have a manager re-save that staff member's PIN in Staff (refreshes offline verifiers), and confirm migrate_manager_can_approve_any_branch.sql is applied.
- **Raised from:** `src/components/pos/CartRemoveApprove.jsx:119`, `src/components/pos/CartRemoveApprove.jsx:154`, `src/components/pos/OpenDrawer.jsx:230`, `src/components/shared/SupervisorApprove.jsx:50`

### AUTH10 — That staff code or email was already used in an earlier attempt that did not finish.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** A previous "Create staff login" attempt created the Auth login but failed before the staff row saved (e.g. a rejected write), leaving an orphaned login with no matching account — Supabase Auth now refuses to reuse that email/code.
- **First action:** Pick a different staff code (or email, for a manager/admin account) and save again. Ask an admin to remove the orphaned Auth user for the old code if you need to reuse it.
- **Raised from:** `src/lib/api.js:3711`

### AUTH11 — Your session has ended because this account was signed in on another device.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Single-active-session policy (migrate_single_active_session_enforcement.sql): a newer login for this staff account replaced this device's session. Detected via the periodic heartbeat, a realtime notice, or a rejected offline-queue sync.
- **First action:** Sign in again to resume on this device. Anything rung offline before the switch is still queued locally and syncs once signed back in.
- **Raised from:** `src/stores/posStore.js:218`, `src/stores/posStore.js:315`

## CAT

### CAT01 — Could not adopt this catalog item into the branch.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Copying a catalog_products template into this branch’s products table failed — commonly a SKU already used locally.
- **First action:** Check whether the branch already has that SKU. If so, edit the existing product instead of adopting again.
- **Raised from:** `src/components/catalog/SupervisorCatalogAdopt.jsx:218`

### CAT02 — Could not add the item to the network catalog.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The catalog_products insert was rejected — usually a duplicate SKU across the network.
- **First action:** Search the catalog for that SKU first; network SKUs must be unique.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:369`

### CAT03 — Could not save catalog changes.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The catalog_products update was rejected.
- **First action:** Retry. Remember this edits the shared TEMPLATE — it does not change products a branch already adopted.
- **Raised from:** _not yet used in code_

### CAT04 — Bulk catalog update failed. Some items may not have changed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A multi-row catalog write failed partway. Rows before the failure are already saved.
- **First action:** Re-run the same selection. The update is idempotent, so re-applying it is safe.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:532`

### CAT05 — Could not load the network catalog.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The catalog_products read failed or timed out.
- **First action:** Check the connection and retry.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:238`, `src/components/catalog/ManagerNetworkCatalog.jsx:308`, `src/components/catalog/SupervisorCatalogAdopt.jsx:252`

### CAT06 — Could not import the catalog file.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The import was rejected during validation, so nothing was written — the file is checked in full before any row is saved.
- **First action:** Fix the row named in the message and import the whole file again.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:263`

### CAT07 — Could not re-sync discountable settings to branches.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The cascade from catalog_products.discount_eligible down to adopted products failed, so some branches still hold the old value.
- **First action:** Retry from Manager → Data. If branches stay out of step, run migrate_sync_discount_eligible.sql.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:559`

## DATA

### DATA01 — Import failed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The file was rejected during validation — nothing was written.
- **First action:** Correct the row named in the message and re-import the whole file.
- **Raised from:** `src/pages/manager/Reports.jsx:305`

### DATA02 — Could not add product.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The product insert was rejected, commonly a duplicate SKU or a missing category.
- **First action:** Check the SKU and category, then retry.
- **Raised from:** _not yet used in code_

### DATA03 — Price update failed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The price write was rejected. The old price is still in force and still being charged.
- **First action:** Retry, then confirm the shelf price matches what the POS charges.
- **Raised from:** _not yet used in code_

### DATA04 — Select a branch first.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The action needs a branch scope and none was chosen.
- **First action:** Pick a branch in the filter and repeat the action.
- **Raised from:** _not yet used in code_

### DATA05 — Report could not be generated.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A report query failed or timed out — most often a very wide date range.
- **First action:** Narrow the date range and retry. Export month by month for long periods.
- **Raised from:** _not yet used in code_

## DEV

### DEV01 — Device settings DB column missing: run migrate_device_settings.sql in Supabase.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The branch_devices/device settings columns do not exist in this database yet.
- **First action:** Apply migrate_device_settings.sql in the Supabase SQL editor.
- **Raised from:** `src/lib/api.js:3513`, `src/lib/api.js:3514`, `src/lib/api.js:3527`, `src/lib/api.js:3528`

### DEV02 — Could not save device on/off setting.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The device settings write was rejected.
- **First action:** Retry. Confirm the signed-in user manages this branch.
- **Raised from:** `src/lib/api.js:3519`, `src/pages/manager/BranchDashboard.jsx:760`

### DEV03 — Receipt printer is disabled for this branch.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Deliberate configuration — printing is switched off in Devices.
- **First action:** Enable the printer in Settings → Devices if a receipt is required.
- **Raised from:** `src/pages/Transactions.jsx:739`, `src/pages/Transactions.jsx:742`

### DEV04 — Receipt print failed.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The print window was refused or the printer did not respond. The SALE IS STILL RECORDED.
- **First action:** Reprint from Transactions. Never re-ring the sale to get a receipt.
- **Raised from:** `src/pages/manager/BranchDashboard.jsx:2342`, `src/pages/Transactions.jsx:754`

### DEV05 — Could not reach the device.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A terminal, drawer or printer did not answer within the timeout.
- **First action:** Check power and cabling, then retry. Sales continue without it.
- **Raised from:** `src/pages/Devices.jsx:275`, `src/pages/Devices.jsx:277`

## GEN

### GEN01 — Unexpected error.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `unknown` — It is not certain whether this sale went through. Check Transactions for the invoice number BEFORE ringing it again, or the customer may be charged twice.
- **Safe to retry:** no
- **Likely cause:** An unclassified failure. If this is common, the failing path needs its own code.
- **First action:** Screenshot the whole screen and send it to support with what you were doing.
- **Raised from:** `src/lib/api.js:3519`

## IMP

### IMP01 — Could not read that spreadsheet.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The file could not be parsed — wrong format, corrupt, or renamed to .xlsx without actually being one. Nothing was imported.
- **First action:** Re-export as .xlsx or .csv from the original program and try again. Keep files under 20MB.
- **Raised from:** `src/components/inventory/InventoryImportPanel.jsx:209`

### IMP02 — Import failed. Nothing was saved.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The rows were rejected during validation, so no products were written. The whole file is checked before any row is saved.
- **First action:** Fix the row named in the message and import the whole file again.
- **Raised from:** `src/components/inventory/InventoryImportPanel.jsx:251`

### IMP03 — Could not undo that import.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The revert RPC failed — the import may already be reverted, or the batch was not found.
- **First action:** Refresh and check the batch status. Only a manager can revert an import.
- **Raised from:** `src/components/inventory/InventoryImportPanel.jsx:90`, `src/components/inventory/InventoryImportPanel.jsx:107`, `src/components/inventory/InventoryImportPanel.jsx:121`

## INV

### INV01 — Product save failed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The products insert/update was rejected — RLS, a missing column, or a duplicate SKU.
- **First action:** Check the SKU is not already used in this branch, then retry.
- **Raised from:** _not yet used in code_

### INV02 — Stock adjustment failed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The branch_inventory write or its stock_movements audit row was rejected.
- **First action:** Retry. If it persists, confirm the product is actually adopted by this branch.
- **Raised from:** _not yet used in code_

### INV03 — Could not toggle menu availability.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The available_today update failed, or the column is missing on an older database.
- **First action:** Retry. If the column is missing, apply the pending migrate_*.sql.
- **Raised from:** _not yet used in code_

### INV04 — Not enough stock for this quantity.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The requested quantity exceeds quantity_on_hand for this branch.
- **First action:** Count the shelf and adjust stock, or reduce the quantity.
- **Raised from:** _not yet used in code_

### INV05 — Could not load the stock movement history.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The stock_movements read failed. Stock counts themselves are unaffected.
- **First action:** Retry, or narrow the date range. Selling and stock adjustments still work.
- **Raised from:** `src/components/inventory/MovementHistoryPanel.jsx:135`

### INV06 — Could not export the movement history.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The xlsx library failed to load, or the file could not be written.
- **First action:** Retry. The movements already on screen are unaffected either way.
- **Raised from:** `src/components/inventory/MovementHistoryPanel.jsx:214`

## MOVE

### MOVE01 — Could not record the cash movement.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** create/approve RPC for cash_movements failed or migrate_cash_movements.sql is missing.
- **First action:** Retry. Apply migrate_cash_movements.sql in the Supabase SQL editor.
- **Raised from:** `src/components/pos/OpenDrawer.jsx:230`, `src/components/pos/OpenDrawer.jsx:302`, `src/components/pos/OpenDrawer.jsx:370`, `src/components/pos/OpenDrawer.jsx:429`

### MOVE02 — Enter a positive amount.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Amount was missing or not greater than zero.
- **First action:** Enter the cash amount leaving the drawer.
- **Raised from:** _not yet used in code_

### MOVE03 — A reason is required.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Cash movements always need a free-text reason.
- **First action:** Type why the cash is leaving the drawer.
- **Raised from:** `src/components/pos/OpenDrawer.jsx:384`, `src/components/pos/OpenDrawer.jsx:384`

### MOVE04 — Supervisor or manager approval is required.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Cannot approve your own request; a different supervisor/manager must act.
- **First action:** Have a supervisor enter their PIN, or notify a manager.
- **Raised from:** `src/components/pos/CartRemoveApprove.jsx:144`, `src/components/pos/OpenDrawer.jsx:169`, `src/components/pos/OpenDrawer.jsx:230`

### MOVE15 — Confirm you understand this movement is unapproved.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Self-record requires the acknowledgment checkbox.
- **First action:** Tick the acknowledgment, then submit.
- **Raised from:** `src/components/pos/OpenDrawer.jsx:380`, `src/components/pos/OpenDrawer.jsx:380`

### MOVE19 — You cannot review your own cash movement.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** reviewed_by must differ from requested_by.
- **First action:** Ask another supervisor or manager to Confirm or Flag.
- **Raised from:** `src/components/dayend/DrawerActivity.jsx:158`, `src/pages/manager/BranchDashboard.jsx:1935`, `src/pages/manager/BranchDashboard.jsx:1976`

### MOVE20 — Opening float already set on this shift.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** starting_cash is no longer zero — opening float is one-time per shift.
- **First action:** Use Cash in / Additional float instead.
- **Raised from:** _not yet used in code_

### MOVE21 — Only a manager can resolve a flagged cash movement.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** resolve_flagged_cash_movement requires is_manager().
- **First action:** Have a manager mark the flagged row Resolved.
- **Raised from:** `src/pages/manager/BranchDashboard.jsx:1893`

### MOVE22 — Only flagged movements can be marked Resolved this way.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Movement status is not flagged_for_investigation.
- **First action:** Use Confirm/Flag on Unauthorized rows, or refresh the log.
- **Raised from:** _not yet used in code_

### MOVE23 — Notify manager needs a connection.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Remote manager alerts require the server. Offline Open Drawer still works with a supervisor PIN on this device.
- **First action:** Use Supervisor PIN on this terminal, or reconnect to notify a remote manager.
- **Raised from:** `src/components/pos/OpenDrawer.jsx:352`, `src/components/pos/OpenDrawer.jsx:352`

## PETTY

### PETTY01 — Could not save the cash drawer entry.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The cash_drawer_entries write was rejected. On older databases this table is still named petty_cash.
- **First action:** Retry. Apply migrate_rename_petty_cash_to_cash_drawer_entries.sql and migrate_schema_cleanup_v1.sql — the app no longer falls back to petty_cash.
- **Raised from:** _not yet used in code_

### PETTY02 — Could not load cash drawer entries.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The cash drawer history read failed. Recorded entries are unaffected.
- **First action:** Retry. The day-end count can still be entered without this list.
- **Raised from:** _not yet used in code_

### PETTY03 — Cannot hand over cash without an approval.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Petty cash can only be marked as handed over once a supervisor or manager has approved it, and only once.
- **First action:** Get the request approved first, or refresh — it may already be marked as handed over.
- **Raised from:** _not yet used in code_

## PRICE

### PRICE01 — Price override failed. The original price still applies.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The override was rejected, usually because supervisor approval was missing or expired.
- **First action:** Get supervisor approval and try again. Check the price on screen before taking payment.
- **Raised from:** `src/pages/POS.jsx:327`

## PRINT

### PRINT01 — Pop-up blocked. Allow pop-ups to print receipts.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The browser blocked the print window. The sale is unaffected.
- **First action:** Allow pop-ups for this site, then reprint from Transactions.
- **Raised from:** _not yet used in code_

## PROMO

### PROMO01 — Could not create the promo.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The promo_events insert (or a per-branch copy of it, for multi-branch create) was rejected.
- **First action:** Check the branch, dates, and rule details, then retry.
- **Raised from:** `src/components/promos/PromoEditorModal.jsx:541`, `src/pages/manager/Promos.jsx:864`

### PROMO02 — Could not save the promo rule.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The promo_rules / promo_rule_products write was rejected — often a duplicate product on the same rule type.
- **First action:** Adjust the rule and retry.
- **Raised from:** `src/components/promos/PromoEditorModal.jsx:414`, `src/components/promos/PromoEditorModal.jsx:433`

### PROMO03 — Could not save promo changes.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The promo_events update was rejected — the promo may no longer be pending.
- **First action:** Reload Promo History and retry from a pending revision.
- **Raised from:** `src/components/promos/PromoEditorModal.jsx:541`, `src/pages/manager/Promos.jsx:650`

### PROMO04 — Could not approve the promo.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** approve_promo_event was rejected — commonly a promo with zero rules, or it is no longer pending.
- **First action:** Add at least one rule if none exist, then retry.
- **Raised from:** `src/pages/manager/Promos.jsx:738`

### PROMO05 — Could not reject the promo.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** reject_promo_event was rejected — commonly a missing reason or the promo is no longer pending.
- **First action:** Enter a reason and retry.
- **Raised from:** `src/pages/manager/Promos.jsx:758`

### PROMO06 — Could not process the promo stop request.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** request_stop_promo / approve_stop_promo / reject_stop_promo was rejected.
- **First action:** Retry, or reload Promo History if the promo status already changed.
- **Raised from:** `src/pages/manager/Promos.jsx:782`, `src/pages/manager/Promos.jsx:795`, `src/pages/manager/Promos.jsx:808`

### PROMO07 — Could not load promo data.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A promo, rule, or product read failed or timed out.
- **First action:** Check the connection and retry.
- **Raised from:** `src/components/promos/PromoEditorModal.jsx:245`, `src/components/promos/PromoEditorModal.jsx:273`, `src/pages/manager/Promos.jsx:394`, `src/pages/manager/Promos.jsx:405`

### PROMO08 — Could not delete the promo.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The promo_events delete was rejected — commonly a promo that is no longer pending/rejected.
- **First action:** Reload Promo History and retry.
- **Raised from:** `src/pages/manager/Promos.jsx:878`

## SALE

### SALE01 — Sale failed: payment was not recorded.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `notRecorded` — The sale was NOT recorded. Do not hand over goods, ring it up again.
- **Safe to retry:** yes
- **Likely cause:** The transaction insert was rejected before any row was written.
- **First action:** Ring the sale up again. It is safe — nothing was saved.
- **Raised from:** `src/components/pos/Cart.jsx:555`

### SALE02 — Sale queued offline. Will sync when online.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `savedOffline` — The sale IS saved on this device and will sync. Do not ring it up again.
- **Safe to retry:** no
- **Likely cause:** Normal offline-first behaviour: the sale is in the IndexedDB outbox awaiting sync.
- **First action:** Nothing to do. Confirm the sidebar returns to "Synced" once the network is back.
- **Raised from:** _not yet used in code_

### SALE03 — Refund failed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `unknown` — It is not certain whether this sale went through. Check Transactions for the invoice number BEFORE ringing it again, or the customer may be charged twice.
- **Safe to retry:** no
- **Likely cause:** The refund write was rejected. It may or may not have partially applied.
- **First action:** Open the transaction and check whether the refund is already listed BEFORE refunding again.
- **Raised from:** `src/pages/manager/BranchDashboard.jsx:1566`, `src/pages/Transactions.jsx:350`, `src/pages/Transactions.jsx:368`, `src/pages/Transactions.jsx:399`

### SALE04 — Void failed. The sale is unchanged.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The void update was rejected, usually by RLS or a missing supervisor approval.
- **First action:** Get supervisor approval and retry. The original sale is still valid and unmodified.
- **Raised from:** _not yet used in code_

### SALE05 — This sale was already recorded, not charged again.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `savedOffline` — The sale IS saved on this device and will sync. Do not ring it up again.
- **Safe to retry:** no
- **Likely cause:** The duplicate guard in migrate_sale_dedupe_hardening.sql matched an existing client_id. A retry reached the server twice.
- **First action:** Nothing to do — this is the protection working. The customer was charged once.
- **Raised from:** _not yet used in code_

### SALE06 — Refund request failed.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Creating, cancelling, or rejecting the remote manager approval request was rejected.
- **First action:** Nothing has been refunded yet — retry, or fall back to in-person supervisor approval.
- **Raised from:** `src/pages/manager/BranchDashboard.jsx:1615`, `src/pages/Transactions.jsx:434`, `src/pages/Transactions.jsx:464`

### SALE07 — Refunds are not available offline.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Refunds change inventory, cash accountability, and audit records — they need a server connection.
- **First action:** Make a physical list of items to refund and record them when the system is back online.
- **Raised from:** `src/pages/Transactions.jsx:764`, `src/pages/Transactions.jsx:1040`, `src/pages/Transactions.jsx:1040`

## SEC

### SEC01 — You cannot assign a role at or above your own.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The role ceiling in migrate_role_assignment_ceiling.sql refused the write. Managers may only create roles strictly below their own.
- **First action:** Ask an admin or master to create this account. This is working as intended.
- **Raised from:** `src/pages/manager/Staff.jsx:1222`

### SEC02 — You cannot modify an account at or above your own role.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The role ceiling refused an edit to a peer or senior account.
- **First action:** Ask someone above that account’s role to make the change.
- **Raised from:** `src/pages/manager/Staff.jsx:1216`

### SEC03 — You cannot change your own role, access, branch or active status.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Self-service privilege change is blocked outright — it is the shortest escalation path there is.
- **First action:** Ask someone above you to make the change. This is working as intended.
- **Raised from:** `src/pages/manager/Staff.jsx:1215`

### SEC04 — A supervisor must approve this action.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A supervisor-gated action (void, price override, refund) ran without approval.
- **First action:** Have a supervisor approve on the terminal, then repeat.
- **Raised from:** _not yet used in code_

## SESS

### SESS01 — Session tools are not installed on this database yet.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The admin session functions from migrate_admin_session_release.sql are missing.
- **First action:** Run migrate_admin_session_release.sql in the Supabase SQL editor.
- **Raised from:** `src/lib/api.js:3613`, `src/lib/api.js:3643`, `src/lib/api.js:3660`, `src/pages/manager/Staff.jsx:457`

### SESS02 — Only a master account can force someone to sign out.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Forcing a sign-out can eject a cashier mid-sale, so it is restricted to master accounts.
- **First action:** Ask a master account to clear the session, or wait 15 minutes for it to expire on its own.
- **Raised from:** `src/lib/api.js:3640`, `src/lib/api.js:3657`, `src/pages/manager/Staff.jsx:984`, `src/pages/manager/Staff.jsx:1017`

## SHIFT

### SHIFT01 — Could not load or save shift records.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The staff_shifts read or write failed.
- **First action:** Retry. If starting a shift will not save, note the time and your change fund on paper and tell a manager.
- **Raised from:** `src/components/pos/OpenDrawer.jsx:175`, `src/components/pos/OpenDrawer.jsx:207`, `src/components/pos/OpenDrawer.jsx:255`, `src/components/pos/OpenDrawer.jsx:287`

### SHIFT02 — This drawer still has an open shift for another cashier.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** One drawer holds one shift at a time — otherwise a shortage cannot be traced to whoever was actually holding the cash.
- **First action:** The previous cashier cashes out on this terminal. If they have gone, a supervisor counts the drawer and closes their shift.
- **Raised from:** `src/lib/api.js:4004`, `src/pages/DayEnd.jsx:1258`, `src/pages/manager/Staff.jsx:1138`

### SHIFT03 — Enter the counted cash amount.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A change fund or ending count was missing, negative, or an adjustment had no reason written.
- **First action:** Count the drawer and type the figure. Zero is allowed; blank is not.
- **Raised from:** `src/lib/api.js:4008`, `src/pages/manager/Staff.jsx:1079`, `src/stores/shiftStore.js:161`

### SHIFT04 — That shift is closed. Record an adjustment instead of editing it.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Closed shift figures are frozen, like sales records: the original count has to stay readable for BIR and for any dispute about it.
- **First action:** Manager → Shifts: use Adjust on that shift. The old value, the new value and your reason are all kept.
- **Raised from:** `src/lib/api.js:4005`

### SHIFT05 — Only a supervisor or manager can change a shift’s cash figures.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** adjust_shift_cash() refused the caller — either the role is too low or the shift is at another branch.
- **First action:** Ask a supervisor at that branch, or a manager.
- **Raised from:** `src/lib/api.js:4006`, `src/lib/api.js:4233`, `src/pages/DayEnd.jsx:684`

## STAFF

### STAFF01 — Staff roster is not installed on this database yet.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Supervisors need branch_staff_roster() so till PINs are not exposed via a wide SELECT.
- **First action:** Run migrate_branch_staff_roster.sql in the Supabase SQL editor.
- **Raised from:** `src/lib/api.js:3562`

### STAFF02 — PIN reveal is not installed on this database yet.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Managers reveal PINs through reveal_staff_pin(), not a direct staff table read.
- **First action:** Run migrate_reveal_staff_pin.sql in the Supabase SQL editor.
- **Raised from:** `src/lib/api.js:3912`

### STAFF03 — You are not allowed to reveal this staff member's PIN.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Only manager, admin, or master accounts may reveal till PINs.
- **First action:** Ask a manager to reveal the PIN, or reset it from Staff with edit access.
- **Raised from:** `src/lib/api.js:3917`

## SYNC

### SYNC01 — Branch sync failed.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `savedOffline` — The sale IS saved on this device and will sync. Do not ring it up again.
- **Safe to retry:** yes
- **Likely cause:** The queue push or remote pull failed. Local data is intact; the queue preserves order and will resume.
- **First action:** Check the connection. Sync retries by itself — no action needed unless it persists for hours.
- **Raised from:** `src/pages/settings/SharedPanels.jsx:75`, `src/stores/posStore.js:1366`

### SYNC02 — Could not load branch data.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The initial branch fetch failed, so products and inventory are unavailable.
- **First action:** Retry. If offline, the app falls back to the last cached copy.
- **Raised from:** _not yet used in code_

### SYNC09 — Records could not sync after repeated attempts. Saved on this device only.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `atRisk` — Saved on this device but not yet on the server. Keep this device on and call support. Do not clear browser data.
- **Safe to retry:** yes
- **Likely cause:** A queue item hit MAX_SYNC_ATTEMPTS and was blocked so it cannot stall everything behind it. These are completed sales that never reached Supabase.
- **First action:** Use "Retry now" on the banner. DO NOT clear browser data or reinstall — that destroys the only copy. Call support.
- **Raised from:** `src/components/shared/Shell.jsx:448`, `src/legal/terms.js:111`, `src/pages/settings/SharedPanels.jsx:133`

### SYNC10 — Could not resync this device.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Settings → Sync Status → Hard resync refused, or the reconciling pull failed — usually because something is still queued, or the server is unreachable.
- **First action:** Clear the queue first (let it sync, or use Retry on the banner), confirm you are online, then try Hard resync again.
- **Raised from:** `src/pages/settings/SharedPanels.jsx:96`

## TILL

### TILL01 — Till is closed. Ask a manager to reopen.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Day-end has been run for this branch and business date. Selling into a closed day would corrupt the Z-Read.
- **First action:** Manager reopens the till from Day end, or start the next business day.
- **Raised from:** `src/components/pos/Cart.jsx:399`, `src/components/pos/Cart.jsx:400`, `src/stores/posStore.js:877`

### TILL02 — Could not reopen till.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The day_ends update was rejected — usually RLS (wrong branch) or a missing dual-control column.
- **First action:** Confirm the manager is scoped to this branch, then run migrate_day_end_dual_control.sql if it is not yet applied.
- **Raised from:** `src/pages/DayEnd.jsx:275`, `src/pages/DayEnd.jsx:625`, `src/pages/DayEnd.jsx:649`, `src/pages/DayEnd.jsx:665`

### TILL03 — Day end failed to save.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Writing the day_ends row failed. The count is still on screen and has not been lost.
- **First action:** Retry. If it keeps failing, screenshot the counted figures before leaving the page.
- **Raised from:** `src/components/shared/ShiftGate.jsx:103`

### TILL04 — Refund/void not allowed: this business day is closed. No sales or refunds until a manager reopens the till, or the next business day opens.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** assert_business_day_mutable() (or the client lock check) refused the void/refund because that sale’s business day is submitted or closed. Trading into a closed day would corrupt the Z-Read.
- **First action:** Manager reopens the till from Day end if the same business day must stay open, otherwise wait until the next business day opens and handle the customer then.
- **Raised from:** `src/components/transactions/TransactionDetailModal.jsx:252`, `src/pages/Transactions.jsx:308`, `src/pages/Transactions.jsx:310`, `src/pages/Transactions.jsx:310`

## TILL_ACT

### TILL_ACT01 — Could not send or resolve the till approval request.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** till_action_requests RPC failed or migrate_till_action_requests.sql is missing.
- **First action:** Retry. Apply migrate_till_action_requests.sql in the Supabase SQL editor.
- **Raised from:** _not yet used in code_
