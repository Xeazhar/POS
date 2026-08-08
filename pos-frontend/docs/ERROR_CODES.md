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
| `notRecorded` | The sale was NOT recorded. Do not hand over goods — ring it up again. |
| `savedOffline` | The sale IS saved on this device and will sync. Do not ring it up again. |
| `atRisk` | Saved on this device but not yet on the server. Keep this device on and call support — do not clear browser data. |
| `unknown` | It is not certain whether this sale went through. Check Transactions for the OR number BEFORE ringing it again, or the customer may be charged twice. |

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

### AUTH01 — Sign-in failed — wrong email/password or account inactive.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Credentials rejected by Supabase Auth, or the staff row is marked inactive.
- **First action:** Re-type the password. If it still fails, check the account is Active on Manager → Staff.
- **Raised from:** `src/pages/Login.jsx:182`

### AUTH02 — No staff profile linked to this login.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The Auth user exists but no row in `staff` has a matching auth_user_id, so the app cannot tell which branch or role they have.
- **First action:** Manager → Staff: re-save the person to relink, or recreate the login.
- **Raised from:** `src/stores/posStore.js:91`

### AUTH03 — Offline and no saved session — connect once to sign in.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** First sign-in on this device with no network. There is nothing cached to verify against.
- **First action:** Get the device online once. After that, sign-in works offline.
- **Raised from:** `src/stores/posStore.js:85`

### AUTH04 — Day was closed — sign in again with password to open the till.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A Z-Read / day-end closed the trading day. Reopening deliberately requires a full sign-in.
- **First action:** Sign in with the email + password account, not the PIN.
- **Raised from:** `src/stores/posStore.js:76`

### AUTH05 — App not configured — missing Supabase environment keys.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY is absent from the build.
- **First action:** Set both in the deploy environment and rebuild. Never use the service role key here.
- **Raised from:** `src/pages/Login.jsx:77`, `src/stores/posStore.js:50`

### AUTH06 — Complete the captcha, then try signing in again.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Turnstile/captcha challenge not solved or expired.
- **First action:** Solve the challenge. If it never appears, check the captcha domain is allowed in the CSP.
- **Raised from:** `src/components/shared/SupervisorApprove.jsx:36`, `src/components/shared/SupervisorApprove.jsx:87`, `src/pages/Login.jsx:182`

### AUTH07 — Too many failed PIN attempts — wait and try again.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The brute-force lockout in migrate_pin_security_hardening.sql tripped: 5 failed attempts within 15 minutes for this login code.
- **First action:** Wait out the lockout, or have a manager reveal/reset the PIN on Manager → Staff.
- **Raised from:** _not yet used in code_

### AUTH08 — Session expired — sign in again.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The Supabase access token could not be refreshed (token revoked, or offline past its lifetime).
- **First action:** Sign in again. If it recurs constantly, check the device clock is correct.
- **Raised from:** _not yet used in code_

## CAT

### CAT01 — Could not adopt this catalog item into the branch.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Copying a catalog_products template into this branch’s products table failed — commonly a SKU already used locally.
- **First action:** Check whether the branch already has that SKU. If so, edit the existing product instead of adopting again.
- **Raised from:** `src/components/catalog/SupervisorCatalogAdopt.jsx:180`

### CAT02 — Could not add the item to the network catalog.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The catalog_products insert was rejected — usually a duplicate SKU across the network.
- **First action:** Search the catalog for that SKU first; network SKUs must be unique.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:284`

### CAT03 — Could not save catalog changes.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The catalog_products update was rejected.
- **First action:** Retry. Remember this edits the shared TEMPLATE — it does not change products a branch already adopted.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:307`

### CAT04 — Bulk catalog update failed — some items may not have changed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A multi-row catalog write failed partway. Rows before the failure are already saved.
- **First action:** Re-run the same selection. The update is idempotent, so re-applying it is safe.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:330`, `src/components/catalog/ManagerNetworkCatalog.jsx:357`, `src/components/catalog/ManagerNetworkCatalog.jsx:401`

### CAT05 — Could not load the network catalog.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The catalog_products read failed or timed out.
- **First action:** Check the connection and retry.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:198`, `src/components/catalog/SupervisorCatalogAdopt.jsx:214`

