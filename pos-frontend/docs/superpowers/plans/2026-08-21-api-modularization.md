# API Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `pos-frontend/src/lib/api.js` (8,647 lines, 211 exports, sole Supabase-calling module) into domain modules under `pos-frontend/src/lib/api/`, with `api.js` becoming a thin barrel re-export, so every one of the 44 existing frontend files that `import ... from '../lib/api'` keeps working with zero changes to their import lines.

**Architecture:** No HTTP server/routes/controllers exist in this repo (confirmed: no Express, no Supabase Edge Functions — only `.sql` migrations). "The API" is `src/lib/api.js` itself, called directly by pages/stores/offline queue per CLAUDE.md's documented architecture ("UI/pages never call Supabase directly — always through `src/lib/api.js`"). This plan is a pure move/split refactor: no new abstraction layers, no behavior changes, no route/controller/versioning concepts introduced.

**Tech Stack:** React + Vite frontend, Supabase JS client, no test framework (verification via `npm run lint` / `npm run build` / export-name parity diff, per CLAUDE.md).

**Spec:** User request in this conversation (audit/cleanup/refactor `pos-frontend/src/lib/api.js` into a clean modular structure, preserve all behavior and frontend compatibility, no new features, no dead-code deletion without evidence).

## Global Constraints

- Every one of the 211 current exports from `src/lib/api.js` (function/const names) must still be importable from `'../lib/api'` (or whatever relative path callers currently use) after this refactor, with identical names, signatures, and behavior. Zero frontend files change their import statements.
- No dead code deleted. Audit (done below) found no exports with zero references anywhere in the repo — every candidate is either called internally, called from a frontend file, or explicitly documented in `CODEMAP.md` as an intentional back-compat wrapper (`fetchActivePromoEventWithRules`). See "Audit findings" below. Nothing is removed in this plan.
- `api.js` must not become a `default` export or a namespace object — it currently has zero `export default`, only named exports (plus `export { allowDemoMode }` re-exported from `./supabase`). Preserve that shape exactly.
- Do not touch `pos-frontend/src/lib/supabase.js` or `pos-frontend/src/lib/xlsxLoader.js`.
- Do not change any Supabase table/column names, RPC names, or query shapes — this is a file-organization move only.
- New files live under `pos-frontend/src/lib/api/` (a new directory; no naming collision with the existing `api.js`, which stays at `pos-frontend/src/lib/api.js` as the barrel).
- Order of work matters: build every new domain file first while the original `api.js` is untouched (so `npm run build` stays green throughout and there is a complete reference to extract from). Only rewrite `api.js` into the barrel as the last content task, once every domain file exists and has been export-diffed against its slice of the original.

## Audit findings (Phase 1–2, already done)

- 211 named exports across `src/lib/api.js` (8,647 lines), grouped into ~18 domains (see task list).
- Dead-code sweep: grepped every export name against the rest of `src/` (excluding `api.js`). 22 names had zero hits outside `api.js`; of those, re-checking total occurrence count *inside* `api.js` showed all but 8 are called internally by other exported functions (e.g. `mapMovement`, `mapShiftRow`, `recordPriceChange`, `fetchStaffIdentities` are heavily used internal helpers, just never imported directly by a page/component). The remaining 8 (`closeDayEnd`, `deviceSummary`, `fetchActivePromoEventWithRules`, `fetchImportBatchItems`, `fetchOpenShiftOnDrawer`, `fetchPriceHistory`, `fetchRefundedQuantities`, `isBranchOnline`) are all explicitly named in `docs/CODEMAP.md` as part of the documented API surface (`fetchActivePromoEventWithRules` is explicitly flagged there as "kept as a back-compat wrapper"). Per the "if uncertain, keep it" instruction, **none are deleted**. Report this list to the user as "exported but no current in-repo caller — kept, likely reserved/back-compat" — see Final Report.
- One genuine cross-domain aggregator found: `fetchPendingApprovals` (L8325) + `dismissNotificationItem` (L8608) + `reconcileResolvedPendingApprovals` (L2466, private) — these read/write across till-action, day-end, cash-movement, promo, and refund-request tables directly and call into multiple other domains' functions. They get their own module (`approvals.js`) rather than living in any single domain file.

## File Structure

All new files under `pos-frontend/src/lib/api/`. `pos-frontend/src/lib/api.js` becomes a barrel (final task).

| File | Responsibility |
|---|---|
| `api/shared.js` | Cross-domain primitives: `hasSupabase`, `allowDemoMode` passthrough, `fetchAllRows`, `isMissingColumnError`, `localDayBoundsIso`, `mapPricing`/`toDbPricing`, `formatProductCode`, `mapProduct`, `mapTransaction`, `mapDayEndRow`, `approverLabel`, `withCashierName`, `withApprover`, `staffNameById`, `fetchStaffIdentities`, `writeProductRow`, `PAGE_ROWS` |
| `api/auth.js` | Sign-in/out, sessions, supervisor PIN, manager unlock, device session id |
| `api/catalog.js` | Network catalog + branch products: bootstrap*, fetch/create/update/delete product, cascade*, price change/history |
| `api/inventory.js` | Stock movements, stock adjustments (`setInventoryStock`, `adjustStock`, `fetchStockMovements`, movement mappers) |
| `api/inventoryImport.js` | Bulk import batches (`commitInventoryImport`, `revertInventoryImport`, `requestImportRevert`, `dismissImportRevertRequest`, `fetchImportBatch*`, `findRecentImportByHash`, category resolution) |
| `api/sales.js` | `completeSale`, void, refunds, transaction detail/lookup |
| `api/till.js` | Till-action requests (cart-remove supervisor gate), cart-remove report |
| `api/approvals.js` | `fetchPendingApprovals`, `dismissNotificationItem`, `reconcileResolvedPendingApprovals` (cross-domain notification bell) |
| `api/announcements.js` | Announcements CRUD |
| `api/dayend.js` | Day-end submit/approve/close/reopen/request lifecycle |
| `api/branches.js` | Company profile, branches, fiscal header, presence/telemetry, devices |
| `api/staff.js` | Staff accounts, roster, sessions, roles |
| `api/shifts.js` | Shift open/close, clock in/out, shift cash summary/adjustments |
| `api/cash.js` | Cash drawer entries (petty cash), cash movements (pickup/cash-in/approval chain), cash impact |
| `api/reports.js` | All `fetch*Report`/`fetch*Summary`/dashboard/BIR reports, `fetchFiscalTransactions` (private) |
| `api/audit.js` | Audit events, security audit events, sale events, notification history |
| `api/promos.js` | Promo events/rules lifecycle, promo stats/receipts |
| `api.js` | Barrel: `export * from './api/<each>.js'` in the order above, plus `export { allowDemoMode } from './supabase'` |

