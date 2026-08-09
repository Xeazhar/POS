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
| `/inventory` | `src/pages/Products.jsx` | staff inventory/menu operations — tabs: stock + **Movement history** |
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
edits `catalog_products` via `api.updateCatalogProduct` — this only changes the default a
*future* adoption gets, never an already-adopted branch product. To change something on a
branch's already-adopted item (price, stock, **discount eligibility**), use that branch's own
page: `Products.jsx` (manager/supervisor edit form) or `manager/Data.jsx` in supervisor mode
(`SupervisorCatalogAdopt`, inline "Discountable" toggle) — both call `api.updateProductRow`
against `products`. Mixing these up is exactly how "I turned on Discountable but PWD/Senior
still won't apply" happens — the product's `discount_eligible` never actually changed on the
branch's real row. `updateProductRow` only includes `discount_eligible` in its update payload
when the caller explicitly passes it, so a partial edit (e.g. stock-only) never silently clears
it — keep that guard if you add more optional fields to that function.

**Exception — Discountable cascades from the network catalog too:** managers' actual workflow
for this specific toggle is the `/manager/data` network catalog page (`ManagerNetworkCatalog`),
not the branch-level pages above. Its "Discountable" save (`saveDiscount()`) calls
`api.cascadeDiscountEligibleToBranches(catalogProductId, discountEligible)`, which updates
`discount_eligible` on every already-adopted `products` row matched via
`products.catalog_product_id` — so unlike every other catalog field (price, name, etc., which
stay template-only / future-adoption-only), Discountable *does* propagate immediately to live
branch products from that page. **Still reportedly not enabling PWD/Senior in the cart even
after this fix** — see Backlog below, not yet root-caused.

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

The unit of cash accountability is the SHIFT, not the day: one branch, one drawer, several
cashiers a day, and a shortage has to point at whoever was holding the cash.

```
Start shift  → count change fund → useShiftStore.startShift
               → local Dexie `shifts` row (clientId) + enqueue OPEN_SHIFT
               → open_staff_shift() RPC → staff_shifts row (serverId)

Selling      → posStore.addTransaction stamps shiftClientId / shiftId
               → syncEngine swaps clientId for serverId on push
               → transactions.shift_id

Cash out     → ShiftCashOut → shift_cash_summary() for expected
               → enqueue CLOSE_SHIFT → close_staff_shift() computes
                 expected + variance server-side, sets clock_out

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
| `start` | no shift here | count the change fund |
| `busy` | another cashier holds this drawer | they cash out, or supervisor closes it |
| `moved` | this cashier is open on another till | cash out there, or supervisor override |

| Piece | File |
|-------|------|
| Store | `src/stores/shiftStore.js` |
| Gate UI | `src/components/shared/ShiftGate.jsx` |
| Cash-out UI | `src/components/shared/ShiftCashOut.jsx` |
| Log / adjustments UI | `src/pages/Shifts.jsx` |
| Drawer identity | `src/utils/drawer.js` |
| Local store | `src/offline/shifts.js` (Dexie `shifts`, v2) |
| Queue ops | `OPEN_SHIFT`, `CLOSE_SHIFT` in `queueTypes.js` / `syncEngine.js` |
| API | `api.js` → `openShift`, `closeShift`, `fetchOpenShift`, `fetchOpenShiftOnDrawer`, `fetchLastClosedShiftOnDrawer`, `fetchShiftCashSummary`, `adjustShiftCash`, `fetchShiftAdjustments`, `fetchStaffShifts` |
| Tables | `staff_shifts` (+ cash columns), `shift_adjustments`, `transactions.shift_id` |
| Migration | `migrate_shift_cash_accountability.sql` |

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

---

## Transactions, voids, refunds (movement)

```
Sale completes → transactions + transaction_items
Staff Transactions.jsx / Manager BranchDashboard
   → TransactionDetailModal
        ├─ void → voidTransaction / RPC
        └─ refund lines → refundSaleItems
              → updates refunded_amount (guard allows only that field on completed sales)
```

| Piece | File |
|-------|------|
| Staff list | `src/pages/Transactions.jsx` |
| Detail modal | `src/components/transactions/TransactionDetailModal.jsx` |
| Mapping helpers | `src/utils/transactionDetail.js` |
| API | `fetchTransactionDetail`, `fetchRefundSummary`, `refundSaleItems` |
| Store | `voidTransaction`, `refundTransactionItems` |
| SQL | `migrate_refund_sale_items.sql`, `migrate_refund_amount_on_transactions.sql` |

**Never show a refunded sale as one already-netted number.** `total − refunded` next to a
"−₱150" reads as if the refund is about to come off a second time. List rows and the detail
modal show the **original total** and the **refunded amount** as two labelled figures.
`netTotal` is still the right thing for aggregates — just not as a row's headline figure.

### Who approved it (approval attribution)

Approver ids were always persisted; what was missing was the **role** and the display.

| Action | Where the approver lives |
|---|---|
| Void / full refund | `transactions.void_approved_by` |
| Item refund | `sale_refund_lines.approved_by` |
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
| cashier | **End shift** | own float → expected → count → variance (via `useShiftStore.cashPosition`), own petty requests, `ShiftCashOut`. No branch totals, no restock, no Submit for closing. |
| supervisor+ | **Day end** | branch sales, every shift's accountability, restock, petty **approval queue**, Submit for closing (the Z-reading gate). |

The split is a privacy boundary, not cosmetics: the old shared screen rendered "Change fund
by shift" — every staff member's float and variance — to whoever opened it, so a cashier
could read a supervisor's drawer. Do not reintroduce a branch-wide figure into the cashier
view.

```
Sales during day → expected cash (sales − voids/refunds ± petty/pickup/float)
DayEnd.jsx (supervisor+) → closeDayEnd RPC → day_ends row
Till locked until reopen (manager, CURRENT business day only) or next business date
Cart soft nudge after ~8 PM or last 2h before openHour+14h
```

**Reopen is current-day only.** `BranchDashboard.jsx` offers Reopen on a closed day-end row
only while `entry.date === todayKey`; past closings render `Locked` with no override at any
role. Reopening a passed day would move cash figures under a Z-reading already filed.

### Petty cash: request → approve → fulfil

```
pending     cashier asked. No money has moved. Anyone may create.
  ↓ approvePettyCash()      supervisor+ ONLY (role check, no delegation/escalation logic)
