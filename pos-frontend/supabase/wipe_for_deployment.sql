-- =============================================================================
-- CalePOS — wipe for deployment (go-live clean slate)
-- =============================================================================
-- DANGER: irreversible. Run in the Supabase SQL editor only when you are ready
-- to throw away all test/trading history and start live with a clean database.
--
-- Keeps:
--   • staff rows with role = 'master' (and their auth.users rows)
--   • branches (structure + fiscal identity fields), roles, categories,
--     company_profile
--
-- Wipes:
--   • all sales, inventory, promos, shifts, drawer, day-end, audit, devices,
--     catalog/products, import batches, PIN lockouts
--   • every non-master staff row and their Auth users
--
-- OR / invoice numbering:
--   branches.or_next is reset to 1 (schema check: or_next >= 1 — cannot be 0).
--   First sale after this wipe gets PREFIX-00000001 (e.g. OR-00000001).
--
-- After running: log in as master, re-create cashiers/supervisors/managers,
-- re-import / adopt catalog, then take the first live sale.
-- =============================================================================

begin;

-- Refuse to run if there is no master account to keep.
do $$
declare
  v_masters int;
begin
  select count(*) into v_masters from public.staff where role = 'master' and is_active;
  if v_masters < 1 then
    raise exception
      'wipe_for_deployment aborted: no active staff with role = master. Create/activate a master account first.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1) Operational data (same family as wipe_non_user_data.sql)
-- ---------------------------------------------------------------------------
truncate table public.refund_requests restart identity cascade;
truncate table public.till_action_requests restart identity cascade;
truncate table public.sale_refund_lines restart identity cascade;
truncate table public.sale_events restart identity cascade;
truncate table public.audit_events restart identity cascade;

truncate table public.promo_rule_products restart identity cascade;
truncate table public.promo_rules restart identity cascade;
truncate table public.promo_events restart identity cascade;

truncate table public.transaction_items restart identity cascade;
truncate table public.transactions restart identity cascade;
truncate table public.stock_movements restart identity cascade;
truncate table public.branch_inventory restart identity cascade;
truncate table public.products restart identity cascade;
truncate table public.catalog_products restart identity cascade;
truncate table public.import_batch_items restart identity cascade;
truncate table public.import_batches restart identity cascade;

truncate table public.shift_adjustments restart identity cascade;
truncate table public.cash_drawer_entries restart identity cascade;
truncate table public.cash_movements restart identity cascade;
-- Legacy name if rename migration was never applied on this project
do $$ begin
  truncate table public.petty_cash restart identity cascade;
exception
  when undefined_table then null;
end $$;
truncate table public.staff_shifts restart identity cascade;
truncate table public.day_ends restart identity cascade;

truncate table public.branch_devices restart identity cascade;
truncate table public.branch_presence restart identity cascade;
truncate table public.pin_login_attempts restart identity cascade;

-- ---------------------------------------------------------------------------
-- 2) Reset invoice / OR sequence on every branch
--    or_next = 1 → first allocate_or_number returns PREFIX-00000001
-- ---------------------------------------------------------------------------
update public.branches
set or_next = 1;

-- ---------------------------------------------------------------------------
-- 3) Drop every non-master staff account (+ Auth user when linked)
-- ---------------------------------------------------------------------------
-- Clear session lock on the survivors so master is not stuck behind a stale lock.
update public.staff
set active_session_id = null,
    session_heartbeat_at = null
where role = 'master';

-- Auth users for non-master staff (PIN-only rows may have null auth_user_id)
delete from auth.users
where id in (
  select auth_user_id
  from public.staff
  where role is distinct from 'master'
    and auth_user_id is not null
);

-- Staff rows that survived Auth cascade (no auth_user_id, or cascade off)
delete from public.staff
where role is distinct from 'master';

-- Safety: never leave orphan Auth users that are not the kept master(s)
delete from auth.users
where id not in (
  select auth_user_id
  from public.staff
  where role = 'master'
    and auth_user_id is not null
);

commit;

-- Intentionally NOT wiped:
--   public.branches, public.roles, public.categories, public.company_profile,
--   public.staff (master only), auth.users (master only)
