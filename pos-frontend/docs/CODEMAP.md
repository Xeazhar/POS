# CalePOS — Programmer’s Code Map

Guide to `pos-frontend`: where code lives, and **how data / control flow moves** through the app.  
Paths are relative to `pos-frontend/`. Product name: **CalePOS**.

**Current release:** `0.20.0` (see `package.json` + `CHANGELOG.md`). Pre-1.0 — not for live trading.

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
  │              custom order ← src/utils/navOrder.js (this till, this staff id)
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
| `src/components/dayend/` | day-end report panels, restock alert UI, manager closing detail |
| `src/components/shared/` | shell, supervisor approval, cross-feature widgets |
| `src/components/ui/` | primitive UI kit (`Modal` / `ModalActions`, buttons, fields, banners) |
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
| `/settings` | `src/pages/Settings.jsx` | role-split: manager General/Security/Sync/About; cashier/supervisor My Account/Sync/About. About links to `/legal/*` |
| `/legal/terms` | `src/pages/Legal.jsx` | public Terms and Conditions — no auth, no Shell (shift gate must not block reading) |
| `/legal/privacy` | `src/pages/Legal.jsx` | public Privacy Policy (RA 10173). Copy lives in `src/legal/` |
| `/settings/devices` | `src/pages/Devices.jsx` | cashier/supervisor: this till. Manager/master: per-branch presence + hardware. **Not** inside the Settings tree |
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

Idle auto-lock delay is company-wide: `company_profile.idle_lock_minutes` (allowed 5, 10,
or 15 — never off). Settings → Session & Auto-lock writes it; Shell reads it on sign-in
and caches the last value in localStorage for offline tills (`src/utils/sessionPolicy.js`).

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
- `canAccessModule` gives `master` unconditional access to every module **except** `inventory`
  (stock/movement for a branch is under Branches → branch dashboard: On hand + Movement
  history). No `DEFAULTS`/`permissions` check at all — a lone master account can never lock
  itself out via Staff, since self-edit is always blocked (`canEditStaff`) and nobody outranks
  master. The former `admin` role is **retired** (`migrate_retire_admin_role.sql` remaps to
  `manager`); only master has that top power. `manager` uses `DEFAULTS` / explicit `permissions`
  (devices not in manager defaults).
- **Public legal pages** (`/legal/terms`, `/legal/privacy`) are rendered *before* the
  signed-in Shell / signed-out Login split. They skip shift gate and auth. Copy is in
  `src/legal/terms.js` and `src/legal/privacy.js`; keep those in sync with real data
  practices (staff PINs, SC/PWD `discount_id_note`, IndexedDB, processors).

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
- `src/offline/db.js` → Dexie schema (products, transactions, movements, dayEnds, shifts, cashMovements, syncQueue, meta caches)
- `src/offline/repository.js` → local read/write helpers (`readBranchSnapshot`, `upsertLocalSale`, `patchLocalTransaction`, promo/catalog/staff caches)
- `src/offline/syncQueue.js` → durable FIFO outbox; `MAX_SYNC_ATTEMPTS` quarantine; exponential `nextRetryAt` backoff (2s→60s)
- `src/offline/syncEngine.js` → push queue then pull; idempotent replay via `client_id` / server RPC guards. `syncBranch()` only runs the reconciling `pullFromRemote()` once the outbox is fully drained, so a device with anything queued keeps its last-known local view — `hardResync()` is the escape hatch: forces `pullFromRemote()` directly, refusing outright if anything is queued/blocked. Exposed as Settings → Sync Status → "Hard resync", for when the server changed by a path this app's own sync never observed (e.g. a direct SQL reset during testing).
- `src/offline/reachability.js` → `canSyncWithBackend()` — Supabase ping, not just `navigator.onLine`
- `src/offline/connectivity.js` → `online` event + 30s poll triggers `syncBranch`
- `src/offline/session.js` → saved session + relogin lock

**Startup:** `loadBranch` paints IndexedDB immediately (`loading: false`), then background sync when backend reachable.

**Sale path (mandatory order):** validate → `upsertLocalSale` (Dexie) → `enqueue(COMPLETE_SALE)` → UI complete → push when reachable.

**Non-sale offline writes** also persist to Dexie where applicable: void (`patchLocalTransaction`), stock adjust (`putLocalMovement`), day-end submit (`putLocalDayEnd`), cash drawer self-record (`putLocalCashMovement` + queue).

Offline is a real first-class flow, not just cached reads. Many writes are:

`UI action` → local repository / queue → later sync to Supabase

---

## Start here (file index)

| What | Where |
|------|--------|
| App entry | `src/main.jsx` |
| Routes / role gates | `src/App.jsx` |
| Page exports | `src/pages/index.js` |
| Nav order + labels + home path | `src/constants/nav.js` + `src/utils/navOrder.js` (per-staff sidebar rearrange on this till) |
| Roles / default module lists | `src/utils/roles.js` |
| UI kit | `src/components/ui/index.jsx` (`Modal` / `ModalActions` — see below) |
| Till PIN rules (cashier/supervisor) | `src/utils/pin.js` (exactly 6 digits) |
| Shell (sidebar, logout, sync chip) | `src/components/shared/Shell.jsx` + `SidebarNav.jsx` |
| Go-live / sell readiness checklist | `docs/GO_LIVE_CHECKLIST.md` |
| Supabase client | `src/lib/supabase.js` |
| All remote API / RPCs | `src/lib/api.js` |
| Auth / cart / products / inventory stores | `src/stores/posStore.js` |
| Sync UI status | `src/stores/syncStore.js` |
| SQL | `supabase/*.sql` |

---

## Request & session flow

### Login → home → shell

1. `Login.jsx` — PIN (`signInWithPin` / `resolve_pin_login`; cashier/supervisor **6-digit**
   till PIN via `utils/pin.js`) or email password (manager+).
2. `useAuthStore.login` sets `user` (role, branchId, branchType, permissions, deviceSettings).
3. `LoginIntro.jsx` — short welcome splash (logo watermark, By Xeazhar, ©); then navigate via
   `staffHomePath(user)` (`nav.js`): cashiers → `/pos`; others → first allowed nav link.
   Session restore skips the splash.
4. `App.jsx` wraps authenticated UI in `Shell`; routes gated by `RequireModule` + role wrappers.
5. Shift gate: `Shell.jsx` calls `useShiftStore.resolve(user)`, which answers from IndexedDB
   first and refines with the server. `ready` lets work proceed; anything else renders
   `ShiftGate.jsx` over the app. Login itself no longer decides this — see "Shifts & change
   fund" below for why.

### Modal layout (`components/ui/index.jsx`)

`Modal` is a flex column capped at `max-h-[calc(100dvh-1.5rem)]` with `min-h-0` (so the
flex item can shrink — without that, `max-height` is ignored and long dialogs clip).
Body scrolls in an inner `overflow-y-auto` region; **Cancel/Save never live in that scroll
region** (they used to be `sticky` and covered fields such as Module access on Edit staff).

Prefer one of:

- **`footer` prop** — pinned bar outside the scroll body (Staff create/edit uses this:
  `footer={<ModalActions>…</ModalActions>}` + `form="staff-edit-form"` on the submit
  button so Save still posts the form).
- **`ModalActions` as a child** — auto-pulled out of the scroll body (also when the sole
  child is a `<form>` wrapping fields + `ModalActions`).

`ModalActions` is `shrink-0` with a top border — not sticky inside the scroller.

### Permissions

- Defaults: `roles.js` → `DEFAULTS[role]`.
- Override: `user.permissions` array from Staff page / DB.
- Check: `canAccessModule(user, moduleId)` (master always true except `inventory`; others use
  DEFAULTS / `permissions[]`. `admin` role retired — see `migrate_retire_admin_role.sql`).
- Nav filters the same way in `staffLinksFor` / `managerLinksFor`.
- **Settings** is always in the sidebar for signed-in users (`navLinksFor`); it is not a
  `MODULES` id, so Staff cannot strip it. Default order puts it last; staff may drag any
  tab (including Settings) via `SidebarNav` — order is per login on this till
  (`utils/navOrder.js`) and does not change `staffHomePath`. Manager-only sections are gated in
  `pages/Settings.jsx`; `company_profile` writes still require `is_manager()` RLS.
  Devices remains module `devices` at `/settings/devices` (manager/master see network
  status; cashiers/supervisors see this till). Session auto-lock minutes live on
  `company_profile.idle_lock_minutes` (5 / 10 / 15 only).

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
| Supervisor gate (price override, etc.) | `src/components/shared/SupervisorApprove.jsx` |
| Cart line remove gate | `src/components/pos/CartRemoveApprove.jsx` (+ `till_action_requests`) |
| Receipt | `src/utils/receipt.js` |
| Devices (scanner/printer/drawer flags) | `src/devices/index.js` + branch `deviceSettings` |

**Cart width:** `POS.jsx` grid `minmax(…)` + `Cart.jsx` sticky footer classes.

**OR number: never generated on-device.** A client-computed number is only atomic within
one browser's IndexedDB, not across every till selling at the branch, so two devices
checking out at once (or two offline devices seeded from the same last-synced counter)
could each compute and print the same "next" number. `posStore.js`'s `addTransaction`
sets `orNumber: null` unconditionally and checkout never awaits sync — the receipt prints
immediately with the sale's local `id` as a PENDING reference (`buildReceipt`, `receipt.js`)
instead. The real OR is assigned only when this sale's `COMPLETE_SALE` queue item reaches
the server, inside `complete_sale(...)` (`migrate_complete_sale_rpc.sql`) — `select … for
update` row-locks the branch's `or_next` counter (via `allocate_or_number`/
`reserve_or_number`, called as plain function calls from inside `complete_sale`), so
concurrent calls (any number of devices, online or catching up after reconnecting)
serialize through Postgres and each gets a distinct sequential number. The old path — a
client-supplied number reconciled server-side via `reserve_or_number` — still exists for
compatibility but nothing calls it with a number anymore; `completeSale`'s
`orNumber`/`clientOrNumber` parameter is always null now, which routes it straight to
`allocate_or_number`. Once the push succeeds the local pending row is deleted and the next
pull brings down the authoritative server row (with its real OR) — the same
delete-then-repull mechanism already used to swap the client id for the server id, so no
extra reconciliation code was needed. Reprint from Transactions (staff) or the manager
detail modal ("Print receipt") shows the real OR once synced; `item.orNumber || `Pending ·
${id-prefix}`` is the shared fallback everywhere a transaction is listed before that.
Branch fiscal header for receipts is cached in `branchMeta.fiscalHeader` on pull so
offline print does not call Supabase. Sync drains the outbox in batches
(`PUSH_BATCH_SIZE`, default 8) via `drainQueueInBackground` so a large offline backlog
does not freeze the UI when connectivity returns.

