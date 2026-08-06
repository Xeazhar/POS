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
  │     logout → clockOut? → useAuthStore.logout → clear cart
  │
  ├─ Pages ……………………… src/pages/*
  │     read/write Zustand stores
  │     call src/lib/api.js when online
  │
  ├─ Zustand stores ……… src/stores/posStore.js (+ syncStore.js)
  │     useAuthStore · useCartStore · useProductStore · useInventoryStore
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
| `/inventory` | `src/pages/Products.jsx` | staff inventory/menu operations |
| `/data` | `src/pages/manager/Data.jsx` | supervisor branch catalog tools |
| `/day-end` | `src/pages/DayEnd.jsx` | close day, petty cash, change fund, pickup |
| `/settings/devices` | `src/pages/Devices.jsx` | staff device awareness |
| `/shifts` | `src/pages/Shifts.jsx` | staff/supervisor branch shift view |
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
5. Optional clock-in: login may set `pendingClockIn` → modal in `Shell.jsx` → `clockIn` → `staff_shifts`.

### Permissions

- Defaults: `roles.js` → `DEFAULTS[role]`.
- Override: `user.permissions` array from Staff page / DB.
- Check: `canAccessModule(user, moduleId)` (admin/master always true).
- Nav filters the same way in `staffLinksFor` / `managerLinksFor`.

### Logout

1. Shell `requestLogout`.
2. Cashiers/supervisors with open shift → must **End shift & sign out** (`clockOut`).
3. `useAuthStore.logout` + cart clear so retail/restaurant carts never bleed across sessions.

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

## Shifts

```
Login → optional clockIn → staff_shifts (open)
POS / work …
Logout → if open shift → clockOut → then logout

Viewing:
  Supervisor /shifts → fetchStaffShifts({ branchId: own })
  Manager /manager/shifts → fetchStaffShifts({ branchId: filter or all })
```

| Piece | File |
|-------|------|
| UI | `src/pages/Shifts.jsx` |
| API | `api.js` → `clockIn`, `clockOut`, `fetchOpenShift`, `fetchStaffShifts` |
| Table | `staff_shifts` (in finance/roles migration) |

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

---

## Day end & cash

```
Sales during day → expected cash (sales − voids/refunds ± petty/pickup/float)
DayEnd.jsx → closeDayEnd RPC → day_ends row
Till locked until reopen (manager) or next business date (format.js businessDate)
Cart soft nudge after ~8 PM or last 2h before openHour+14h
```

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

## Shared utilities

| Need | File |
|------|------|
| Money, qty, business date, stockTone | `src/utils/format.js` |
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
| Unique login codes | `migrate_staff_login_code_unique.sql` |
| PIN auth fix | `migrate_fix_pin_login_auth.sql` |
| BIR / sale immutability | `migrate_bir_pos_compliance.sql` |
| Refunds | `migrate_refund_sale_items.sql`, `migrate_refund_amount_on_transactions.sql` |
| Import batches (managers + branch staff write) | `migrate_import_batches.sql`, `migrate_import_batches_branch_staff.sql` |
| Ulam / restaurant | `migrate_ulam_ordering.sql` |
| Devices / presence | `migrate_device_settings.sql`, `migrate_branch_presence.sql` |

Run migrations in the Supabase SQL editor; respect comments about order / dependencies.

**RLS pattern:** branch staff → `current_staff_branch()`; managers → `is_manager()` across branches.

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
| Day-end cash | `DayEnd.jsx` |
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
- **Active promo fetch in POS:** `src/pages/POS.jsx`
  - `useEffect` calls `fetchActivePromoEventWithRules(branchId)`
  - `Cart` receives `promoRules` + `promoLabel`
- **Promo discount engine:** `src/components/pos/Cart.jsx`
  - `pricing = useMemo(...)`
  - applies promo discounts only when PWD/Senior is *not* selected

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
