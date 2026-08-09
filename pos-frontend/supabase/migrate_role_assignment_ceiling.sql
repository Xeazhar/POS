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
--     Self-service promotion should always require a second person. Other self-writes
--     (display name, session heartbeat) are unaffected.
--   * master is exempt — it is the root of the tree and must be able to create peers,
--     or there is no way to replace a lost owner account.
--   * A session whose JWT maps to no ACTIVE staff row is refused outright. Only a request
--     with no JWT at all (service role, SQL editor, the pre-login PIN functions) bypasses
--     the checks — otherwise deactivating a compromised account would not take effect
--     until its token happened to expire.

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
  v_uid        uuid := auth.uid();
begin
  -- ==========================================================================
  -- GATE 0: does this write touch authority at all?
  -- ==========================================================================
  -- If an UPDATE changes none of the four columns that confer authority, it cannot
  -- escalate anything, so the role ceiling has no business inspecting it. Returning here
  -- first makes a whole class of outage impossible.
  --
  -- This is not a theoretical tidy-up. The first version of this migration checked
  -- new.role on every write, which meant the session heartbeat that runs at LOGIN —
  -- a cashier updating their own row, role unchanged — was rejected with
  -- "a cashier cannot assign the cashier role", and nobody could sign in. Any write that
  -- leaves role, permissions, is_active and branch_id alone (heartbeat, last-seen,
  -- display name, and every column added in future) is now none of this trigger's
  -- concern by construction, not by remembering to special-case it.
  if tg_op = 'UPDATE'
     and new.role is not distinct from old.role
     and new.permissions is not distinct from old.permissions
     and new.is_active is not distinct from old.is_active
     and new.branch_id is not distinct from old.branch_id then
    return new;
  end if;

  -- NO JWT AT ALL: the service role, the SQL editor, a seed script, or the SECURITY
  -- DEFINER login functions (resolve_pin_login runs before anyone is signed in, so
  -- auth.uid() is null there). These must stay unrestricted or the very first master
  -- account could never be created and PIN login would break.
  if v_uid is null then
    return new;
  end if;

  select id, role into v_actor_id, v_actor_role
  from public.staff
  where auth_user_id = v_uid and is_active
  limit 1;

  -- A JWT that maps to no ACTIVE staff row: a deactivated account whose token has not yet
  -- expired, or a staff row with a null auth_user_id.
  --
  -- Scoped to UPDATE deliberately. The risk the review identified is a deactivated
  -- manager continuing to REWRITE staff rows until their token ages out, and that is
  -- refused here. INSERT is left to fall through because legitimate account creation
  -- genuinely runs without a resolvable actor: handle_new_user() fires inside the
  -- auth.users insert, and supabase.auth.signUp() can leave the client briefly holding
  -- the new user's session — neither has a staff row yet, by definition. Denying those
  -- would break creating staff entirely, and INSERT is already gated: the RLS policy on
  -- `staff` requires is_manager(), which a stranger does not satisfy.
  if v_actor_role is null then
    if tg_op = 'UPDATE' then
      raise exception
        'Role ceiling: no active staff record for this session (SEC02).'
        using errcode = '42501';
    end if;
    return new;
  end if;

  -- master is the root of the tree; it may do anything, including create peers.
  if v_actor_role = 'master' then
    return new;
  end if;

  v_actor_rank := public.role_rank(v_actor_role);

  -- Rule 1: never assign a role at or above your own.
  --
  -- Only when the role is actually being SET — on insert, or on an update that changes it.
  -- Testing new.role unconditionally meant an unchanged role always failed its own
  -- ceiling test (a manager's row holds 'manager', and 30 >= 30), so every ordinary
  -- self-write — a session heartbeat, a display-name edit — was rejected with SEC01
  -- before Rule 3's targeted column check could run.
  -- Written as a nested IF rather than `tg_op = 'INSERT' or new.role is distinct from
  -- old.role`. In an INSERT trigger OLD is unassigned, and touching OLD.role there raises
  -- `record "old" is not assigned yet` — PostgreSQL does not promise to short-circuit the
  -- OR, so that form could fail on every staff INSERT. OLD is only referenced under
  -- tg_op = 'UPDATE' here, where it is guaranteed to exist.
  if tg_op = 'INSERT' then
    if public.role_rank(new.role) >= v_actor_rank then
      raise exception
        'Role ceiling: a % cannot create an account with the % role (SEC01).', v_actor_role, new.role
        using errcode = '42501';
    end if;
  elsif new.role is distinct from old.role then
    if public.role_rank(new.role) >= v_actor_rank then
      raise exception
        'Role ceiling: a % cannot assign the % role (SEC01).', v_actor_role, new.role
        using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.id = v_actor_id then
      -- Rule 3: your OWN row. You may touch it, but not the columns that confer
      -- authority. Checked per column rather than on the row as a whole so that ordinary
      -- self-writes — session heartbeat, display name — keep working.
      --
      -- This branch must come before Rule 2, because your own role is by definition equal
      -- to your own rank and Rule 2 would otherwise reject every self-write outright.
      if new.role is distinct from old.role
         or new.permissions is distinct from old.permissions
         or new.is_active is distinct from old.is_active
         or new.branch_id is distinct from old.branch_id then
        raise exception
          'Role ceiling: you cannot change your own role, access, branch or active status (SEC03). Ask someone above you.'
          using errcode = '42501';
      end if;
    -- Rule 2: never modify SOMEONE ELSE'S account at or above your own rank. Without this
    -- a manager could demote the admin who supervises them and then act freely.
    elsif public.role_rank(old.role) >= v_actor_rank then
      raise exception
        'Role ceiling: a % cannot modify a % account (SEC02).', v_actor_role, old.role
        using errcode = '42501';
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
-- MUST STILL WORK after this runs — check these before trusting a deploy:
--
--   * Signing in as a cashier and as a supervisor. Login updates the staff row's session
--     heartbeat, which touches no authority column and must pass Gate 0 untouched. An
--     earlier version of this file failed exactly here and locked everyone out with
--     "a cashier cannot assign the cashier role".
--   * Creating a new cashier from Manager -> Staff.
--   * Renaming your own account (name only).
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
  raise notice 'NOW TEST SIGN-IN as a cashier before leaving. Login writes to staff.';
end $$;