**`completeSale()` writes atomically via one RPC, not four separate round trips.**
`complete_sale(...)` (`migrate_complete_sale_rpc.sql`) does till check → OR allocation →
`transactions` insert → `transaction_items` inserts → `record_stock_movement` per line →
`sale_events` audit insert, all inside one server-side Postgres transaction — either the
whole sale lands or none of it does, closing a real gap in the old flow (a `transaction_items`
or `record_stock_movement` failure after the `transactions` insert had already committed
used to leave a money-only orphan row, and the `client_id` idempotency fast path would then
treat a retry of that same offline-queued sale as already done, silently skipping the missing
items/inventory forever). `completeSale()` (`api.js`) tries this RPC first; if the function
doesn't exist yet (database predates the migration), it falls back to the pre-atomic
multi-step flow — assert_till_open + allocate/reserve_or_number → insert `transactions` →
insert `transaction_items` → `record_stock_movement` per line in parallel — unchanged from
before. Both paths write the same columns and go through the same RLS-equivalent branch
check (`current_staff_branch()`/`is_manager()`, replicated inside `complete_sale` since it's
`security definer`); `branch_type`/restaurant-vs-retail is re-derived server-side from
`branches` in both cases rather than trusted from the client. `void_sale_secure` and
`refund_sale_items` are unchanged — they were already single atomic RPCs.

**Receipt line "Price" and "Amt" columns both always print.** `receiptToHtml()`
(`receipt.js`) renders both via the shared `priceCell()` helper, which shows a
struck-through regular price above the net price only when that cell's own
value is discounted (`net < regular`) — it does not compare Price against Amt
or special-case qty === 1.

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
when `vatExemptSales > 0`, and the same detail modal offers **Print receipt** (browser reprint
of the existing OR; see Manager tracking).

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
  └─► receipt.js buildReceipt()/receiptToHtml() — full BIR breakdown. Items
        table columns: Item/Price/Qty/Amt. Totals block: Subtotal (totalSales,
        VAT-inclusive) / Less 12% Vat / 12% Vat (both = vatAmount, always
        shown) / Discountable + Senior Citizen 20% / PWD (both only shown when
        scPwdDiscount > 0, "Discountable" = vatExemptSales, the VAT-exclusive
        base the 20% is computed from) / Less: Discount (promo-only remainder,
        shown when > 0) / Total (transaction.total)
```

**TIN is two-level.** A Philippine business has ONE TIN; a branch gets a BIR branch code
appended (`00000` head office, then `00001`…). `company_profile.tin` + `branches.branch_tin_code`
→ `api.composeTin()`, surfaced as `full_tin` on every row `fetchBranches()` returns, so the
receipt, the X/Z reading and the settings screen cannot print three different numbers.
`branches.tin` survives as a per-branch override and as the pre-migration fallback.

Company identity and idle-lock minutes are edited in **Settings → Business Information**
and **Settings → Session & Auto-lock** (`fetchCompanyProfile` / `saveCompanyProfile`).
`company_profile` writes still require `is_manager()` RLS. Branch dashboard does not
edit company TIN.

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
saving an item in `ManagerNetworkCatalog`'s bulk editor (`saveEditor`) **or** a CSV import
update line (`commitCatalogImport` → `action: 'update'`) writes `catalog_products` via
`updateCatalogProduct`, then also pushes to every `products` row already linked to it
(matched via `products.catalog_product_id`, falling back to a SKU match for rows that were
never linked — see `cascadeDiscountEligibleToBranches` below for why that link is often
missing):
- **`discountEligible`** — `api.cascadeDiscountEligibleToBranches(catalogProductId, eligible, sku)`.
- **`name`/`sku`/`barcode`/`category`/`price`/`budgetPrice`** — `api.cascadeCatalogFieldsToBranches(catalogProductId, fields, { matchSku, staffId })`,
  fired whenever any of those fields is dirty. A price change is also logged per branch via
  `recordPriceChange` (same RPC `Products.jsx` uses), so the Price Change Register and Price
  Listing report see catalog-driven price edits, not just branch-level ones. The SKU match for
  unlinked rows uses the item's **pre-edit** SKU (`row.sku` / `existing.sku`), since an unlinked
  branch row still carries whatever SKU it had before this save.

**CSV import is create + update:** `buildCatalogImportPreview` / `commitCatalogImport` create
new SKUs and **update** matching ones (unchanged rows skip). Export on Manager → Data downloads
the live catalog so a manager can edit prices in a spreadsheet and re-import for bulk
repricing. Same cascade loop as `saveEditor`.

Both cascades are called from the same save/import loop, sequentially per changed row (not
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
| Import commit / history / undo UI | `src/components/inventory/InventoryImportPanel.jsx` (Recent imports card) |
| Import commit / history | `api.js` `commitInventoryImport`, `fetchImportBatches` |
| Branch staff import RLS | `supabase/migrate_import_batches_branch_staff.sql` |
| In-memory catalog | `useProductStore` |
| Bootstrap from server | `api.bootstrapBranchData` |

**Product deactivation ("Archived"):** `api.setProductActive(id, isActive)` flips
`products.is_active`. Since every product fetch (`fetchBranchProducts`, `bootstrapPosCatalog`,
`bootstrapBranchData`) already filters `is_active = true`, deactivating a product alone
removes it from POS, dashboards, and low-stock counts — no other suppression logic needed.
A real `DELETE` already fails for anything ever sold (`transaction_items.product_id` is
`ON DELETE RESTRICT`), so this is the only working "remove" for a sold product — a soft
pause for a frozen/discontinued item, not a delete. UI lives in `Products.jsx`: a "Status"
select (Active / Archived) in the product detail panel, and an "Archived (N)" toggle that
swaps the list to `api.fetchInactiveBranchProducts(branchId)` so archived items can be
found and reactivated (same `is_active` flip back to true). No schema change from the
former "Not selling" naming — same boolean, same RPC, relabelled.

**Revert import — manager executes, supervisor can request:**
`revert_import_batch` (RPC) stays manager-only (`is_manager()`) and deactivates the batch's
created products + reverses the stock it added (including restocks), same effect as
"Archived" above. A supervisor cannot call it directly, but can flag a `committed` batch
via `api.requestImportRevert` (RPC `request_import_revert`, `migrate_import_revert_request.sql`)
— sets `import_batches.status = 'revert_requested'` + `revert_requested_by/at`. That table is
attached to the same `tg_ops_broadcast` trigger `refund_requests`/`till_action_requests` use
(see "Realtime / live updates" below), so it reaches the manager's notification bell
(`fetchPendingApprovals` in `api.js`, kind `import_revert_pending`) even off-site, linking to
`/inventory?branch=<id>` (`Products.jsx` reads that query param to preselect the branch for a
manager). A manager either reverts it (fulfills the request) or calls
`api.dismissImportRevertRequest` (RPC `dismiss_import_revert_request`) to clear the flag
without reverting. RLS on `import_batches` was already branch-scoped for supervisors
(`migrate_import_batches_branch_staff.sql`), so no policy changes were needed for this.
A supervisor's "Request revert" button (`InventoryImportPanel.jsx`) only shows for
`REVERT_REQUEST_WINDOW_MS` (5 minutes) after the batch's `created_at` — purely a
client-side render gate (no RPC/RLS change), catching a fresh mis-import before it's a
batch someone else has already sold against, without leaving a request option open on old,
already-relied-upon imports. The manager's own "Undo" has no such window.

---

## Shifts & change fund (cash accountability)

The unit of cash accountability is the BUSINESS DAY, not the shift: one branch, one drawer,
several cashiers a day, and the drawer is counted once — at Day End — not once per cashier.
(Earlier this was per-shift; see `migrate_day_end_request_no_shift_count.sql` for why it
changed and the tradeoff that came with it: a variance can no longer be pinned to a specific
cashier when more than one worked the drawer that day, only to whoever counted at close.)

```
Start shift  → auto-starts at startingCash 0, no prompt → useShiftStore.startShift
               → local Dexie `shifts` row (clientId) + enqueue OPEN_SHIFT
               → open_staff_shift() RPC → staff_shifts row (serverId)
               (a stale open shift left by a previous cashier on this drawer is
                auto-closed here, no count, so the new shift is never blocked)
               EXCEPT right after a manager reopens a closed day — see
               `needsFreshCount` below, the one case that still asks for a count.
               Add real cash any time via POS → Open Drawer → Opening float
               (only offered while startingCash is still 0).

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

**A pending local close beats a stale remote "still open."** `fetchOpenShift` filters on the
SERVER's `clock_out`, so a `CLOSE_SHIFT` that has not pushed yet (still in the outbox) makes
the server genuinely, correctly report the shift as open — it does not know about the close.
`resolve()` used to trust that read unconditionally and re-save the shift locally as open
(`upsertFromRemote`), silently undoing `endShift()`'s local close; re-logging in shortly after
ending a shift (before the queue item synced) resurrected it as open, so the cashier had to
end it a second time before the supervisor's (server-sourced) view ever agreed it was closed.
`resolve()` now checks for a local record matching the remote row's `client_id` that is
`status: 'closed'` with `syncStatus: 'pending'` before accepting the remote's "open" answer,
and skips the overwrite when found — falls through to `gate: 'start'` instead, same as any
other resumed-after-close cashier. Same root cause as the `resolve()`-after-`endShift()` rule
below; different call site (a fresh `resolve()`, not a redundant one), so both guards are
needed.

**Drawer identity** is `src/utils/drawer.js`: a localStorage id that survives sign-out,
because the drawer does not move when the cashier does. It defaults to the shared `'main'`
rather than a random per-device id — most shops have one cash box and several devices
pointed at it, and those must share a drawer identity or two people could count into the
same till unnoticed. A till with its own cash box gets its own id in Settings → Devices.
Same cashier on a different drawer is a different pile of cash, so that is gate `moved`
(supervisor override), never a resume.