## Task Right-Sizing

Each task below = extract one domain's exports (and their private helpers) into one new file, verified independently before moving on. The final barrel-rewrite task is its own task because it's the only one that changes `api.js` itself and is where integration risk concentrates.

---

### Task 1: `api/shared.js`

**Files:**
- Create: `pos-frontend/src/lib/api/shared.js`
- Reference (read-only, do not modify yet): `pos-frontend/src/lib/api.js`

**Interfaces:**
- Produces (consumed by nearly every later task): `hasSupabase`, `allowDemoMode`, `fetchAllRows(build)`, `isMissingColumnError(error, column)`, `localDayBoundsIso(startKey, endKey)`, `mapPricing(mode)`, `toDbPricing(mode)`, `formatProductCode(productNo)`, `mapProduct(row, stock, meta)`, `mapTransaction(row)`, `mapDayEndRow(row)`, `approverLabel(name, role)`, `withCashierName(row, names)`, `withApprover(row, identities, field)`, `staffNameById(ids)`, `fetchStaffIdentities(ids)`, `writeProductRow(mode, payload, opts)`, `PAGE_ROWS`

- [ ] **Step 1: Read source ranges from the original file**

Read `pos-frontend/src/lib/api.js` lines 1–434 (everything before `pingBackend`). This contains the top-of-file imports, `hasSupabase`/`allowDemoMode`, `mapPricing`/`toDbPricing`, `isMissingColumnError`, `PAGE_ROWS`/`fetchAllRows`, `localDayBoundsIso`, `writeProductRow`, `formatProductCode`, `mapProduct`, `fetchStaffIdentities`, `mapTransaction`, `approverLabel`, `staffNameById`, `withCashierName`, `withApprover`, `mapDayEndRow`.

Also read lines 305–434 again carefully to identify `mapMovement`/`MOVEMENT_TYPES`/`fetchStockMovements`/`resolveMovementReferences`/`readableReference`/`UUID_RE` (lines 305–433) — **these do NOT go in shared.js**, they belong to Task 4 (`inventory.js`), because every call site of `mapMovement`/`resolveMovementReferences`/`readableReference` is inventory-only (verified by grep — no cross-domain callers).

- [ ] **Step 2: Write `api/shared.js`**

Compose the file as:
1. The subset of the original top-of-file `import` statements (lines ~1–13) that are actually referenced by the symbols this file keeps (`supabase`, `allowDemoMode` from `./supabase`; `appError` from `../utils/errors` if used by these functions; check each import against actual usage in the extracted code — drop any import not referenced by code that ends up in this file, since the rest moves to other domain files).
2. `export const hasSupabase = Boolean(supabase)` and `export { allowDemoMode }`.
3. `mapPricing`, `toDbPricing` — currently private (not `export`ed from `api.js`); export them from `shared.js` since `catalog.js` and `inventoryImport.js` both call them.
4. `isMissingColumnError`, `PAGE_ROWS`, `fetchAllRows`, `localDayBoundsIso` — export them (currently private) since 10+ other domain files call them.
5. `writeProductRow` — export it (currently private); used by both `catalog.js` and `inventoryImport.js`.
6. The existing public exports `formatProductCode`, `mapProduct`, `fetchStaffIdentities`, `mapTransaction`, `approverLabel`, `mapDayEndRow` — keep as `export function`/`export async function` exactly as written.
7. `staffNameById`, `withCashierName`, `withApprover` — export them (currently private); used across `catalog.js` (bootstrap), `sales.js`, `reports.js`, `staff.js`, `shifts.js`, `audit.js`.

- [ ] **Step 3: Lint the new file in isolation**

Run: `cd pos-frontend && npx eslint src/lib/api/shared.js`
Expected: no errors (unused-import warnings are fine at this stage since nothing imports from it yet — fix any actual syntax error).

- [ ] **Step 4: Commit is deferred — do not commit yet.** (Commits happen only when the user explicitly asks; continue to Task 2.)

---

### Task 2: `api/auth.js`

**Files:**
- Create: `pos-frontend/src/lib/api/auth.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`
- Produces: `pingBackend`, `hasAuthSession`, `fetchSessionStaff`, `signIn`, `signInWithPin`, `verifySupervisorPin`, `fetchSupervisorPinVerifiers`, `saveStaffPinVerifier`, `logApprovalEventRemote`, `signOut`, `claimStaffSession`, `heartbeatStaffSession`, `releaseStaffSession`, `isSessionRevokedError`, `setManagerUnlockSecret`, `clearManagerUnlockSecret`, `verifyAccountPassword`, `verifyOwnPin`, `getOrCreateDeviceSessionId`, `clearDeviceSessionId`