### CAT06 — Could not import the catalog file.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The import was rejected during validation, so nothing was written — the file is checked in full before any row is saved.
- **First action:** Fix the row named in the message and import the whole file again.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:222`

### CAT07 — Could not re-sync discountable settings to branches.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The cascade from catalog_products.discount_eligible down to adopted products failed, so some branches still hold the old value.
- **First action:** Retry from Manager → Data. If branches stay out of step, run migrate_sync_discount_eligible.sql.
- **Raised from:** `src/components/catalog/ManagerNetworkCatalog.jsx:424`

## DATA

### DATA01 — Import failed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The file was rejected during validation — nothing was written.
- **First action:** Correct the row named in the message and re-import the whole file.
- **Raised from:** `src/pages/manager/Reports.jsx:282`

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

### DEV01 — Device settings DB column missing — run migrate_device_settings.sql in Supabase.

- **Severity:** `config` — Configuration — retrying will never help, an admin must fix it
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The branch_devices/device settings columns do not exist in this database yet.
- **First action:** Apply migrate_device_settings.sql in the Supabase SQL editor.
- **Raised from:** `src/lib/api.js:1843`, `src/lib/api.js:1844`, `src/lib/api.js:1857`, `src/lib/api.js:1858`

### DEV02 — Could not save device on/off setting.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The device settings write was rejected.
- **First action:** Retry. Confirm the signed-in user manages this branch.
- **Raised from:** `src/lib/api.js:1849`, `src/pages/manager/BranchDashboard.jsx:309`

### DEV03 — Receipt printer is disabled for this branch.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Deliberate configuration — printing is switched off in Devices.
- **First action:** Enable the printer in Settings → Devices if a receipt is required.
- **Raised from:** `src/pages/Transactions.jsx:473`, `src/pages/Transactions.jsx:476`

### DEV04 — Receipt print failed.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The print window was refused or the printer did not respond. The SALE IS STILL RECORDED.
- **First action:** Reprint from Transactions. Never re-ring the sale to get a receipt.
- **Raised from:** `src/pages/Transactions.jsx:489`

### DEV05 — Could not reach the device.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A terminal, drawer or printer did not answer within the timeout.
- **First action:** Check power and cabling, then retry. Sales continue without it.
- **Raised from:** `src/pages/Devices.jsx:81`, `src/pages/Devices.jsx:83`

## GEN

### GEN01 — Unexpected error.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `unknown` — It is not certain whether this sale went through. Check Transactions for the OR number BEFORE ringing it again, or the customer may be charged twice.
- **Safe to retry:** no
- **Likely cause:** An unclassified failure. If this is common, the failing path needs its own code.
- **First action:** Screenshot the whole screen and send it to support with what you were doing.
- **Raised from:** `src/lib/api.js:1849`

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

## PRINT

### PRINT01 — Pop-up blocked — allow pop-ups to print receipts.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The browser blocked the print window. The sale is unaffected.
- **First action:** Allow pop-ups for this site, then reprint from Transactions.
- **Raised from:** _not yet used in code_

## SALE

### SALE01 — Sale failed — payment was not recorded.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `notRecorded` — The sale was NOT recorded. Do not hand over goods — ring it up again.
- **Safe to retry:** yes
- **Likely cause:** The transaction insert was rejected before any row was written.
- **First action:** Ring the sale up again. It is safe — nothing was saved.
- **Raised from:** `src/components/pos/Cart.jsx:405`

### SALE02 — Sale queued offline — will sync when online.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `savedOffline` — The sale IS saved on this device and will sync. Do not ring it up again.
- **Safe to retry:** no
- **Likely cause:** Normal offline-first behaviour: the sale is in the IndexedDB outbox awaiting sync.
- **First action:** Nothing to do. Confirm the sidebar returns to "Synced" once the network is back.
- **Raised from:** _not yet used in code_

### SALE03 — Refund failed.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `unknown` — It is not certain whether this sale went through. Check Transactions for the OR number BEFORE ringing it again, or the customer may be charged twice.
- **Safe to retry:** no
- **Likely cause:** The refund write was rejected. It may or may not have partially applied.
- **First action:** Open the transaction and check whether the refund is already listed BEFORE refunding again.
- **Raised from:** `src/pages/Transactions.jsx:222`, `src/pages/Transactions.jsx:234`, `src/pages/Transactions.jsx:260`

### SALE04 — Void failed — the sale is unchanged.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The void update was rejected, usually by RLS or a missing supervisor approval.
- **First action:** Get supervisor approval and retry. The original sale is still valid and unmodified.
- **Raised from:** _not yet used in code_

### SALE05 — This sale was already recorded — not charged again.

- **Severity:** `warning` — Warning — informational, the user can proceed
- **Sale impact:** `savedOffline` — The sale IS saved on this device and will sync. Do not ring it up again.
- **Safe to retry:** no
- **Likely cause:** The duplicate guard in migrate_sale_dedupe_hardening.sql matched an existing client_id. A retry reached the server twice.
- **First action:** Nothing to do — this is the protection working. The customer was charged once.
- **Raised from:** _not yet used in code_

## SEC

### SEC01 — You cannot assign a role at or above your own.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The role ceiling in migrate_role_assignment_ceiling.sql refused the write. Managers may only create roles strictly below their own.
- **First action:** Ask an admin or master to create this account. This is working as intended.
- **Raised from:** `src/pages/manager/Staff.jsx:386`

### SEC02 — You cannot modify an account at or above your own role.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** The role ceiling refused an edit to a peer or senior account.
- **First action:** Ask someone above that account’s role to make the change.
- **Raised from:** `src/pages/manager/Staff.jsx:393`

### SEC03 — You cannot change your own role, access, branch or active status.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Self-service privilege change is blocked outright — it is the shortest escalation path there is.
- **First action:** Ask someone above you to make the change. This is working as intended.
- **Raised from:** `src/pages/manager/Staff.jsx:392`

### SEC04 — A supervisor must approve this action.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** A supervisor-gated action (void, price override, refund) ran without approval.
- **First action:** Have a supervisor approve on the terminal, then repeat.
- **Raised from:** _not yet used in code_

## SYNC

### SYNC01 — Branch sync failed.

- **Severity:** `degraded` — Degraded — carried on in a reduced mode, nothing lost
- **Sale impact:** `savedOffline` — The sale IS saved on this device and will sync. Do not ring it up again.
- **Safe to retry:** yes
- **Likely cause:** The queue push or remote pull failed. Local data is intact; the queue preserves order and will resume.
- **First action:** Check the connection. Sync retries by itself — no action needed unless it persists for hours.
- **Raised from:** _not yet used in code_

### SYNC02 — Could not load branch data.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The initial branch fetch failed, so products and inventory are unavailable.
- **First action:** Retry. If offline, the app falls back to the last cached copy.
- **Raised from:** _not yet used in code_

### SYNC09 — Records could not sync after repeated attempts — saved on this device only.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `atRisk` — Saved on this device but not yet on the server. Keep this device on and call support — do not clear browser data.
- **Safe to retry:** yes
- **Likely cause:** A queue item hit MAX_SYNC_ATTEMPTS and was blocked so it cannot stall everything behind it. These are completed sales that never reached Supabase.
- **First action:** Use "Retry now" on the banner. DO NOT clear browser data or reinstall — that destroys the only copy. Call support.
- **Raised from:** `src/components/shared/Shell.jsx:584`

## TILL

### TILL01 — Till is closed — ask a manager to reopen.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** no
- **Likely cause:** Day-end has been run for this branch and business date. Selling into a closed day would corrupt the Z-Read.
- **First action:** Manager reopens the till from Day end, or start the next business day.
- **Raised from:** `src/components/pos/Cart.jsx:265`, `src/components/pos/Cart.jsx:266`, `src/stores/posStore.js:657`

### TILL02 — Could not reopen till.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** The day_ends update was rejected — usually RLS (wrong branch) or a missing dual-control column.
- **First action:** Confirm the manager is scoped to this branch, then run migrate_day_end_dual_control.sql if it is not yet applied.
- **Raised from:** `src/pages/DayEnd.jsx:169`, `src/pages/DayEnd.jsx:183`, `src/pages/manager/BranchDashboard.jsx:215`, `src/pages/manager/BranchDashboard.jsx:237`

### TILL03 — Day end failed to save.

- **Severity:** `blocking` — Blocking — the task cannot continue
- **Sale impact:** `none`
- **Safe to retry:** yes
- **Likely cause:** Writing the day_ends row failed. The count is still on screen and has not been lost.
- **First action:** Retry. If it keeps failing, screenshot the counted figures before leaving the page.
- **Raised from:** _not yet used in code_
