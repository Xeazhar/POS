-- Wipe non-user operational data for a clean schema/load-path overhaul.
-- SAFE: does NOT delete staff, Auth users, roles, branches, or company_profile.
--
-- Run in the Supabase SQL editor on DEV/SCRATCH only — never on a live trading DB
-- unless you intentionally want to clear sales/inventory history.
--
-- After this, apply migrate_schema_cleanup_v1.sql + migrate_network_manager_overview.sql
-- (see supabase/README.md).

begin;

-- Pending approvals / queues first (FKs into transactions)
truncate table public.refund_requests restart identity cascade;
truncate table public.sale_refund_lines restart identity cascade;
truncate table public.sale_events restart identity cascade;
truncate table public.audit_events restart identity cascade;

-- Promos
truncate table public.promo_rule_products restart identity cascade;
truncate table public.promo_rules restart identity cascade;
truncate table public.promo_events restart identity cascade;

-- Sales / inventory / cash
truncate table public.transaction_items restart identity cascade;
truncate table public.transactions restart identity cascade;
truncate table public.stock_movements restart identity cascade;
truncate table public.branch_inventory restart identity cascade;
truncate table public.products restart identity cascade;
truncate table public.catalog_products restart identity cascade;
truncate table public.import_batch_items restart identity cascade;
truncate table public.import_batches restart identity cascade;

-- Day end / shifts / drawer (staff rows kept; shift history wiped)
truncate table public.shift_adjustments restart identity cascade;
truncate table public.cash_drawer_entries restart identity cascade;
truncate table public.staff_shifts restart identity cascade;
truncate table public.day_ends restart identity cascade;

-- Devices / presence (not users)
truncate table public.branch_devices restart identity cascade;
truncate table public.branch_presence restart identity cascade;

-- PIN lockout counters only (not staff credentials)
truncate table public.pin_login_attempts restart identity cascade;

commit;

-- Intentionally NOT truncated:
--   public.staff, public.roles, public.branches, public.categories,
--   public.company_profile, auth.users