- [ ] **Step 1: Read lines 434–895 of the original `api.js`** (from `pingBackend` through the end of `clearDeviceSessionId`, i.e. everything before `bootstrapPosCatalog`). Also note private helpers in this range: `parseSupervisorPinRpcResult` (L542), `isSupervisorPinAuthFailure` (L564), `MANAGER_UNLOCK_SESSION_KEY` (L737), `readUnlockRecord` (L775) — these stay private (non-exported) inside `auth.js`, same as today.

- [ ] **Step 2: Write `api/auth.js`**

Include the relevant top-of-file imports this range actually uses (`supabase`, `pinAuthEmail`/`isSupervisorOrAbove`/`isManagerRole` from `../utils/roles`, `clearUnlockSecret`/`loadUnlockSecret`/`saveUnlockSecret` from `../offline/session`, `createVerifier`/`isVerifierExpired`/`verifyAgainst` from `../utils/unlockVerifier`, `appError` from `../utils/errors`, `withTimeout` from `../utils/withTimeout`, `APP_VERSION` from `../utils/version` — check each against actual usage in this range). Import `hasSupabase` from `./shared.js`.

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/auth.js`
Expected: no syntax errors.

---

### Task 3: `api/catalog.js`

**Files:**
- Create: `pos-frontend/src/lib/api/catalog.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `fetchAllRows`, `isMissingColumnError`, `mapProduct`, `mapTransaction`, `mapDayEndRow`, `withCashierName`, `withApprover`, `staffNameById`, `fetchStaffIdentities`, `writeProductRow`, `mapPricing`, `toDbPricing`
- Produces: `bootstrapPosCatalog`, `bootstrapBranchActivity`, `bootstrapBranchData`, `bootstrapBranchInventory`, `fetchBranchProducts`, `fetchCatalogProducts`, `createCatalogProduct`, `commitCatalogImport`, `updateCatalogProduct`, `cascadeDiscountEligibleToBranches`, `resyncDiscountEligibleToBranches`, `cascadeCatalogFieldsToBranches`, `adoptCatalogProducts`, `createProduct`, `updateProductRow`, `setProductActive`, `deleteProduct`, `fetchInactiveBranchProducts`, `setMenuAvailableToday`, `updateProductPrice`, `recordPriceChange`, `fetchPriceHistory`

- [ ] **Step 1: Read lines 895–1835 of the original `api.js`** (from `bootstrapPosCatalog` through `fetchPriceHistory`, i.e. everything before `setInventoryStock`). Private helper in range: `mapCatalogRow` (L1122) — stays private in `catalog.js` (only used within this range).

- [ ] **Step 2: Write `api/catalog.js`** with the imports this range needs (`normalizeBranchType`/`isRestaurantBranchType`/`RESTAURANT_FEATURES_ENABLED` from `../utils/features`, `normalizeMenuKind` from `../utils/ulam`, `appError`, `today`/etc. from `../utils/format` as used) plus the shared imports listed above.

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/catalog.js`
Expected: no syntax errors.

---

### Task 4: `api/inventory.js`

**Files:**
- Create: `pos-frontend/src/lib/api/inventory.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `fetchAllRows`, `isMissingColumnError`, `localDayBoundsIso`, `fetchStaffIdentities`
- Produces: `MOVEMENT_TYPES`, `fetchStockMovements`, `mapMovement`, `setInventoryStock`, `adjustStock`, `fetchInventoryReport`

- [ ] **Step 1: Read two ranges of the original `api.js`:**
  - Lines 305–433 (`mapMovement`, `MOVEMENT_TYPES`, `fetchStockMovements`, `resolveMovementReferences` (private), `readableReference` (private), `UUID_RE` (private))
  - Lines 1816–1907 (`setInventoryStock`, `adjustStock`, up to but not including `completeSale`)
  - Line 6882–6951 (`fetchInventoryReport`, up to but not including `findRecentImportByHash`)

- [ ] **Step 2: Write `api/inventory.js`** combining all three ranges. `resolveMovementReferences`, `readableReference`, `UUID_RE` stay private (module-scoped, not exported) exactly as today.

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/inventory.js`
Expected: no syntax errors.

---

### Task 5: `api/inventoryImport.js`

**Files:**
- Create: `pos-frontend/src/lib/api/inventoryImport.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `writeProductRow`, `toDbPricing`, `mapPricing`
- Produces: `findRecentImportByHash`, `fetchImportBatches`, `fetchImportBatchItems`, `commitInventoryImport`, `revertInventoryImport`, `requestImportRevert`, `dismissImportRevertRequest`

