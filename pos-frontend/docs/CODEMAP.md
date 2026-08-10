# CalePOS — Programmer’s Code Map

Guide to `pos-frontend`: where code lives, and **how data / control flow moves** through the app.  
Paths are relative to `pos-frontend/`. Product name: **CalePOS**.

---

## Architecture (how layers talk)

```
Browser (Vite + React)
  │
  ├─ Routes / gates …………… src/App.jsx
  │     StaffOnly · ManagerOnly · SupervisorOnly · RequireModule
  │
  ├─ Shell ……………………… src/components/shared/Shell.jsx
  │     sidebar ← navLinksFor(user) ← src/constants/nav.js
  │     shift gate → ShiftGate.jsx (useShiftStore)
  │     logout → plain sign out; the shift stays open and resumes on next login
  │     ending a shift lives on /day-end (cashier view) → ShiftCashOut.jsx
  │
  ├─ Pages ……………………… src/pages/*
  │     read/write Zustand stores
  │     call src/lib/api.js when online
  │
  ├─ Zustand stores ……… src/stores/posStore.js (+ syncStore.js, shiftStore.js)
  │     useAuthStore · useCartStore · useProductStore · useInventoryStore
  │     useShiftStore — the open cash shift for this drawer
  │
  ├─ api.js ………………… thin wrappers over Supabase client
  │     tables · RPC · Auth
  │
  └─ Offline path ……… src/offline/*
        IndexedDB (db.js) ← repository.js
        outbox queue → syncEngine when back online
```

**Rule of thumb:** UI never talks to Supabase directly except via `api.js`. Stores own session + live catalog/cart. Offline writes go to IndexedDB + queue, then syncEngine replays.

---

## AI Quick Orientation

If an external AI needs to understand the project fast, start in this order:

1. `src/App.jsx`
   - route map
   - role gates
   - which page mounts for each path
2. `src/stores/posStore.js`
   - main client-side business logic
   - auth, cart, products, inventory/day-end
3. `src/lib/api.js`
   - Supabase queries
   - RPC calls
   - server-to-UI mapping functions
4. `src/offline/*`
   - local-first persistence
   - queue replay / sync
5. relevant page file in `src/pages/*`
   - most feature orchestration happens at page level

When changing behavior, the usual path is:

`page` → `store` → `api.js` → `Supabase schema/migration`

---

## System Shape

### Top-level layers

| Layer | Main files | Why it matters |
|------|------|------|
| Routes / shell | `src/App.jsx`, `src/components/shared/Shell.jsx` | decides which UI loads and who can open it |
| Pages | `src/pages/*`, `src/pages/manager/*` | feature entry points; most UI orchestration lives here |
| Shared components | `src/components/*` | reusable feature UI (`pos`, `transactions`, `dayend`, `shared`, `ui`) |
| Stores | `src/stores/posStore.js`, `src/stores/syncStore.js` | main client-side state + business actions |
| API boundary | `src/lib/api.js`, `src/lib/supabase.js` | all online DB/auth access |
| Offline layer | `src/offline/*` | IndexedDB, queue, sync replay, connectivity |
| Utilities | `src/utils/*` | formatting, validation, receipts, reports, imports, menu pricing |
| SQL | `supabase/schema.sql`, `supabase/*.sql` | actual persistence, RLS, RPC behavior |

### Feature component folders

| Folder | Purpose |
|------|------|
| `src/components/pos/` | cart, numpad, weight modal, POS-specific behavior |
| `src/components/transactions/` | transaction detail / refund display |
| `src/components/dayend/` | day-end report panels, restock alert UI |
| `src/components/shared/` | shell, supervisor approval, cross-feature widgets |
| `src/components/ui/` | primitive UI kit used across the app |
| `src/components/dashboard/` | dashboard/overview widgets |

---

## Major Routes

| Path | Main file | Notes |
|------|------|------|
| `/` | `src/pages/Dashboard.jsx` or `src/pages/manager/Overview.jsx` | home depends on role |
| `/pos` | `src/pages/POS.jsx` | cashiering, barcode mode, inquiry, promos |
| `/transactions` | `src/pages/Transactions.jsx` | list + detail modal + refund flow |
| `/inventory` | `src/pages/Products.jsx` | staff inventory/menu operations — tabs: stock + **Movement history** (`src/components/inventory/MovementHistoryPanel.jsx`) |
| `/data` | `src/pages/manager/Data.jsx` | supervisor branch catalog tools |
| `/day-end` | `src/pages/DayEnd.jsx` | **role-split**: cashier → "End shift" (own drawer only); supervisor+ → "Day end" (branch, petty approval queue, submit for closing) |
| `/settings/devices` | `src/pages/Devices.jsx` | staff device awareness |
| `/shifts` | `src/pages/manager/Staff.jsx` | **merged Staff page** (supervisor+) — tabs: Staff roster + Shifts log |
| `/manager/branches` | `src/pages/manager/Branches.jsx` | branch list |
| `/manager/branches/:branchId` | `src/pages/manager/BranchDashboard.jsx` | manager branch operations dashboard |
| `/manager/staff` | `src/pages/manager/Staff.jsx` | staff management |
| `/manager/data` | `src/pages/manager/Data.jsx` | manager all-branch catalog tools |
| `/manager/promos` | `src/pages/manager/Promos.jsx` | promo event/rule management |
| `/manager/reports` | `src/pages/manager/Reports.jsx` | all report generation/export |

---

## Stores (State Ownership)

### `useAuthStore`
- File: `src/stores/posStore.js`
- Owns:
  - `user`
  - login/logout/session restore state
  - fresh-login lock after day end
- Main responsibilities:
  - email login
  - PIN login
  - offline session restore
  - logout / clock-out coordination

### `useCartStore`
- File: `src/stores/posStore.js`
- Owns:
  - current cart items
  - order type
- Main responsibilities:
  - add/remove items
  - qty adjustments
  - restaurant price tier switching
  - combo detection

### `useProductStore`
- File: `src/stores/posStore.js`
- Owns:
  - current branch products/menu
- Main responsibilities:
  - branch catalog hydration
  - add/update product
  - import/update product rows
  - menu availability toggles

### `useInventoryStore`
- File: `src/stores/posStore.js`
- Owns:
  - transactions
  - stock movements
  - day ends
  - branch `dayOpenHour`
- Main responsibilities:
  - complete sale
  - refund/void
  - stock movement history
  - day-end close/reopen state

### `useSyncStore`
- File: `src/stores/syncStore.js`
- Owns:
  - online/sync badge state only
- Main responsibilities:
  - reflect queue/sync status in UI

---

## Offline lock-screen unlock (security-sensitive)

The lock screen must open during a blackout or ISP outage, so the manager password check
runs **entirely on-device** — no Supabase call. That forces a verifier onto the machine, and
a verifier on a shop-floor terminal has to be assumed stolen. Two independent defences:

| Layer | File | Stops |
|---|---|---|
| PBKDF2-HMAC-SHA256, 210k iterations, 16-byte per-device salt, constant-time compare | `src/utils/unlockVerifier.js` | offline brute-force of a lifted IndexedDB — ~20 guesses/sec/core vs ~1e9/sec against the old unsalted SHA-256 |
| Persisted failed-attempt backoff — 3 free, then 5s doubling to a 5-min cap | `src/offline/session.js` (`recordUnlockFailure`) | guessing at an unattended terminal (~291 tries/day max). IndexedDB-backed, so a page reload or power cycle can't reset it |

Verifiers expire after 30 days (`VERIFIER_MAX_AGE_MS`) and need a real sign-in again, which
bounds how long a walked-off device keeps something worth attacking. Legacy v1 records
(unsalted SHA-256) still verify **once** and are then transparently rewritten as v2 — a
terminal that happens to be offline during the upgrade must not get locked out.

**Never** reintroduce a fast hash here, and never store the password itself. PBKDF2 buys
time proportional to password strength; it is not a substitute for one.

## Route Gates and Permissions

Main permission files:
- `src/App.jsx`
- `src/constants/nav.js`
- `src/utils/roles.js`

Important gate components in `App.jsx`:
- `StaffOnly`
- `ManagerOnly`
- `SupervisorOnly`
- `SupervisorOrAboveOnly`
- `RequireModule`

Permission behavior:
- defaults come from `roles.js` → `DEFAULTS`
- custom `user.permissions` override defaults
- nav visibility uses the same checks as route access
- DB still enforces branch access via RLS even if UI allows navigation
- `canAccessModule` gives `master` unconditional access to every module, no `DEFAULTS`/
  `permissions` check at all — a lone master account can never lock itself out via Staff, since
  self-edit is always blocked (`canEditStaff`) and nobody outranks master. `admin` gets the same
  unconditional access **except** `devices` (a cashier-unit pairing screen an office role has no
  default use for) — that one module falls through to the normal permissions check, so it can
  still be switched on per-admin-account via Staff. `manager` was never in this bypass and
  already excludes `devices` from its `DEFAULTS`.

---

## Server Boundary and Offline Boundary

### API boundary
- `src/lib/api.js` is the main server boundary.
- It contains:
  - mapping helpers (`mapProduct`, `mapTransaction`, etc.)
  - auth helpers
  - Supabase table queries
  - RPC wrappers
  - report builders/fetchers

If behavior seems “server-ish”, check `api.js` before editing the UI.

### Offline boundary
- `src/offline/db.js` → Dexie schema
- `src/offline/repository.js` → local read/write helpers
- `src/offline/syncQueue.js` → queue persistence
- `src/offline/syncEngine.js` → replay queue + refresh branch snapshot
- `src/offline/connectivity.js` → reconnect/poll sync triggers
- `src/offline/session.js` → saved session + relogin lock

Offline is a real first-class flow, not just cached reads. Many writes are:

`UI action` → local repository / queue → later sync to Supabase

---

## Start here (file index)

| What | Where |
|------|--------|
| App entry | `src/main.jsx` |
| Routes / role gates | `src/App.jsx` |
| Page exports | `src/pages/index.js` |
| Nav order + labels + home path | `src/constants/nav.js` |
| Roles / default module lists | `src/utils/roles.js` |
| UI kit | `src/components/ui/index.jsx` |
| Shell (sidebar, logout, sync chip) | `src/components/shared/Shell.jsx` |
| Supabase client | `src/lib/supabase.js` |
| All remote API / RPCs | `src/lib/api.js` |
| Auth / cart / products / inventory stores | `src/stores/posStore.js` |
| Sync UI status | `src/stores/syncStore.js` |
| SQL | `supabase/*.sql` |

---

## Request & session flow

### Login → home → shell

1. `Login.jsx` — PIN (`signInWithPin` / `resolve_pin_login`) or email password.
2. `useAuthStore.login` sets `user` (role, branchId, branchType, permissions, deviceSettings).
3. Navigate via `staffHomePath(user)` (`nav.js`): cashiers → `/pos` (restaurant may `?menu=1`); others → first allowed nav link.
4. `App.jsx` wraps authenticated UI in `Shell`; routes gated by `RequireModule` + role wrappers.
5. Shift gate: `Shell.jsx` calls `useShiftStore.resolve(user)`, which answers from IndexedDB
   first and refines with the server. `ready` lets work proceed; anything else renders
   `ShiftGate.jsx` over the app. Login itself no longer decides this — see "Shifts & change
   fund" below for why.

### Permissions

- Defaults: `roles.js` → `DEFAULTS[role]`.
- Override: `user.permissions` array from Staff page / DB.
- Check: `canAccessModule(user, moduleId)` (admin/master always true).
- Nav filters the same way in `staffLinksFor` / `managerLinksFor`.

### Logout

1. Shell `requestLogout` → `logout()`. **No prompt, no shift question.**
2. `useAuthStore.logout` + cart clear so retail/restaurant carts never bleed across sessions.
   `useShiftStore.forget()` drops the in-memory pointer only — the IndexedDB shift row stays.

**Do not reattach a shift prompt to sign-out.** The shift already survives sign-out, tab
close, refresh and crash (`useShiftStore.resolve()` resumes it without re-counting the
float), so the question had exactly one safe answer and trained cashiers to tap through a
dialog that sometimes offered to close their shift. A shift ends in exactly two ways:
the cashier ends it from **End shift** (`DayEnd.jsx` cashier view → `ShiftCashOut`), or
day-end / Z-reading closes the business day. There is deliberately no second entry point
to cashing out.

---

## Cashiering / POS sale (movement)

```
POS.jsx (search / grid / inquiry)
   │ addItem / WeightModal
   ▼
useCartStore  ──►  Cart.jsx (lines, Exact/quick cash, Checkout modal)
   │ confirm pay
   ▼
useInventoryStore.addTransaction
   │ online → api.createSale (+ stock movements)
   │ offline → IndexedDB + QUEUE_TYPES sale
   ▼
transactions table + branch_inventory
   │ optional
   ▼
receipt.js → printer device (if enabled)
```

| Piece | File |
|-------|------|
| Layout (grid + cart column) | `src/pages/POS.jsx` |
| Search (name / SKU / barcode / product code) | `POS.jsx` filter + Enter exact match |
| Cart UI + checkout | `src/components/pos/Cart.jsx` |
| Cart state | `useCartStore` |
| Ulam / budget line math | `src/utils/ulam.js` |
| Kg entry | `src/components/pos/WeightModal.jsx` |
| Numpad / quick cash | `src/components/pos/NumPad.jsx` |
| Supervisor gate (void line, price…) | `src/components/shared/SupervisorApprove.jsx` |
| Receipt | `src/utils/receipt.js` |
| Devices (scanner/printer/drawer flags) | `src/devices/index.js` + branch `deviceSettings` |

**Cart width:** `POS.jsx` grid `minmax(…)` + `Cart.jsx` sticky footer classes.

