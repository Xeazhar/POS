-- READ-ONLY security audit. Changes nothing — safe to run on production any time.
--
-- Static review of the .sql files in this folder says every table enables RLS. That only
-- proves intent: a migration may not have been applied, RLS can be toggled off in the
-- dashboard, and a policy can exist while RLS is disabled (in which case the policy is
-- inert and the table is readable by any authenticated user). This asks the live database
-- what is actually true.
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and run. It is a single
-- statement returning one table, sorted worst-first. No psql meta-commands.
--
-- Act on CRITICAL rows. REVIEW rows need a human decision. OK / OK-ish / INFO are expected.

with rls_off as (
  select
    'CRITICAL'::text as severity,
    '1. RLS disabled'::text as section,
    c.relname::text as item,
    format(
      'RLS is OFF. %s policy(ies) exist but are INERT until RLS is enabled. Fix: alter table %I enable row level security;',
      (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname),
      c.relname
    ) as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
),
rls_no_policy as (
  select
    'REVIEW'::text,
    '2. RLS on, no policies'::text,
    c.relname::text,
    'RLS is on but no policy grants access — every read returns zero rows for normal users.'::text
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
    and not exists (
      select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
    )
),
unrestricted as (
  select
    case
      when tablename in ('categories', 'roles', 'catalog_products', 'company_profile') then 'OK-ish'
      else 'REVIEW'
    end::text,
    '3. Unrestricted policy'::text,
    (tablename || ' / ' || policyname)::text,
    format('%s USING (true) — no branch scoping. %s', cmd,
      case
        when tablename in ('categories', 'roles', 'catalog_products')
          then 'Shared reference data, so this is expected.'
        when tablename = 'company_profile'
          then 'Singleton company TIN/name for receipts; write policy is manager-only.'
        else 'This table is branch-scoped elsewhere; confirm cross-branch read is intended.'
      end
    )::text
  from pg_policies
  where schemaname = 'public' and qual = 'true'
),
-- Names every RLS policy and trigger helper relies on. SECURITY DEFINER here is expected.
rls_helper_names(proname) as (
  values
    ('current_staff_id'),
    ('current_staff_role'),
    ('current_staff_branch'),
    ('is_manager'),
    ('is_master'),
    ('is_supervisor_or_above'),
    ('rls_auto_enable')
),
-- Functions wired as triggers (not direct RPC entry points).
trigger_bound as (
  select distinct p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_trigger t on t.tgfoid = p.oid
  where n.nspname = 'public' and p.prosecdef and not t.tgisinternal
),
-- PostgREST-exposed routines (anon or authenticated may call).
client_rpcs(proname) as (
  select distinct routine_name
  from information_schema.routine_privileges
  where specific_schema = 'public'
    and grantee in ('authenticated', 'anon')
),
definer_auth_ok as (
  select p.oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral (select pg_get_functiondef(p.oid) as body) b
  where n.nspname = 'public' and p.prosecdef
    and (
      b.body ilike '%is_manager%'
      or b.body ilike '%is_master%'
      or b.body ilike '%is_supervisor_or_above%'
      or b.body ilike '%current_staff_branch%'
      or b.body ilike '%current_staff_id%'
      or b.body ilike '%auth.uid()%'
      or b.body ilike '%assert_audit_log_caller%'
      or b.body ilike '%raise exception%'
    )
),
definer_no_check as (
  select
    case
      when h.proname is not null then 'OK'
      when tb.oid is not null then 'OK'
      when ao.oid is not null then 'OK'
      when cr.proname is null then 'INFO'
      else 'CRITICAL'
    end::text as severity,
    '4. SECURITY DEFINER'::text as section,
    p.proname::text as item,
    case
      when h.proname is not null then
        'RLS helper — reads auth.uid() / staff row for policies; not a data RPC.'::text
      when tb.oid is not null then
        'Trigger function — runs on table DML, not a direct client RPC.'::text
      when ao.oid is not null then
        'Body contains auth.uid(), role/branch helper, or raise exception — review if logic is sufficient.'::text
      when cr.proname is null then
        'SECURITY DEFINER but not granted to authenticated/anon — internal/trigger-only.'::text
      else
        'Client-callable RPC with no obvious auth check in body. Read the function; apply migrate_security_definer_hardening_v1.sql if listed there.'::text
    end as detail
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join rls_helper_names h on h.proname = p.proname
  left join trigger_bound tb on tb.oid = p.oid
  left join definer_auth_ok ao on ao.oid = p.oid
  left join client_rpcs cr on cr.proname = p.proname
  where n.nspname = 'public' and p.prosecdef
    and case
      when h.proname is not null then false
      when tb.oid is not null then false
      when ao.oid is not null then false
      when cr.proname is null then false
      else true
    end
),
anon_writes as (
  select
    'CRITICAL'::text,
    '5. anon role can write'::text,
    (table_name || ' / ' || privilege_type)::text,
    'The pre-login anon role holds a write grant. Revoke it.'::text
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
),
mutable_search_path as (
  select
    case when p.prosecdef then 'REVIEW' else 'INFO' end::text,
    '7. Mutable search_path'::text,
    p.proname::text,
    case
      when p.prosecdef then
        'SECURITY DEFINER without SET search_path. Fix: alter function … set search_path = public; (migrate_function_search_path_v1.sql).'::text
      else
        'Invoker function without SET search_path. Pin it to match the rest of the RPC set.'::text
    end
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.proconfig is null
         or not exists (
           select 1 from unnest(p.proconfig) c where c like 'search_path=%'
         ))
),
summary as (
  select
    'INFO'::text,
    '6. Summary'::text,
    'totals'::text,
    format(
      '%s tables, %s with RLS on, %s policies, %s SECURITY DEFINER functions.',
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'),
      (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity),
      (select count(*) from pg_policies where schemaname = 'public'),
      (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef)
    )::text
)
select * from (
  select * from rls_off
  union all select * from rls_no_policy
  union all select * from unrestricted
  union all select * from definer_no_check
  union all select * from anon_writes
  union all select * from mutable_search_path
  union all select * from summary
) findings
order by
  case severity
    when 'CRITICAL' then 0
    when 'REVIEW' then 1
    when 'OK-ish' then 2
    when 'OK' then 3
    else 4
  end,
  section, item;

-- If this returns only OK / OK-ish / INFO rows (plus maybe company_profile under §3), you are clean.
--
-- To see the full policy inventory rather than just the unrestricted ones, run separately:
--   select tablename, policyname, cmd, qual from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
--
-- To inspect a flagged RPC body:
--   select pg_get_functiondef('public.FUNCTION_NAME'::regproc);
