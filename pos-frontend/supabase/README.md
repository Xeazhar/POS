# Supabase SQL layout

## What to run where

| File | Purpose |
|------|---------|
| `schema.sql` | **Canonical full schema** for new projects (tables + RLS + core functions). Keep organized; update when you add features. |
| `migrate_*.sql` | **One-shot patches** for databases that already exist. Run in order if a column/table is missing. Do not delete old migrations after they’ve been applied in production. |

## Recommended apply order (existing project)

1. Already applied base + older `migrate_*.sql` files (leave them).
2. Run any **new** migrations you haven’t applied yet, e.g.:
   - `migrate_pin_security_hardening.sql` (PIN lockout + no password leak)
   - `migrate_promos_supervisor_branch_scope.sql`
   - `migrate_staff_shift_period.sql` (AM/PM on clock-in)
   - `migrate_day_end_dual_control.sql` (submit → approve close, immutability)
   - `migrate_promo_dual_control.sql` (promo create/stop need manager approval)
   - `migrate_promo_description.sql` (adds `promo_events.description`, shown in Promo History)
   - `migrate_staff_active_session.sql` (one active login + lock-screen PIN verify)
   - `migrate_network_product_catalog.sql` (shared catalog; supervisors adopt to branch)
   - `migrate_catalog_branch_type.sql` (retail vs restaurant catalog filter)
   - `migrate_rename_petty_cash_to_cash_drawer_entries.sql` (**only this one** for change fund / petty cash / cash drawer — creates `cash_drawer_entries` + columns; do not also run `migrate_cash_accountability_controls.sql`)
   - `migrate_manager_can_approve_any_branch.sql` (managers may PIN-approve any branch; supervisors stay branch-scoped)
   - `migrate_shift_cash_accountability.sql` (per-shift change fund, one shift per drawer, `transactions.shift_id`, `shift_adjustments`). Needs `migrate_refund_amount_on_transactions.sql` and the cash-drawer migration above first — it checks and refuses rather than half-applying. **Apply outside trading hours:** it enforces one open shift per drawer and clocks out any extra shifts that are already open.
   - `migrate_day_end_supervisor_autoclose.sql` (a supervisor's own day-end submission closes immediately instead of waiting on a separate approval step). Needs `migrate_day_end_dual_control.sql` first.
   - `migrate_shift_close_no_supervisor_flag.sql` (lets a cashier close their own shift when no supervisor/manager can reach the till, flagged `closed_without_supervisor` for a manager to review remotely). Needs `migrate_shift_cash_accountability.sql` first.
   - `migrate_sync_catalog_identity_fields.sql` (one-time catch-up: pushes name/SKU/barcode/category from network-catalog edits made before the live per-save cascade existed down to branches that already adopted the item; price is deliberately excluded — see file header. Safe to re-run.)
   - `wipe_products_clean_start.sql` (**destructive**) — wipe products + catalog for a fresh import
   - etc.

## Table map (mental model)

```
branches
  ├─ staff (+ pin login / permissions / active_session_id)
  ├─ catalog_products (network master) → products (per-branch adopt) → branch_inventory
  ├─ transactions → transaction_items
  ├─ promo_events (status: pending|active|stop_pending|…) → promo_rules → promo_rule_products
  ├─ day_ends
  ├─ import_batches → import_batch_items
  ├─ cash_drawer_entries (ex petty_cash) → staff_shifts (change fund, cash-out, variance)
  │     └─ shift_adjustments (logged corrections to a closed shift)
  ├─ branch_presence, branch_devices
  └─ sale_events, audit_events (BIR / audit)

pin_login_attempts   ← lockout only (no client access; security definer RPCs)
```

## PIN security

- Till PIN is complex (letters + numbers + symbols) — enforced in app UI.
- `resolve_pin_login` returns **auth email only** (never Auth password).
- Failed attempts recorded in `pin_login_attempts` (5 fails → 15 min lock).