**OR number at print time:** the real OR number is allocated server-side (`allocate_or_number`
RPC, inside `api.completeSale`) — offline-first means the receipt is built and printed
*immediately* off the local optimistic transaction, before that RPC has necessarily run. Until
a real number comes back, `transaction.orNumber` is `null`/absent; `buildReceipt` (`receipt.js`)
detects that and prints `OR No: PENDING (assigns on sync)` rather than falling back to
`transaction.id`, which is only the local client id (`txn_<uuid>`) — printing that raw id as if
it were the OR number was a real bug (very long, looked official, wasn't).

**Receipt line "Price" column is blank at qty 1.** `receiptToHtml()` (`receipt.js`) omits
the unit-price cell (prints `—`) when `line.qty === 1` — at that quantity the unit price and
the line "Amt" are the same number by definition, so printing both read as the price shown
twice on the ticket. "Amt" always prints; "Price" only earns its column when it says
something "Amt" doesn't (qty ≠ 1).

---

## VAT + SC/PWD (BIR compliance)

Prices are always VAT-inclusive shelf prices; VAT is backed out of the total, never added
on top. **Rate is flat 12% nationwide** (`VAT_RATE_DEFAULT` in `src/utils/vat.js`) — not
branch-configurable; `Cart.jsx` no longer reads a per-branch rate, and `manager/Branches.jsx`
has no VAT-rate field. (`branches.vat_rate` still exists in the DB as unused legacy plumbing —
left alone rather than a destructive column drop.)

**The rule — one discount, VAT-exclusive base (RA 9994 / RA 10754).** Read the block at the
top of `src/utils/vat.js` before touching any pricing code:

```
base = MIN(regular price, active promo price)     ← VAT-INCLUSIVE

SC/PWD presented and line eligible:               otherwise:
  vatExclusive  = base / 1.12                       net  = base
  scPwdDiscount = vatExclusive × 0.20               line is VATable
  net           = vatExclusive − scPwdDiscount
  line is VAT-EXEMPT (no output VAT at all)
```

Two failure modes this is written to prevent:
- **Stacking.** A promo does *not* produce its own deduction followed by a second 20% off
  the regular price. Its only role is to lower the base the single 20% comes from. On a
  ₱112 item with a 10% promo the answer is **₱72.00** (base 100.80 → /1.12 = 90.00 → −20%),
  never ₱78.40 (112 − 11.20 − 22.40). Promos and SC/PWD are no longer mutually exclusive —
  the old code discarded the promo entirely when SC/PWD was selected, which overcharged.
- **Forgetting the VAT strip.** 20% of `base/1.12`, not 20% of `base`. Pass
  `vatRegistered: false` for a non-VAT-registered store and the strip is skipped
  (`vatExclusive === base`).

Promo discounts have no BIR receipt line — a promo price *is* the selling price, so it's
netted into the sales figures. The SC/PWD 20% **is** a mandated "Less:" disclosure and is
surfaced separately. `vatExemptedAmount` (output VAT not charged due to the exemption) is
returned for BIR reporting.

VAT/exempt breakdown is surfaced everywhere a transaction's money is shown: the checkout
panel walks each discounted line through regular → promo base → VAT-exclusive → 20% → net,
with a VAT-exempt tag, then totals promo discount / SC/PWD discount / VAT exempted / net.
The printed receipt marks exempt lines `VAT-EXEMPT`.

**Never re-derive a net line as `gross − discountAmount`.** On an exempt line the VAT strip
is part of the reduction but is *not* a discount, so that subtraction is wrong. Use
`lineBreakdown[i].netAmount` (Cart) / `line.netLineTotal` + `line.netUnitPrice` (receipt).

VAT/exempt breakdown is surfaced everywhere a transaction's money is shown: the POS checkout
preview, the printed receipt, and `TransactionDetailModal.jsx` (shared by staff
`Transactions.jsx` and manager `BranchDashboard.jsx` — same component, same fields, both get
it automatically). The manager "Recent receipts" panel additionally tags a row `VAT-exempt`
when `vatExemptSales > 0`.

```
Cart.jsx pricing useMemo
  │ per line: regularAmount (VAT-incl), promoDiscountAmount, vatExempt flag
  │ NOTE: promos are computed ALWAYS, including on SC/PWD sales — they set the base
  ▼
utils/vat.js computeVatBreakdown()      ← single source of truth, pure/testable
  │ returns { vatableSales, vatAmount, vatExemptSales, zeroRatedSales,
  │           scPwdDiscount, discountAmount, totalSales, amountDue, lineBreakdown }
  ├─► POS checkout preview (Cart.jsx)
  ├─► addTransaction → QUEUE_TYPES.COMPLETE_SALE → api.completeSale()
  │     writes transactions.{vat_amount, vatable_sales, vat_exempt_sales,
  │     zero_rated_sales, sc_pwd_discount, vat_rate_applied} + per-line
  │     transaction_items.vat_category — frozen at sale time, never recomputed
  │     from "current" rates later (sale immutability)
  └─► receipt.js buildReceipt()/receiptToHtml() — full BIR breakdown, always
        shown even at ₱0 (VATable/Exempt/Zero-Rated/VAT/Total Sales/Less:
        SC/PWD Discount/TOTAL AMOUNT DUE)
```

**TIN is two-level.** A Philippine business has ONE TIN; a branch gets a BIR branch code
appended (`00000` head office, then `00001`…). `company_profile.tin` + `branches.branch_tin_code`
→ `api.composeTin()`, surfaced as `full_tin` on every row `fetchBranches()` returns, so the
receipt, the X/Z reading and the settings screen cannot print three different numbers.
`branches.tin` survives as a per-branch override and as the pre-migration fallback.

**No admin UI edits `company_profile` right now.** `manager/Branches.jsx` used to have a
"Company details" card (business name/TIN/address) editing it directly; removed at the
owner's request pending a proper settings surface — the data model, `api.fetchCompanyProfile`/
`saveCompanyProfile`, and the TIN composition above are all still in place, only that one
page's form is gone. Existing `company_profile` rows are untouched.

`buildReceipt` must be handed the **real branch row** (`fetchBranchFiscalHeader(branchId)`,
cached). Passing a `{ name, business_name }` stub is what made the POS print `TIN: —`,
blank permit and blank MIN on every sale for as long as it did.

| Piece | File |
|-------|------|
| Calculation (pure) | `src/utils/vat.js` `computeVatBreakdown()` |
| Checkout wiring | `src/components/pos/Cart.jsx` `pricing` useMemo |
| Persistence | `src/stores/posStore.js` `addTransaction` → `src/lib/api.js` `completeSale()` |
| Receipt | `src/utils/receipt.js` |
| BIR X/Z/Cashier reports | `src/utils/terminalReports.js` (`taxable`, `nonTaxable`, `seniorDisc`) |
| Schema | `supabase/migrate_vat_breakdown.sql` |

**Rounding:** every aggregate (`vatableSales`, `vatAmount`, `vatExemptSales`, `scPwdDiscount`)
is derived by rounding the *summed* full-precision total once, not by summing pre-rounded
per-line pieces — this guarantees `vatableSales + vatAmount` exactly equals the rounded
vatable gross on multi-item carts. Per-line `discount_amount` (stored on `transaction_items`,
shown on cart/receipt) is still individually rounded, same as any other stored currency line.

**Server trust model:** `completeSale()` writes client-computed VAT figures as-is — same trust
model the app already has for `total_amount`/`discount_amount`, consistent with the
offline-first architecture (re-deriving the whole pricing engine — promos, kg pricing, ulam
combos — in Postgres would be a much larger, separate undertaking). A `not valid` CHECK
constraint on `transactions` (`transactions_vat_breakdown_sane_check`) catches gross
mismatches on new rows only — it does not retroactively validate historical rows, since
sale records are immutable and columns didn't exist for older ones.

**Historical data note:** `vat_exempt_sales`/`zero_rated_sales`/`sc_pwd_discount` default to 0
on rows written before `migrate_vat_breakdown.sql`. Their `vatable_sales`/`vat_amount` already
account for the full sale (the pre-fix formula treated everything as vatable), so nothing is
missing financially — reports run over date ranges spanning the migration just won't show the
correct VATable/Exempt split for the older portion.

---

## Products / inventory / import (movement)

```
Supervisor /data  or  Manager /manager/data
        │                    │
        └──── Data.jsx ──────┘
               │
               ├─ Add item → useProductStore.addProduct → api.createProduct
               ├─ Import file → inventoryImport.js preview
               │                 → commitInventoryImport (batches + products + stock)
               └─ refreshCatalog → local table + setProducts if same branch

Staff Inventory /inventory
        └── Products.jsx (edit, stock adjust, restaurant “today” toggles)
               → useProductStore.updateProduct / addMovement
```

**`catalog_products` (network template) vs. `products` (a branch's live item) are different
tables, edited by different UI:** `manager/Data.jsx` in manager mode (`ManagerNetworkCatalog`)
edits `catalog_products` via `api.updateCatalogProduct` — this sets the default a *future*
adoption gets, and **also cascades to every branch that already adopted the item** (see below).
To change **one specific branch's** copy without touching every other branch that adopted the
same catalog item, use that branch's own page instead: `Products.jsx` (manager/supervisor edit
form) or `manager/Data.jsx` in supervisor mode (`SupervisorCatalogAdopt`, inline "Discountable"
toggle) — both call `api.updateProductRow` against `products`. `updateProductRow` only includes
`discount_eligible` in its update payload when the caller explicitly passes it, so a partial
edit (e.g. stock-only) never silently clears it — keep that guard if you add more optional
fields to that function.

**The network catalog editor cascades to already-adopted branches, not just future adoptions:**
saving an item in `ManagerNetworkCatalog`'s bulk editor (`saveEditor`) writes `catalog_products`
via `updateCatalogProduct`, then also pushes to every `products` row already linked to it
(matched via `products.catalog_product_id`, falling back to a SKU match for rows that were
never linked — see `cascadeDiscountEligibleToBranches` below for why that link is often
missing):
- **`discountEligible`** — `api.cascadeDiscountEligibleToBranches(catalogProductId, eligible, sku)`.
- **`name`/`sku`/`barcode`/`category`/`price`/`budgetPrice`** — `api.cascadeCatalogFieldsToBranches(catalogProductId, fields, { matchSku, staffId })`,
  fired whenever any of those fields is dirty. A price change is also logged per branch via
  `recordPriceChange` (same RPC `Products.jsx` uses), so the Price Change Register and Price
  Listing report see catalog-driven price edits, not just branch-level ones. The SKU match for
  unlinked rows uses the item's **pre-edit** SKU (`row.sku`), since an unlinked branch row still
  carries whatever SKU it had before this save.

Both cascades are called from the same `saveEditor` loop, sequentially per changed row (not
`Promise.all`) — a burst of per-item follow-up writes against Supabase is a good way to get
rate-limited halfway through a bulk save. `supabase/migrate_sync_catalog_identity_fields.sql`
is the one-time catch-up for edits made **before** the identity/price cascade existed
(`migrate_sync_discount_eligible.sql` is the equivalent for `discount_eligible`); it
deliberately does not touch price/budget_price — see that file's header for why a bulk
one-time price overwrite is treated differently from a one-time name/SKU/barcode/category
catch-up.

| Feature | Files |
|---------|--------|
| Inventory / Menu UI + filters | `src/pages/Products.jsx` |
| Add / import / catalog filters | `src/pages/manager/Data.jsx` |
| Supervisor route | `/data` (`App.jsx` `SupervisorOnly`) — **own branch only** |
| Manager route | `/manager/data` — all branches |
| Import parse / preview | `src/utils/inventoryImport.js` |
| Import commit / history | `api.js` `commitInventoryImport`, `fetchImportBatches` |
| Branch staff import RLS | `supabase/migrate_import_batches_branch_staff.sql` |
| In-memory catalog | `useProductStore` |
| Bootstrap from server | `api.bootstrapBranchData` |

**Revert import:** manager-only (RPC `revert_import_batch` still checks `is_manager()`).

---

## Shifts & change fund (cash accountability)

The unit of cash accountability is the BUSINESS DAY, not the shift: one branch, one drawer,
several cashiers a day, and the drawer is counted once — at Day End — not once per cashier.
(Earlier this was per-shift; see `migrate_day_end_request_no_shift_count.sql` for why it
changed and the tradeoff that came with it: a variance can no longer be pinned to a specific
cashier when more than one worked the drawer that day, only to whoever counted at close.)

```
Start shift  → count change fund → useShiftStore.startShift
               → local Dexie `shifts` row (clientId) + enqueue OPEN_SHIFT
               → open_staff_shift() RPC → staff_shifts row (serverId)
               (a stale open shift left by a previous cashier on this drawer is
                auto-closed here, no count, so the new shift is never blocked)

Selling      → posStore.addTransaction stamps shiftClientId / shiftId
               → syncEngine swaps clientId for serverId on push
               → transactions.shift_id

End shift    → ShiftCashOut → plain clock-out. No count, no PIN — just enqueue
               CLOSE_SHIFT → close_staff_shift() sets clock_out, leaves
               ending_cash/expected_cash/variance null

Request day  → CashierEndShift "Request day end" (+ "request manager" toggle)
end            → requestDay() → request_day_end() RPC → day_ends.status = 'requested'
               (till stays open — a request is a notification, not a lock)

Day end      → SupervisorDayEnd "Close day" → counts the drawer once for the
               whole day → submitDay() → submit_day_end() → auto-closes for
               supervisor+ (see "Day end & cash" below)

Sign out     → shift stays open. Signing back in on the same drawer resumes it and
               does NOT ask for the change fund again.
```

**The resume rule.** `useShiftStore.resolve()` asks: is there an open shift for this
`staff_id` + `drawer_id`? Yes → resume. No → count in. It is answered from IndexedDB first
so it works with no network — asking the server would make "cannot reach the server" look
like "no open shift", and the safe-looking default (ask for the float again) is the wrong
one: it opens a second shift on a drawer that was already counted.

**Drawer identity** is `src/utils/drawer.js`: a localStorage id that survives sign-out,
because the drawer does not move when the cashier does. It defaults to the shared `'main'`
rather than a random per-device id — most shops have one cash box and several devices
pointed at it, and those must share a drawer identity or two people could count into the
same till unnoticed. A till with its own cash box gets its own id in Settings → Devices.
Same cashier on a different drawer is a different pile of cash, so that is gate `moved`
(supervisor override), never a resume.

| Gate | Meaning | Remedy |
|------|---------|--------|
| `ready` | shift open, sell | — |
| `start` | no shift here | count the change fund (unless today's business day is already closed — see below) |
| `moved` | this cashier is open on another till | cash out there, or supervisor override |
| `ended` | this session just cashed out | Request day end (still reachable on `/day-end`), then sign out |

There is no `busy` gate: a stale open shift under a previous cashier on the same drawer
never blocks the next one — `open_staff_shift()` auto-closes it (no count) before opening
the new shift, server-side, in the same transaction as the unique open-shift-per-drawer
index.

| Piece | File |
|-------|------|
| Store | `src/stores/shiftStore.js` |
| Gate UI | `src/components/shared/ShiftGate.jsx` |
| End-shift UI | `src/components/shared/ShiftCashOut.jsx` (plain clock-out, no count) |
| Log / adjustments UI | `src/pages/Shifts.jsx` |
| Drawer identity | `src/utils/drawer.js` |
| Local store | `src/offline/shifts.js` (Dexie `shifts`, v2) |
| Queue ops | `OPEN_SHIFT`, `CLOSE_SHIFT`, `REQUEST_DAY_END`, `REJECT_DAY_REQUEST` in `queueTypes.js` / `syncEngine.js` |
| API | `api.js` → `openShift`, `closeShift`, `requestDayEnd`, `rejectDayEndRequest`, `fetchOpenShift`, `fetchOpenShiftOnDrawer`, `fetchOpenShiftsForBranch`, `fetchLastClosedShiftOnDrawer`, `fetchShiftCashSummary`, `adjustShiftCash`, `fetchShiftAdjustments`, `fetchStaffShifts`, `acknowledgeShiftReview` |
| Tables | `staff_shifts` (+ cash columns, `closed_without_supervisor`, `reviewed_by`, `reviewed_at` — dormant, see below), `shift_adjustments`, `transactions.shift_id`, `day_ends` (+ `requested_at`, `requested_by`, `request_manager`, `rejected_at`, `rejected_by`, `reject_reason`) |
| Migration | `migrate_shift_cash_accountability.sql`, `migrate_shift_close_no_supervisor_flag.sql`, `migrate_day_end_request_no_shift_count.sql`, `migrate_day_end_reject_request.sql`, `migrate_shift_cash_void_fix.sql`, `migrate_staff_identity_resolve.sql`, `migrate_branch_roster_exclude_managers.sql` |

**Query shifts by `business_date`, never by `clock_in`.** `fetchStaffShifts` matches its
date range on the `business_date` column. Filtering on the clock-in instant is wrong twice
over: a business day runs open-hour to open-hour, so a 05:00 clock-in belongs to the
*previous* business date; and `clock_in` is `timestamptz`, so a bare `2026-08-09T00:00:00`
is read in the database session's zone (UTC on Supabase) rather than Manila, sliding the
whole window eight hours. Both silently dropped rows out of Day end's "Change fund by
shift", which reads as floats and closing counts never having been recorded. Any new
shift query needs the same treatment. Rows predating the column fall back to `clock_in`.

**A shift close never carries a count anymore.** `close_staff_shift()` accepts
`p_ending_cash` as optional; when omitted (the normal `ShiftCashOut.jsx` path now)
`ending_cash`/`expected_cash`/`variance` are left null rather than a fabricated ₱0.00 —
`api.closeShift()` defaults `endingCash` to `null`, never `0`, for exactly this reason.
`cash_sales`/`cash_refunds`/`cash_paid_out`/`cash_pickups` are still computed and stored on
every close regardless, since Day End's "Change fund by shift" totals read from those, not
from a per-shift ending count.

**The `staff_shifts` column fallback ladder is ordered, and the order is load-bearing.**
`api.js` reads shifts through progressively older column sets: `SHIFT_COLS` →
`SHIFT_COLS_CORE` → `SHIFT_COLS_LEGACY` → `SHIFT_COLS_MINIMAL`. `shift_period` (its own
migration) and `closed_without_supervisor`/`reviewed_by`/`reviewed_at`
(`migrate_shift_close_no_supervisor_flag.sql`) are each optional and independent of the core
cash-accountability schema, so any of them can be missing on a database that has every cash
column. They are therefore tested *together*, via `isMissingOptionalShiftColumn`, *before*
`isMissingShiftCashSchema` — which matches `does not exist` generically and would otherwise
read one missing optional column as a missing cash schema, dropping straight to a column set
with no `starting_cash`/`ending_cash` and rendering every float and closing count blank.
`migrate_shift_cash_accountability.sql` adds `shift_period` itself, because the
`open_staff_shift()` RPC it defines inserts into that column; without it, opening a shift
raises `column shift_period does not exist`. Any new optional column added to the ladder
keeps the same rule: narrow filters (`drawer_id`, `business_date`) only on tiers that
actually carry the column.

**Ending a shift no longer needs anyone's approval.** `ShiftCashOut.jsx` is a plain confirm
now — no cash field, no `SupervisorApprove` PIN prompt. `endShift` (shiftStore.js) always
closes under the cashier's own id (`closedBy: user.id`); `close_staff_shift()`'s
`closed_without_supervisor` flag is deliberately never set true by this path anymore (it
would otherwise fire on every single shift close, not just the rare unwitnessed one it used
to mean) — `migrate_day_end_request_no_shift_count.sql` covers why. The
`closed_without_supervisor`/`reviewed_by`/`reviewed_at` columns and
`acknowledge_shift_review()` RPC are left in the schema (harmless) but are dormant: nothing
sets the flag true anymore, so `fetchPendingApprovals`' "shift closed without supervisor"
section and Manager/Staff → Shifts' **Needs review** status will not fire on new shifts.

**Ending a shift forces sign-out before the next count — but Request day end must still be
reachable first.** `endShift` (shiftStore.js) lands on `gate: 'ended'`, not `'start'`.
`ShiftGate` renders that gate as a screen with a **Sign out** button (plus a **Day end**
shortcut) — no "count a new change fund" form, no override. Falling through to the start
screen would let whoever is standing at the till open the NEXT shift under THIS cashier's
still-open session. `Shell`'s `shiftBlocking` covers every gate except `ready`/`checking`,
**except** `ended` while already on `/day-end` — that carve-out is what lets a cashier who
just ended their shift still tap **Request day end** on that same screen (`CashierEndShift`
already renders fine with no active shift) before signing out; navigating anywhere else
while `ended` locks the app the same way `moved` does. The cash-out modal's `onDone`
(`DayEnd.jsx`) must NOT call `resolve()` afterward — that re-asks the server "is a shift
open?", gets no, and overwrites `ended` back to `start`, undoing this.

**Request day end is locked out while a shift is still open.** `CashierEndShift`'s "Day end"
card shows a plain "End your shift first" message instead of the request form whenever
`shift` (the live open shift) is truthy — asking to close the whole business day while your
own drawer isn't even counted yet has the two actions backwards. The card falls through to
the normal request UI (or the existing requested/submitted/closed/rejected status views,
unaffected by this) once the shift is gone. Pure a client-side gate, no RPC change — the
request itself was never actually tied to shift state server-side.

**A closed business day refuses a new change fund.** `ShiftGate` checks
`isDayFullyClosed(dayEnds, dayOpenHour)` (`useInventoryStore`) whenever gate is `'start'`
and `holdsDrawer` is true; if today's `day_ends` row is already `'closed'`, it renders a
**Day closed** screen (sign out, no count form) instead of the usual change-fund form. Cash
counted into a drawer after the day's Z-reading already ran is cash nobody's closing figures
ever saw — an instant, unexplainable variance. Self-corrects at the next business date
(`isDayFullyClosed` always checks *today's* business date) or if a manager reopens the
closing from Day End. Supervisor floor shifts (`holdsDrawer` false) are not gated by this —
they carry no cash.

**A cashier stuck on "Day closed" can ask for it back, not just sign out.** Reopening stays
manager-only (`reopen_day_end`), but a cashier (or anyone on the branch) can
**Request reopen** right from that screen — `request_day_reopen()` RPC
(`migrate_day_end_reopen_request.sql`) sets `day_ends.reopen_requested_at/by/reason`, online-
only (`useInventoryStore.requestDayReopen`, deliberately not queued — the whole point is to
notify a manager *now*, and the till is blocked either way). Surfaces to managers via
`fetchPendingApprovals`'s `day_end_reopen_requested` items (bell) and a banner on
`BranchDashboard.jsx`'s "Day-end closings" card (pre-fills the reopen reason field from the
request). `reopen_day_end()`/`submit_day_end()` both clear the request columns when the day
actually gets reopened or re-closed, so a stale request never lingers past the event that
made it moot.

**A cashier is never blocked by another cashier's still-open drawer.** There is no `busy`
gate (removed along with per-shift counting) — `open_staff_shift()` auto-closes a stale
open shift on the same drawer (no count, `close_note` explains why) before opening the new
one, inside the same transaction that satisfies the unique open-shift-per-drawer index. See
`migrate_day_end_request_no_shift_count.sql`.

**Closed shifts are frozen** by a trigger. A correction goes through `adjust_shift_cash()`,
which logs old value, new value, actor and reason to `shift_adjustments` — the same
immutability principle as sales records, for the same BIR reason.

**`holds_drawer`** separates cashier shifts (count cash, exclusive on the drawer) from
supervisor floor shifts (no count, no exclusivity). Without it a supervisor clocking in
would lock the cashier out of the till they are standing at.

**RLS**: a cashier reads only their own shifts; supervisor+ reads the branch. The two facts
a cashier still needs about someone else's drawer — who holds it, and what the last person
left in it — come from the narrow definer functions `drawer_holder()` and
`drawer_last_count()`, which return a name, a time and one figure and nothing else.

**Resolving a name for a `staff_id` a supervisor doesn't own needs the definer function,
not a PostgREST embed.** `staff`'s own RLS (`read staff`) only grants a caller their own row
or a manager — full network access. A `staff_shifts.select('staff:staff_id(full_name)')`
embed (or any embed to `staff`) is filtered by that same policy, so a supervisor reading
their branch's shift log (RLS-visible rows) got every other cashier's name silently
blanked, and the void/refund Audit panel (`fetchSaleEvents`) had the identical "performed
by" gap. `resolve_staff_identities(p_ids)` (`migrate_staff_identity_resolve.sql`) grants a
supervisor their own branch (still id/full_name/role only, never `login_pin`), and
`api.fetchStaffIdentities()` now calls it first — falling back to the old raw `staff` read
(self-only for a supervisor) if the migration isn't applied. `fetchSaleEvents` and
`fetchStaffShifts` both resolve through it instead of an embed. Anything else that embeds
`staff` directly for a non-manager viewer has the same latent gap.

**A branch's roster hides manager/admin/master, even when their row carries that
`branch_id`.** Those roles oversee every branch, not just one — listing them in a single
branch's "who works here" list is misleading to the supervisor reading it, not a capability
they need to see there. `branch_staff_roster()`'s supervisor branch adds
`role not in ('manager','admin','master')` (`migrate_branch_roster_exclude_managers.sql`);
its manager branch is untouched — a manager managing accounts still needs to see them.

---

## Transactions, voids, refunds (movement)

```
Sale completes → transactions + transaction_items
Staff Transactions.jsx / Manager BranchDashboard
   → TransactionDetailModal
        ├─ void → voidTransaction / RPC
        └─ refund lines → refundSaleItems
              → updates refunded_amount (guard allows only that field on completed sales)

Approval, in Transactions.jsx's refund flow:
   supervisor/manager signed in → self-approved instantly (canApproveDirect)
   cashier, supervisor on site  → SupervisorApprove modal (code+PIN, in person)
   cashier, "no supervisor available — notify manager instead" checked
        → request_refund_approval RPC → refund_requests row (status='pending')
        → RequestNotifications bell + BranchDashboard.jsx (manager, any device)
        → approve_refund_request RPC executes void_sale_secure/refund_sale_items,
          Transactions.jsx's waiting modal resolves via realtime (+ 5s poll fallback)
```

| Piece | File |
|-------|------|
| Staff list | `src/pages/Transactions.jsx` |
| Detail modal | `src/components/transactions/TransactionDetailModal.jsx` |
| Mapping helpers | `src/utils/transactionDetail.js` |
| API | `fetchTransactionDetail`, `fetchRefundSummary`, `refundSaleItems` |
| Store | `voidTransaction`, `refundTransactionItems` |
| SQL | `migrate_refund_sale_items.sql`, `migrate_refund_amount_on_transactions.sql`, `migrate_fix_refund_sale_items_typo.sql` |
| Remote manager approval | `src/components/shared/SupervisorApprove.jsx` (in-person), `requestRefundApproval`/`approveRefundRequest`/`rejectRefundRequest`/`cancelRefundRequest`/`fetchRefundRequests` in `src/lib/api.js`, `migrate_refund_requests.sql` |

**Remote manager approval ("no supervisor available — notify manager instead").** For a
branch whose manager is never on site, the in-person `SupervisorApprove` PIN flow doesn't
work — there's no one there to type a PIN. `Transactions.jsx`'s refund reason step shows a
checkbox (only when the signed-in user isn't already `isSupervisorOrAbove`, since that role
already self-approves with zero friction) that, instead of opening `SupervisorApprove`,
calls `requestRefundApproval` and shows a "Waiting for manager…" modal. A pending state
**cannot live on `transactions` itself** — `guard_transaction_updates()` only allows
`completed→voided` or a `refunded_amount` increase, and rejects any update once a row is
`voided` — so it lives in its own `refund_requests` table (`migrate_refund_requests.sql`),
mirroring promo dual-control (`migrate_promo_dual_control.sql`'s `promo_events` status/
`requested_by`/`approved_by` shape). A manager sees it in the header bell
(`RequestNotifications.jsx` → `fetchPendingApprovals`'s `refund_pending` items) and on
`BranchDashboard.jsx`'s "Refund requests" section for that branch — from any device, since
`is_manager()` has no branch scoping. Approving (`approve_refund_request` RPC) executes the
actual `void_sale_secure`/`refund_sale_items` server-side, with `requested_by` (the cashier)
as the acting staff and the approving manager as `p_approved_by` — the cashier's UI never
calls those directly for this path, it just reflects the result once realtime (or the poll
fallback) reports the request as `approved`/`rejected`. Cashier can `cancelRefundRequest`
while still pending. This path is manager-only (`is_manager()`, not
`isSupervisorOrAbove()`) — a supervisor who is actually on site uses the existing in-person
flow instead and never needs it.

**Never show a refunded sale as one already-netted number.** `total − refunded` next to a
"−₱150" reads as if the refund is about to come off a second time. List rows and the detail
modal show the **original total** and the **refunded amount** as two labelled figures.
`netTotal` is still the right thing for aggregates — just not as a row's headline figure.

**Be careful re-patching `refund_sale_items` / `void_sale_secure` in a new migration.**
`migrate_day_end_dual_control.sql`'s "patch" of `refund_sale_items` (to add the business-day
lock check) silently dropped its `sale_events` inserts and the `fully_voided` return key while
copying the body, and introduced a `p_txn`/`v_txn` typo that broke every item-level refund —
fixed by `migrate_fix_refund_sale_items_typo.sql`, the latest body. When touching either RPC
again, diff against the latest migration file, not an older one, and confirm the return shape
still has every key the caller (`posStore.js`) branches on (`fully_voided`, `refunded_amount`).
`Transactions.jsx`'s refund/full-refund modals show `error` inline now (not just the page-level
banner, which sits behind the modal overlay) — keep doing that for any new modal that can fail.

### Who approved it (approval attribution)

Approver ids are persisted (columns below); the display layer resolves them to **name + role**.

**Void was the exception until `migrate_void_sale_approved_by.sql`:** the Void/Refund Log
report reads its "Approved by" column from `sale_events.payload.approved_by`, but
`void_sale_secure` — the RPC every void actually goes through — never accepted or wrote an
approver at all; the client's separate `transactions.void_approved_by` patch never reached
`sale_events`. The migration adds `p_approved_by` to the RPC so both are set atomically in the
same insert, mirroring how `refund_sale_items` already did it. `api.js`'s `voidSale()` passes
`p_approved_by`; on a pre-migration schema the RPC call fails to match (old 3-arg signature) and
falls through to the manual fallback path, which already set both correctly.

| Action | Where the approver lives |
|---|---|
| Void / full refund | `transactions.void_approved_by` + `sale_events.payload.approved_by` |
| Item refund | `sale_refund_lines.approved_by` |
| Remote refund request | `refund_requests.requested_by` (cashier) + `.approved_by` (manager, also flows into the two rows above once approved) |
| Petty cash | `cash_drawer_entries.approved_by` / `confirmed_by` |
| Shift cash correction | `shift_adjustments.approved_by` |
| Cart line removal, price override, second-drawer override | `audit_events` via `logApprovalEvent()` — these have no row of their own |

`fetchStaffIdentities(ids)` resolves `{id: {name, role}}` (no PostgREST embed — `transactions`
FKs `staff` three times, so an embed needs disambiguating at every call site).
`approverLabel(name, role)` produces the one string every surface shows: `"Ana Cruz · Supervisor"`.
`SupervisorApprove.onApproved` returns `{ staffId, name, role, via }`.

---

## Day end & cash

**One route, two screens.** `DayEnd.jsx` branches on `isSupervisorOrAbove(user.role)`:

| Role | Screen | Sees |
|---|---|---|
| cashier | **End shift** | own shift's cash-sales-so-far (informational — `useShiftStore.cashPosition`), a plain **End shift** clock-out (`ShiftCashOut`, no count/PIN), a **Request day end** action, own petty requests. No branch totals, no restock, no Close day. |
| supervisor+ | **Day end** | branch sales, every shift's accountability, restock, petty **approval queue**, any pending **day-end request**, Close day (the Z-reading gate, does the one drawer count for the day). |

**`cashPosition()` merges server + not-yet-synced local sales.** The server RPC
(`shift_cash_summary`) only knows about a sale once it has synced — a sale rung up is
written locally first (`syncStatus: 'pending'`) and pushed in the background, so trusting
the RPC alone left a window where a just-made sale read as ₱0.00 on "Your shift so far".
`useShiftStore.cashPosition()` always adds this device's still-`pending`/`local` cash
sales/refunds on top of the server figure (`source: 'server+pending'`); a row drops out of
that delta on its own once it syncs, so there is no double count. `source: 'local'` (used
only when no remote figure is reachable at all — offline, or an unmigrated schema) is
labeled "Offline" vs "Estimate" based on actual connectivity (`reasonOffline`), and always
omits paid-out/pickups — petty cash has no IndexedDB mirror, so an on-device-only estimate
genuinely cannot know about it. `cashPositionNotice()` (`shiftStore.js`) is the single place
that turns `source`/`reasonOffline` into the banner text shown in both `ShiftCashOut.jsx`
and `CashierEndShift`.

**`shift.serverId` in the live store goes stale, so anything server-facing must resolve it
fresh, not read it off the store.** `startShift()` sets the in-memory `shift` object once,
with `serverId: null` if the OPEN_SHIFT push hasn't landed yet. `markShiftSynced()`
(`offline/shifts.js`) stamps the real id onto the IndexedDB row once it does — but nothing
pushes that back into the live Zustand state, so `shift.serverId` reads `null` for the rest of
the session even long after the shift has actually synced. Two real consequences before this
was caught: `cashPosition()` fell to the local-only branch (hardcoding paid-out/pickups to 0)
for a shift's entire session whenever this raced; and a petty-cash request made through the
cashier's own `PettyCashPanel` (`shiftId={shift?.serverId}`) could get written with
`shift_id: null`, permanently invisible to `shift_cash_summary()`'s strict
`shift_id = p_shift_id` filter while still counted in the supervisor's unscoped day total —
another way the two screens could disagree even with a single shift on the drawer.
`useShiftStore.syncShiftServerId()` fixes this: resolves the id fresh from IndexedDB via
`resolveShiftServerId()` and writes it back into the store, so every later read of
`shift.serverId` (from any component) is current. `cashPosition()` calls it first, on every
call.

**A transaction's `date` is a CALENDAR date — never compare it to a business date.**
`mapTransaction`/`mapMovement` (`api.js`) set `date: localDateKey(created_at)`, which knows
nothing about the branch's open hour. `businessDate()` DOES roll back a day before
`dayOpenHour`. Comparing the two keys (`txn.date === date`) is wrong in both directions: it
drops every sale rung between midnight and the open hour out of its own business day, and
counts the *previous* business day's early-hours sales into the current one. On a branch that
trades past midnight this made `SupervisorDayEnd`'s "All sales (POS)" / "Expected in drawer"
disagree with the cashier's shift figure — `shift_cash_summary()` scopes by `shift_id` and
applies no date filter at all, so it was never affected. It also fed a wrong `recorded_cash`
into `submit_day_end`, i.e. into a saved fiscal record.

Use `rowBusinessDate(row, openHour)` (`utils/format.js`) for any money/report filter keyed on a
business date. It derives from `createdAt` (the real instant), falling back to the row's
calendar `date` only when `createdAt` is absent. Applied in `DayEnd.jsx` (`inBusinessDay`),
`buildDayEndReport` (which now takes `dayOpenHour`), and `BranchDashboard.jsx` (`inToday`).
This is the transaction-side sibling of the existing "query shifts by `business_date`, never by
`clock_in`" rule above — same failure, different table.

**`SupervisorDayEnd`'s "Cash on hand" field starts blank, not `0`** (`cashOnHand === ''`
until the supervisor types something) — `hasCashOnHand` gates both the "Variance vs
expected" display and `noteRequired`, so the screen reads "—  Enter cash on hand to
compare" instead of a false "₱X Short" the instant the page loads with nothing counted
yet. The "Close day" button was already correctly disabled on a blank field before this
fix (`disabled={cashOnHand === '' || ...}`) — only the premature on-screen variance was
wrong, not what could actually be submitted. Also shows Card/E-wallet sales (net of
refunds, same as `cashSales`, informational — never enter `expectedCash`) alongside Cash
sales under "All sales (POS)", so a supervisor can see the tender split without leaving
this screen.

