-- Stop privilege escalation through the Staff page. Run once; safe to re-run.
--
-- THE HOLE
-- --------
-- schema.sql grants staff writes like this:
--
--   create policy "managers manage staff" on staff for all to authenticated
--     using (public.is_manager()) with check (public.is_manager());
--
-- is_manager() is true for manager, admin AND master. The policy therefore says: any
-- manager may write any staff row, with any values. Two consequences, both reachable
-- from the browser console with nothing but a normal manager login:
--
--   1. A manager can create an account with role = 'master'.
--   2. A manager can UPDATE THEIR OWN ROW and set role = 'master'.
--
-- After (2) the attacker is indistinguishable from a legitimate owner: every action from
-- then on is correctly attributed to a real, valid master account, and the staff table
-- only stores the CURRENT role, so the promotion leaves no trace once made.
--
-- The UI in src/pages/manager/Staff.jsx now refuses both. That is a usability fix, not a
-- security control — the browser is not the security boundary, and the REST endpoint is
-- open to anyone holding the publishable key plus a manager session. This trigger is the
-- control.
--
-- WHAT IT ENFORCES
-- ----------------
--   * You may only create/assign roles strictly BELOW your own. A manager cannot mint
--     another manager; peer creation turns one compromised login into an unbounded set.
--   * You may not modify an account at or above your own rank.
--   * You may not change your own role, module permissions, active flag or branch.
--     Self-service promotion should always require a second person.
--   * master is exempt — it is the root of the tree and must be able to create peers,
--     or there is no way to replace a lost owner account.

-- ---------------------------------------------------------------------------
-- 1. Rank helper (mirrors ROLE_RANK in src/utils/roles.js — keep the two in step)
-- ---------------------------------------------------------------------------
create or replace function public.role_rank(p_role text)
returns integer
language sql
immutable
set search_path = public
as $$
  select case p_role
    when 'cashier'    then 10
    when 'supervisor' then 20
    when 'manager'    then 30
    when 'admin'      then 40
    when 'master'     then 50
    else 0
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The ceiling trigger
-- ---------------------------------------------------------------------------
create or replace function public.enforce_staff_role_ceiling()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid;
  v_actor_role text;
  v_actor_rank integer;
begin
  -- No signed-in staff context: the service role, the SQL editor, a seed script, or the
  -- SECURITY DEFINER login functions (resolve_pin_login runs before anyone is signed in,
  -- so auth.uid() is null there). These must stay unrestricted or the very first master
  -- account could never be created and PIN login would break.
  select id, role into v_actor_id, v_actor_role
  from public.staff
  where auth_user_id = auth.uid() and is_active
  limit 1;

  if v_actor_role is null then
    return new;
  end if;

  -- master is the root of the tree; it may do anything, including create peers.
  if v_actor_role = 'master' then
    return new;
  end if;

  v_actor_rank := public.role_rank(v_actor_role);

  -- Rule 1: never assign a role at or above your own.
  if public.role_rank(new.role) >= v_actor_rank then
    raise exception
      'Role ceiling: a % cannot assign the % role (SEC01).', v_actor_role, new.role
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    -- Rule 2: never modify an account at or above your own rank. Without this a manager
    -- could demote the admin who supervises them and then act freely.
    if public.role_rank(old.role) >= v_actor_rank then
      raise exception
        'Role ceiling: a % cannot modify a % account (SEC02).', v_actor_role, old.role
        using errcode = '42501';
    end if;

    -- Rule 3: no self-service change to your own authority. Checked on the specific
    -- columns that confer authority rather than on the row as a whole, so ordinary
    -- self-writes (session heartbeat, display name) are unaffected.
    if old.id = v_actor_id then
      if new.role is distinct from old.role
         or new.permissions is distinct from old.permissions
         or new.is_active is distinct from old.is_active
         or new.branch_id is distinct from old.branch_id then
        raise exception
          'Role ceiling: you cannot change your own role, access, branch or active status (SEC03). Ask someone above you.'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists staff_role_ceiling on public.staff;
create trigger staff_role_ceiling
  before insert or update on public.staff
  for each row execute function public.enforce_staff_role_ceiling();

-- ---------------------------------------------------------------------------
-- 3. Keep the helper off the public RPC surface
-- ---------------------------------------------------------------------------
-- role_rank is harmless to call, but Postgres grants EXECUTE to PUBLIC by default and
-- there is no reason for a client to reach it. enforce_staff_role_ceiling must never be
-- callable directly — it is SECURITY DEFINER.
revoke execute on function public.enforce_staff_role_ceiling() from public, anon, authenticated;
revoke execute on function public.role_rank(text) from anon;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Signed in as a manager, each of these should now fail with SEC01 / SEC02 / SEC03:
--
--   insert into staff (branch_id, full_name, role, is_active)
--   values ('<branch-uuid>', 'Escalation test', 'master', true);          -- SEC01
--
--   update staff set role = 'master' where id = '<your own staff id>';    -- SEC03
--
-- And this should still succeed:
--
--   insert into staff (branch_id, full_name, role, is_active)
--   values ('<branch-uuid>', 'Normal cashier', 'cashier', true);
--
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'staff_role_ceiling' and tgrelid = 'public.staff'::regclass
  ) then
    raise exception 'staff_role_ceiling trigger was not created';
  end if;
  raise notice 'staff_role_ceiling active — role escalation via the staff table is now blocked.';
end $$;
