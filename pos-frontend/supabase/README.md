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
   - etc.

## Table map (mental model)

```
branches
  ├─ staff (+ pin login / permissions)
  ├─ products → branch_inventory, stock_movements
  ├─ transactions → transaction_items
  ├─ promo_events → promo_rules → promo_rule_products
  ├─ day_ends
  ├─ import_batches → import_batch_items
  ├─ petty_cash, staff_shifts
  ├─ branch_presence, branch_devices
  └─ sale_events, audit_events (BIR / audit)

pin_login_attempts   ← lockout only (no client access; security definer RPCs)
```

## PIN security

- Till PIN is complex (letters + numbers + symbols) — enforced in app UI.
- `resolve_pin_login` returns **auth email only** (never Auth password).
- Failed attempts recorded in `pin_login_attempts` (5 fails → 15 min lock).
