-- READ-ONLY security audit. Changes nothing — safe to run on production any time.
--
-- Static review of the .sql files in this folder says every table enables RLS. That only
-- proves intent: a migration may not have been applied, RLS can be toggled off in the
-- dashboard, and a policy can exist while RLS is disabled (in which case the policy is
-- inert and the table is readable by any authenticated user). This asks the live database
-- what is actually true.
--
-- HOW TO RUN: paste the whole file into the Supabase SQL editor and run. It is a single
-- statement returning one table, sorted worst-first. No psql meta-commands (\echo and
-- friends are a psql client feature; the Supabase editor sends raw SQL to Postgres, which
-- rejects them with `syntax error at or near "\"`).
--
-- Act on anything with severity CRITICAL or REVIEW.

with rls_off as (
  -- Table is readable/writable by any signed-in user regardless of any policies present.
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
  -- Not a breach: it fails closed. But it usually shows up as "the page is empty".
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
  -- A USING clause of `true` means every authenticated user sees every row, cross-branch.
  -- Legitimate for reference data (categories, roles); a finding on anything branch-scoped.
  select
    case
      when tablename in ('categories', 'roles', 'catalog_products') then 'OK-ish'
      else 'REVIEW'
    end::text,
    '3. Unrestricted policy'::text,
    (tablename || ' / ' || policyname)::text,
    format('%s USING (true) — no branch scoping. %s', cmd,
      case
        when tablename in ('categories', 'roles', 'catalog_products')
          then 'Shared reference data, so this is expected.'
        else 'This table is branch-scoped elsewhere; confirm cross-branch read is intended.'
      end
    )::text
  from pg_policies
  where schemaname = 'public' and qual = 'true'
),
definer_no_check as (
  -- SECURITY DEFINER runs as the function owner and bypasses RLS entirely. Each one must
  -- do its own authorisation check or it is a privilege-escalation path any authenticated
  -- user can reach over RPC.
  select
    'CRITICAL'::text,
    '4. SECURITY DEFINER without auth check'::text,
    p.proname::text,
    'Bypasses RLS and shows no is_manager() / current_staff_branch() / raise exception. Read the body and confirm it cannot be abused cross-branch.'::text
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
    and pg_get_functiondef(p.oid) not ilike '%is_manager%'
    and pg_get_functiondef(p.oid) not ilike '%current_staff_branch%'
    and pg_get_functiondef(p.oid) not ilike '%raise exception%'
),
anon_writes as (
  -- The publishable key runs as `anon` before sign-in. It should never hold write grants.
  select
    'CRITICAL'::text,
    '5. anon role can write'::text,
    (table_name || ' / ' || privilege_type)::text,
    'The pre-login anon role holds a write grant. Revoke it.'::text
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema = 'public'
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
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
  union all select * from summary
) findings
order by
  case severity
    when 'CRITICAL' then 0
    when 'REVIEW' then 1
    when 'OK-ish' then 2
    else 3
  end,
  section, item;

-- If this returns only the '6. Summary' row, nothing needs attention.
--
-- To see the full policy inventory rather than just the unrestricted ones, run separately:
--   select tablename, policyname, cmd, qual from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