**Top products/categories and DayEnd's sold-item breakdown read `transaction_items` via
`fetchSoldLineItems` (`api.js`), never `stock_movements` or a transaction's `itemsList`.**
`itemsList` is never populated on a transaction loaded through `bootstrapBranchData` —
`BOOTSTRAP_TX_COLS` only selects `transaction_items(id)`, a count, not product/qty/price — so
any code trying to read it for historical data silently gets nothing. `stock_movements` looks
like a substitute but isn't: its rows are deliberately never deleted when a transaction is
(see `debug_reset_all_transactions.sql`'s header), so an orphaned `'sale'`-type movement from
a deleted test sale keeps counting as "sold today" forever, and it carries no historical price
at all — only today's *live* `products.price` was ever available to multiply by, so a later
price edit retroactively rewrote history. `fetchSoldLineItems` fixes both: it joins
`transaction_items` to `transactions` (mirroring the already-correct network-wide
`fetchNetworkDashboard` query) and returns each line's `line_total` — what was actually
charged. `Dashboard.jsx` fetches it client-bucketed by calendar day (`inPeriod`);
`DayEnd.jsx`/`buildDayEndReport` fetch+narrow it by **business** day
(`rowBusinessDate`, same buffer-then-narrow shape as `fetchBranchCashImpact`) before passing
it to `buildDayEndReport` as `soldItemRows`. Because this is a network fetch, `DayEnd.jsx`
shows a "reconnect to see today's sales breakdown" notice in place of the report when it's
offline/unavailable (`soldItemsUnavailable`) — the actual cash count and Submit/Close Day
action never depended on this data and are unaffected, still offline-queueable as before.

**`transactions.shift_id` was never selected from the server at all.** `BOOTSTRAP_TX_COLS`
(`api.js`) — the column list behind `bootstrapBranchData()`, i.e. every sync pull — omitted
`shift_id`, and `mapTransaction()` never mapped it onto the client object either. The database
value was always correct (confirmed via `diagnose_shift_vs_day_end.sql`); the client silently
dropped it on every row the moment it round-tripped through a pull. `putTransactions()`
(`offline/repository.js`) bulk-writes that same mapped shape into Dexie, so the gap propagated
into the offline store too — any shift-scoped read of an already-synced transaction (not just
`SupervisorDayEnd`'s discount annotation below, which is what surfaced it) silently saw
nothing for that row. `shiftClientId` is deliberately NOT restored in the mapping — it only
ever meant anything as a same-session local-optimistic hint before a shift had synced; once a
row reaches the server, `shiftId` is the only attribution to trust.

**Cash sales figures show gross-vs-discount, informationally.** `total`/`netTotal` on a
transaction are already net of discount (the customer only ever hands over the discounted
amount), so no discount term appears in the actual "Expected"/"Drawer should hold" math — it
was already correct. What was missing was visibility: `cashDiscounts` (sum of
`discountAmount` across that scope's cash `'Paid'` transactions) and `cashSalesGross`
(`cashSales + cashDiscounts`) are computed in both `SupervisorDayEnd` and `CashierEndShift`
and shown as a small annotation under the "Cash sales" line whenever discounts were given that
day/shift, so "why is cash sales lower than sticker prices" has an answer on this screen
instead of only in the separate Discount Report.

`day_end` is in `manager`/`admin`'s default module list (`roles.js` `DEFAULTS`) specifically
so a manager can reach this same screen — needed for a cashier's "request manager" day end
when no supervisor is available (see below); managers otherwise mostly work from
`BranchDashboard.jsx`.

The cashier/supervisor split is a privacy boundary, not cosmetics: the old shared screen
rendered "Change fund by shift" — every staff member's float and variance — to whoever
opened it, so a cashier could read a supervisor's drawer. Do not reintroduce a branch-wide
figure into the cashier view.

```
Sales during day → expected cash (sales − voids/refunds ± petty/pickup/float)
Cashier "Request day end" → request_day_end RPC → day_ends.status = 'requested'
  (no numbers yet, till stays open — a request is a notification, not a lock)
  ├─ supervisor+ "Decline request" → reject_day_end_request RPC → status 'rejected'
  │    (row kept for audit, cashier's screen falls back to the normal request form)
  └─ DayEnd.jsx (supervisor+) → submit_day_end RPC → day_ends row, status 'closed' immediately
Till locked until reopen (manager, CURRENT business day only) or next business date
Cart soft nudge after ~8 PM or last 2h before openHour+14h
```

**A cashier requests, a supervisor (or manager) counts and closes.** Cash counting happens
once per business day now — the cashier's "Request day end" (`CashierEndShift`, DayEnd.jsx)
carries no cash figures, just a flag (`request_day_end` RPC → `day_ends.status =
'requested'`, `requested_by`, `request_manager`). The **"No supervisor available — request
manager instead"** toggle is always shown to the cashier (not conditioned on whether a
supervisor happens to be clocked in — a supervisor's shift is not expected to stay open all
day, so that presence is not a reliable signal). `SupervisorDayEnd` shows a banner for a
pending request and — unchanged — the normal Close Day form (cash-on-hand → `submitDay`)
counts the drawer and closes, overwriting the `'requested'` row with real numbers. If
`request_manager` was set, a supervisor viewing the screen sees "waiting for a manager"
instead of the form (`waitingForManager` in `DayEnd.jsx`) — any manager can always act on it.
`fetchPendingApprovals` surfaces `'requested'` rows the same way: to a supervisor only when
not manager-flagged, to a manager always.

**Declining a request.** Whoever could act on a request (supervisor, or manager when
`request_manager` was set — the same `waitingForManager` gating as Close Day) can instead
decline it via a **Decline request** button on the same banner, calling
`rejectDayRequest` → `reject_day_end_request` RPC. This sets `status = 'rejected'` (with
`rejected_at/by`, an optional `reject_reason`) and clears `requested_at/by`/`request_manager`
— the row is kept, not deleted, for the audit trail (an `audit_events` row is also written).
Nothing else has to special-case `'rejected'`: `dayRequested`/`dayInProgress` in
`CashierEndShift` are only true for `'requested'`/`'submitted'`/`'closed'`, so a rejected row
falls straight through to the normal "Request day end" form again — `CashierEndShift` shows a
one-line "your last request was declined" notice above that form when it does.

**Closing no longer waits on a separate approval.** `submit_day_end` auto-closes (sets
`status = 'closed'`, `approved_by`/`approved_at`) when the caller is supervisor_or_above, by
calling `approve_day_end` on itself in the same statement — see
`migrate_day_end_supervisor_autoclose.sql`. This screen is already gated to supervisor+
(`DayEnd()`'s role split above), so the old two-step submit-then-approve was one person
approving their own submission a moment later; collapsing it removes that wait without adding
a new actor. A plain cashier calling `submit_day_end` directly (not exposed in the UI — a
cashier's own action here is `request_day_end`, not `submit_day_end`) still lands on
`'submitted'` and needs a supervisor+ to approve — dual control is untouched for that caller.
The local optimistic status in `submitDay` (`posStore.js`) mirrors this: `'closed'` when the
signed-in user is supervisor+, `'submitted'` otherwise, so the UI does not show "awaiting
approval" for a day that is about to close anyway.

**Cancel closing = the existing manager-only reopen, surfaced here too.** Since a supervisor
closing their own day removed the review pause approval used to provide, `DayEnd.jsx` puts a
**Cancel closing** button next to a closed day, visible only to managers — it calls the same
`reopenDay`/`reopen_day_end` used by `BranchDashboard.jsx`'s Reopen, unchanged and still
manager-only, reason required, logged to `audit_events`. A supervisor cannot self-reopen a day
they closed; that boundary was deliberately left alone.

**Reopen is current-day only.** `BranchDashboard.jsx` offers Reopen on a closed day-end row
only while `entry.date === todayKey`; past closings render `Locked` with no override at any
role. `DayEnd.jsx`'s Cancel closing only ever acts on `dayEndForBusinessDate(dayEnds, date)`
for the CURRENT business date, so it inherits the same restriction without a separate check.
Reopening a passed day would move cash figures under a Z-reading already filed.

**`DayEnd.jsx` has no historical closings list of its own.** It used to render its own
"Previous day-end closings" table, duplicating `BranchDashboard.jsx`'s paginated "Day-end
closings" section (which also has Reopen) with a plainer read-only copy. Removed — a
supervisor closing today's day doesn't need yesterday's numbers on the same screen, and a
manager wanting history already has the richer version. `DayEnd.jsx` still fetches `dayEnds`
(`useInventoryStore`) for `dayEndForBusinessDate(dayEnds, date)` — only the list *rendering*
was removed, not the underlying fetch.

**Close day is the last thing on the page, not the first.** The sales-summary / cash-on-hand /
variance / notes / Close day card used to sit directly under the top sales report, above
Accountability and the petty cash queue — reachable (and closeable) without scrolling past
either. It now renders last, after Accountability and Petty cash, so a supervisor sees the
shift-by-shift drawer breakdown and any pending petty cash before reaching the button that
locks the day. No state or logic moved, only where the card renders in `SupervisorDayEnd`'s
JSX.

### Petty cash: request → approve → fulfil

```
pending     cashier asked. No money has moved. Anyone may create.
  ↓ approvePettyCash()      supervisor+ ONLY (role check, no delegation/escalation logic)
approved    authorised. Money is STILL IN THE DRAWER.
  ↓ fulfillPettyCash()      anyone on site, including the requester
fulfilled   cash physically handed over. THIS is the disbursement.
```

**A supervisor-or-above's own request skips `pending` entirely.** `requestPettyCash({ ...,
autoApprove })` writes `status: 'approved'` (and self-sets `approved_by`) instead of
`'pending'` when `autoApprove` is true. The caller passes `autoApprove: canApprove` —
`PettyCashPanel`'s existing prop, the same gate its manual Approve button already uses
(`DayEnd.jsx`'s supervisor screen renders the panel with `canApprove` true; the cashier's own
"End shift" screen passes `canApprove={false}`, so a cashier's request still lands pending as
before). This adds no new trust boundary: `canApprove` was already a purely app-level gate (no
DB role check on the write itself — see the note below), so self-approving at creation is the
same authority the same person already had one click later via Approve.

**Note on this table's write boundary:** `cash_drawer_entries`' RLS policy
(`migrate_rename_petty_cash_to_cash_drawer_entries.sql`) only checks branch match / `is_manager()`,
not role — unlike the fulfil step, there is no DB `CHECK` gating who can set `status = 'approved'`
on this table, so the supervisor-only rule for approving is enforced by UI (`canApprove`) only, not
by the database. Pre-existing, unrelated to the auto-approve change above; flagged here rather than
fixed, since closing it would mean adding a `SECURITY DEFINER` RPC for the whole request/approve
path (matching the `submit_day_end` pattern below) — a larger change than any reported bug asked for.

**Only `fulfilled` is deducted from expected cash.** `approved` is a commitment, not a
disbursement — deducting it made the drawer read short between approval and handover.
**Every consumer of that rule must agree**, or the same drawer reconciles to different
numbers on different screens. All four now filter on `'fulfilled'`:

| Consumer | Where |
|---|---|
| `close_staff_shift()`, `shift_cash_summary()` | `migrate_petty_cash_fulfilment.sql` |
| End-shift / day-end expected cash | `src/pages/DayEnd.jsx` (`rowStatus`) |
| **X / Z reading cash-in-drawer + short/over** | `src/utils/terminalReports.js` |
| Row mapping default for pre-workflow rows | `src/lib/api.js` (`mapPettyCashRow`) |

A `paid_out` row with a null `status` predates the workflow columns, so its cash was already
handed over: the default is `'fulfilled'` in all of the above. Defaulting one of them to
`'approved'` parks an old disbursement in the awaiting-handover queue and adds its cash back
into the expected drawer.

Fulfilment without a prior approval is impossible by construction, in two places:
`fulfillPettyCash` filters `.eq('status', 'approved')`, and the DB holds
`cash_drawer_entries_fulfil_needs_approval`. The UI is not the boundary. That constraint is
deliberately left `NOT VALID` forever — enforced on every new write, exempt only for
pre-split history rows, which keep a null approver rather than being back-filled with a
sign-off that never happened.

`migrate_petty_cash_fulfilment.sql` must be applied **after**
`migrate_shift_cash_accountability.sql` — it needs `transactions.shift_id` and rewrites two
functions that file creates. Its section 0 raises a named error if you run it early.

**A voided cash sale must net to zero, not `-total_amount`.** `close_staff_shift()` and
`shift_cash_summary()` excluded a voided transaction from `sales` (correct — it is no longer
a sale) but then subtracted its full `total_amount` again as a `refund` (wrong) —
double-counting cash that was never added to `sales` in the first place. Whatever cash a sale
put in the drawer, its void takes back out; the net effect on expected cash must be zero, same
as it already was on the client-side `SupervisorDayEnd` total (which only ever excluded voids,
never had this bug). Fixed in `migrate_shift_cash_void_fix.sql`: a non-`'completed'` row now
contributes `0` to `refunds`, not `total_amount`. The offline client mirror,
`sumCash()` in `src/stores/shiftStore.js`, has the same fix — keep both in sync if this
formula changes again. This is why a cashier's "Your shift so far" could read lower than the
supervisor's "Expected in drawer" by exactly the sum of that shift's voided cash sales.

**A pickup/petty-cash entry must be charged to whoever holds the drawer, not to whoever is
looking at the screen.** `SupervisorDayEnd`'s "Cash pickup" quick form, and the `shiftId` it
passes into `<PettyCashPanel canRequest>` for supervisor-made paid-out requests, used to
attribute the entry to `activeShift` — the VIEWING supervisor's own shift (often `null`, since
supervisors don't usually hold a drawer). `shift_cash_summary()` filters strictly on
`shift_id = p_shift_id`, so an entry attributed to the wrong shift (or none) never shows up in
that cashier's "Your shift so far", while `SupervisorDayEnd`'s own day-wide totals (unscoped by
shift) always included it — another way the two screens could disagree with a single shift on
the drawer. Fixed by attributing to `drawerHolderShift` — `drawerShifts.find((row) =>
row.open)`, i.e. whichever shift is actually open on the drawer right now — computed once in
`SupervisorDayEnd` and reused by both call sites.

Rows already written with a null `shift_id` stay broken until repaired:
`migrate_backfill_cash_drawer_shift_id.sql` attaches them to the drawer shift that was open
when they were recorded (or the day's only drawer shift), and reports anything too ambiguous
to attribute. `transactions.shift_id` is NOT repairable — `guard_transaction_updates()`
rejects every update to a sale except a void transition — so a sale that reached the server
unattributed is counted in the supervisor's day total and in no cashier's shift total,
permanently. `supabase/diagnose_shift_vs_day_end.sql` is a read-only query that prints both
sides' components side by side and flags exactly these orphaned rows; reach for it first when
the two screens disagree.

| Piece | File |
|---|---|
| Shared panel (request/approve/fulfil) | `src/components/dayend/PettyCashPanel.jsx` |
| API | `requestPettyCash`, `approvePettyCash`, `fulfillPettyCash`, `rejectPettyCash` |
| Migration | `supabase/migrate_petty_cash_fulfilment.sql`, `supabase/migrate_shift_cash_void_fix.sql` |

| Piece | File |
|-------|------|
| Page | `src/pages/DayEnd.jsx` |
| Report panels | `src/components/dayend/DayEndReportPanels.jsx` |
| Snapshot builder | `src/utils/dayEndReport.js` |
| Nudge | `Cart.jsx` `shouldNudgeDayEnd` |
| API | `closeDayEnd`, `reopenDayEnd`, `requestDayReopen`, `addPettyCash`, `fetchPettyCash`, `fetchPettyCashTimeline` |
| Dates / open hour | `src/utils/format.js` |

### Cash accountability timeline

`DayEnd.jsx` records three types of drawer/accountability entries into `cash_drawer_entries` (formerly `petty_cash`):
- `"[CHANGE FUND] ..."` → opening float
- `"[PICKUP] ..."` → cash pickup / safe drop
- plain reason text → paid-out / petty cash

Manager tracking lives in:
- `src/pages/manager/BranchDashboard.jsx`
  - reads `fetchPettyCashTimeline(branchId, { startDate, endDate })`
  - renders time, type, amount, cashier/staff, and note/reason
- `src/lib/api.js`
  - maps `cash_drawer_entries` rows into normalized timeline entries with `kind`, `staffName`, `createdAt`
  - falls back to legacy `petty_cash` table name until `migrate_rename_petty_cash_to_cash_drawer_entries.sql` is applied

---

## Devices

| Piece | File |
|-------|------|
| Staff Devices page | `src/pages/Devices.jsx` |
| Capability helpers | `src/devices/index.js` |
| Manager toggles | `BranchDashboard.jsx` → `saveBranch` device_settings |
| Presence / heartbeat | `useBranchHeartbeat.js`, `migrate_branch_presence.sql` |

UI copy: when manager enables a device, show **Enabled by manager · Connected/Not connected** (not stale “Disabled”).

---

## Manager area

| Page | Path | File |
|------|------|------|
| Overview | `/` (manager) | `manager/Overview.jsx` |
| Branches | `/manager/branches` | `manager/Branches.jsx` |
| Branch detail | `/manager/branches/:id` | `manager/BranchDashboard.jsx` |
| Staff | `/manager/staff` | `manager/Staff.jsx` |
| Shifts | `/manager/shifts` | `Shifts.jsx` (manager mode) |
| Data / catalog | `/manager/data` | `manager/Data.jsx` |
| Reports | `/manager/reports` | `manager/Reports.jsx` + `utils/terminalReports.js` + `api.fetchTerminalReportSource` |

Period filters (day/week/month/year) live on Overview / BranchDashboard. Restaurant branch UI emphasizes menu / devices / day ops over retail stock language.

**`/data` ("Catalog", staff nav) and `/manager/data` ("Data", manager nav) route to the same
`ManagerData` component** — for a manager/master, `staffLinksFor` (`nav.js`) drops the
`catalog` entry so it isn't duplicated alongside `manager_data`, the same dedup already done
for `shifts`/`manager_promos`. A supervisor/cashier still sees "Catalog" as their only route
to it, since they have no `/manager/*` nav.

**Staff roster (`manager/Staff.jsx`, "Staff" sub-tab) rows are not interactive** — clicking a
row used to expand a full per-person shift/cash-correction panel duplicating the "Shifts"
sub-tab (`ShiftsTab`, same file) exactly; removed as pure redundancy, not a capability loss —
`ShiftsTab` already has the full shift log, cash correction (`onAdjust`), close-shift and
review-acknowledge UI. The row's Hours/Shifts/Variance columns are still populated from the
same `shiftsByStaff` data (glance-only, no click needed).

**Reveal PIN requires re-entering your own password first**
(`pinRevealTarget`/`onConfirmPinReveal`), via `verifyAccountPassword()` — the same offline
PBKDF2 verifier the lock screen uses (`src/utils/unlockVerifier.js`), not a live Supabase
sign-in, so it still works offline. Only gated for `hasSupabase` — the local demo fallback
skips the check (nothing real to protect).

### Dashboard metrics: Sales performance / Payment & cash impact / Audit

All three dashboards a manager or supervisor lands on — `manager/Overview.jsx`
(network-wide), `manager/BranchDashboard.jsx` (one branch, always today), and
`Dashboard.jsx` (supervisor's `/` home, one branch, Today/Week/Month toggle) — show the
same three metric groups, built from the same formulas so the numbers can never quietly
disagree between screens:

- **Sales performance** (Gross sales, Net sales, Discounts, Refunds, Voided sales) — the
  same reduction `utils/terminalReports.js` uses for the X/Z reading: Gross = Σ(total +
  discount) over Paid, Net = Σ(total − refunded) over Paid, Discounts = Σ discount over
  Paid, Refunds = Σ refunded over Paid (partial refunds only), Voided = Σ total over
  Voided. Computed client-side from already-loaded transactions on BranchDashboard/
  Dashboard; on Overview, `api.branchSummary()` was extended to return these 5 fields
  alongside its existing `revenue/orders/lowStock`, using the same per-branch transactions
  query it already ran.
- **Payment & cash impact** (Cash sales, Card sales, E-wallet sales, Cash in/out, Expected
  cash) — always TODAY's business day regardless of any period toggle (a drawer is
  counted once a day; see "Day end & cash" above). `api.fetchBranchCashImpact(branchId,
  date, openHour)` is the single source for this — it composes `fetchPettyCashTimeline` +
  `fetchStaffShifts` + a small business-date-filtered transactions query, and returns the
  **exact same expected-cash formula** `SupervisorDayEnd` (`DayEnd.jsx`) uses for its own
  "Expected" line, so a dashboard tile can never disagree with the real Day End screen for
  the same branch/day. `cashSales`/`cardSales`/`ewalletSales` are all net of same-tender
  refunds (so the three sum to that day's net sales), but only `cashSales` feeds
  `expectedCash` — a card/e-wallet sale or refund never touches the physical drawer, so
  those two figures are informational only on this card. Overview sums this across every
  branch a manager can see (one call per branch, today). `Dashboard.jsx`/`Overview.jsx`
  also have a separate, period-scoped "Payment methods" ranking card (`SalesMixBar`,
  gross tender, % of period) further down the page — that one answers "how do customers
  pay over the selected period", this card answers "does today's drawer add up"; the two
  can legitimately show the same peso figure when the period is "Today" and there were no
  refunds, which is not a bug. `BranchDashboard.jsx` has no separate payment-methods card,
  so this is the only place its Card/E-wallet totals appear.
- **Audit** (void/refund counts, total value, a paginated recent list) — reuses
  `api.fetchSaleEvents({ branchId, start, end })`, the same source Reports →
  "Void / Refund Log" already reads. Rendered by `components/dashboard/AuditSummary.jsx`:
  2 totals + up to 5 rows per page with its own tiny Prev/Next pager (deliberately not the
  shared `Pager` — that one's sized for full tables). Rows are **not** clickable — at the
  size this list needs to be, a tap target is bad touchscreen UX (same reasoning
  `RevenueChart` uses full-height hit bands instead of a precise dot); a `title` tooltip
  carries who performed it, who approved it, and the full reason for anyone hovering on
  desktop. Both names are resolved via `resolve_staff_identities()` (see "Shifts & change
  fund" → RLS above), not a `staff(...)` embed — a supervisor needs to see a same-branch
  cashier's name here, and the embed silently blanks it. The "Open full log" link only renders when `canAccessModule(user,
  'manager_reports')` is true, since a default-permission supervisor does not have that
  module.

**Layout, all three pages:** the revenue chart (`RevenueChart`, now takes an optional
`height` prop — raised above its 220 default here to roughly match the height of the
3-card stack beside it) sits on the left; Sales performance, Payment & cash impact and
Audit stack in that order on the right, in a single `items-stretch` grid row. Top products / Top
categories / Payment methods sit in their own row below (all three rendered via
`SalesMixBar`, including on `Dashboard.jsx`, which used to hand-roll the Top products and
Payment methods lists — converted to `SalesMixBar` for visual consistency with Overview).
`manager/Overview.jsx`'s old "Revenue by branch" panel was removed outright (state, fetch
fallback and all) rather than just hidden, since it restated the hero KPI once a network
has only a couple of branches.

`components/dashboard/StatTiles.jsx` is the shared report-line renderer behind the Sales
performance and Payment & cash impact rows on all three pages — a real 2-row CSS grid (label row,
value row) rather than a flexbox of independently-sized boxes, so one item having an extra
hint line can't drag its neighbors' label/value out of alignment. The first entry in
`items` is the lead figure (rendered larger) — pass whichever number is most actionable
first (Net sales, not Gross; Expected cash, not Cash sales).

---

## Offline & sync (movement)

```
Online action → api.js → Supabase

Offline action → repository / enqueue(QUEUE_TYPES.*)
                 → IndexedDB
Online again → connectivity watcher → syncEngine
                 → replay queue → refresh stores → syncStore UI (Shell chip)
```

| Piece | File |
|-------|------|
| Public API | `src/offline/index.js` |
| IndexedDB | `src/offline/db.js` |
| Repo | `src/offline/repository.js` |
| Queue | `syncQueue.js`, `queueTypes.js` |
| Engine | `syncEngine.js` |
| Connectivity | `connectivity.js` |
| Shell status | `syncStore.js` |

**A queued op must be safe to run twice, because the queue WILL run it twice.** `pushQueue`
retries a failed item until it succeeds; if the server actually committed but the response
never made it back to the device (connection drops mid-round-trip, tab closes), the item stays
un-DONE and retries — now hitting a state where the op has already happened. Two real cases in
`VOID_SALE`:
- **The sale's own id.** `voidTransaction()` (`posStore.js`) queues whatever `id` the sale had
  on the device at void time — for a sale rung offline, that's still the client-generated
  `txn_...` placeholder, not a real uuid. `requireTransactionServerId()` (`syncEngine.js`,
  mirrors `requireShiftServerId`) resolves it via `client_id` once the sale's own
  `COMPLETE_SALE` has landed ahead of it in the FIFO queue.
- **Idempotency of the void itself.** A retried void hits `void_sale_secure`'s own guard —
  `raise exception 'Transaction already voided'` — which is correct behavior for a genuinely
  conflicting second void, but wrong for a retry of the SAME op that already landed: treated as
  an ordinary failure, it fails every retry forever and gets quarantined
  (`MAX_SYNC_ATTEMPTS` → BLOCKED → the red "records could not sync" banner) even though the
  desired end state was reached on attempt one. `isAlreadyVoidedError()` (`api.js`) recognizes
  this — and the trigger-level equivalent, `'voided transactions are locked'`, on the
  pre-`void_sale_secure` fallback path — and returns the current (already-voided) row instead
  of throwing. Same shape as `isDuplicateClientIdError()` just above it in `api.js`, for
  `COMPLETE_SALE`'s own retry-of-an-already-inserted-sale case.

---

## Realtime / live updates

Separate from the offline sync queue above — this is one-way, server → open tab, "something
changed, go refetch." It does **not** replace the queue/pull logic that reconciles IndexedDB
with Postgres while offline; it's for the case where the app is already online and a manager
edits something a cashier is currently looking at (price, promo, an approval request) and
that needs to show up **immediately**, not after the next 60s poll or page reload.

```
Postgres row changes (products, promo_events/rules, day_ends, cash_drawer_entries,
staff_shifts, …)
   │ (only if migrate_enable_realtime.sql has been run — see below)
   ▼
Supabase Realtime (postgres_changes), RLS-gated same as a normal SELECT
   │
   ▼
src/offline/realtime.js  subscribeTable / subscribeMany  →  debounce()  →  refetch
   ├─► useLiveData (src/hooks/useLiveData.js) — the layered wrapper pages should use
   │     ├─► POS.jsx: promo_events/promo_rules/promo_rule_products → reload activePromos
   │     ├─► POS.jsx: products/branch_inventory → useProductStore.mergeProducts
   │     └─► BranchDashboard.jsx: day_ends/cash_drawer_entries → reload() (branch + full
   │           bootstrap + petty timeline); staff_shifts (separately) → loadStaffShifts()
   └─► RequestNotifications.jsx: day_ends/cash_drawer_entries(+petty_cash)/promo_events
         (manager: unfiltered; supervisor: own branch only) → reload the approval-inbox badge
```

**`BranchDashboard.jsx` used to fetch everything once at mount and never again** — a day-end
close, cash-drawer entry, or shift clock-out from another terminal never reached an already-open
dashboard tab, so "Day-end closings", the cash drawer log, and the staff hours roster all looked
frozen until a manual page reload. Fixed with the two `useLiveData` calls above. `staff_shifts`
was not previously in the realtime publication — added alongside this fix (re-run
`migrate_enable_realtime.sql`). Even before that migration reaches a given deploy, the
visibility/focus and 5-minute poll layers still apply, so reopening or refocusing the tab picks
up the change.

**`Dashboard.jsx` (staff/supervisor `/` home) had the opposite problem — it re-fetched
everything on every visit, not never.** Its mount effect called `loadBranch()` unconditionally,
which internally does a blocking `syncBranch()` (a full `bootstrapBranchData` remote pull)
behind the full-page skeleton — even seconds after `App.jsx` or `Login.jsx` had already loaded
the same branch. Every trip back to Home re-ran the whole bootstrap query set for data that
hadn't gone stale. Fixed by only calling `loadBranch` when the store is genuinely empty
(`storeProducts.length === 0` — a real cold load, e.g. a hard refresh landing on `/`);
freshness afterward comes from the sale/shift flows' own background `syncBranch` calls and the
header's manual Refresh, the same as it already did before this fix, just without an
unnecessary extra full pull on every navigation.

**`useLiveData` is the front door — don't hand-roll a subscription in a page.** It layers four
independent freshness signals so no single failure leaves a tab stale, which is exactly what
kept happening before:

| Layer | Covers |
|---|---|
| realtime subscription | the fast path (sub-second) |
| `visibilitychange` / `focus` | events missed while the tab was hidden or the socket was dead — postgres_changes does **not** replay a gap |
| `online` event | network came back |
| interval poll (5 min default) | last resort when all of the above failed |

`subscribeTable` also watches the channel status callback: on `CHANNEL_ERROR` / `TIMED_OUT` /
`CLOSED` it rebuilds the channel with backoff (1s → 2s → 5s → 10s → 30s, capped), and a
successful `SUBSCRIBED` triggers one refetch — because whatever changed while we were
disconnected was never delivered. Status transitions log to the console in dev (`[realtime]`).

**Deploy staleness (`useAppVersion`, `/version.json`)**: a counter terminal can stay open for
days, so it keeps running the bundle it loaded — including bundles predating a fix someone is
testing. The service worker doesn't solve this (`skipWaiting` swaps assets on the *next*
navigation, which for a never-navigated SPA tab never comes). `versionJsonPlugin` in
`vite.config.js` emits `/version.json` per build; `src/hooks/useAppVersion.js` reads it on load,
then re-reads every 60s and on focus. A difference shows the "Update available" banner in
`Shell.jsx`. It auto-reloads **only** when nothing would be lost (empty cart, no pending sync
queue, no open logout prompt) — otherwise it waits for a tap, because reloading mid-sale would
throw away the cashier's cart.

**Required SQL migration:** `migrate_enable_realtime.sql` — adds the relevant tables to the
`supabase_realtime` publication. Safe to re-run; a table not yet in the publication just means
its channel silently never fires (not an error) — callers always do one immediate fetch on
mount regardless, so the feature degrades to "fresh on load, no live push" rather than failing.

**Fallback intervals still exist** (POS promos: 5 min, notifications: 5 min) purely as a safety
net in case a realtime subscription silently drops — they are not the primary update path
anymore, so don't be alarmed that they're slower than before; realtime is what's actually
carrying live updates now.

**Why debounced, not per-row:** a manager adding a promo plus several rules fires several
inserts in a row — `debounce()` (400ms) coalesces that burst into one trailing refetch instead
of one per row change.

| Piece | File |
|-------|------|
| Subscribe/backoff/debounce helpers | `src/offline/realtime.js` |
| Layered freshness hook (use this) | `src/hooks/useLiveData.js` |
| Deploy-staleness watchdog | `src/hooks/useAppVersion.js` + `versionJsonPlugin` in `vite.config.js` |
| Update banner | `src/components/shared/Shell.jsx` |
| Products live refresh | `src/lib/api.js` `fetchBranchProducts()`, `useProductStore.mergeProducts` (`src/stores/posStore.js`) |
| Wiring | `src/pages/POS.jsx`, `src/components/shared/RequestNotifications.jsx` |
| Schema | `supabase/migrate_enable_realtime.sql` |

---

## Shared utilities

| Need | File |
|------|------|
| Money, qty, business date, stockTone | `src/utils/format.js` |
| Which DB this build targets (env badge) | `src/utils/environment.js` |
| Support error codes | `src/utils/errors.js` |
| Sanitize / duplicate product checks | `src/utils/validate.js` |
| Ulam / menu kinds | `src/utils/ulam.js` |
| Dashboard charts | `src/components/dashboard/*` |

---

## Database (Supabase)

| Topic | File |
|-------|------|
| Base schema | `supabase/schema.sql` |
| PIN, payments, roles, petty, shifts | `migrate_staff_pin_payments_roles_finance.sql` |
| Per-shift change fund, drawer exclusivity, shift adjustments | `migrate_shift_cash_accountability.sql` |
| Unique login codes | `migrate_staff_login_code_unique.sql` |
| PIN auth fix | `migrate_fix_pin_login_auth.sql` |
| BIR / sale immutability | `migrate_bir_pos_compliance.sql` |
| Refunds | `migrate_refund_sale_items.sql`, `migrate_refund_amount_on_transactions.sql` |
| Import batches (managers + branch staff write) | `migrate_import_batches.sql`, `migrate_import_batches_branch_staff.sql` |
| Ulam / restaurant | `migrate_ulam_ordering.sql` |
| Devices / presence | `migrate_device_settings.sql`, `migrate_branch_presence.sql` |
| Petty cash rename | `migrate_rename_petty_cash_to_cash_drawer_entries.sql` |
| Manager cross-branch approve | `migrate_manager_can_approve_any_branch.sql` |
| PIN lockout hardening | `migrate_pin_security_hardening.sql` |
| Per-line discount tracking | `migrate_discountable_transaction_items.sql` |
| Hot-table perf indexes | `migrate_perf_indexes_hot_tables.sql` (run each `CREATE INDEX CONCURRENTLY` statement individually — cannot run inside a transaction block) |
| Multiple concurrent promos + per-line attribution | `migrate_promo_multi_active.sql`, `migrate_promo_line_attribution.sql` |
| Promo auto-expire | `migrate_promo_auto_expire.sql` |
| VAT breakdown (BIR) | `migrate_vat_breakdown.sql` |
| Realtime (live POS/notification updates) | `migrate_enable_realtime.sql` |
| Company TIN + per-branch BIR branch code | `migrate_company_tin.sql` |
| Petty cash `fulfilled` state (+ rewrites `close_staff_shift`/`shift_cash_summary`) | `migrate_petty_cash_fulfilment.sql` |
| Master force sign-out of a stuck session | `migrate_admin_session_release.sql` |

Run migrations in the Supabase SQL editor; respect comments about order / dependencies.

**RLS pattern:** branch staff → `current_staff_branch()`; managers → `is_manager()` across branches.

**`staff` stores `login_pin` and `auth_secret` in PLAINTEXT.** RLS is row-level, not
column-level, so any policy letting a role SELECT a staff row lets it read that row's PIN.
That is why supervisors read the roster through `branch_staff_roster()`
(`migrate_branch_staff_roster.sql`) — a definer function with an explicit safe column list —
rather than a widened `read staff` policy. Never "simplify" it into a policy change, and
never add a secret column to that function's select list.

### Environments (dev vs production)

`src/utils/environment.js` reads `VITE_APP_ENV` and derives the Supabase project ref from
`VITE_SUPABASE_URL`. Anything not `production` renders a badge in `Shell.jsx` and
`Login.jsx` naming the database actually being written to. An unset value resolves to
`development` — the dangerous case must never be the quiet default. Setup instructions:
`pos-frontend/README.md` → *Environments*.

---

## “I want to change…” cheat sheet

| Goal | Open first |
|------|------------|
| Cart UI / tender / checkout | `Cart.jsx` |
| POS search / tiles / inquiry | `POS.jsx` |
| Add / import products | `manager/Data.jsx` (+ `/data` for supervisor) |
| Inventory stock adjust | `Products.jsx` |
| Who lands where after login | `nav.js` `staffHomePath`, `Login.jsx` |
| Who can open a page | `roles.js` + `App.jsx` gates |
| Sidebar links | `nav.js` + `Shell.jsx` |
| Refund totals | `TransactionDetailModal.jsx` + refund migrations |
| Day-end cash | `DayEnd.jsx` (two views — check which role you mean) |
| Petty cash workflow | `components/dayend/PettyCashPanel.jsx` |
| Staff roster / shift log / hours | `manager/Staff.jsx` (merged tab) |
| TIN on receipts / reports | `api.composeTin` + `fetchBranches` `full_tin` |
| Stuck "already signed in" | `api.fetchActiveSessions` / `forceReleaseStaffSession` |
| Receipt layout | `receipt.js` |
| New report | `manager/Reports.jsx` |
| New table/RPC | `supabase/migrate_*.sql` + `api.js` |

---

## Roles → typical surfaces

| Role | Login | Main areas |
|------|-------|------------|
| Cashier | PIN | POS, Transactions, Inventory (view/adjust), Day end, Devices |
| Supervisor | PIN | Same + Shifts (branch) + **Products `/data`** (add/import) |
| Manager / Admin | Email | Overview, Branches, Staff, Shifts (all), Data, Reports |
| Master | Email | Manager + staff routes combined |

---

Product name in UI/docs: **CalePOS**.

---
## Feature → file map (fast “what to edit”)

### Barcode scanner mode (retail, non-restaurant)
- **Enabled/disabled flag:** `src/pages/POS.jsx` → `barcodeOn` / `barcodeTableMode`
- **Search/scan UI:** `src/pages/POS.jsx`
  - `searchPopupOpen` state
  - `ITEM SEARCH` modal (`barcodeTableMode && searchPopupOpen`)
  - Results table is driven by `visible` (matches name/SKU/barcode/productCode)
- **Inquiry toggle:** `src/pages/POS.jsx` → `inquiryMode` + button in the `ITEM SEARCH` modal
- **Cart layout in barcode mode:** `src/components/pos/Cart.jsx`
  - `Cart` receives `barcodeMode={barcodeTableMode}`
  - `barcodeMode ? (...) : (...)` section is the barcode-specific “cart lines (left) + sale summary rail (right)”

### Stock movement ledger — two views of one table

`stock_movements` is surfaced in two places, and they are deliberately kept identical in
look and column vocabulary (`Date · Type · Change · Balance`) so they do not read as two
different reports:

| View | File | Scope |
|---|---|---|
| Inventory → Movement history tab | `src/components/inventory/MovementHistoryPanel.jsx` | every product, filterable, adds Product + By/note columns and a time alongside the date |
| Product detail drawer | `src/pages/Products.jsx` | one product |

Shared conventions: quantities carry their unit (`+4.00 pc`, `−1.00 kg`), `Balance` is the
only bold figure in the row and turns red when negative, and a `price_change` row shows
`₱old → ₱new` under Change with `—` under Balance — it moved money, not stock. Change either
view and change the other.

`stock_movements.reference` is an internal key, not display text: a sale writes the
**transaction id**, a bulk import writes the **batch id**, other types write a word
(`initial`, `edit`, the adjustment action). `fetchStockMovements` resolves sale ids to
`OR <number>` in one chunked lookup and blanks any other bare UUID before the row reaches
the UI — never render `reference` raw.

### Discountable indicators (where you can see “Discountable: Yes/No”)
- **Barcode search results table:** `src/pages/POS.jsx` → `ITEM SEARCH` modal table
- **Manager/supervisor product catalog list:** `src/pages/manager/Data.jsx` → product row in the catalog table (`pageRows.map`)
- **Product movement history sidebar (staff Inventory / Products):** `src/pages/Products.jsx`
  - product detail drawer header shows “Discountable”
- **Product movement history sidebar (manager BranchDashboard):** `src/pages/manager/BranchDashboard.jsx`
  - `selectedProduct` drawer header shows “Discountable”

### Discount tracking (persistent, per-line)
- **Eligibility source on products:** `products.discount_eligible` (mapped in `src/lib/api.js` → `discountEligible`)
- **Line-level persistence (per receipt/report):**
  - Migration: `supabase/migrate_discountable_transaction_items.sql`
  - Schema: `supabase/schema.sql` (`transaction_items.discount_eligible`, `transaction_items.discount_amount`)
- **How the backend is written during sale:**
  - Queue payload adds per-item `discountEligible` + `discountAmount`: `src/stores/posStore.js` (inside `enqueue(QUEUE_TYPES.COMPLETE_SALE, ...)`)
  - Supabase insert includes new columns: `src/lib/api.js` → `completeSale()` → `transaction_items.insert(lines)`
- **How it is read back:**
  - `src/lib/api.js` → `fetchTransactionDetail()` selects `discount_eligible`/`discount_amount` and maps them to `lines[]`
- **Receipt display:**
  - `src/utils/receipt.js` → `receiptToHtml()` shows a per-line “Discount -₱X.XX” note when `line.discountAmount > 0`

### Manager Promo events (item/pair/bundle/BOGO)
- **Manager tab UI:** `src/pages/manager/Promos.jsx` (create event + create rules)
  - Managers must select a branch first; promos never apply to all branches
  - Supervisors are locked to their assigned branch (UI + RLS)
  - Several promos can be live on one branch at once — see **Multiple concurrent promos** below;
    this is the current behavior, not the old single-active-promo model.
- **Active promo fetch in POS:** `src/pages/POS.jsx`
  - `useEffect` calls `fetchActivePromoEventsWithRules(branchId)` (plural — returns **all** live
    events); `fetchActivePromoEventWithRules` (singular) still exists only as a back-compat
    wrapper around the first result.
  - `Cart` receives `promoRules` (flattened across all live events, each tagged `eventName`) —
    it no longer takes a single `promoLabel` prop; it derives its own label from
    `computePromoDiscounts`' `appliedEventNames`.
  - Ended promos self-heal via `expireEndedPromos()` (calls RPC `expire_ended_promos`) run at the
    top of the promo fetch — no cron needed, see **Promo auto-expire** below.
- **Promo discount engine:** `src/components/pos/Cart.jsx`
  - `pricing = useMemo(...)`
  - applies promo discounts only when PWD/Senior is *not* selected
  - highest discount per line wins across all live rules/events — offers never stack on one line
- **kg items excluded from pair/bundle/BOGO rule creation.** `computePromoDiscounts` already
  zeroed weighed (kg, meat-counter) lines out of `pair_pct`/`bundle_pct`/`bogo_pct` at checkout
  (`item_pct` still applies to kg lines). `Promos.jsx`'s rule-creation product pickers now filter
  those three rule types down to `pricingMode !== 'kg'` products too (`eligibleProducts`), so a
  manager can no longer build a rule that would silently never apply.
- **Duplicate-rule guard.** `onAddRule` blocks adding a product to a new rule if it's already
  covered by another rule on the same event (same-event only, not cross-event).
- **Pending promo requests.** `workingEvent` only ever surfaces the first pending row it finds
  per branch. A "Pending promo requests" card (branch-scoped) and the network-wide "All
  branches — promo history" table (shown when no branch is selected, `fetchPromoEventsAcrossBranches`
  in `api.js`) both list every pending row with inline Approve/Reject, so a second supervisor's
  submission isn't invisible until someone opens Promo History.
- **Pair/bundle partner indicator.** `buildPromoByProductId` (`utils/promo.js`) now also carries
  `partners` (the other product(s) on that rule); `promoPartnerLabel()` renders "w/ X" (pair) or
  "+N items" (bundle, full list in the `title` tooltip) under the promo badge on POS tiles.
- **Bundle rule name — distinct from the promo event's name.** An event can hold several
  rules at once, including more than one bundle, so "the event is named X" doesn't say which
  specific set of products makes up which bundle. `promo_rules.bundle_name`
  (`migrate_promo_rule_bundle_name.sql`, nullable, only meaningful for `rule_type =
  'bundle_pct'`) gives one bundle its own label (e.g. "Meryenda Bundle"), set on creation in
  `Promos.jsx` (required to add the rule) — there is no edit-after-creation path, same
  boundary every other rule field already has (delete + recreate). `createPromoRule`,
  `fetchPromoRulesForEvent`/`loadPromoRulesForEvent` (`api.js`) all carry `bundleName`
  through, with the usual missing-column fallback for a pre-migration DB.
- **`promoDisplayName(info)`** (`utils/promo.js`) — the label next to a promo badge: a
  bundle's own name when it has one, the promo event's name otherwise. Used by every POS
  tile render site instead of reading `eventName` directly.
- **POS bundle quick-add buttons.** `collectPromoBundles(promoRules)` (`utils/promo.js`)
  reshapes every named `bundle_pct` rule into `{ ruleId, bundleName, discountPct, products }`
  — one entry per rule (a rule already IS one complete bundle, no cross-rule grouping
  needed). `POS.jsx` renders one button per bundle above the product grid (`activeBundles`,
  hidden in barcode-scan mode and restaurant menu-setup mode); tapping it calls `select()`
  — the same per-tile add-to-cart path, same stock/till/inquiry guards — once per product in
  the bundle, so a cashier adds a whole bundle in one tap instead of finding each item.
- **Bundle name in the Cart breakdown is display-only, never persisted.**
  `computePromoDiscounts` (`utils/promo.js`) returns TWO parallel per-line arrays:
  `linePromoNames` (the promo EVENT's name — unchanged, still what `Cart.jsx` tags onto
  `transaction_items.promo_name` for the checkout/save payload) and `lineBundleNames` (the
  bundle's own name, new, read only by `Cart.jsx`'s on-screen line tag / checkout breakdown).
  Do not let a bundle's name leak into the persisted value — `fetchPromoSalesStats`
  (`migrate_promo_line_attribution.sql`) matches `transaction_items.promo_name` against the
  promo EVENT's name; a bundle name there would silently zero out that event's sales stats
  for every one of its bundle's receipts.
- **Reject reason.** `reject_promo_event(p_promo_event_id, p_staff_id, p_reason)` — 3-arg RPC as
  of `migrate_promo_reject_reason.sql` (adds `promo_events.reject_reason`, required, mirrors the
  `stop_reason` pattern). `rejectPromoEvent()` in `api.js` takes a `reason`; `Promos.jsx` opens a
  reason modal (`rejectTarget`/`rejectReason`) instead of rejecting immediately. Only covers
  reject-create (denying a pending new promo) — `reject_stop_promo` (declining a stop request)
  is unchanged.
- **Create from the network view.** The branch-scoped "New promo event" form (Live promos card)
  isn't the only way to create one — the network view (no branch chosen) has its own "Create a
  promo" card with a branch `<SelectField>` (since that view has no implicit branch), submitting
  via `onCreateEventNetwork` → `createAndActivatePromoEvent({ branchId: networkCreateBranchId, ... })`
  directly, then refreshing `networkActive`/`networkHistory` in place — it does **not** navigate
  into the branch. Both forms share `validateNewPromoDates()` (today-or-future start, end after
  start) and the `eventName`/`eventDescription`/`startsAt`/`endsAt` state (safe: the two forms
  are never mounted at once, gated by the same `branchId` ternary).
- **Page order:** branch selector → network "Create a promo" + "Active promos" + "All branches —
  promo history" (no branch chosen) → pending requests → Live promos/create → pending draft card
  → Rules → Add promo rule → Promo history (bottom, per-branch).

---

## Backlog for external AI (Gemini / ChatGPT)

### Important: nothing in this whole multi-session conversation has been committed
`git log` stops at `b9b8629 Fixed bugs in manager approval` — every fix described in this
file (multi-promo, VAT, realtime, the Discountable cascade, the Cart live-eligibility check,
the `updateProductRow` guard, this session's product-refresh fallback + Promo-sales-panel
removal) is **still only sitting uncommitted in the working tree**. If PWD/Senior "still isn't
enabling" was tested against a deployed build or a since-restarted dev server, that build
predates all of it. **Before doing further root-cause work on the discount bug, confirm the
user is testing against this actual working tree** (`npm run dev` freshly started here, or a
build/deploy made *after* these changes) — otherwise every fix below will keep looking broken
no matter how correct the code is.

### ROOT-CAUSED #2: PostgREST silently truncated product reads at 1000 rows
`bootstrapBranchData`, `fetchBranchProducts`, and `fetchCatalogProducts` had no `.range()`
pagination. Supabase's `db-max-rows` (1000 by default) caps the response **and returns no
error** — so any branch past 1000 products silently lost everything after the 1000th by
name. Those products never reached `useProductStore`, so `Cart.jsx`'s eligibility lookup
(`productById.get(item.id)`) missed them and fell back to the stale flag frozen on the cart
line at add-time. Net effect: a product reads "Discountable: Yes" in the catalog and still
refuses PWD/Senior at the counter. Same cap explains items missing from Manager → Data.

Fixed with `fetchAllRows(build)` in `api.js` — pages via `.range()` until a short page comes
back. **Any new query that can return an unbounded set must use it**; a bare `.select()` is
a silent truncation waiting to happen.

Also fixed in `writeProductRow`: the missing-column fallback deleted `unit_cost` and
`discount_eligible` **as a pair**, so a schema missing `unit_cost` stripped the discount flag
from every product write while still reporting success. Each column is now dropped only when
the server actually names it.

`Cart.jsx` `pricing.eligibilityDebug` explains per line why PWD/Senior can't apply —
`not in this branch's catalog — re-sync` (a sync/data problem) vs `not marked discountable`
(a flag problem). These are completely different failures and guessing between them has
cost real debugging time.

### ROOT-CAUSED #1: Discountable not reaching POS (`products.catalog_product_id` was NULL)
The cascade matched on `products.catalog_product_id`, but that column was only ever written
in **one** place — `createProduct`'s best-effort mirror into `catalog_products` — and that
path has two holes:

1. Writing `catalog_products` requires `is_manager()`. A **supervisor** adding a product hits
   RLS, the insert fails inside a `try/catch` that only `console.warn`s, and the row is left
   with a NULL link.
2. **The bulk importer never set the column at all**, so every imported product has a NULL link.

Products *adopted* from the catalog were fine (`adopt_catalog_products` sets it), which is
exactly why some products discounted correctly and others never did. Fixed three ways:
- `cascadeDiscountEligibleToBranches(catalogProductId, eligible, sku)` now takes the SKU and
  runs a second pass over `catalog_product_id is null` rows matched by SKU
  (`.ilike`, case-insensitive), **backfilling the link** as it goes so each row needs the
  fallback only once.
- `migrate_backfill_catalog_links.sql` — creates missing catalog rows, links every unlinked
  product by SKU, and adds a `before insert or update of sku` trigger so the link can never
  go missing again regardless of code path or role. Reports what's still unlinked.
- Bulk multi-select in `ManagerNetworkCatalog` for setting Discountable on many items at once.

### DONE in this pass (do not re-implement)
- **Layered live-update system** — `useLiveData` hook + hardened `subscribeTable` (status
  callback, exponential-backoff resubscribe, refetch-on-reconnect) + `useAppVersion` deploy
  watchdog with `/version.json`. See the "Realtime / live updates" section above.
- **One-discount SC/PWD + VAT model** — promo now sets the base instead of being discarded
  when SC/PWD is applied; full per-line audit trail in checkout. See "VAT + SC/PWD" above.
- **Promo rename** — `manager/Promos.jsx` Rename action (live-promo row + history row) via
  `updatePromoEventDetails({ promoEventId, name })`. That function is now a true partial
  update: fields are written only when explicitly passed (`undefined` = leave alone, `null`
  = clear). Before this, a rename-only call would have nulled `starts_at`/`ends_at` and
  silently un-scheduled a live promo. Renaming does **not** rewrite past
  `transaction_items.promo_name`, so historical sales stay attributed to the old name.
- **Live-promo header** — dropped the redundant "Active" badge (everything in that dropdown
  is live, and the option label already says Active vs Stop pending); Stop / Approve stop /
  Rename now sit right-aligned on the selector row instead of stacked underneath.
- **Promo indicator on POS tiles** — turned out to already be fully built (red border/background,
  "PROMO" badge, event name, strikethrough original price), not missing as an earlier note here
  claimed. That earlier claim was wrong (written from a stale summary, not verified against the
  code) — don't trust old backlog notes without checking the file first.
- **Removed the redundant "Promo sales" card** from `manager/Promos.jsx`'s live-promo column —
  it duplicated Promo History's per-row "Sales" action (`openPromoTracking` → `trackingEvent`
  modal, same receipt/discount/net-sales numbers). Deleted the card, its `promoStats`/
  `promoStatsBusy` state, and the effect that populated it; the page's promo-management column
  is now full width instead of a 2-col grid with one empty side.
- **Product live-refresh fallback poll** — `POS.jsx`'s products/branch_inventory realtime effect
  had no polling fallback (unlike the promo effect's 5-min safety net), so a tab open before
  `migrate_enable_realtime.sql` is applied (or one that silently drops its channel) would never
  pick up a manager's edit without a manual reload. Added the same 5-min `setInterval` fallback.

### DONE in recent pass (do not re-implement)
- Module access: explicit `permissions[]` wins; routes gated by `RequireModule` only; Staff shows **Custom access** vs **Default access**.
- Manager cover for supervisor approvals: `SupervisorApprove` has **Approve as manager** when signed-in role is manager/admin/master; SQL `migrate_manager_can_approve_any_branch.sql` lets manager PIN work cross-branch.
- Sidebar **Refresh** button → `window.location.reload()`.
- **Multiple concurrent promos** — several promo events can now be live (active/stop_pending) on one branch at once. See below.
- **Discountable cascade from network catalog** — toggling Discountable on `/manager/data` now also flips `discount_eligible` on every already-adopted branch product (`api.cascadeDiscountEligibleToBranches`), not just the template default. See "Products / inventory / import" section above.
- **Catalog identity/price cascade** — saving name/SKU/barcode/category/price/budgetPrice on `/manager/data` now also pushes to every already-adopted branch product (`api.cascadeCatalogFieldsToBranches`), same reach as the Discountable cascade, instead of only setting the default for future adoptions. A price change is logged per branch via `recordPriceChange`, so the Price Change Register and Price Listing report pick it up. `migrate_sync_catalog_identity_fields.sql` catches up edits made before this existed (price intentionally excluded — see file header). See "Products / inventory / import" section above.
- **Bulk import price-change logging** — `commitInventoryImport`'s update-existing-row branch now calls `recordPriceChange` when the imported price differs from the row's price before the import, matching every other price-editing path. Previously an import could change a product's price with nothing recorded in the Price Change Register.
- **Fiscal report "today" timezone fix** — `fetchFiscalTransactions` (feeds the SC/PWD Register, Discount Report, Electronic Journal, BIR Daily Breakdown, and Tender Summary) filtered `created_at` with a bare `${start}T00:00:00` string, read in the DB session's UTC zone instead of Manila — the same class of bug already documented and fixed for `fetchStaffShifts`/`branchSummary` elsewhere in this file. Sales rung before ~8AM local were filed under the previous day and dropped from "today". Fixed by converting the local day boundary to a real ISO instant before querying.
- **Promo auto-expire** — a promo past its `ends_at` ends itself, no manager action needed. Three layers, because the DB one alone silently did nothing when its migration wasn't applied:
  1. **Display truth (always correct, zero dependencies):** `promoHasEnded()` / `promoEffectiveStatus()` in `api.js` derive status from the timestamp. Promo History shows `stopped · Promo ended`, and Delete unlocks, the moment the end time passes.
  2. **Never live:** `fetchActivePromoEventsWithRules` filters ended events out of the live list **regardless of `respectDuration`**. This was the actual bug — `manager/Promos.jsx` passes `respectDuration: false` (so rules can be built on a not-yet-started promo), which was also resurrecting *finished* ones into the Active dropdown. `respectDuration` governs the not-started case only; ended is unconditional.
  3. **Durable DB sweep:** `expireEndedPromos()` calls RPC `expire_ended_promos()` (`migrate_promo_auto_expire.sql`); if that function isn't deployed it falls back to a direct `UPDATE` on `promo_events` (managers/supervisors have RLS write on their branch — cashiers get denied, which is fine since layers 1–2 already cover them). Runs at the top of `fetchActivePromoEventsWithRules`, `fetchActivePromosAcrossBranches`, and `fetchPromoEventsForBranch`.
- **`datetime-local` timezone fix** (`manager/Promos.jsx` `localDateTimeValue`) — promo start/end fields were formatted with `toISOString().slice(0,16)`, which is **UTC**: a Manila manager saw and saved times 8 hours off. Now built from local getters. New promos also default `starts_at` to now (fills a blank field only — never overwrites a typed value).
- **Edit dates on an already-active promo** — `manager/Promos.jsx` Promo History "Modify" button used to be hidden for `active`/`stop_pending` rows; now shown for all statuses (only edits `starts_at`/`ends_at` via `updatePromoEventDetails`, never touches approval state, so no new dual-control needed). Delete stays restricted to non-live statuses.
- **Promo description** — `promo_events.description` (`migrate_promo_description.sql`, nullable text). Set on create (optional textarea next to Name) or afterwards via Promo History's row menu → **Edit description**, both through the same partial-update `updatePromoEventDetails`/insert path as name/dates — a description-only edit never touches schedule or approval state. Shown under the promo's name in Promo History; not read by the discount engine, not shown to customers. `createAndActivatePromoEvent` and `fetchPromoEventsForBranch` fall back to omitting the column if the migration isn't applied yet (same `isMissingColumnError` pattern as other optional columns in this file).
- **Promo History date filter** — From/To `<input type="date">` above the history table, filtering client-side on `starts_at`'s date (not `created_at` — a manager picking a range means "promos that ran then", not "rows I made then"). Pure UI filter on the already-fetched `history` array; no new query.
- **Promo History actions collapsed into a "⋯" menu** — the row used to lay out 4-8 inline text buttons (Sales, Approve/Reject, Approve/Reject stop, Modify, Rename, Edit description, Delete) side by side; same actions now live in a per-row dropdown (`openActionsId` state, closed by a full-screen click-away `div`). No action's behavior changed, only where it lives. The dropdown itself renders through a `createPortal(..., document.body)` with `position: fixed` computed from the trigger button's `getBoundingClientRect()` (`actionsAnchor` state) rather than `position: absolute` inside the row — the table's own scroll wrapper needs `overflow-x-auto` for wide screens, and per the CSS overflow spec, `overflow-x: auto` with `overflow-y: visible` still computes `overflow-y` to `auto` (clipping), not `visible`. An absolutely-positioned dropdown there was silently clipped to invisible for rows near the wrapper's edge — same root cause if a future popover in a horizontally-scrolling table goes invisible with no console error.
- **Stop reason was already implemented** — a reason is required when requesting or executing a stop (`request_stop_promo` RPC, `stop_reason` column) and already rendered in Promo History under the status badge. This predates the description/date-filter work above; don't re-add it.

### Multiple concurrent promos (DONE)
**Required SQL migration:** run `pos-frontend/supabase/migrate_promo_multi_active.sql` (drops the one-live-promo-per-branch unique index and stops `approve_promo_event()` from deactivating sibling promos).

- **SQL/RPC:** `migrate_promo_multi_active.sql` — no more single-active constraint or forced deactivation on approve.
- **API** (`src/lib/api.js`): `fetchActivePromoEventsWithRules(branchId, opts)` returns **all** live events for a branch as `[{ event, rules }]`. `fetchActivePromoEventWithRules(branchId, opts)` is kept as a back-compat wrapper returning just the first one.
- **Conflict policy** (`src/utils/promo.js` `computePromoDiscounts`): each rule computes its own line-discount contribution in isolation, then the **highest discount per line wins** across all rules/events — offers never stack on one line. The function also returns `linePromoNames` (which event won each line) and `appliedEventNames` (distinct event names actually applied) for attribution.
- **POS** (`src/pages/POS.jsx`): `activePromos` (array) replaces the old single `activePromo`. Rules from every live event are flattened into one `promoRules` list, each tagged with its own `eventName`, then merged via `buildPromoByProductId` (best % per product wins) for tile pricing/badges.
- **Cart** (`src/components/pos/Cart.jsx`): no longer takes a single `promoLabel` prop — it derives the discount label itself from `computePromoDiscounts`' `appliedEventNames` (joined, e.g. "Valentines + Payday Sale"), and per-line breakdown rows show the actual promo that won that line via `linePromoNames`.
- **Promos UI** (`src/pages/manager/Promos.jsx`): `activeEvents` (array, was `active` singular) renders one card per live promo with its own Stop/Approve-stop controls. `managingId` + `managedEvent` track which live event's rules/sales-stats panel is currently shown ("Manage rules" button per card); a fresh pending draft (`workingEvent`) always takes priority for rule-building over an already-live event, so creating promo B while promo A is still live doesn't block adding rules to B.

**Mixed-cart reporting fix:** `transactions.discount_type` is still a single text column (joined label like "Promo A + Promo B" when a cart mixes promos) — exact-matching that per promo would undercount mixed carts. Fixed via **per-line attribution**: `migrate_promo_line_attribution.sql` adds `transaction_items.promo_name` (which promo won that specific line, null for PWD/Senior/undiscounted). `src/lib/api.js` `fetchPromoSalesStats` now attributes by that column (prefilters candidate receipts by branch/date/`discount_amount > 0`, then matches lines by `promo_name = promoName`) instead of matching the whole transaction's `discount_type`. `fetchPromoSalesStatsLegacy` (same file) is the pre-migration fallback and is used automatically if the `promo_name` column doesn't exist yet.
- **Cart** (`Cart.jsx`): tags each checkout line with `promoName` (from `computePromoDiscounts`' `linePromoNames`) before calling `addTransaction`.
- **Store** (`posStore.js` `addTransaction`): passes `promoName` through to the `QUEUE_TYPES.COMPLETE_SALE` payload.
- **API** (`api.js` `completeSale`): writes `transaction_items.promo_name`; falls back to omitting the column (like the existing `price_tier` fallback) on old schemas.

---
## Block-level navigation hints (useful for future AI/code-review)

### `src/pages/POS.jsx` blocks
- **Product matching logic:** `visible = sellable.filter(...)`
  - In scanner mode: if `barcodeTableMode && !search.trim()` then results are hidden (prevents random table spam).
- **Barcode search popup:** `barcodeTableMode && searchPopupOpen`
  - Contains `SearchBox`
  - On `Enter`, uses exact match on `sku`, `barcode`, or `productCode`, then calls `select()`
  - Table rows include the “Discountable” label.

### `src/components/pos/Cart.jsx` blocks
- **Checkout overlay:** `checkoutOpen && <Modal ...>` (payment / tendered / confirm)
- **Approval overlays:** `paying && <StatusOverlay ...>` + `removeIndex != null && <SupervisorApprove ...>`
- **Barcode mode layout:**
  - `barcodeMode ? (...) : (...)`
  - Inside barcode mode:
    - **Left rail:** scrollable cart item list + per-line discount notes
    - **Right rail:** subtotal/discount/VAT/total + `Checkout` button