- [ ] **Step 1: Read lines 6952–7210 of the original `api.js`** (from `findRecentImportByHash` through `dismissImportRevertRequest`, i.e. everything before `expireEndedPromos`). Private helpers in range: `ensureCategoryId` (L6905 — note this is just *before* line 6952, check whether it's used only by this range or also by `catalog.js`'s `createCatalogProduct`/`commitCatalogImport`; if it's called from both, export it from `shared.js` instead and import here), `resolveCategoryIds` (L6934, same check), `DUPLICATE_IMPORT_HOURS` (L6950).

- [ ] **Step 2: Write `api/inventoryImport.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/inventoryImport.js`
Expected: no syntax errors.

---

### Task 6: `api/sales.js`

**Files:**
- Create: `pos-frontend/src/lib/api/sales.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `mapTransaction`, `withCashierName`, `withApprover`, `staffNameById`, `fetchStaffIdentities`, `isMissingColumnError`
- Produces: `completeSale`, `fetchTransactionDetail`, `voidSale`, `refundSaleItems`, `requestRefundApproval`, `approveRefundRequest`, `rejectRefundRequest`, `cancelRefundRequest`, `dismissPendingRefundRequestsForTransaction`, `fetchRefundRequestById`, `fetchRefundRequests`, `fetchRefundSummary`, `fetchRefundedQuantities`, `loadTransactionByClientId`, `fetchEarliestTransactionDate`

- [ ] **Step 1: Read lines 1840–2976 of the original `api.js`** (from `loadTransactionByClientId` through `fetchRefundedQuantities`, i.e. everything before `fetchAnnouncements`). Private helpers to keep local: `isDuplicateClientIdError` (L1835 — just before this range, check it's sales-only before moving), `isMissingFunctionError` (L1892), `isDeadlockError` (L1903), `isAlreadyVoidedError` (L2278).

Note: `createTillActionRequest`, `resolveTillActionRequest`, `dismissPendingTillActionsOnSite`, `reconcileResolvedPendingApprovals`, `clearResolvedDayEndRequest`, `fetchTillActionRequestById`, `fetchCartRemoveReport`, `fetchPendingTillActionRequests`, `mapTillActionRequest`, `CART_REMOVE_AUDIT_TYPES`, `cartRemoveOutcomeFromAudit`, `cartRemoveMethodLabel` fall inside lines 2375–2831 which is INSIDE the 1840-2976 span textually, but these belong to `till.js` (Task 7) / `approvals.js` (Task 8) / `dayend.js` (Task 9) instead — see those tasks for exact sub-ranges. When extracting this task's content, skip lines 2357–2831 (till/approvals/clearResolvedDayEndRequest block) and lines 2976 boundary (`fetchAnnouncements` starts the next domain).

- [ ] **Step 2: Write `api/sales.js`** with the range's needed imports (`aggregatePromoSalesOffers` from `../utils/promo`, `mapDayReport` from `../utils/dayEndReport` if referenced in this exact range — verify, it may only be used by `dayend.js`/`reports.js` instead, `appError`, `today`/`netAfterRefund`/etc. from `../utils/format`, `normalizeMenuKind` from `../utils/ulam` if used).

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/sales.js`
Expected: no syntax errors.

---

### Task 7: `api/till.js`

**Files:**
- Create: `pos-frontend/src/lib/api/till.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `fetchStaffIdentities`
- Produces: `createTillActionRequest`, `resolveTillActionRequest`, `dismissPendingTillActionsOnSite`, `fetchTillActionRequestById`, `fetchPendingTillActionRequests`, `fetchCartRemoveReport`, `mapTillActionRequest` (used by `approvals.js` too — export it)

- [ ] **Step 1: Read lines 2357–2410 (`mapTillActionRequest`, `createTillActionRequest`, `resolveTillActionRequest` — through just before `dismissPendingTillActionsOnSite`), then 2410–2458 (`dismissPendingTillActionsOnSite`), then 2616–2831 (`fetchTillActionRequestById`, `CART_REMOVE_AUDIT_TYPES`, `cartRemoveOutcomeFromAudit`, `cartRemoveMethodLabel`, `fetchCartRemoveReport`, through end of `fetchCartRemoveReport`), then 2800–2831 (`fetchPendingTillActionRequests`)** of the original `api.js`. (`reconcileResolvedPendingApprovals`, L2466–2605, and `clearResolvedDayEndRequest`, L2607–2614, are explicitly excluded — they go to `approvals.js` and `dayend.js` respectively, Tasks 8 and 9.)

- [ ] **Step 2: Write `api/till.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/till.js`
Expected: no syntax errors.

---

### Task 8: `api/approvals.js`

**Files:**
- Create: `pos-frontend/src/lib/api/approvals.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`
- Consumes from `./till.js`: `resolveTillActionRequest`, `fetchPendingTillActionRequests`
- Consumes from `./cash.js` (Task 13): `fetchPendingCashMovements`
- Consumes from `./dayend.js` (Task 9): `clearResolvedDayEndRequest`, `rejectDayEndRequest`
- Produces: `fetchPendingApprovals`, `dismissNotificationItem`

- [ ] **Step 1: Read lines 2460–2606 of the original `api.js`** (`reconcileResolvedPendingApprovals`, private — keep private in this file), and lines 8325–end of file (`fetchPendingApprovals` through `dismissNotificationItem`).

- [ ] **Step 2: Write `api/approvals.js`**, importing `today` from `../utils/format` (used for `bizToday`), plus the cross-module imports listed above. This file is written last among the domain tasks (after Tasks 7, 9, 13) since it depends on their exports — sequence Task 8 after Task 13 in execution, even though numbered here for narrative grouping.

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/approvals.js`
Expected: no syntax errors. (Import-resolution errors against `./till.js`/`./cash.js`/`./dayend.js` are expected to be clean only once those files exist — run this lint pass after Tasks 7, 9, 13 are done.)

---

### Task 9: `api/dayend.js`

**Files:**
- Create: `pos-frontend/src/lib/api/dayend.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `mapDayEndRow`
- Produces: `clearResolvedDayEndRequest`, `submitDayEnd`, `approveDayEnd`, `closeDayEnd`, `reopenDayEnd`, `confirmDayEndHandoff`, `requestDayReopen`, `rejectDayEndRequest`, `requestDayEnd`, `fetchRecentDayEndStatuses`

- [ ] **Step 1: Read lines 2607–2614 (`clearResolvedDayEndRequest`) and lines 3034–3155 (`submitDayEnd` through `requestDayEnd`, up to but not including `composeTin`) of the original `api.js`.** Also read line 3271–3283 (`fetchRecentDayEndStatuses`, up to but not including `mapBranchFiscalHeader`).

- [ ] **Step 2: Write `api/dayend.js`** with `mapDayReport` from `../utils/dayEndReport` if used in this range (verify), `appError`, `today`/`rowBusinessDate` from `../utils/format` as needed.

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/dayend.js`
Expected: no syntax errors.

---

### Task 10: `api/branches.js`

**Files:**
- Create: `pos-frontend/src/lib/api/branches.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `isMissingColumnError`, `fetchAllRows`
- Produces: `composeTin`, `fetchCompanyProfile`, `saveCompanyProfile`, `fetchBranches`, `mapBranchFiscalHeader`, `fetchBranchFiscalHeader`, `reorderBranches`, `BRANCH_ONLINE_WINDOW_SEC`, `isBranchOnline`, `heartbeatBranch`, `fetchBranchDeviceSettings`, `reportBranchDevices`, `fetchBranchTelemetry`, `deviceSummary`, `saveBranch`

- [ ] **Step 1: Read lines 3155–3626 of the original `api.js`** (from `composeTin` through end of `saveBranch`, i.e. everything before `fetchStaffRoster`). Private helpers to keep local: `companyProfileCache` (L3162), `COMPANY_PROFILE_SELECT`/`COMPANY_PROFILE_SELECT_LEGACY` (L3164-3165), `mapCompanyProfile` (L3167), `branchHeaderCache` (L3281), `DEVICE_KEY_MAP`/`DEVICE_LABELS` (L3370/3379), `BRANCH_LIST_COLS`/`BRANCH_LIST_COLS_LEGACY` (L3141/3143).

- [ ] **Step 2: Write `api/branches.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/branches.js`
Expected: no syntax errors.

---

### Task 11: `api/staff.js`

**Files:**
- Create: `pos-frontend/src/lib/api/staff.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `isMissingColumnError`
- Produces: `fetchRoles`, `fetchStaffRoster`, `fetchAllStaff`, `fetchActiveSessions`, `forceReleaseStaffSession`, `releaseAllStaffSessions`, `createStaffAccount`, `updateStaffRow`, `revealStaffPin`

- [ ] **Step 1: Read lines 3626–3985 of the original `api.js`** (from `fetchStaffRoster` — note `fetchRoles` at L3472 is slightly earlier, include it — through `revealStaffPin`, everything before `mapShiftRow`). Private helpers to keep local: `staffCodeUniqueError` (L3873), `persistStaffPinVerifier` (L3884).

Correction to range start: read lines 3472–3985 to capture `fetchRoles` (L3472) through `revealStaffPin`.

- [ ] **Step 2: Write `api/staff.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/staff.js`
Expected: no syntax errors.

---

### Task 12: `api/shifts.js`

**Files:**
- Create: `pos-frontend/src/lib/api/shifts.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `isMissingColumnError`, `localDayBoundsIso`, `fetchStaffIdentities`, `withCashierName`
- Produces: `mapShiftRow`, `openShift`, `closeShift`, `fetchShiftCashSummary`, `fetchOpenShiftOnDrawer`, `fetchOpenShiftsForBranch`, `fetchLastClosedShiftOnDrawer`, `adjustShiftCash`, `receiveShiftHandoff`, `fetchShiftAdjustments`, `clockIn`, `clockOut`, `fetchOpenShift`, `fetchStaffShifts`

- [ ] **Step 1: Read lines 3985–4525 of the original `api.js`** (from `mapShiftRow` through end of `fetchStaffShifts`, everything before `CASH_DRAWER_TABLE`). Private helpers to keep local: `SHIFT_COLS`/`SHIFT_COLS_CORE`/`SHIFT_COLS_LEGACY`/`SHIFT_COLS_MINIMAL` (L4020-4025), `isMissingOptionalShiftColumn` (L4028), `isMissingShiftCashSchema` (L4033), `isMissingShiftRpc` (L4040), `shiftRpcError` (L4046).

- [ ] **Step 2: Write `api/shifts.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/shifts.js`
Expected: no syntax errors.

---

### Task 13: `api/cash.js`

**Files:**
- Create: `pos-frontend/src/lib/api/cash.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `isMissingColumnError`, `fetchAllRows`, `localDayBoundsIso`, `fetchStaffIdentities`
- Produces: `CASH_DRAWER_TABLE`, `addPettyCash`, `recordChangeFund`, `CASH_MOVEMENT_COUNTING_STATUSES`, `createCashMovementApproved`, `createCashMovementPending`, `approveCashMovementPin`, `approveCashMovementManager`, `denyCashMovement`, `cancelCashMovement`, `selfRecordCashMovement`, `reviewCashMovement`, `resolveFlaggedCashMovement`, `fetchCashMovementById`, `fetchCashMovements`, `fetchPendingCashMovements`, `fetchPettyCash`, `fetchPettyCashTimeline`, `fetchBranchCashImpact`, `fetchCashHandoffReport`

- [ ] **Step 1: Read lines 4525–5180 of the original `api.js`** (from `CASH_DRAWER_TABLE` through end of `fetchCashHandoffReport`, everything before `fetchTerminalReportSource`... actually verify: check the exact line where the next domain (`branchSummary`, L5180) begins and stop just before it). Private helpers to keep local: `CASH_DRAWER_COLS` (L4526), `withCashDrawerTable` (L4530), `mapPettyCashRow` (L4595), `mapCashMovementRow` (L4666), `withCashMovementActors` (L4697), `withPettyCashActors` (L4945).

- [ ] **Step 2: Write `api/cash.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/cash.js`
Expected: no syntax errors.

---

### Task 14: `api/reports.js`

**Files:**
- Create: `pos-frontend/src/lib/api/reports.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `fetchAllRows`, `localDayBoundsIso`, `staffNameById`, `withCashierName`, `mapProduct`
- Consumes from `./inventory.js`: `mapMovement` (if `fetchStockMovementReport` needs it — verify)
- Produces: `branchSummary`, `fetchManagerOverviewMetrics`, `fetchPeriodComparison`, `fetchNetworkDashboard`, `fetchSoldLineItems`, `fetchReportSalesDetail`, `fetchDailyReading`, `fetchBirDailyBreakdown`, `fetchScPwdReport`, `fetchDiscountReport`, `fetchTenderSummary`, `fetchElectronicJournal`, `fetchGrossMarginReport`, `fetchStockMovementReport`, `fetchShrinkageValue`, `fetchShrinkageReport`, `fetchPriceChangeReport`, `fetchTerminalReportSource`, `fetchFiscalBackup`, `fetchBranchSalesTotal`, `fetchNetworkSalesTotal`

- [ ] **Step 1: Read lines 5180–6098 (`branchSummary` through the start of `fetchFiscalTransactions`) and lines 6098–6952 (`fetchFiscalTransactions` private helper through end of `fetchInventoryReport`'s preceding function, i.e. up to but not including `findRecentImportByHash` at L6952) of the original `api.js`.** Note `fetchInventoryReport` (L6882) itself was already assigned to `api/inventory.js` in Task 4 — exclude lines 6882–6951 from this file to avoid duplicating it; everything else in 6098–6952 stays here. `fetchFiscalTransactions` (L6098, private) stays private in `reports.js`.

- [ ] **Step 2: Write `api/reports.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/reports.js`
Expected: no syntax errors.

---

### Task 15: `api/audit.js`

**Files:**
- Create: `pos-frontend/src/lib/api/audit.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `localDayBoundsIso`, `fetchAllRows`
- Produces: `logAuditEvent`, `logApprovalEvent`, `fetchAuditEvents`, `fetchNotificationHistory`, `fetchSecurityAuditEvents`, `fetchSaleEvents`

- [ ] **Step 1: Read lines 5790–5976 of the original `api.js`** (from `logAuditEvent` through end of `fetchSaleEvents`, everything before `fetchDailyReading`). Private consts to keep local: `NOTIFICATION_EVENT_TYPES` (L5899), `SECURITY_AUDIT_TYPES` (L5942).

Note: `logApprovalEventRemote` (L664) already belongs to `auth.js` (Task 2) — do not duplicate here, this is a differently-named, differently-scoped function.

- [ ] **Step 2: Write `api/audit.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/audit.js`
Expected: no syntax errors.

---

### Task 16: `api/announcements.js`

**Files:**
- Create: `pos-frontend/src/lib/api/announcements.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`
- Produces: `fetchAnnouncements`, `createAnnouncement`, `updateAnnouncement`, `markAnnouncementsSeen`

- [ ] **Step 1: Read lines 2976–3034 of the original `api.js`** (from `fetchAnnouncements` through end of `markAnnouncementsSeen`, everything before `submitDayEnd`). Private helper to keep local: `mapAnnouncement` (L2954, just before this range — include it).

- [ ] **Step 2: Write `api/announcements.js`**

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/announcements.js`
Expected: no syntax errors.

---

### Task 17: `api/promos.js`

**Files:**
- Create: `pos-frontend/src/lib/api/promos.js`

**Interfaces:**
- Consumes from `./shared.js`: `hasSupabase`, `isMissingColumnError`, `fetchAllRows`, `localDayBoundsIso`
- Produces: `expireEndedPromos`, `promoHasEnded`, `promoEffectiveStatus`, `promoStatusBadge`, `fetchActivePromoEventsWithRules`, `fetchActivePromoEventWithRules`, `fetchPromoRulesForEvent`, `createAndActivatePromoEvent`, `approvePromoEvent`, `rejectPromoEvent`, `requestStopPromo`, `approveStopPromo`, `rejectStopPromo`, `fetchPromoSalesStatsSummary`, `fetchPromoSalesStats`, `fetchPromoRuleTypesForEvents`, `requestPromoEdit`, `createPromoWithRules`, `createPromoAcrossBranches`, `copyPromoEventToBranches`, `createPromoRule`, `updatePromoEventDetails`, `deletePromoRule`, `fetchPromoEventsForBranch`, `fetchActivePromosAcrossBranches`, `fetchPromoEventsAcrossBranches`, `deletePromoEvent`

- [ ] **Step 1: Read lines 7210–8325 of the original `api.js`** (from `expireEndedPromos` through end of `fetchPendingApprovals`'s preceding function, i.e. up to but not including `fetchPendingApprovals` at L8325). Private helpers to keep local: `loadPromoRulesForEvent` (L7312), `fetchPromoAttributedLines` (L7532), `promoQueryWindow` (L7568), `promoRulesByEventId` (L7580), `loadPromoRulesCached` (L7587), `hydratePromoLineProducts` (L7600), `promoStatsFromAttributedLines` (L7623), `aggregatePromoItems` (L7657), `buildPromoReceipts` (L7692), `fetchPromoSalesStatsLegacy` (L7727), `fetchPromoEventStatus` (L7879), `assertPromoEventPending` (L7885), `assertPromoRuleMutable` (L7893), `PROMO_RULE_MIN_PRODUCTS` (L8009).

- [ ] **Step 2: Write `api/promos.js`** with `aggregatePromoSalesOffers` from `../utils/promo` if used (verify).

- [ ] **Step 3: Lint**

Run: `cd pos-frontend && npx eslint src/lib/api/promos.js`
Expected: no syntax errors.

---

### Task 18: Export-parity check (before touching the barrel)

**Files:** none created/modified — verification only.

- [ ] **Step 1: Build the "before" export list**

Run: `cd pos-frontend && grep -oE '^export (async function|function|const) [A-Za-z0-9_]+' src/lib/api.js | awk '{print $NF}' | sort -u > /tmp/before_exports.txt && wc -l /tmp/before_exports.txt`
Expected: `211 /tmp/before_exports.txt`

- [ ] **Step 2: Build the "after" export list from the new domain files**

Run: `cd pos-frontend && grep -hoE '^export (async function|function|const) [A-Za-z0-9_]+' src/lib/api/*.js | awk '{print $NF}' | sort -u > /tmp/after_exports.txt && wc -l /tmp/after_exports.txt`
Expected: `211` or more (more is fine — some previously-private helpers like `fetchAllRows`, `isMissingColumnError`, `mapMovement` are now exported from their home file for cross-file imports; they must NOT be re-exported through the barrel in Task 19 unless they were in the original 211).

- [ ] **Step 3: Diff and confirm nothing from the original 211 is missing**

Run: `cd pos-frontend && comm -23 /tmp/before_exports.txt /tmp/after_exports.txt`
Expected: empty output. If any name prints, that export was missed during extraction — find which task's file it belongs to (cross-reference the domain tables above) and add it before proceeding.

---

### Task 19: Rewrite `api.js` as the barrel

**Files:**
- Modify: `pos-frontend/src/lib/api.js` (full rewrite — this is the only task that touches the original file's content)

**Interfaces:**
- Produces: every one of the original 211 exports, re-exported with identical names.

- [ ] **Step 1: Save the original export list for the final parity check** (already done in Task 18, `/tmp/before_exports.txt`).

- [ ] **Step 2: Replace the entire contents of `pos-frontend/src/lib/api.js`** with re-exports in this order, restricted to exactly the 211 names in `/tmp/before_exports.txt` (do not blanket `export *`, since that would leak the newly-public internal helpers like `fetchAllRows` through a second path — instead each line explicitly lists only the names that were in the original public surface):

```js
export {
  hasSupabase, allowDemoMode, formatProductCode, mapProduct, mapTransaction,
  mapDayEndRow, approverLabel,
} from './api/shared.js'

export {
  pingBackend, hasAuthSession, fetchSessionStaff, signIn, signInWithPin,
  verifySupervisorPin, fetchSupervisorPinVerifiers, saveStaffPinVerifier,
  logApprovalEventRemote, signOut, claimStaffSession, heartbeatStaffSession,
  releaseStaffSession, isSessionRevokedError, setManagerUnlockSecret,
  clearManagerUnlockSecret, verifyAccountPassword, verifyOwnPin,
  getOrCreateDeviceSessionId, clearDeviceSessionId,
} from './api/auth.js'

export {
  bootstrapPosCatalog, bootstrapBranchActivity, bootstrapBranchData,
  bootstrapBranchInventory, fetchBranchProducts, fetchCatalogProducts,
  createCatalogProduct, commitCatalogImport, updateCatalogProduct,
  cascadeDiscountEligibleToBranches, resyncDiscountEligibleToBranches,
  cascadeCatalogFieldsToBranches, adoptCatalogProducts, createProduct,
  updateProductRow, setProductActive, deleteProduct,
  fetchInactiveBranchProducts, setMenuAvailableToday, updateProductPrice,
  recordPriceChange, fetchPriceHistory,
} from './api/catalog.js'

export {
  MOVEMENT_TYPES, fetchStockMovements, setInventoryStock, adjustStock,
  fetchInventoryReport,
} from './api/inventory.js'

export {
  findRecentImportByHash, fetchImportBatches, fetchImportBatchItems,
  commitInventoryImport, revertInventoryImport, requestImportRevert,
  dismissImportRevertRequest,
} from './api/inventoryImport.js'

export {
  loadTransactionByClientId, fetchEarliestTransactionDate, completeSale,
  fetchTransactionDetail, voidSale, refundSaleItems, requestRefundApproval,
  approveRefundRequest, rejectRefundRequest, cancelRefundRequest,
  dismissPendingRefundRequestsForTransaction, fetchRefundRequestById,
  fetchRefundRequests, fetchRefundSummary, fetchRefundedQuantities,
} from './api/sales.js'

export {
  createTillActionRequest, resolveTillActionRequest,
  dismissPendingTillActionsOnSite, fetchTillActionRequestById,
  fetchPendingTillActionRequests, fetchCartRemoveReport,
} from './api/till.js'

export { fetchPendingApprovals, dismissNotificationItem } from './api/approvals.js'

export {
  fetchAnnouncements, createAnnouncement, updateAnnouncement,
  markAnnouncementsSeen,
} from './api/announcements.js'

export {
  clearResolvedDayEndRequest, submitDayEnd, approveDayEnd, closeDayEnd,
  reopenDayEnd, confirmDayEndHandoff, requestDayReopen, rejectDayEndRequest,
  requestDayEnd, fetchRecentDayEndStatuses,
} from './api/dayend.js'

export {
  composeTin, fetchCompanyProfile, saveCompanyProfile, fetchBranches,
  mapBranchFiscalHeader, fetchBranchFiscalHeader, reorderBranches,
  BRANCH_ONLINE_WINDOW_SEC, isBranchOnline, heartbeatBranch,
  fetchBranchDeviceSettings, reportBranchDevices, fetchBranchTelemetry,
  deviceSummary, saveBranch,
} from './api/branches.js'

export {
  fetchRoles, fetchStaffRoster, fetchAllStaff, fetchActiveSessions,
  forceReleaseStaffSession, releaseAllStaffSessions, createStaffAccount,
  updateStaffRow, revealStaffPin, fetchStaffIdentities,
} from './api/staff.js'
```

  Note: `fetchStaffIdentities` lives in `api/shared.js` per Task 1 — do NOT re-export it from `staff.js` too. Cross-check every line in this step against `/tmp/before_exports.txt` and the per-task "Produces" lists above; the exact grouping matters less than the completeness check in Step 3.

```js
  export {
    mapShiftRow, openShift, closeShift, fetchShiftCashSummary,
    fetchOpenShiftOnDrawer, fetchOpenShiftsForBranch,
    fetchLastClosedShiftOnDrawer, adjustShiftCash, receiveShiftHandoff,
    fetchShiftAdjustments, clockIn, clockOut, fetchOpenShift,
    fetchStaffShifts,
  } from './api/shifts.js'

  export {
    CASH_DRAWER_TABLE, addPettyCash, recordChangeFund,
    CASH_MOVEMENT_COUNTING_STATUSES, createCashMovementApproved,
    createCashMovementPending, approveCashMovementPin,
    approveCashMovementManager, denyCashMovement, cancelCashMovement,
    selfRecordCashMovement, reviewCashMovement, resolveFlaggedCashMovement,
    fetchCashMovementById, fetchCashMovements, fetchPendingCashMovements,
    fetchPettyCash, fetchPettyCashTimeline, fetchBranchCashImpact,
    fetchCashHandoffReport,
  } from './api/cash.js'

  export {
    branchSummary, fetchManagerOverviewMetrics, fetchPeriodComparison,
    fetchNetworkDashboard, fetchSoldLineItems, fetchReportSalesDetail,
    fetchDailyReading, fetchBirDailyBreakdown, fetchScPwdReport,
    fetchDiscountReport, fetchTenderSummary, fetchElectronicJournal,
    fetchGrossMarginReport, fetchStockMovementReport, fetchShrinkageValue,
    fetchShrinkageReport, fetchPriceChangeReport, fetchTerminalReportSource,
    fetchFiscalBackup, fetchBranchSalesTotal, fetchNetworkSalesTotal,
  } from './api/reports.js'

  export {
    logAuditEvent, logApprovalEvent, fetchAuditEvents,
    fetchNotificationHistory, fetchSecurityAuditEvents, fetchSaleEvents,
  } from './api/audit.js'

  export {
    expireEndedPromos, promoHasEnded, promoEffectiveStatus, promoStatusBadge,
    fetchActivePromoEventsWithRules, fetchActivePromoEventWithRules,
    fetchPromoRulesForEvent, createAndActivatePromoEvent, approvePromoEvent,
    rejectPromoEvent, requestStopPromo, approveStopPromo, rejectStopPromo,
    fetchPromoSalesStatsSummary, fetchPromoSalesStats,
    fetchPromoRuleTypesForEvents, requestPromoEdit, createPromoWithRules,
    createPromoAcrossBranches, copyPromoEventToBranches, createPromoRule,
    updatePromoEventDetails, deletePromoRule, fetchPromoEventsForBranch,
    fetchActivePromosAcrossBranches, fetchPromoEventsAcrossBranches,
    deletePromoEvent,
  } from './api/promos.js'
```

- [ ] **Step 3: Full export-parity re-check against the rewritten barrel**

Run: `cd pos-frontend && grep -oE "^\s*[A-Za-z0-9_]+,?$" src/lib/api.js | tr -d ', ' | grep -v '^$' | sort -u > /tmp/barrel_exports.txt && comm -23 /tmp/before_exports.txt /tmp/barrel_exports.txt`
Expected: empty output (every original export name is re-exported from the barrel). If anything prints, fix the barrel before proceeding — do not skip this.

- [ ] **Step 4: Confirm no accidental duplicate re-export of a name from two different domain files**

Run: `cd pos-frontend && grep -oE "^\s*[A-Za-z0-9_]+,?$" src/lib/api.js | tr -d ', ' | grep -v '^$' | sort | uniq -d`
Expected: empty output. A duplicate here is a hard JS syntax error (`npm run build` will also catch it in Step 5, but check explicitly first).

- [ ] **Step 5: Build**

Run: `cd pos-frontend && npm run build`
Expected: build succeeds with no errors. Any "does not provide an export named X" error means a name was placed in the wrong domain file or the barrel line for that domain is missing/misspelled — fix by locating X in the domain-assignment tables above and correcting the relevant `export { }` block in this file or the exporting domain file.

- [ ] **Step 6: Lint**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors. Pre-existing warnings unrelated to this refactor are acceptable; any `no-unused-vars` on an import added during extraction must be fixed (remove the unused import).

---

### Task 20: Manual smoke verification

**Files:** none — manual testing only, per CLAUDE.md ("Verify changes via `npm run lint`, `npm run build`, and manual exercise through `npm run dev`" — no test suite exists in this repo).

- [ ] **Step 1: Start the dev server**

Run: `cd pos-frontend && npm run dev`

- [ ] **Step 2: Exercise one flow per domain that changed the most call-graph surface** — login (auth.js), load POS + ring a sale (catalog.js + inventory.js + sales.js), open the notification bell (approvals.js), open Day End (dayend.js + cash.js), open Manager → Reports (reports.js), open Manager → Promos (promos.js). Confirm no console errors and each screen loads data as before.

- [ ] **Step 3: Stop the dev server once confirmed.**

---

## Self-Review Notes

- **Spec coverage:** every one of the user's 8 primary-goal bullets is covered — audit (done above + Task 18), endpoint/dependency map (domain tables), usage determination (dead-code sweep above), dead-code removal (none found, documented), duplication removal (n/a — no duplicated logic found across domains during the audit; flag in Final Report if any surfaces during extraction), modular refactor (Tasks 1–19), functionality/frontend-compatibility preservation (barrel + parity checks, Tasks 18 & 19), no new features (plan adds zero new logic, pure move).
- **Ambiguous cross-file helpers flagged for verification during extraction, not guessed:** `ensureCategoryId`/`resolveCategoryIds` (Task 5), `mapMovement` use in `reports.js` (Task 14), a few import lists marked "verify" rather than asserted — resolve each by grepping the specific name within the exact line range being extracted before finalizing that file.
- **Type/name consistency:** all "Produces" lists across tasks were cross-checked against the single grep-derived export list (211 names, Task 18) — no renames introduced anywhere in this plan.
