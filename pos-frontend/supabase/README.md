# Supabase SQL layout

## What to run where

| File | Purpose |
|------|---------|
| `schema.sql` | **Canonical full schema** for new projects (tables + RLS + core functions). Keep organized; update when you add features. |
| `migrate_*.sql` | **One-shot patches** for databases that already exist. Run in order if a column/table is missing. Do not delete old migrations after they’ve been applied in production. |

## Known drift: `schema.sql` is stale

`schema.sql` has not been kept in sync with the `migrate_*.sql` files — entire
subsystems (`staff_shifts`, `cash_drawer_entries`, day-end request/reject, dual
control, PIN lockout, promo dual control, and more) exist only as migrations,
not in `schema.sql` itself. **Do not bootstrap a new environment from
`schema.sql` alone right now** — it is missing features the live app depends
on. Use the full apply order below, or generate a verified `schema.sql` per
"Generating a verified `schema.sql`" further down.

## Full apply order (fresh project)

Exhaustive, dependency-correct order for every `migrate_*.sql` in this
directory, derived from each file's own prerequisite checks plus the order
they were actually authored in (git history). Apply `schema.sql` first, then
these in order. **Skip `migrate_cash_accountability_controls.sql` entirely**
on a fresh install — `migrate_rename_petty_cash_to_cash_drawer_entries.sql`
supersedes it and creates `cash_drawer_entries` from scratch when no legacy
`petty_cash` table exists; running both is redundant and the rename migration
is the one every later migration (shift accountability, petty cash
fulfilment) assumes is in place.

```
migrate_import_batches.sql
migrate_products_per_branch.sql
migrate_roles_lookup.sql
migrate_sale_stock_update.sql
migrate_branch_day_open_hour.sql
migrate_day_end_till_lock.sql
migrate_branch_presence.sql
migrate_price_change_history.sql
migrate_bir_pos_compliance.sql
migrate_restaurant_branch.sql
migrate_ulam_ordering.sql
migrate_product_code.sql
migrate_device_settings.sql
migrate_day_end_report.sql
migrate_staff_pin_payments_roles_finance.sql   -- staff_shifts, is_supervisor_or_above, payment_method
migrate_refund_amount_on_transactions.sql
migrate_refund_sale_items.sql
migrate_fix_pin_login_auth.sql
migrate_staff_login_code_unique.sql
migrate_import_batches_branch_staff.sql
migrate_promos_events_and_rules.sql            -- creates promo_events/promo_rules
migrate_promos_event_duration.sql              -- alters promo_events, needs the file above
migrate_discountable_transaction_items.sql
migrate_promos_supervisor_branch_scope.sql
migrate_pin_security_hardening.sql             -- PIN lockout, no password leak
migrate_network_product_catalog.sql            -- creates catalog_products
migrate_catalog_branch_type.sql                -- alters catalog_products, needs the file above
migrate_day_end_dual_control.sql               -- submit -> approve close, immutability
migrate_promo_dual_control.sql                 -- promo create/stop need manager approval
migrate_staff_active_session.sql               -- one active login + lock-screen PIN verify
migrate_staff_shift_period.sql                 -- AM/PM on clock-in
migrate_rename_petty_cash_to_cash_drawer_entries.sql  -- (NOT migrate_cash_accountability_controls.sql, see above)
migrate_manager_can_approve_any_branch.sql
migrate_promo_auto_expire.sql
migrate_promo_line_attribution.sql
migrate_promo_multi_active.sql
migrate_vat_breakdown.sql
migrate_sale_dedupe_hardening.sql
migrate_backfill_catalog_links.sql
migrate_perf_indexes_hot_tables.sql
migrate_enable_realtime.sql
migrate_sync_discount_eligible.sql
migrate_role_assignment_ceiling.sql
migrate_harden_grants.sql
migrate_shift_cash_accountability.sql          -- per-shift change fund, transactions.shift_id, shift_adjustments
                                                -- apply outside trading hours: clocks out any shift
                                                -- already open on a drawer while enforcing one-per-drawer
migrate_petty_cash_fulfilment.sql              -- needs cash_drawer_entries + transactions.shift_id above
migrate_shift_cash_void_fix.sql                -- fixes a voided cash sale wrongly subtracting from expected cash
migrate_backfill_cash_drawer_shift_id.sql      -- one-off: attaches orphaned petty-cash/pickup rows to their shift
migrate_admin_session_release.sql
migrate_branch_staff_roster.sql
migrate_company_tin.sql
migrate_promo_expired_status.sql
migrate_day_end_supervisor_autoclose.sql       -- needs migrate_day_end_dual_control.sql above
migrate_shift_close_no_supervisor_flag.sql     -- needs migrate_shift_cash_accountability.sql above
migrate_day_end_request_no_shift_count.sql     -- needs both files above (dual-checks on apply)
migrate_promo_description.sql
migrate_sync_catalog_identity_fields.sql       -- one-time catch-up, safe to re-run
migrate_day_end_reject_request.sql             -- needs migrate_day_end_request_no_shift_count.sql above
```

`wipe_products_clean_start.sql` is **destructive** and not part of this order —
run it by hand only when you want to wipe products/catalog for a fresh import.

## Recommended apply order (existing project)

Same list as above, minus whatever you've already applied. Check a
migration's own header comment first — most fail fast with a clear error if
a prerequisite is missing rather than half-applying.

## Generating a verified `schema.sql`

Because `schema.sql` has drifted (see above), the reliable way to refresh it
is to apply everything to a real Postgres and dump the result, not to hand-edit
`schema.sql` from reading the migrations — this project's RLS policies and
`security definer` functions are the actual access-control boundary (see
`CLAUDE.md`), and a hand-merge across 50+ files is exactly where a policy or a
superseded function version could be silently dropped.

1. Create a scratch Supabase project (free tier is fine — do **not** do this
   against the production project).
2. In its SQL editor, run `schema.sql`, then every file in the full apply
   order above, in order.
3. Get the project's connection string from Settings → Database, then dump
   schema-only (no data, no Supabase-internal `auth`/`storage` schemas):
   ```bash
   npx supabase db dump --db-url "<connection string>" --schema public -f schema.sql
   ```
4. Replace this repo's `schema.sql` with the output, and spot-check it against
   the table map below.
5. Delete the scratch project once you've verified the dump.

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