approved    authorised. Money is STILL IN THE DRAWER.
  ↓ fulfillPettyCash()      anyone on site, including the requester
fulfilled   cash physically handed over. THIS is the disbursement.
```

**Only `fulfilled` is deducted from expected cash.** `approved` is a commitment, not a
disbursement — deducting it made the drawer read short between approval and handover.
`close_staff_shift()` and `shift_cash_summary()` were rewritten to match
(`migrate_petty_cash_fulfilment.sql`); leaving them on `'approved'` produces a false
variance on every cash-out.

Fulfilment without a prior approval is impossible by construction, in two places:
`fulfillPettyCash` filters `.eq('status', 'approved')`, and the DB holds
`cash_drawer_entries_fulfil_needs_approval`. The UI is not the boundary.

| Piece | File |
|---|---|
| Shared panel (request/approve/fulfil) | `src/components/dayend/PettyCashPanel.jsx` |
| API | `requestPettyCash`, `approvePettyCash`, `fulfillPettyCash`, `rejectPettyCash` |
| Migration | `supabase/migrate_petty_cash_fulfilment.sql` |

| Piece | File |
|-------|------|
| Page | `src/pages/DayEnd.jsx` |
| Report panels | `src/components/dayend/DayEndReportPanels.jsx` |
| Snapshot builder | `src/utils/dayEndReport.js` |
| Nudge | `Cart.jsx` `shouldNudgeDayEnd` |
| API | `closeDayEnd`, `reopenDayEnd`, `addPettyCash`, `fetchPettyCash`, `fetchPettyCashTimeline` |
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

---

## Realtime / live updates

Separate from the offline sync queue above — this is one-way, server → open tab, "something
changed, go refetch." It does **not** replace the queue/pull logic that reconciles IndexedDB
with Postgres while offline; it's for the case where the app is already online and a manager
edits something a cashier is currently looking at (price, promo, an approval request) and
that needs to show up **immediately**, not after the next 60s poll or page reload.

```
Postgres row changes (products, promo_events/rules, day_ends, cash_drawer_entries, …)
   │ (only if migrate_enable_realtime.sql has been run — see below)
   ▼
Supabase Realtime (postgres_changes), RLS-gated same as a normal SELECT
   │
   ▼
src/offline/realtime.js  subscribeTable / subscribeMany  →  debounce()  →  refetch
   ├─► useLiveData (src/hooks/useLiveData.js) — the layered wrapper pages should use
   │     ├─► POS.jsx: promo_events/promo_rules/promo_rule_products → reload activePromos
   │     └─► POS.jsx: products/branch_inventory → useProductStore.mergeProducts
   └─► RequestNotifications.jsx: day_ends/cash_drawer_entries(+petty_cash)/promo_events
         (manager: unfiltered; supervisor: own branch only) → reload the approval-inbox badge
```

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
- **Promo auto-expire** — a promo past its `ends_at` ends itself, no manager action needed. Three layers, because the DB one alone silently did nothing when its migration wasn't applied:
  1. **Display truth (always correct, zero dependencies):** `promoHasEnded()` / `promoEffectiveStatus()` in `api.js` derive status from the timestamp. Promo History shows `stopped · Promo ended`, and Delete unlocks, the moment the end time passes.
  2. **Never live:** `fetchActivePromoEventsWithRules` filters ended events out of the live list **regardless of `respectDuration`**. This was the actual bug — `manager/Promos.jsx` passes `respectDuration: false` (so rules can be built on a not-yet-started promo), which was also resurrecting *finished* ones into the Active dropdown. `respectDuration` governs the not-started case only; ended is unconditional.
  3. **Durable DB sweep:** `expireEndedPromos()` calls RPC `expire_ended_promos()` (`migrate_promo_auto_expire.sql`); if that function isn't deployed it falls back to a direct `UPDATE` on `promo_events` (managers/supervisors have RLS write on their branch — cashiers get denied, which is fine since layers 1–2 already cover them). Runs at the top of `fetchActivePromoEventsWithRules`, `fetchActivePromosAcrossBranches`, and `fetchPromoEventsForBranch`.
- **`datetime-local` timezone fix** (`manager/Promos.jsx` `localDateTimeValue`) — promo start/end fields were formatted with `toISOString().slice(0,16)`, which is **UTC**: a Manila manager saw and saved times 8 hours off. Now built from local getters. New promos also default `starts_at` to now (fills a blank field only — never overwrites a typed value).
- **Edit dates on an already-active promo** — `manager/Promos.jsx` Promo History "Modify" button used to be hidden for `active`/`stop_pending` rows; now shown for all statuses (only edits `starts_at`/`ends_at` via `updatePromoEventDetails`, never touches approval state, so no new dual-control needed). Delete stays restricted to non-live statuses.

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