**A supervisor may hold a drawer too — chosen per shift, not fixed by role, and never on
click alone.** `Shell.jsx`'s `holdsDrawer = user?.role === 'cashier'` is only the DEFAULT
handed to `ShiftGate`/the first `resolve()` call at sign-in. `ShiftGate.jsx` (`canChooseDrawer
= role === 'supervisor'`) renders a "Floor" vs "Working the register" card pair on the start
screen — pure selection (`setWantsDrawer`), it does not fire the shift; a supervisor confirms
with the same "Start shift" button everyone uses (`canChooseDrawer` is excluded from
`autoStarting` specifically so this never silently auto-fires the moment an option is
clicked, unlike a real cashier's shift). On that click, if "Working the register" is selected,
`onStartClick` first re-resolves (`resolve(user, { holdsDrawer: true })`, same call the
`moved` gate's "Check again" button already makes) so an existing open drawer shift on
another till is still caught — a supervisor's first `resolve()` ran with `holdsDrawer: false`
and skipped that check entirely, unlike a cashier who gets it for free at sign-in. Only a
clean `start` result continues to `doStart()`, at ₱0 same as a cashier's shift (see
`needsFreshCount` below for the one case that still asks for a typed count — gated on
`needsFreshCount` itself, not bare `holdsDrawer`, so an ordinary "working the register" day
never shows the change-fund field). `resolve()`'s own returned `handoff` — not the
component's `handoff` state — is what gets passed as `doStart({ carriedFrom })`: `doStart` is
a closure captured at render time, so the currently-running `onStartClick` would otherwise
still be holding whatever `handoff` was BEFORE this re-resolve ran (a state update doesn't
rewrite a closure already executing); threading the fresh value through explicitly is what
lets a reopened-day recount still link `carriedFromShiftId` correctly instead of always
carrying `null` for a supervisor's drawer shift. This is a genuine per-shift choice, not a per-account
setting — nothing is written back to the `staff` row. Everything downstream (Open Drawer's
petty-cash/opening-float button, Day End's cashier-drawer accountability list, `cashStats`/
cash-impact totals) already keys off `shift.holdsDrawer`, never off role, so a supervisor's
drawer shift needs no special-casing anywhere else — it is swept into the same "open cashier
shifts" checks a real cashier's shift is. The one place that does NOT read the live selection:
the `gate === 'ended'` screen reads `handoff.holdsDrawer` (the ended shift's own field, from
`endShift()`'s return value) rather than the component's `holdsDrawer`, because `wantsDrawer`
is local state that resets on remount and cannot be trusted to still describe a shift that
already closed.

**Master gets a shift lazily, on first real use — never on sign-in, never just from opening
POS.** `Shell.jsx`'s `worksShifts` (gates `resolveShift`/`ShiftGate` entirely) is still
cashier/supervisor only — a master signing in to check Reports must not be forced through a
shift lifecycle it has no use for. But selling and Open Drawer are both fundamentally
shift-scoped (`transactions.shift_id`/`cash_movements.shift_id`), so master needs one the
moment it actually does either. `useShiftStore.ensureMasterShift(user)` is the lazy path
(no-op for every other role, which already has a shift by the time either caller below can
run): `posStore.addTransaction` awaits it before reading the active shift (first sale), and
POS.jsx's Open Drawer button awaits it before the modal opens (surfacing any failure via
`window.alert(formatSupportError(...))` rather than opening the modal regardless). `resolve()`'s
`moved` gate (master already has an open shift on a different drawer) is not auto-resolved
here either — `ensureMasterShift` throws `SHIFT06` instead of silently opening a second
concurrent shift, same reasoning as `ShiftGate`'s `moved` screen below, just without a UI of
its own since master never renders `ShiftGate`. `POS.jsx`'s `canOpenDrawer` is the one other
spot that special-cases master — true whenever the till isn't closed, regardless of `shift`
(master may not have one yet), where every other role still requires `Boolean(shift) &&
shift.holdsDrawer !== false`.

| Gate | Meaning | Remedy |
|------|---------|--------|
| `ready` | shift open, sell | — |
| `start` | no shift here | auto-starts at startingCash 0, no prompt — unless today's business day is already closed (see below) or was reopened after a close (`needsFreshCount`, see below), which still asks for a count |
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
| API | `api.js` → `openShift`, `closeShift`, `requestDayEnd`, `rejectDayEndRequest`, `fetchOpenShift`, `fetchOpenShiftOnDrawer`, `fetchOpenShiftsForBranch`, `fetchLastClosedShiftOnDrawer`, `fetchShiftCashSummary`, `adjustShiftCash`, `fetchShiftAdjustments`, `fetchStaffShifts` |
| Tables | `staff_shifts` (+ cash columns), `shift_adjustments`, `transactions.shift_id`, `day_ends` (+ `requested_at`, `requested_by`, `request_manager`, `rejected_at`, `rejected_by`, `reject_reason`) |
| Migration | `migrate_shift_cash_accountability.sql`, `migrate_day_end_request_no_shift_count.sql`, `migrate_day_end_reject_request.sql`, `migrate_shift_cash_void_fix.sql`, `migrate_staff_identity_resolve.sql`, `migrate_branch_roster_exclude_managers.sql`, `migrate_schema_cleanup_v1.sql` (drops dormant shift-review columns) |

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
`SHIFT_COLS_CORE` → `SHIFT_COLS_LEGACY` → `SHIFT_COLS_MINIMAL`. `shift_period` is optional
on older DBs and is stripped via `isMissingOptionalShiftColumn` *before*
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
closes under the cashier's own id (`closedBy: user.id`). The old
`closed_without_supervisor` / `acknowledge_shift_review` path was removed in
`migrate_schema_cleanup_v1.sql` (columns + RPC + inbox/UI).

**Ending a shift forces sign-out before the next count — but Request day end must still be
reachable first.** `endShift` (shiftStore.js) lands on `gate: 'ended'`, not `'start'`.

**Supervisor Day end order:** close any open cashier drawer shifts → **Confirm received
handoff** (`api.receiveShiftHandoff` / `migrate_receive_shift_handoff.sql`) for closed
shifts still missing `ending_cash` → end own floor shift → Close day. Confirming handoff
does **not** require the supervisor's own shift to be closed first — they're still working
the floor while cashiers hand over their drawers, so `receiveAllHandoffs`'s disabled
condition only checks `openDrawerShifts.length` (other cashiers' shifts still open), not
`ownShiftOpen`. `closeDayBlockedReason` (`DayEnd.jsx`) checks in that same order — open
cashier shifts, then pending handoffs, then the supervisor's own shift — so whichever step
is actually next is what the Close day button's disabled message names. Staff → Shifts
badge goes Pending handoff → Received handoff. Apply that migration before using the button.
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

**Only a reopened day still asks for a count; an ordinary new shift auto-starts at 0.**
`ShiftGate`'s `needsFreshCount = holdsDrawer && todayEntry?.status === 'reopened'` is the
only case that renders the change-fund form at all — every other `holdsDrawer` start (a
fresh business day, a same-day cashier handoff, `resolve()` answering `start` for any
reason) fires `startShift` automatically with `startingCash: 0` from a `useEffect`, no
modal. This follows the same "counting is a DAY-END activity, not a shift-boundary one"
principle `endShift` already applies on the way out (see the flow diagram above) — a
mid-day cashier switch has no more reason to demand a count on the way in than it does on
the way out, and real cash entering later goes through POS → Open Drawer → **Opening
float** (only offered while `startingCash` is still 0 — see `migrate_cash_movement_cash_in.sql`,
which updates `staff_shifts.starting_cash` server-side on approval, guarded to only apply
once). A floor shift (`holdsDrawer` false) is untouched by any of this — it still picks its
AM/PM window on the form, same as always; it never had a count to skip.

Why reopened is the one exception, and why it must not be linked as a carry either:
`ShiftGate`'s `doStart` sets `carriedFrom: handoff?.endingCash != null ? handoff : null` —
linking a new shift to the handoff it followed, but *only* when that handoff actually has a
counted `ending_cash`. `DayEnd.jsx`'s `shiftFloatTotal` (and the mirrored calc in
`api.fetchBranchCashImpact`) excludes a linked shift's `startingCash` from the day's float
total, on the reasoning that its cash is not new money — it is the same drawer someone
recounted, and the sales that built it up are already inside the day's cumulative
`cashSales`. That reasoning only holds when a genuine counted amount exists to point at:
`ending_cash` is null on an ordinary `endShift` clock-out (counting moved to Day End, see
above) and is only ever populated by a supervisor's **Confirm received handoff**
(`receive_shift_handoff`, which computes and writes one). Linking regardless of that — the
first version of this fix did — made every plain same-day shift handover exclude its own
real `startingCash` from the total, because Day End treated an *uncounted* predecessor as
"already counted". A reopened day is the one case where a genuine counted `ending_cash`
reliably exists (Close day requires every shift on the drawer to have gone through Confirm
received handoff first), so it is both the only case that still asks for a count *and* the
only case where linking that count as carried is correct.

Being linked (`carriedFromShiftId` set) is still not sufficient on its own to call a shift's
float a duplicate: the reopened-day form pre-fills the carried figure but the cashier can
still type a different count (`differsFromCarried`), and a shift that opened at `startingCash:
0` can independently declare a fresh float later via POS → Open Drawer → **Opening float**
(only offered while `startingCash` is still 0 — `migrate_cash_movement_cash_in.sql`). Either
path leaves `startingCash` different from the frozen `carried_amount` captured at shift-open,
which means it is no longer "the same drawer recounted" — it is new, real money and must be
counted. `DayEnd.jsx`'s `shiftFloatTotal`, `api.fetchBranchCashImpact`, and
`manager_overview_metrics()`'s `changeFund` (`migrate_fix_overview_cash_impact_carry.sql`) all
apply the same rule: exclude a carried shift's `startingCash` only when it still equals
`carriedAmount`/`carried_amount` **and** the predecessor it carried from is itself in the same
branch+business-date set being summed; count it in full otherwise. Before this, the two React
call sites (unconditional exclude) and the SQL RPC (no exclusion at all) disagreed with each
other in opposite directions on the exact same data.

**Cash impact must merge both drawer tables — `cash_drawer_entries` (legacy petty cash) and
`cash_movements` (POS → Open Drawer dual control).** `DayEnd.jsx` (`paidOutTotal`/
`pickupTotal` + `movePaidOutTotal`/`movePickupTotal`/`moveCashInTotal`), `BranchDashboard.jsx`'s
`cashStats`, and `DayEndClosingDetail.jsx` all sum both; only counting-status `cash_movements`
rows count (`CASH_MOVEMENT_COUNTING_STATUSES` — a `pending_remote` request has not moved cash
yet), and `opening_float`-type rows are excluded (already counted via `staff_shifts
.starting_cash`). `api.fetchBranchCashImpact` and `manager_overview_metrics()`
(`migrate_fix_overview_cash_impact_movements.sql`) mirror the same merge — both previously read
`cash_drawer_entries` only, so a petty cash paid-out or pickup recorded through Open Drawer
never moved the network Overview page's "Cash in / out" card even once approved.

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
Closed-day refusals quote **TILL04** (not a bare string, and not AUTH07 — see errors.js: the
PIN "locked" matcher must not steal "business day is locked"). Date filter defaults to **Today**.

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
| cashier | **End shift** | `OwnShiftSoFar.jsx`: shift detail (Started / On shift duration / drawer / period), own cash-sales-so-far (`useShiftStore.cashPosition`), **Drawer Activity** (own shift movements, read-only), **End shift** clock-out (`ShiftCashOut`), **Request day end**. No creation of petty/pickup here — use POS → Open Drawer. |
| supervisor+ | **Day end** | Same **`OwnShiftSoFar`** block at the top (own shift figures + shift-scoped drawer activity), then branch sales, Accountability (open shifts), branch-wide **Drawer Activity** (review `self_recorded`), pending handoffs / day-end request, Close day (blocked until own shift ended, cashier shifts closed, handoffs received, and self-recorded movements reviewed). Floor supervisors (`holdsDrawer: false`) see cash sales only; till-holding cashiers see the full drawer breakdown. |

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
for a shift's entire session whenever this raced; and older drawer writes that used
`shiftId={shift?.serverId}` could land with `shift_id: null`, permanently invisible to
`shift_cash_summary()`'s strict `shift_id = p_shift_id` filter while still counted in the
supervisor's unscoped day total — another way the two screens could disagree even with a
single shift on the drawer.
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

**`SupervisorDayEnd`'s "Cash on hand" field starts blank, not `0`** — draft input is never
pre-filled from a prior visit, a reopened day row, or IndexedDB; leaving Day end and returning
always shows an empty field until someone counts again (submitted/closed days show filed
`existing.cashOnHand` read-only). `hasCashOnHand` gates both the "Variance vs expected"
display and `noteRequired`, so the screen reads "— Enter cash on hand to compare" instead of
a false "₱X Short" the instant the page loads with nothing counted yet. The "Close day"
button stays disabled until the draft field has a value. Also shows Card/E-wallet sales (net of
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
not manager-flagged, to a manager always. Inbox matching keys off `status = 'requested'`
(not `closed_at IS NULL`) — see `migrate_day_end_request_notify_fix.sql` for why the old
filter hid every request.

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
role. Clicking the row still opens the read-only closing detail (petty / cash-outs) for
that past day. `DayEnd.jsx`'s Cancel closing only ever acts on `dayEndForBusinessDate(dayEnds, date)`
for the CURRENT business date, so it inherits the same restriction without a separate check.
Reopening a passed day would move cash figures under a Z-reading already filed.

**`DayEnd.jsx` has no historical closings list of its own.** It used to render its own
"Previous day-end closings" table, duplicating `BranchDashboard.jsx`'s paginated "Day-end
closings" section (which also has Reopen, and a click-through detail for petty / cash-outs)
with a plainer read-only copy. Removed — a
supervisor closing today's day doesn't need yesterday's numbers on the same screen, and a
manager wanting history already has the richer version. `DayEnd.jsx` still fetches `dayEnds`
(`useInventoryStore`) for `dayEndForBusinessDate(dayEnds, date)` — only the list *rendering*
was removed, not the underlying fetch.

**Close day is the last thing on the page, not the first.** The sales-summary / cash-on-hand /
variance / notes / Close day card renders last, after Accountability and Drawer Activity, so a
supervisor sees open shifts and unauthorized movements before locking the day.

### Legacy petty cash queue (removed)

The Day End **Petty cash (paid-out)** panel (`PettyCashPanel.jsx`) and its request → approve →
fulfil UI are **removed**. New paid-outs/pickups are only created via POS → **Open Drawer**
(`cash_movements`). `fetchPettyCash` / `fetchPettyCashTimeline` remain so historical
`cash_drawer_entries` still feed expected-cash math and the manager Cash drawer log display.
Legacy write helpers `requestPettyCash` / `approvePettyCash` / `fulfillPettyCash` /
`rejectPettyCash` are gone from `api.js`. Shell bell no longer lists pending legacy petty.

**Only `fulfilled` legacy paid-outs are deducted from expected cash** (same filter in
`DayEnd.jsx`, `terminalReports.js`, `mapPettyCashRow`, and shift cash RPCs). A null status
on old rows defaults to fulfilled.

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
looking at the screen.** Older Day End pickup / paid-out writes used to attribute `shiftId` to
`activeShift` — the VIEWING supervisor's own shift (often `null`). `shift_cash_summary()`
filters strictly on `shift_id = p_shift_id`, so an entry attributed to the wrong shift (or none)
never showed in that cashier's "Your shift so far". Fixed by attributing to
`drawerHolderShift` — whichever shift is actually open on the drawer. New Open Drawer movements
always use the cashier's open `staff_shifts` row.

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
|-------|------|
| Page | `src/pages/DayEnd.jsx` |
| Report panels | `src/components/dayend/DayEndReportPanels.jsx` |
| Own shift panel | `src/components/dayend/OwnShiftSoFar.jsx` (cashier End shift + supervisor Day end header) |
| Snapshot builder | `src/utils/dayEndReport.js` |
| Nudge | `Cart.jsx` `shouldNudgeDayEnd` |
| API | `closeDayEnd`, `reopenDayEnd`, `requestDayReopen`, `addPettyCash`, `fetchPettyCash`, `fetchPettyCashTimeline` |
| Dates / open hour | `src/utils/format.js` |

### Cash accountability timeline

`DayEnd.jsx` historically recorded drawer/accountability entries into `cash_drawer_entries`
(formerly `petty_cash`). **New petty cash and pickups use `cash_movements`** (see below).

**Cash movements (`cash_movements`, `migrate_cash_movements.sql`)** — sole creation UI is
POS → **Open Drawer** (`OpenDrawer.jsx` on `POS.jsx`):
- Types: `petty_cash` | `pickup`; session FK = `staff_shifts.id`; register = `drawer_id`/`drawer_label`
- Statuses: `pending_remote` → `approved` / `remote_approved` / `denied` / `self_recorded` →
  day-end `confirmed` (**Resolved**) | `flagged_for_investigation` (**Flagged**). UI end-states:
  **Approved** / **Resolved** / **Flagged**. Manager-only `resolve_flagged_cash_movement`
  (`migrate_cash_movement_resolve_flagged.sql`) turns Flagged → Resolved.
- Counting statuses (reduce expected cash): approved, remote_approved, self_recorded, confirmed, flagged
- Notify Manager = in-app + realtime (Shell bell inline Approve/Deny + BranchDashboard); no FCM;
  POS waits **60s** then offers self-record (`OPEN_DRAWER_WAIT_SEC` in `SupervisorPinWait.jsx`)
- Shared PIN/wait UI: `SupervisorPinPanel` + `ManagerWaitPanel` in `SupervisorPinWait.jsx`
- **Offline:** Open Drawer stays enabled. Supervisor PIN verified on-device (same PBKDF2
  verifiers as cart remove), **or** self-record with acknowledgment (flagged for day-end).
  Both write IndexedDB + `CASH_MOVEMENT_APPROVED` queue and sync when online. Notify manager
  is unavailable offline (needs server) — self-record replaces that path while offline.
- Cancel (X): voids `pending_remote` via `cancel_cash_movement` (`migrate_cash_movement_cancel.sql`)
- Day End **Drawer Activity** (`DrawerActivity.jsx`) lists **this business day's** Open Drawer
  rows only (amount, reason, requester, approver/reviewer, status) — `useDayEndData` scopes
  every `fetchCashMovements` path to the current date. `self_recorded` = **Unauthorized**;
  page-top banner + row/banner open Mark Resolved / Flag modal. Reviewer must be
  supervisor/manager **other than** `requested_by` (RPC `review_cash_movement` + UI).
  Close day hard-blocked until every unauthorized row is `confirmed` (Resolved) or
  `flagged_for_investigation`. Approved / remote_approved / denied never block close.
  Managers may later Mark Resolved on Flagged rows (Branch Cash drawer log).
- Reports → **Cash Movements** (`Reports.jsx` id `cash-movements`) for cross-session analysis
- RPCs in `api.js`: `createCashMovementApproved|Pending`, `approveCashMovementPin|Manager`, `denyCashMovement`, `cancelCashMovement`, `selfRecordCashMovement`, `reviewCashMovement`, `resolveFlaggedCashMovement`
- **Self-approve for supervisor+.** A cashier's request still needs a real second person
  (PIN, remote manager approval, or the flagged self-record fallback) — dual control (approver
  ≠ requester) is untouched for them. A supervisor/manager/master recording their OWN drawer
  skips the whole PIN/notify screen: `OpenDrawer.jsx`'s `canSelfApprove` (`isSupervisorOrAbove`)
  calls `createCashMovementApproved` directly with `approvedBy === requestedBy`, landing
  straight on **Approved** (never Flagged). The actual control is server-side —
  `migrate_cash_movement_self_approve.sql` only accepts that equality when
  `is_supervisor_or_above()` is true for the CALLING session (`auth.uid()`'s own staff row,
  not anything the client sends), so a cashier cannot reach this path by passing their own id
  twice. Audit event type is `cash_movement_self_approved` (`meta.via = 'self'`), distinct
  from a PIN-approved `cash_movement_approved` (`via = 'pin'`), so Reports/Audit can tell the
  two apart.

**Cart line remove (`till_action_requests`, `migrate_till_action_requests.sql`)** —
`CartRemoveApprove.jsx` on cart trash/void-from-cart:
- Supervisor PIN on site, or Notify manager → **30s** wait (`CART_REMOVE_WAIT_SEC`), then
  self-allow with acknowledgment (logged)
- Shell bell + BranchDashboard Approve/Deny resolve the pending request and stop the countdown
- API: `createTillActionRequest`, `resolveTillActionRequest`, `fetchPendingTillActionRequests`
- **Offline:** PIN checked locally against PBKDF2 verifiers in IndexedDB (`supervisorVerifiers`,
  provisioned via `fetch_branch_supervisor_verifiers` on sync and when staff PINs are saved —
  `migrate_offline_supervisor_pin.sql`). Never plaintext PINs. Approval audit persists in
  `offlineAuditEvents` + sync queue (`LOG_APPROVAL_EVENT`) with idempotent server insert via
  `log_audit_event_idempotent`. Cart `cartId` is stored in audit meta as `cart_id`.

Legacy `cash_drawer_entries` kinds still counted in `shift_cash_summary` / day-end math for history:
- `"[CHANGE FUND] ..."` → opening float (legacy)
- `"[PICKUP] ..."` → cash pickup
- plain reason → paid-out / petty cash

Manager tracking lives in:
- `src/pages/manager/BranchDashboard.jsx`
  - pending `cash_movements` Approve/Deny strip
  - pending `till_action_requests` (cart remove) Approve/Deny strip
  - **Cash drawer log** = today’s `fetchCashMovements` + legacy `fetchPettyCashTimeline`;
    unauthorized → Mark Resolved / Flag; Flagged → Mark Resolved (**manager only** via
    `resolveFlaggedCashMovement`); end-state labels Approved / Resolved / Flagged
  - **Day-end closings** rows are clickable → `DayEndClosingDetail.jsx` loads that business
    date’s shift cash-outs (`fetchStaffShifts`) plus petty / pickups / cash-in
    (`fetchCashMovements` + `fetchPettyCashTimeline`). Approve / Reopen stay on the row
    (stopPropagation). Reopen remains current-day only.
  - **Recent receipts** open `TransactionDetailModal` with **Print receipt** — browser reprint
    of the existing OR (`buildReceipt` + `receiptPrinter.printReceipt`); uses the *viewed*
    branch fiscal header (`fetchBranchFiscalHeader`), does not mint a new OR, and is not
    gated on the manager’s own till printer toggle (this is a copy, not a counter print).
  - live reload on `cash_movements` / `cash_drawer_entries` / day_ends / refunds / till actions
  - **Staff terminals:** `Shell.jsx` → `useBranchOperationsLive` refetches
    `bootstrapBranchActivity` into `useInventoryStore` on `OPERATIONS_CHANGED` (manager reopen,
    day-end submit/approve, etc.) so POS / ShiftGate unlock without a full reload; `loadBranch`
    also refetches day-end activity on login when online (even if the sync outbox is non-empty),
    and `putDayEnds` drops stale local pending rows when the server already has that business date

Managers do **not** get a Day end sidebar tab (`nav.js` hides `day_end` for `isManagerRole`);
module access remains so `/day-end` still works for cashier “request manager” closes.
- `src/lib/api.js` maps both tables

---

## Devices

| Piece | File |
|-------|------|
| Staff Devices page (this till) | `src/pages/Devices.jsx` `TillDevices` |
| Manager/master network status | `src/pages/Devices.jsx` `NetworkDevicesOverview` via `fetchBranchTelemetry` |
| Capability helpers | `src/devices/index.js` |
| Manager toggles | `BranchDashboard.jsx` → `saveBranch` device_settings |
| Presence / heartbeat | `useBranchHeartbeat.js` (cashiers only), `migrate_branch_presence.sql` |

Cashiers and supervisors report presence + device stubs every 45s. Manager Devices treats a till as
offline when that heartbeat is older than 3 minutes (`DEVICE_STALE_MS`). Enable/disable
stays on the branch dashboard; Devices is status only.

UI copy: when manager enables a device, show **Enabled by manager · Connected/Not connected** (not stale “Disabled”).

---

## Manager area

| Page | Path | File |
|------|------|------|
| Overview | `/` (manager) | `manager/Overview.jsx` |
| Branches | `/manager/branches` | `manager/Branches.jsx` |
| Branch detail | `/manager/branches/:id` | `manager/BranchDashboard.jsx` |
| Devices (network status) | `/settings/devices` | `Devices.jsx` (manager/master view) |
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
`ShiftsTab` already has the full shift log, cash correction (`onAdjust`), and close-shift
UI. The row's Hours/Shifts/Variance columns are still populated from the
same `shiftsByStaff` data (glance-only, no click needed). Filter strip: search, Branch (or
locked branch for supervisors), **Status** (All / Active / Inactive), shift date range.
Supervisor floor shifts (`holdsDrawer` false) still show the branch/terminal drawer label
(not "No drawer"); float columns stay blank.

**Reveal PIN requires re-entering your own password first**
(`pinRevealTarget`/`onConfirmPinReveal`), via `verifyAccountPassword()` — the same offline
PBKDF2 verifier the lock screen uses (`src/utils/unlockVerifier.js`), not a live Supabase
sign-in, so it still works offline. Only gated for `hasSupabase` — the local demo fallback
skips the check (nothing real to protect).

**Cashier / supervisor till PIN** is exactly **6 digits** (no letters/symbols). Rules and
helpers live in `src/utils/pin.js` (`sanitizePinInput`, `validateComplexPin` name kept for
call-site stability, `randomComplexPin`, `PIN_RULES_HINT`). Enforced on Staff create/edit;
login (`signInWithPin`), `SupervisorApprove` / `SupervisorPinWait`, and lock-screen PIN mode
strip input to digits. **Generate** on the staff form emits a random 6-digit PIN. Manager+
still use email + password. Legacy complex PINs must be reset to 6 digits before login.

### Dashboard metrics: Sales performance / Payment & cash impact / Audit

All three dashboards a manager or supervisor lands on — `manager/Overview.jsx`
(network-wide), `manager/BranchDashboard.jsx` (one branch, always today), and
`Dashboard.jsx` (supervisor's `/` home, one branch, Today/Week/Month toggle) — show the
same three metric groups, built from the same formulas so the numbers can never quietly
disagree between screens:

- **Sales performance** / **Payment & cash impact** on **Manager Overview** come from a
  single RPC `manager_overview_metrics(p_days)` (`migrate_network_manager_overview.sql`,
  wrapped by `api.fetchManagerOverviewMetrics`) instead of N× `branchSummary` + N×
  `fetchBranchCashImpact`. If the RPC is missing, Overview falls back to the old fan-out.
- **`revenue` is net of refunds everywhere, not gross.** The RPC's `revenue` key, the JS
  fallback's `branchSummary().revenue`, and `fetchPeriodComparison()`'s `current`/`previous`
  revenue all now equal `total_amount - refunded_amount` summed over `completed` transactions —
  same convention as `BranchDashboard.jsx`'s own "Revenue today" figure (`netTotal`).
  Before `migrate_fix_manager_overview_revenue_net.sql`, the RPC and JS fallback returned
  `revenue` as raw `total_amount` (no refund subtraction) while a separate `netSales` key on the
  same response WAS netted — Manager Overview's headline "Revenue" card overstated actual revenue
  by however much had been refunded, while BranchDashboard's figure for the same branch/day was
  correct. `grossSales` (pre-discount total) is unaffected and still distinct from `revenue`/
  `netSales`, which are now identical by definition — kept as two keys only because existing
  callers read both. **One canonical Revenue everywhere:** Revenue = Gross sales − Discounts −
  Refunds, and every place that shows it — the headline KPI, the Sales performance lead tile
  (labelled "Revenue", not "Net sales" — a separate "Net sales" figure would just repeat it),
  the Revenue over time chart, and period-over-period comparisons — reads the same figure.
  `fetchNetworkDashboard`'s chart bucket sum now also subtracts `refunded_amount` per row
  (previously summed raw `total_amount`, disagreeing with the KPI card above it on the same
  page); `branchBars`/`paymentMix` are left on gross `total_amount` by choice — a refund isn't
  reliably attributable to the original sale's payment method or branch bucket, so netting those
  would be a guess, not a correction.
- **BranchDashboard** live updates (`day_ends` / `cash_drawer_entries` / `refund_requests`)
  call `reloadOps` → `bootstrapBranchActivity` + drawer/cash/audit only — **not** a full
  product bootstrap.
- **"Revenue today" vs. yesterday badge.** `BranchDashboard.jsx`'s top KPI row fetches
  `fetchPeriodComparison('day', branchId)` (`api.js`, now takes an optional `branchId` filter —
  same function `Overview.jsx` uses network-wide) once on load for `previous.revenue` (yesterday's
  total). The `DeltaBadge` (`components/ui`) always compares that fixed baseline against the
  LIVE `revenue` value (derived from `data.transactions`, kept fresh by `reloadOps`) — never
  `comparison.current`, which is a load-time snapshot that would go stale the moment a void or
  refund changes today's total without a matching refetch. Only the Revenue/Sales-today card has
  this; the other top cards (Orders, Refunded, Low stock, Reseko loss) are either already covered
  by their own hint or are point-in-time counts a period-over-period % doesn't fit well.
- Login/`loadBranch` paints POS from `bootstrapPosCatalog` first, then completes sync via
  `bootstrapBranchData` (catalog + activity in parallel for IndexedDB).
- **Bootstrap tiers:** `bootstrapPosCatalog` (products + branch fiscal header only) →
  `bootstrapBranchInventory` (catalog + movements, no txs/day-ends) → `bootstrapBranchData`
  (full offline snapshot). Inventory page reload uses `fetchBranchProducts`; Promos editor
  uses `bootstrapPosCatalog`. Branch dashboard initial load runs branches + full bootstrap
  in parallel, then one `Promise.all` wave for day ops. Promo history stats use
  `fetchPromoSalesStatsSummary` with `utils/mapLimit.js` (concurrency 3); Sales modal
  detail uses `fetchPromoSalesStats`. Spreadsheet I/O: `src/lib/xlsxLoader.js` (lazy
  `@e965/xlsx`, safe `read` defaults).
- **Resilience:** `AppErrorBoundary` (root), `lazyWithRetry` on route chunks (one hard
  reload on chunk failure), `useCompactChrome` + `compact:` layout for touch devices in
  desktop-site mode, `DesktopModeHint` banner.
- POS promo reads no longer call `expireEndedPromos` (write-on-read); manager promo screens
  still sweep. Display truth is `promoHasEnded` / `promoEffectiveStatus` (`status` only —
  `promo_events.is_active` was dropped in `migrate_schema_cleanup_v1.sql`).

- **Sales performance** (Revenue, Gross sales, Discounts, Refunds, Voided sales) — the
  same reduction `utils/terminalReports.js` uses for the X/Z reading: Gross = Σ(total +
  discount) over Paid, Revenue = Σ(total − refunded) over Paid (the canonical figure, see
  above), Discounts = Σ discount over Paid, Refunds = Σ refunded over Paid (partial
  refunds only), Voided = Σ total over Voided. Computed client-side from already-loaded
  transactions on BranchDashboard/Dashboard; on Overview, via `fetchManagerOverviewMetrics`
  (or legacy `branchSummary`).
- **Payment & cash impact** (Cash sales, Card sales, E-wallet sales, Cash in/out, Expected
  cash) — always TODAY's business day regardless of any period toggle (a drawer is
  counted once a day; see "Day end & cash" above). `api.fetchBranchCashImpact(branchId,
  date, openHour)` remains the single-branch source; Overview uses the network RPC total.
- **Audit** (void/refund counts, total value, a paginated recent list) — reuses
  `api.fetchSaleEvents({ branchId, start, end })`, the same source Reports →
  "Void / Refund Log" already reads. Rendered by `components/dashboard/AuditSummary.jsx`:
  2 totals + up to 5 rows per page with its own tiny Prev/Next pager (deliberately not the
  shared `Pager` — that one's sized for full tables). Rows are **not** clickable — at the
  size this list needs to be, a tap target is bad touchscreen UX (same reasoning
  `RevenueChart` uses full-height hit bands instead of a precise dot). No hover tooltip
  either (app-wide — see "Tooltips removed" below); the branch/staff/reason columns show
  everything inline instead. `showBranch` (Overview only, network-wide) adds a Branch
  column, resolved from `sale_events.branches(name)`. Both names are resolved via
  `resolve_staff_identities()` (see "Shifts & change fund" → RLS above), not a
  `staff(...)` embed — a supervisor needs to see a same-branch cashier's name here, and
  the embed silently blanks it. The "Open full log" link only renders when
  `canAccessModule(user, 'manager_reports')` is true, since a default-permission
  supervisor does not have that module.

**Layout, all three pages:** the revenue chart (`RevenueChart` with `fill`) sits on the left in
an `items-stretch` grid so its height matches the Sales / Payment / Audit stack beside it
(wide ~1.6fr column kept); Overview, BranchDashboard, and supervisor Dashboard share that layout.
`manager/Overview.jsx`'s old "Revenue by branch" panel was removed outright (state, fetch
fallback and all) rather than just hidden, since it restated the hero KPI once a network
has only a couple of branches.

`components/dashboard/StatTiles.jsx` is the shared report-line renderer behind the Sales
performance and Payment & cash impact rows on all three pages — a real 2-row CSS grid (label row,
value row) rather than a flexbox of independently-sized boxes, so one item having an extra
hint line can't drag its neighbors' label/value out of alignment. The first entry in
`items` is the lead figure (rendered larger) — pass whichever number is most actionable
first (Revenue, not Gross; Expected cash, not Cash sales).

**Revenue over time is interactive on Manager Overview (network-wide) — click a point to
cross-filter.** `fetchNetworkDashboard` buckets Top products/Top categories/Payment
methods/branch split by the same date bucket it already builds the chart from
(`pointBreakdowns`, keyed by each point's `bucketKey`) in the same query pass — no second
round-trip. `RevenueChart` takes `selectedIndex`/`onSelectIndex`; clicking a point (or the
same point again to clear) sets `Overview.jsx`'s `selectedPointIndex`, which swaps Top
products/Top categories/Payment methods to that bucket's breakdown and filters the Audit
list client-side (`eventMatchesBucket`, matching the same bucket convention). The headline
Sales performance / Payment & cash impact tiles stay whole-period — cash impact isn't
bucketed server-side, so drilling into those would need a second fetch per click. Not
implemented on BranchDashboard/Dashboard (single-branch view, one card row, less to gain
from cross-filtering) — `RevenueChart`'s `selectedIndex`/`onSelectIndex` are optional and
default to plain hover-only behavior when omitted, so those pages are unaffected.

**Tooltips removed app-wide.** The shared `[data-tooltip]` CSS hover box + native `title`
fallback (`index.css`, `PrimaryButton`/`SecondaryButton`/`IconButton`/`ToggleSwitch`/
`StatusBadge`/`DeltaBadge` in `components/ui/index.jsx`) is gone — those components still
accept (and silently discard) a `tooltip`/`title` prop so existing call sites don't need
touching, but nothing renders it. Every native-element `title="…"` hover hint (buttons,
badges, truncated cells) was removed at each call site individually. `title`/`subtitle`
props on `PageHeader`, `SectionHeading`, `StatTiles`, `SalesMixBar`, `StatusOverlay`,
`AuditSummary`, `SupervisorApprove`, etc. are a different thing — visible heading text, not
a tooltip — and were left alone.

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

**Authoritative state is always PostgreSQL.** Broadcast payloads are notifications only
(event name + branch_id + product_id/version or kind). Clients must refetch via `api.js`
(RLS/RPC). Never apply broadcast quantities or financial fields as truth.

```
DB trigger / realtime.send (security definer)
   │ private topics:
   │   pos:branch:<uuid>:inventory   → INVENTORY_CHANGED | CATALOG_CHANGED
   │   pos:branch:<uuid>:operations  → OPERATIONS_CHANGED
   │   pos:network:operations        → OPERATIONS_CHANGED (managers only)
   ▼
Supabase Realtime Authorization (realtime.messages RLS via staff_can_subscribe_branch /
is_manager) — channel name is NOT a security boundary
   ▼
src/offline/realtime.js  subscribeBroadcast (+ subscribeTable for promo child tables)
   → debounce → secured refetch
   ├─► useLiveData — Broadcast primary; postgres_changes optional; visibility/online/poll fallback
   │     ├─► POS.jsx inventory topic → fetchBranchProducts / mergeProducts
   │     ├─► POS.jsx promos still on postgres_changes (promo_events/rules/rule_products)
   │     ├─► BranchDashboard / DayEnd → operations topic → reload
   │     └─► RequestNotifications → network (manager) or branch operations (supervisor)
```

**Required SQL:** `migrate_realtime_broadcast_v1.sql` (private Broadcast + inventory
`change_version` + tighten inventory writes + append-only audit policies) + `migrate_sale_ops_broadcast.sql`
(attaches the same ops trigger to `transactions` — without it, a new sale/void/refund only
reaches other open tabs via the 15s poll fallback, not immediately). Also enable
**Realtime Authorization** in the Supabase dashboard (private channels). Keep
`migrate_enable_realtime.sql` for promo postgres_changes publication.

**Reconnect:** socket rebuild + `SUBSCRIBED` refetch + existing `syncBranch` / queue drain.
Broadcast does **not** replay gaps — poll/focus/sync repair local state.

| Piece | File |
|-------|------|
| Subscribe/backoff/debounce + private Broadcast | `src/offline/realtime.js` |
| Layered freshness hook | `src/hooks/useLiveData.js` |
| Deploy-staleness watchdog | `src/hooks/useAppVersion.js` + `versionJsonPlugin` in `vite.config.js` |
| Update banner | `src/components/shared/Shell.jsx` |
| Products live refresh | `src/lib/api.js` `fetchBranchProducts()`, `useProductStore.mergeProducts` |
| Schema | `supabase/migrate_realtime_broadcast_v1.sql` (+ `migrate_enable_realtime.sql` for promos) |

**Deploy staleness:** counter terminals stay open for days. `useAppVersion` polls `/version.json` and shows Shell's update banner; auto-reload only when cart/queue are safe.

---

## Restaurant / carinderia (archived)

**Disabled** for meat + retail focus. Gate: `src/utils/features.js`
`RESTAURANT_FEATURES_ENABLED`. Archive notes: `docs/archive/restaurant-features.md`.
Do not delete `src/utils/ulam.js` (`lineTotal` is shared with retail).

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

## Design tokens & theming

| Topic | File |
|-------|------|
| All color/font tokens (`@theme` block) | `src/index.css` |
| Light values | `:root { }` in `src/index.css` |
| Dark-mode overrides | `:root[data-theme="dark"] { }` in `src/index.css` |
| Theme preference (per-device, not synced) | `src/stores/themeStore.js` (`localStorage: calepos_theme`) |
| Flash-of-wrong-theme guard | inline `<script>` in `index.html` `<head>` |
| Appearance setting UI | `src/pages/settings/SharedPanels.jsx` (`AppearancePanel`) |

Rebrand is a **values-only** change — token *names* (e.g. `--color-brand-gold`) don't change,
only their hex. Current direction is the original: warm neutral canvas, gold accent
(`#e9b949`), always-dark chrome. New UI still follows the existing rule at the top of
`index.css`: pick a token by role, never inline a hex.

Every card/panel/modal/input surface in the app must use `bg-brand-card`, never raw
`bg-white` — before dark mode existed, ~90 spots across the codebase used literal
`bg-white` (harmless when the app was light-only), which stayed stubbornly white in dark
mode while their `text-brand-*` content correctly went light-on-dark, producing illegible
washed-out cards. `--color-brand-card` (and `search`) are deliberately a soft off-white in
light mode, not pure `#fff` (matches `n50`) — a page built from ~90 stark-white cards on a
barely-different canvas read as glaring. `bg-white` is still correct for two specific things
that should NOT use `--color-brand-card`: a translucent wash over already-dark chrome
(`bg-white/10` etc. — the opacity variant, not solid) and `ToggleSwitch`'s knob (a fixed
white circle regardless of theme, standard switch convention). Solid `bg-brand-gold` fills
use `text-brand-on-gold` for their label/icon (dark text — gold is light) rather than a
hardcoded color, so a future accent swap only touches this one token again.

Sidebar/topbar/table-header chrome (`--color-brand-dark`, `-panel`, `-dark-inset/hover/active`,
`--color-brand-ondark*`) is **fixed-identity, always dark** — it does not flip with the
Appearance toggle, same as the POS cart panel's `--color-brand-cart-*` tones, `NumPad`'s
keypad, and `--color-brand-gold`/`-on-gold`/`--color-brand-sync-*`/`--color-brand-meat*`.
Only the canvas/card/ink/search surfaces (and the neutral scale) re-theme via
`:root[data-theme="dark"]`.

"Currently active" pill/tab/toggle states (period selectors, payment-method picker, filter
chips, `ToggleSwitch`-adjacent one-off buttons) use `border-brand-gold bg-brand-gold
text-brand-on-gold` — the same accent language as `PrimaryButton` and the active nav link.

Type is a single family, Open Sans, in both `--font-sans` (body/UI, the default) and
`--font-display` (headings, via a global `h1, h2` rule, not `h3` which is small tracked-out
micro-labels — same weight system, same face). `--font-mono` (IBM Plex Mono) stays a
distinct utility face for tabular money/qty/OR-number figures, via `moneyClass`/`<Money>`
in `components/ui/index.jsx`.

Printed output (`src/utils/receipt.js`, `src/utils/terminalReports.js`) renders its own
standalone HTML with hardcoded colors, intentionally outside the token system — printed
receipts stay legible on paper regardless of the on-screen theme.

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
| Offline OR reserve on sync | `migrate_offline_or_reserve.sql` (`reserve_or_number`) |
| Refunds | `migrate_refund_sale_items.sql`, `migrate_refund_amount_on_transactions.sql` |
| Import batches (managers + branch staff write) | `migrate_import_batches.sql`, `migrate_import_batches_branch_staff.sql` |
| Ulam / restaurant | `migrate_ulam_ordering.sql` |
| Devices / presence | `migrate_device_settings.sql`, `migrate_branch_presence.sql` |
| Petty cash rename | `migrate_rename_petty_cash_to_cash_drawer_entries.sql` |
| Cash movements (POS Open Drawer) | `migrate_cash_movements.sql`, `migrate_cash_movement_cash_in.sql`, `migrate_cash_movement_self_approve.sql` (supervisor+ self-approve) |
| Cart remove / till action notify | `migrate_till_action_requests.sql` |
| Manager cross-branch approve | `migrate_manager_can_approve_any_branch.sql` |
| PIN lockout hardening | `migrate_pin_security_hardening.sql` |
| Per-line discount tracking | `migrate_discountable_transaction_items.sql` |
| Hot-table perf indexes | `migrate_perf_indexes_hot_tables.sql` (run each `CREATE INDEX CONCURRENTLY` statement individually — cannot run inside a transaction block) |
| Multiple concurrent promos + per-line attribution | `migrate_promo_multi_active.sql`, `migrate_promo_line_attribution.sql` |
| Schema cleanup (drop promo `is_active`, duplicate client_id index, dormant shift-review, tighten refund RLS) | `migrate_schema_cleanup_v1.sql` |
| Manager Overview one-shot aggregates | `migrate_network_manager_overview.sql` (`manager_overview_metrics`), `migrate_fix_manager_overview_revenue_net.sql`, `migrate_fix_overview_cash_impact_carry.sql`, `migrate_fix_overview_cash_impact_movements.sql` |
| Promo auto-expire | `migrate_promo_auto_expire.sql` |
| VAT breakdown (BIR) | `migrate_vat_breakdown.sql` |
| Realtime (live POS/notification updates) | `migrate_enable_realtime.sql`, `migrate_realtime_broadcast_v1.sql`, `migrate_sale_ops_broadcast.sql` (transactions on the ops trigger) |
| Function `search_path` pin | `migrate_function_search_path_v1.sql` |
| Duplicate-index drop + hot FK indexes + RLS initplan | `migrate_perf_fk_indexes_v1.sql` |
| Company TIN + per-branch BIR branch code | `migrate_company_tin.sql` |
| Idle auto-lock minutes (5/10/15) | `migrate_idle_lock_minutes.sql` |
| Petty cash `fulfilled` state (+ rewrites `close_staff_shift`/`shift_cash_summary`) | `migrate_petty_cash_fulfilment.sql` |
| Master force sign-out of a stuck session | `migrate_admin_session_release.sql` |
| Atomic checkout RPC (till + OR + transaction + items + stock + audit in one transaction) | `migrate_complete_sale_rpc.sql` |
| Login perf: skip redundant password rehash | `migrate_login_conditional_rehash.sql` |
| **Anon/public EXECUTE revoked on core sale RPCs (critical)** | `migrate_revoke_anon_sale_rpc_grants.sql` |

Run migrations in the Supabase SQL editor; respect comments about order / dependencies.

**RLS pattern:** branch staff → `current_staff_branch()`; managers → `is_manager()` across branches.

**Grant SECURITY DEFINER RPCs to `authenticated` explicitly, and always check they end up
`anon`-denied.** Postgres grants `EXECUTE` to `PUBLIC` on every new function by default —
`grant ... to authenticated` alone does NOT revoke that default, so a function with no
explicit `revoke ... from public, anon` stays callable by the anon/publishable key with zero
login. `allocate_or_number`, `reserve_or_number`, `void_sale_secure`, `refund_sale_items`,
and `record_stock_movement` shipped this way for a long time before `get_advisors`
(`anon_security_definer_function_executable`) caught it — see
`migrate_revoke_anon_sale_rpc_grants.sql` for the fix and full blast-radius writeup. Two of
those four also had no in-function branch/staff check at all (relying solely on the grant),
and `record_stock_movement`'s check used `<>` instead of `IS DISTINCT FROM`, which is
NULL-unsafe: an anon caller has no matching `staff` row, so `current_staff_branch()` returns
NULL and `NULL <> p_branch_id` is NULL, not `true` — the `raise exception` never fires.
`complete_sale()` (`migrate_complete_sale_rpc.sql`) uses `IS DISTINCT FROM` and is explicitly
revoked from `public, anon`. **Any new client-callable SECURITY DEFINER RPC must do both**:
an `IS DISTINCT FROM`-based branch/staff check, and an explicit `revoke all on function
...(...) from public, anon` right after its `grant ... to authenticated`. Run
`get_advisors(type: security)` after adding one and confirm it stops appearing under
`anon_security_definer_function_executable`.

**`staff` stores `login_pin` and `auth_secret` in PLAINTEXT.** RLS is row-level, not
column-level, so any policy letting a role SELECT a staff row lets it read that row's PIN.
That is why supervisors read the roster through `branch_staff_roster()`
(`migrate_branch_staff_roster.sql`) — a definer function with an explicit safe column list —
rather than a widened `read staff` policy. Managers reveal a till PIN only through
`reveal_staff_pin()` (`migrate_reveal_staff_pin.sql`), not a client-side `SELECT login_pin`.
Client-callable SECURITY DEFINER RPCs must enforce scope in-function — see
`migrate_security_definer_hardening_v1.sql` and `supabase/audit_security.sql` §4.
Public functions should `SET search_path = public` (`migrate_function_search_path_v1.sql`;
audit §7).
Never "simplify" it into a policy change, and never add a secret column to the roster
function's select list.

**Schema cleanup (`migrate_schema_cleanup_v1.sql`):** `promo_events.is_active` removed
(status-only); duplicate `(branch_id, client_id)` unique index dropped (re-drop in
`migrate_perf_fk_indexes_v1.sql` if `migrate_sale_dedupe_hardening.sql` was re-run); dormant
`closed_without_supervisor` / `acknowledge_shift_review` removed; `refund_requests` has no
client UPDATE policy (RPC-only mutations); `sale_events`/`audit_events` RLS uses
`is_manager()` / `current_staff_branch()`. App: `voidSale` is RPC-only; cash drawer reads
`cash_drawer_entries` only (no `petty_cash` fallback).

### Environments (dev vs production)

`src/utils/environment.js` reads `VITE_APP_ENV` and derives the Supabase project ref from
`VITE_SUPABASE_URL`. Anything not `production` renders a badge in `Shell.jsx` and
`Login.jsx` naming the database actually being written to. An unset value resolves to
`development` — the dangerous case must never be the quiet default. Setup instructions:
`pos-frontend/README.md` → *Environments*.

### Load-test user provisioning

`npm run setup:load-test` (`scripts/setup-load-test-users.mjs`) provisions the accounts the
28/50/100/200-user stress tests log in as: 7 branches × (1 supervisor + 3 cashiers) = 28
accounts, idempotent (safe to re-run; existing accounts are reused, PINs are not rotated).
It reads Supabase connection details from `.env.test` (gitignored; template in
`.env.test.example`), which must point at a **dedicated load-test Supabase project** — never
`calepos-dev`/`calepos-staging`/production — enforced by a required `SUPABASE_TEST_CONFIRM`
literal in that file. The script uses `auth.admin.createUser()` (service role key, Node-only,
never bundled into the frontend) so account creation bypasses the Turnstile captcha check
entirely; the load-test *traffic* itself still needs a Turnstile site key wired to the
target project — `.env.test.example` documents Cloudflare's official test key pair for that.
Generated login codes/PINs are written back into a marked block in `.env.test` (not printed
in full to the terminal).

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
| Sidebar links | `nav.js` + `Shell.jsx` + `SidebarNav.jsx`; drag order in `utils/navOrder.js` |
| Settings (company TIN, VAT, auto-lock, security activity, sync) | `pages/Settings.jsx` + `pages/settings/*` + `utils/sessionPolicy.js` |
| Terms / Privacy Policy | `pages/Legal.jsx` + `src/legal/{meta,terms,privacy}.js` — public `/legal/terms` and `/legal/privacy`; linked from Login and Settings → About |
| Network device status (manager/master) | `pages/Devices.jsx` + `api.fetchBranchTelemetry` |
| Staff roster / shift log / hours | `manager/Staff.jsx` (merged tab) |
| Refund totals | `TransactionDetailModal.jsx` + refund migrations |
| Day-end cash / Drawer Activity | `DayEnd.jsx`, `DrawerActivity.jsx` |
| Branch day-end closing detail | `BranchDashboard.jsx` + `dayend/DayEndClosingDetail.jsx` |
| Reprint a branch receipt | `BranchDashboard.jsx` Recent receipts → `TransactionDetailModal` Print |
| POS Open Drawer (petty/pickup) | `OpenDrawer.jsx`, `POS.jsx` |
| Cart line remove approval | `CartRemoveApprove.jsx`, `SupervisorPinWait.jsx` |
| Cash movements (Open Drawer) | `components/pos/OpenDrawer.jsx`, `components/dayend/DrawerActivity.jsx` |
| Staff roster / shift log / hours | `manager/Staff.jsx` (merged tab) |
| Staff create/edit modal / till PIN | `manager/Staff.jsx` + `utils/pin.js` (6-digit PIN); Modal `footer` in `ui/index.jsx` |
| Modal scroll vs action bar | `components/ui/index.jsx` (`Modal` / `ModalActions` / optional `footer`) |
| TIN on receipts / reports | `api.composeTin` + `fetchBranches` `full_tin`; edit company TIN in Settings → Business Information |
| Stuck "already signed in" | `api.fetchActiveSessions` / `forceReleaseStaffSession` |
| Receipt layout | `receipt.js` |
| New report | `manager/Reports.jsx` |
| New table/RPC | `supabase/migrate_*.sql` + `api.js` |

---

## Roles → typical surfaces

| Role | Login | Main areas |
|------|-------|------------|
| Cashier | PIN (6 digits) | POS, Transactions, Inventory (view/adjust), Day end, Devices |
| Supervisor | PIN (6 digits) | Same + Shifts (branch) + **Products `/data`** (add/import) |
| Manager | Email | Overview, Branches, Staff, Devices (network status), Data, Reports |
| Master | Email | Manager + staff routes combined (sole top account; `admin` role retired) |

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
  - Inventory section has **On hand | Movement history** subtabs; movement tab uses
    `MovementHistoryPanel` with `compact` (smaller page, no CSV export, defaults to Today).
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
- **Manager tab UI:** `src/pages/manager/Promos.jsx` + `src/components/promos/PromoEditorModal.jsx` (create/edit + rules modal)
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
- **Duplicate-rule guard is scoped per rule type.** `handleAddRule` blocks adding a product to a
  *second rule of the same `ruleType`* on the same event (ambiguous authoring — which % would
  apply?), but a product CAN sit in an `item_pct` rule AND a `pair_pct` rule AND a `bundle_pct`
  rule at once on the same event — `computePromoDiscounts` already resolves any overlap
  (same-event or cross-event) by taking the best line discount per product, never stacking, so
  blocking that combination at authoring time was stricter than the runtime engine needs.
- **Inactive branches never appear in a promo branch picker.** Every branch dropdown/checklist
  across the promo flow filters `is_active !== false`: `Promos.jsx`'s top branch filter,
  `PromoEditorModal`'s single "Branch" picker, its "Also create on" multi-select, and the
  "Add to branch" checklist — an inactive branch has no one running a live catalog to manage or
  SKU-match against.
- **Multi-branch promo create.** `PromoEditorModal`'s create flow (network view, no branch
  pre-selected) shows a "Also create on" checklist of the other active branches once a reference
  branch is picked; submitting with any checked
  calls `createPromoAcrossBranches` (`api.js`) instead of `createPromoWithRules`. Rules are
  matched onto each target branch by **SKU** (not product id — `products` rows are per-branch,
  per **Network catalog vs branch products** below); a branch missing a SKU just drops that
  product from its copy of the rule, and a rule that falls below its minimum product count on a
  branch (e.g. only one side of a pair matched) is skipped for that branch only. Nothing is
  created on a branch where every rule ends up empty. The modal reports a summary ("Created on N
  of M branches. Skipped: ...") via `onSaved(summary)`, shown as a success banner on `Promos.jsx`.
- **Add an existing promo to more branches later.** For the case of a branch left out of the
  original multi-branch create, or one that only just adopted the products — the branch-specific
  Managing panel (`Promos.jsx`, `managerView` only) has an **Add to branch…** button next to
  Stop/Approve on the currently-managed live promo. It opens a checklist of other active branches
  and calls `copyPromoEventToBranches` (`api.js`): reads the source event's name/dates + its rules
  (`fetchPromoRulesForEvent`, which already carries `sku` per product) and fans them out through
  the same `createPromoAcrossBranches` SKU-matching path — each target branch gets a fresh
  `pending` promo needing its own approval, same dual-control as any other create. Not exposed to
  supervisors: a non-manager write to another branch's `promo_events` is rejected by RLS
  (`managers manage promo events` policy only allows a supervisor within their own branch), so the
  action is gated to `managerView`.
- **Rules visible on the Managing panel.** `activeEvents` (from `fetchActivePromoEventsWithRules`)
  already carries each event's `rules` (rule type, discount %, bundle name, and per-product
  name/SKU) — the branch-specific "Managing" selector now renders them in a read-only table below
  the Stop/Approve/Add-to-branch row, so a manager can see what's actually on a live promo without
  opening the edit modal. Same rules table (read-only here, with a Delete action in
  `PromoEditorModal`) — `expandPromoRuleRows` (`utils/promo.js`) gives `item_pct` its own row per
  product (they're independent discounts, no pairing/bundling between them, unlike pair/bundle/
  BOGO which stay one row for their one linked set); `PromoEditorModal`'s Delete button only
  renders on a group's first row (`isFirstOfGroup`) since deleting still removes the whole
  authored rule, not one product out of it.
- **Errors route through the shared catalog.** `Promos.jsx` and `PromoEditorModal.jsx` use
  `formatSupportError(err, 'PROMOxx')` (`utils/errors.js`) instead of showing `err.message`
  directly — codes `PROMO01`–`PROMO08` cover create / rule save / edit-save / approve / reject /
  stop / load / delete. The Stop and Reject confirmation modals also now render the error banner
  *inside* the modal (they didn't before — a failed reject/stop set page-level `error` state that
  was invisible behind the modal's full-screen scrim, which read as the action silently doing
  nothing).
- **Required-field highlighting.** `Field`/`SelectField` (`components/ui/index.jsx`) take an
  optional `error` prop (string or `true`) that red-borders the input and prints a small message
  underneath (`aria-invalid` set too) — additive, every other call site is unaffected. Wired up on
  `PromoEditorModal`'s required fields (promo name, dates, branch, bundle name, pair/BOGO product
  pickers) and the Stop/Reject reason fields, gated behind a `formAttempted`/`ruleAttempted`/
  `stopAttempted`/`rejectAttempted` flag set on submit click rather than a silently-disabled
  button, so the user sees *why* nothing happened. `handleSubmit` clears `ruleAttempted` before
  its own validation runs — submitting the promo abandons whatever's sitting in the "add rule"
  staging fields, so an earlier failed "Add rule" click doesn't leave that picker red forever
  once the manager's actually done and just submitting. Not yet swept across the rest of the app.
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
- **Create from the network view.** Managers open **Create promo** from the network overview (no branch chosen) — branch is picked inside `PromoEditorModal`.
- **Page order:** branch selector → network active promos + **Promo performance** (no branch) → pending requests → Live promos + **Create/Request promo** button → **Promo performance** summary table (per-branch). Create/edit + rules live in `PromoEditorModal` only — not inline on the page.
- **Rules required before approval.** `approve_promo_event` rejects pending promos with zero rules (`migrate_promo_edit_reapproval.sql`). Create/edit modal blocks submit until ≥1 rule is staged.
- **Freeze after approve.** `active` / `stop_pending` promos cannot add/delete rules or change name/dates/description via `updatePromoEventDetails` / `createPromoRule` / `deletePromoRule` (API guards + UI hides direct edit actions).
- **Edit requires reapproval.** Live promos use **Request edit** → RPC `request_promo_edit` clones event + rules into a new `pending` row (`supersedes_event_id`). Original stays live until the revision is approved; approve stops the superseded event then activates the revision.
- **Promo performance (branch + network).** `StatTiles` summary (promos run, discount given, receipts, discount % of sales) + sortable comparison table (name, rule type, date range, receipts, discount, discount %). Sales `...` drill-down unchanged (`fetchPromoSalesStats`). Network view adds Branch column + `SalesMixBar` by rule type. Helpers: `fetchBranchSalesTotal`, `fetchNetworkSalesTotal`, `fetchPromoRuleTypesForEvents`, `summarizePromoRuleTypes` (`utils/promo.js`).

