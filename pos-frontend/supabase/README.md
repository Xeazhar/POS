# Supabase SQL layout

## What to run where

| File | Purpose |
|------|---------|
| `schema.sql` | **Canonical full schema** for new projects (tables + RLS + core functions). Keep organized; update when you add features. |
| `migrate_*.sql` | **One-shot patches** for databases that already exist. Run in order if a column/table is missing. Do not delete old migrations after they’ve been applied in production. |

## `schema.sql` status

`schema.sql` was regenerated 2026-08-16 by introspecting `CalePOS_Demo`
(commit `b039438`) and is a verified bootstrap as of that commit — apply it
start-to-finish and you do **not** need to replay the `migrate_*.sql` history
below it.

**Apply these on top of `schema.sql`, in this order** — authored/committed
after the regeneration, so they are not yet baked in:

```
migrate_announcements.sql
migrate_announcements_backfill_permissions.sql
migrate_terminal_report_old_grand_total_rpc.sql
migrate_single_active_session_enforcement.sql
migrate_rename_or_to_invoice.sql   -- last: supersedes complete_sale/void_sale_secure/
                                    -- refund_sale_items bodies from every earlier file
migrate_promo_expire_supervisor_gate.sql
```

`CalePOS_Demo` itself (the shared dev project) has **not** had these 5
applied as of this writing — apply them there too before relying on it for
local dev, or its `or_number`/`or_prefix` columns will disagree with the
`invoice_number`/`invoice_prefix` naming the current frontend (`api.js`,
`CODEMAP.md`) already expects.

