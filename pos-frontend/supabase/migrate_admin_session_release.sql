-- Let a master account force-release a stuck "already signed in" session.
--
-- THE BUG THIS FIXES: claim_staff_session() (migrate_staff_active_session.sql) refuses a
-- second login while session_heartbeat_at is under 15 minutes old. Nothing is wrong with
-- that rule, but a session is only cleared by release_staff_session(), which the client
-- calls on a clean sign-out. A browser killed from Task Manager, a tablet whose battery
-- died, a power cut, a crashed tab — none of those run that call. The staff row is left
-- pointing at a session that no longer exists anywhere, and the person is locked out of
-- their own account for up to 15 minutes with no way to clear it and no device to sign
-- out from. That is the "it says I'm already signed in but I'm not" report.
--
-- Apply AFTER migrate_staff_active_session.sql. Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Who may do this
-- ---------------------------------------------------------------------------
-- Master only. Forcing a release is, in effect, kicking someone off a live till mid-sale,
-- so it deliberately does NOT extend to manager — this is a break-glass control, not a
-- routine one.
create or replace function public.is_master()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
    where auth_user_id = auth.uid()
      and is_active
      and role = 'master'
  );
$$;

-- ---------------------------------------------------------------------------
-- 2) Release one person's session
-- ---------------------------------------------------------------------------
create or replace function public.admin_release_staff_session(p_staff_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_master() then
    raise exception 'SESSION_NOT_ALLOWED: only a master account can force a sign-out';
  end if;
  if p_staff_id is null then
    raise exception 'SESSION_TARGET_REQUIRED: pick an account';
  end if;

  update public.staff
  set active_session_id = null,
      session_heartbeat_at = null
  where id = p_staff_id;

  -- Who forced whom off, and when. A control that can eject a cashier mid-shift has to
  -- leave a trace, same as a void or a price override.
  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  select s.branch_id,
         (select id from public.staff where auth_user_id = auth.uid() limit 1),
         'session_force_release',
         'Forced sign-out of ' || coalesce(s.full_name, 'staff'),
         jsonb_build_object('target_staff_id', s.id, 'scope', 'one')
  from public.staff s
  where s.id = p_staff_id;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Release everyone (optionally one branch)
-- ---------------------------------------------------------------------------
create or replace function public.admin_release_all_sessions(p_branch_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_actor uuid;
begin
  if not public.is_master() then
    raise exception 'SESSION_NOT_ALLOWED: only a master account can force a sign-out';
  end if;

  select id into v_actor from public.staff where auth_user_id = auth.uid() limit 1;

  with released as (
    update public.staff
    set active_session_id = null,
        session_heartbeat_at = null
    where active_session_id is not null
      and (p_branch_id is null or branch_id = p_branch_id)
      -- Never eject the master doing this: they would immediately lock themselves out of
      -- the screen they are standing on.
      and id is distinct from v_actor
    returning 1
  )
  select count(*) into v_count from released;

  insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    p_branch_id,
    v_actor,
    'session_force_release',
    'Forced sign-out of ' || v_count || ' account(s)',
    jsonb_build_object('scope', case when p_branch_id is null then 'all' else 'branch' end,
                       'released', v_count)
  );

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Who is currently holding a session (so the master can see before acting)
-- ---------------------------------------------------------------------------
create or replace function public.admin_active_sessions()
returns table (
  staff_id uuid,
  full_name text,
  role text,
  branch_id uuid,
  branch_name text,
  session_heartbeat_at timestamptz,
  is_stale boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id,
         s.full_name,
         s.role,
         s.branch_id,
         b.name,
         s.session_heartbeat_at,
         -- Past the 15-minute window claim_staff_session() uses, so this row is no longer
         -- actually blocking anyone — shown so a master can tell a real live session from
         -- a leftover one before ejecting anybody.
         (s.session_heartbeat_at is null or s.session_heartbeat_at <= now() - interval '15 minutes')
  from public.staff s
  left join public.branches b on b.id = s.branch_id
  where s.active_session_id is not null
    and public.is_master()
  order by s.session_heartbeat_at desc nulls last;
$$;

grant execute on function public.is_master() to authenticated;
grant execute on function public.admin_release_staff_session(uuid) to authenticated;
grant execute on function public.admin_release_all_sessions(uuid) to authenticated;
grant execute on function public.admin_active_sessions() to authenticated;

-- Verify (as a master)
--   select * from public.admin_active_sessions();
--   select public.admin_release_staff_session('<staff uuid>');
--   select public.admin_release_all_sessions();