---

## Promo subsystem — implementation notes

### Query pagination — unbounded selects must use fetchAllRows
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

### `catalog_product_id` link integrity (Discountable not reaching POS)
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

### Live-update, VAT/SC-PWD, and Promos UI notes
- **Layered live-update system** — `useLiveData` hook + hardened `subscribeTable` (status
  callback, exponential-backoff resubscribe, refetch-on-reconnect) + `useAppVersion` deploy
  watchdog with `/version.json`. See the "Realtime / live updates" section above.
- **One-discount SC/PWD + VAT model** — promo now sets the base instead of being discarded
  when SC/PWD is applied; full per-line audit trail in checkout. See "VAT + SC/PWD" above.
- **Promo rename (historical note).** Renaming no longer applies to live promos — use **Request edit** + reapproval. Pending revisions and new creates are renamed inside `PromoEditorModal`. Past `transaction_items.promo_name` values are never rewritten.
- **Live-promo header** — dropped the redundant "Active" badge (everything in that dropdown
  is live, and the option label already says Active vs Stop pending); Stop / Approve stop
  sit right-aligned on the selector row instead of stacked underneath.
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

### Permissions, catalog cascade, and promo lifecycle notes
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
- **Edit dates on live promos (superseded).** Live promos no longer expose direct Modify/Rename/Edit description — **Request edit** opens a pending revision in `PromoEditorModal`; approval replaces the live event via `supersedes_event_id`.
- **Promo description** — `promo_events.description` (`migrate_promo_description.sql`, nullable text). Set on create (optional textarea next to Name) or afterwards via Promo History's row menu → **Edit description**, both through the same partial-update `updatePromoEventDetails`/insert path as name/dates — a description-only edit never touches schedule or approval state. Shown under the promo's name in Promo History; not read by the discount engine, not shown to customers. `createAndActivatePromoEvent` and `fetchPromoEventsForBranch` fall back to omitting the column if the migration isn't applied yet (same `isMissingColumnError` pattern as other optional columns in this file).
- **Promo History date filter** — From/To `<input type="date">` above the history table, filtering client-side on `starts_at`'s date (not `created_at` — a manager picking a range means "promos that ran then", not "rows I made then"). Pure UI filter on the already-fetched `history` array; no new query.
- **Promo History actions collapsed into a "⋯" menu** — the row used to lay out 4-8 inline text buttons (Sales, Approve/Reject, Approve/Reject stop, Modify, Rename, Edit description, Delete) side by side; same actions now live in a per-row dropdown (`openActionsId` state, closed by a full-screen click-away `div`). No action's behavior changed, only where it lives. The dropdown itself renders through a `createPortal(..., document.body)` with `position: fixed` computed from the trigger button's `getBoundingClientRect()` (`actionsAnchor` state) rather than `position: absolute` inside the row — the table's own scroll wrapper needs `overflow-x-auto` for wide screens, and per the CSS overflow spec, `overflow-x: auto` with `overflow-y: visible` still computes `overflow-y` to `auto` (clipping), not `visible`. An absolutely-positioned dropdown there was silently clipped to invisible for rows near the wrapper's edge — same root cause if a future popover in a horizontally-scrolling table goes invisible with no console error.
- **Stop reason was already implemented** — a reason is required when requesting or executing a stop (`request_stop_promo` RPC, `stop_reason` column) and already rendered in Promo History under the status badge. This predates the description/date-filter work above; don't re-add it.