The `migrate_*.sql` full-order list below is kept for the rare case you need
to bootstrap without `schema.sql` (e.g. reconstructing history, or auditing
a specific migration's prerequisites) — it is not the fresh-install path.

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
migrate_offline_or_reserve.sql                 -- reserve_invoice_number: accept till-assigned
                                                -- invoice number on sync without shrinking
                                                -- branches.invoice_next
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
migrate_import_revert_request.sql              -- needs migrate_import_batches.sql and
                                                -- migrate_import_batches_branch_staff.sql above
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
migrate_offline_supervisor_pin.sql             -- needs migrate_pin_security_hardening.sql and
                                                -- migrate_manager_can_approve_any_branch.sql above
migrate_promo_auto_expire.sql
migrate_promo_line_attribution.sql
migrate_promo_group_id.sql                     -- needs migrate_promo_line_attribution.sql above
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
migrate_reveal_staff_pin.sql                    -- needs migrate_branch_staff_roster.sql above; manager-only PIN reveal RPC
migrate_security_definer_hardening_v1.sql       -- session/audit/price/promo RPC auth checks; run after session + audit migrations
migrate_single_active_session_enforcement.sql  -- needs migrate_staff_active_session.sql,
                                                -- migrate_admin_session_release.sql, and this
                                                -- file above (redefines current_staff_id/
                                                -- branch/role again); deploy with matching
                                                -- frontend build (drops old 2-arg RPC signatures)
migrate_revoke_cash_movement_internal_grants.sql -- revoke EXECUTE on internal cash-movement definer helpers
migrate_company_tin.sql
migrate_promo_expired_status.sql
migrate_day_end_supervisor_autoclose.sql       -- needs migrate_day_end_dual_control.sql above
migrate_shift_close_no_supervisor_flag.sql     -- needs migrate_shift_cash_accountability.sql above
migrate_day_end_request_no_shift_count.sql     -- needs both files above (dual-checks on apply)
migrate_promo_description.sql
migrate_sync_catalog_identity_fields.sql       -- one-time catch-up, safe to re-run
migrate_notification_cleanup.sql               -- needed before migrate_day_end_reject_request.sql
                                                -- and migrate_day_end_request_notify_fix.sql below
migrate_day_end_reject_request.sql             -- needs migrate_day_end_request_no_shift_count.sql above
migrate_day_end_request_notify_fix.sql        -- needs reject + notification_cleanup; closed_at null on request so bell shows
migrate_promo_reject_reason.sql                -- needs migrate_promo_dual_control.sql above; adds
                                                -- reject_reason + 3-arg reject_promo_event RPC
migrate_void_sale_approved_by.sql              -- needs migrate_day_end_dual_control.sql above (supersedes
                                                -- its void_sale_secure body); adds 4-arg void_sale_secure
                                                -- (p_approved_by) so the Void/Refund Log report's
                                                -- "Approved by" column is populated for voids
migrate_fix_refund_sale_items_typo.sql         -- needs migrate_day_end_dual_control.sql above (supersedes
                                                -- its refund_sale_items body); fixes a "p_txn" typo that
                                                -- broke every item-level refund, and restores the
                                                -- sale_events inserts + fully_voided return key that
                                                -- migration had silently dropped
migrate_refund_requests.sql                    -- needs migrate_fix_refund_sale_items_typo.sql and
                                                -- migrate_void_sale_approved_by.sql above; adds the
                                                -- refund_requests table + approve/reject/cancel RPCs for
                                                -- remote manager approval when no supervisor is on site
migrate_staff_identity_resolve.sql             -- needs migrate_staff_pin_payments_roles_finance.sql above;
                                                -- adds resolve_staff_identities() so a supervisor can
                                                -- resolve a same-branch staff name/role (audit "performed
                                                -- by", shift log) without RLS silently blanking the join
migrate_branch_roster_exclude_managers.sql     -- needs migrate_branch_staff_roster.sql above; supersedes
                                                -- its function body so a supervisor's branch roster no
                                                -- longer lists manager/admin/master accounts
migrate_day_end_reopen_request.sql             -- needs migrate_day_end_dual_control.sql and
                                                -- migrate_day_end_supervisor_autoclose.sql above; adds
                                                -- request_day_reopen() + reopen_requested_at/by/reason
                                                -- columns so a cashier blocked by a closed day can ask
                                                -- for it back instead of being stuck; supersedes
                                                -- reopen_day_end() and submit_day_end() to clear the
                                                -- request once it's fulfilled or moot
migrate_promo_rule_bundle_name.sql             -- needs migrate_promos_events_and_rules.sql above; adds
                                                -- promo_rules.bundle_name (nullable, bundle_pct only) —
                                                -- a name for one bundle rule, distinct from its promo
                                                -- event's name, for the POS quick-add button
migrate_promo_edit_reapproval.sql              -- needs migrate_schema_cleanup_v1.sql above; adds
                                                -- supersedes_event_id, request_promo_edit(), approve
                                                -- requires ≥1 rule, edit revision stops live promo
migrate_schema_cleanup_v1.sql                  -- drop duplicate client_id index, promo is_active,
                                                -- dormant shift-review cols, tighten refund_requests RLS,
                                                -- align sale/audit event policies; cash_drawer_entries only
migrate_network_manager_overview.sql           -- manager_overview_metrics(p_days) RPC — one round-trip
                                                -- for Overview sales KPIs + today cash impact
migrate_receive_shift_handoff.sql              -- receive_shift_handoff() — supervisor confirms
                                                -- cashier drawer handoff after end-shift (clears
                                                -- Staff "Pending handoff"); needs shift cash schema
migrate_retire_admin_role.sql                  -- remap staff.role admin→manager; delete roles.admin;
                                                -- master is sole top account (run after ceiling)
migrate_cash_movements.sql                     -- cash_movements ledger + RPCs; POS Open Drawer
migrate_cash_movement_cash_in.sql              -- needs migrate_cash_movements.sql above; put
                                                -- before migrate_cash_movement_self_approve.sql
                                                -- petty/pickup; updates shift_cash_summary
migrate_cash_movement_cancel.sql               -- cancel_cash_movement — cashier X/Cancel voids
                                                -- pending_remote Open Drawer requests
migrate_cash_movement_resolve_flagged.sql      -- manager-only flagged → Resolved (confirmed)
migrate_till_action_requests.sql               -- till_action_requests + RPCs; POS cart line
                                                -- remove Notify manager (30s) / self-allow
migrate_till_action_on_site_resolve.sql        -- needs migrate_notification_cleanup.sql;
                                                -- cashier session clears alert after on-site PIN
migrate_realtime_broadcast_v1.sql              -- private Broadcast topics; inventory
                                                -- change_version; ops triggers; cashiers
                                                -- cannot direct-write branch_inventory;
                                                -- audit/sale_events append-only
                                                -- (skips ALTER on realtime.messages —
                                                -- that table is Supabase-owned)
migrate_realtime_broadcast_policies.sql        -- optional: CREATE POLICY on
                                                -- realtime.messages if main migrate
                                                -- could not (Dashboard Realtime Auth ON)
migrate_function_search_path_v1.sql            -- SET search_path = public on 9 invoker
                                                -- helpers/triggers flagged by advisors;
                                                -- safe to re-run
migrate_perf_fk_indexes_v1.sql                 -- drop duplicate client_id / sku / barcode
                                                -- indexes; hot FK indexes; wrap auth.uid()
                                                -- in (select …) on read staff / audit RLS
migrate_idle_lock_minutes.sql                  -- company_profile.idle_lock_minutes (5/10/15);
                                                -- needs migrate_company_tin.sql
migrate_fix_manager_overview_revenue_net.sql   -- needs migrate_network_manager_overview.sql above;
                                                -- manager_overview_metrics()'s 'revenue' was gross
                                                -- total_amount (no refund subtraction), disagreeing
                                                -- with its own 'netSales' and with BranchDashboard's
                                                -- netted "Revenue today" — now revenue = netSales
migrate_sale_ops_broadcast.sql                 -- needs migrate_realtime_broadcast_v1.sql above;
                                                -- attaches tg_ops_broadcast() to transactions so a
                                                -- new sale/void/refund pushes OPERATIONS_CHANGED
                                                -- immediately instead of only the 15s poll fallback
migrate_fix_overview_cash_impact_carry.sql     -- needs migrate_fix_manager_overview_revenue_net.sql
                                                -- above; supersedes manager_overview_metrics()'s
                                                -- changeFund sum, which had no carried-shift guard
                                                -- at all (double-counted a genuine duplicate carry) —
                                                -- now matches DayEnd.jsx/api.fetchBranchCashImpact's
                                                -- "exclude only when startingCash still equals
                                                -- carried_amount" rule
migrate_revoke_anon_sale_rpc_grants.sql        -- CRITICAL, apply everywhere ASAP: closes an
                                                -- unauthenticated-bypass gap where the anon/
                                                -- publishable key alone could call
                                                -- allocate_invoice_number/reserve_invoice_number/
                                                -- void_sale_secure/refund_sale_items/
                                                -- record_stock_movement with no login;
                                                -- needs exact signatures from
                                                -- migrate_void_sale_approved_by.sql and
                                                -- migrate_refund_requests.sql above
migrate_fix_null_unsafe_branch_checks.sql      -- CRITICAL, apply everywhere ASAP: record_stock_movement
                                                -- and request_import_revert gated cross-branch access
                                                -- with `<>` against current_staff_branch(), which is
                                                -- NULL for an anon caller — NULL <> x is NULL, not TRUE,
                                                -- so the guard silently never raised; switches both to
                                                -- IS DISTINCT FROM and revokes the anon grant on
                                                -- request_import_revert (record_stock_movement's anon
                                                -- grant is already revoked by the migration above)
migrate_login_conditional_rehash.sql           -- needs migrate_fix_pin_login_auth.sql above;
                                                -- resolve_pin_login only rewrites
                                                -- auth.users.encrypted_password when it doesn't
                                                -- already verify, instead of rehashing + writing
                                                -- unconditionally on every login
migrate_complete_sale_rpc.sql                  -- needs assert_till_open,
                                                -- reserve_invoice_number/allocate_invoice_number,
                                                -- record_stock_movement, and every
                                                -- transactions/transaction_items column above.
                                                -- complete_sale() — one atomic RPC replacing
                                                -- completeSale()'s 4 separate round trips
migrate_fix_overview_cash_impact_movements.sql -- needs migrate_fix_overview_cash_impact_carry.sql
                                                -- and migrate_cash_movements.sql above;
                                                -- supersedes manager_overview_metrics()'s cash
                                                -- impact block, which never read cash_movements
                                                -- (the POS -> Open Drawer ledger), only the legacy
                                                -- cash_drawer_entries table
migrate_cash_movement_self_approve.sql         -- put last: needs migrate_cash_movement_cash_in.sql
                                                -- above; supersedes create_cash_movement_approved's
                                                -- body so a supervisor/manager/master recording
                                                -- their OWN Open Drawer activity is cleanly
                                                -- 'approved' with no PIN/flag; cashiers still need
                                                -- real dual control. Safe to re-run.
migrate_announcements.sql                      -- announcements table (manager-authored, branch or
                                                -- network-wide) + staff.announcements_seen_at +
                                                -- mark_announcements_seen(); read by CashierDashboard.jsx,
                                                -- authored on ManagerAnnouncements.jsx
migrate_announcements_backfill_permissions.sql -- needs migrate_announcements.sql above; grants
                                                -- cashier_dashboard / manager_announcements to
                                                -- pre-existing staff rows whose permissions array
                                                -- predates those modules (see file header). Safe
                                                -- to re-run
migrate_terminal_report_old_grand_total_rpc.sql -- sum_completed_sales_before(branch, before) —
                                                -- server-side SUM for the Terminal/X/Z report's
                                                -- "Old Grand Total", replacing a client-side pull
                                                -- of every completed sale in the branch's history.
                                                -- api.js falls back to the old query if this isn't
                                                -- applied yet, so it's safe to apply independently
migrate_shift_cash_summary_expose_cash_in.sql  -- needs migrate_cash_movement_cash_in.sql above;
                                                -- adds cash_in to shift_cash_summary's output so
                                                -- OwnShiftSoFar.jsx can show it as its own line
                                                -- instead of only being folded into expected_cash
migrate_day_end_cash_handoff.sql               -- day_ends.handoff_confirmed_by/at +
                                                -- confirm_day_end_handoff() — manager confirms
                                                -- receiving a closed day's cash; non-blocking,
                                                -- no deadline
```

**Dev wipe (optional, non-user data only):** `wipe_non_user_data.sql` truncates sales/inventory/promos/shifts/drawer while **keeping** `staff`, `branches`, `roles`, `company_profile`, and Auth users. Run on DEV before cleanup if you want a clean slate.

**Go-live wipe (keeps master only):** `wipe_for_deployment.sql` — same operational wipe as above, **plus** deletes every non-master `staff` / Auth user and resets `branches.invoice_next` to `1` (first invoice = `PREFIX-00000001`). Aborts if no active master exists. Run once when ready for live trading, never casually on a DB you still need.

`wipe_products_clean_start.sql` is **destructive** and not part of the apply order —
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

**`CalePOS_Demo` (Supabase project `pcasudqyqgzrlpyfdvbe`) is the tested
reference project** and is now the team's dev-tier database (`calepos-dev`
in `.env.local`) — it has every file in the full apply order above applied
through the `schema.sql` regeneration commit, **but not yet the 5
post-regeneration migrations listed in "`schema.sql` status" above**. Apply
those there before dumping, or the dump will carry the same gap forward.
Only fall back to a scratch project if `CalePOS_Demo` is ever reset or goes
stale.

1. Get `CalePOS_Demo`'s connection string from Settings → Database
   (Session pooler or direct connection; needs the DB password, not the
   anon/publishable key), then dump schema-only (no data, no
   Supabase-internal `auth`/`storage` schemas):
   ```bash
   npx supabase db dump --db-url "<connection string>" --schema public -f schema.sql
   ```
2. Replace this repo's `schema.sql` with the output, and spot-check it against
   the table map below.
3. Before trusting the dump, re-check `list_migrations` (or this file's apply
   order) against the project's actual migration history so you're not
   dumping a project that's mid-drift itself.

If you don't have the DB password and only have Supabase MCP / dashboard
query access, you can reconstruct an equivalent schema by introspecting
`pg_catalog`/`information_schema` (`pg_get_functiondef`, `pg_indexes`,
`pg_policies`, `pg_get_constraintdef`) instead of running `pg_dump` — slower
and needs more careful spot-checking, but doesn't require sharing the DB
password.

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
  ├─ cash_movements (petty/pickup during open shift; POS Open Drawer)
  ├─ till_action_requests (cart line remove remote approve)
  ├─ branch_presence, branch_devices
  ├─ announcements (branch-scoped or NULL = network-wide; manager-authored)
  └─ sale_events, audit_events (BIR / audit)

pin_login_attempts   ← lockout only (no client access; security definer RPCs)
```

## PIN security

- Till PIN is exactly 6 digits (cashier/supervisor) — enforced in app UI (`src/utils/pin.js`).
- `resolve_pin_login` returns **auth email only** (never Auth password).
- Failed attempts recorded in `pin_login_attempts` (5 fails → 15 min lock).
