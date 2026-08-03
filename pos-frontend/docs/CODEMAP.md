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
| API | `closeDayEnd`, `reopenDayEnd` |
| Dates / open hour | `src/utils/format.js` |

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
| Reports | `/manager/reports` | `manager/Reports.jsx` |

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