### Multiple concurrent promos
**Required SQL migration:** run `pos-frontend/supabase/migrate_promo_multi_active.sql` (drops the one-live-promo-per-branch unique index and stops `approve_promo_event()` from deactivating sibling promos).

- **SQL/RPC:** `migrate_promo_multi_active.sql` — no more single-active constraint or forced deactivation on approve.
- **API** (`src/lib/api.js`): `fetchActivePromoEventsWithRules(branchId, opts)` returns **all** live events for a branch as `[{ event, rules }]`. `fetchActivePromoEventWithRules(branchId, opts)` is kept as a back-compat wrapper returning just the first one.
- **Conflict policy** (`src/utils/promo.js` `computePromoDiscounts`): each rule computes its own line-discount contribution in isolation, then the **highest discount per line wins** across all rules/events — offers never stack on one line. The function also returns `linePromoNames` (which event won each line) and `appliedEventNames` (distinct event names actually applied) for attribution.
- **POS** (`src/pages/POS.jsx`): `activePromos` (array) replaces the old single `activePromo`. Rules from every live event are flattened into one `promoRules` list, each tagged with its own `eventName`, then merged via `buildPromoByProductId` (best % per product wins) for tile pricing/badges.
- **Cart** (`src/components/pos/Cart.jsx`): no longer takes a single `promoLabel` prop — it derives the discount label itself from `computePromoDiscounts`' `appliedEventNames` (joined, e.g. "Valentines + Payday Sale"), and per-line breakdown rows show the actual promo that won that line via `linePromoNames`. The "Promo ended — … Re-quote" banner only fires when an event name that was pricing a still-present line has left the live `promoRules` set (real expire/stop) — not when removing a line or breaking a BOGO/bundle threshold merely drops eligibility on remaining items.
- **Promos UI** (`src/pages/manager/Promos.jsx`): `activeEvents` (array, was `active` singular) renders one card per live promo with its own Stop/Approve-stop controls. `managingId` + `managedEvent` track which live event's rules/sales-stats panel is currently shown ("Manage rules" button per card); a fresh pending draft (`workingEvent`) always takes priority for rule-building over an already-live event, so creating promo B while promo A is still live doesn't block adding rules to B.

**Mixed-cart reporting fix:** `transactions.discount_type` is still a single text column (joined label like "Promo A + Promo B" when a cart mixes promos) — exact-matching that per promo would undercount mixed carts. Fixed via **per-line attribution**: `migrate_promo_line_attribution.sql` adds `transaction_items.promo_name` (which promo won that specific line, null for PWD/Senior/undiscounted). `src/lib/api.js` `fetchPromoSalesStats` attributes by that column (paged query on `transaction_items` with `promo_name = promoName` + branch/date join on `transactions`, then derives receipts from matched lines) instead of scanning up to 1000 discounted receipts first. Sales drill-down groups lines into **offers** (`aggregatePromoSalesOffers` in `utils/promo.js`) — bundle name, Buy 1 take 1, pair, item % — using `promo_group_id` + event rules, not a flat SKU list. `fetchPromoSalesStatsLegacy` (same file) is the pre-migration fallback and is used automatically if the `promo_name` column doesn't exist yet.
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
- **Approval overlays:** `paying && <StatusOverlay ...>` + `removeIndex != null && <CartRemoveApprove ...>`
- **Barcode mode layout:**
  - `barcodeMode ? (...) : (...)`
  - Inside barcode mode:
    - **Left rail:** scrollable cart item list + per-line discount notes
    - **Right rail:** subtotal/discount/VAT/total + `Checkout` button
