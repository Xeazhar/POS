-- Single active session per staff: evict-on-login, enforced via RLS, not just a login gate.
--
-- Supersedes the "reject the second login" behavior in migrate_staff_active_session.sql with
-- "the new login always wins, the old one is evicted everywhere the server can reach it."
-- Session identity is now the caller's own Supabase Auth JWT `session_id` claim (stable across
-- reloads/refreshes, unique per sign-in) instead of a client-supplied uuid — closes a latent gap
-- where any authenticated caller could pass an arbitrary p_staff_id/p_session_id to the old
-- claim/heartbeat/release RPCs.
--
-- Apply AFTER migrate_staff_active_session.sql and migrate_admin_session_release.sql.
-- Deploy together with the matching frontend build — this drops the old 2-arg RPC signatures.
--
-- ONE-TIME EFFECT: every currently signed-in session's active_session_id holds the old
-- device-fingerprint value, not a real JWT session_id, so every existing session will look
-- "evicted" the next time it's checked and will need to sign in again once. Expected; self-heals.

-- ---------------------------------------------------------------------------
-- 0) Session identity helper
-- ---------------------------------------------------------------------------
create or replace function public.current_session_id()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(auth.jwt() ->> 'session_id', '')::uuid;
$$;

revoke execute on function public.current_session_id() from public, anon;
grant execute on function public.current_session_id() to authenticated;

-- ---------------------------------------------------------------------------
-- 1) Drop the old client-supplied-id overloads (closes the spoofing gap)
-- ---------------------------------------------------------------------------
drop function if exists public.claim_staff_session(uuid, uuid);
drop function if exists public.heartbeat_staff_session(uuid, uuid);
drop function if exists public.release_staff_session(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 2) Claim: always evicts a mismatched prior session; audits + broadcasts the eviction
-- ---------------------------------------------------------------------------
create or replace function public.claim_staff_session()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_branch_id uuid;
  v_full_name text;
  v_prev_session uuid;
  v_new_session uuid := public.current_session_id();
  v_replaced boolean := false;
begin
  if v_new_session is null then
    raise exception 'SESSION_CONTEXT_MISSING: sign-in token has no session id';
  end if;

  select id, branch_id, full_name, active_session_id
    into v_staff_id, v_branch_id, v_full_name, v_prev_session
  from staff
  where auth_user_id = auth.uid() and is_active
  limit 1
  for update;

  if v_staff_id is null then
    raise exception 'STAFF_NOT_FOUND: no active staff row for this account';
  end if;

  v_replaced := v_prev_session is not null and v_prev_session is distinct from v_new_session;

  update staff
  set active_session_id = v_new_session,
      session_heartbeat_at = now()
  where id = v_staff_id;

  if v_replaced then
    -- Auditable trail of who got kicked, by whom, and when — same shape as the master
    -- break-glass release in migrate_admin_session_release.sql, but self-triggered by a
    -- normal login rather than an admin action.
    insert into public.audit_events (branch_id, staff_id, event_type, detail, meta)
    values (
      v_branch_id,
      v_staff_id,
      'session_replaced',
      coalesce(v_full_name, 'Staff') || ' signed in on a new device; previous session ended',
      jsonb_build_object('previous_session_id', v_prev_session, 'new_session_id', v_new_session)
    );

    -- Best-effort instant notice to the evicted device, if it's online right now. The
    -- heartbeat check below is the real enforcement; this just removes the wait for a
    -- device that happens to be connected. Never trusted as-is by the receiver — it just
    -- triggers a real heartbeat_staff_session() re-check (see Shell.jsx).
    perform public.broadcast_pos_event(
      v_branch_id,
      'operations',
      'OPERATIONS_CHANGED',
      jsonb_build_object('kind', 'session_revoked', 'staff_id', v_staff_id)
    );
  end if;

  return jsonb_build_object('replaced', v_replaced);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Heartbeat: verify-only, never steals. This is what an evicted device fails.
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat_staff_session()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_session uuid := public.current_session_id();
begin
  select id into v_staff_id from staff where auth_user_id = auth.uid() and is_active limit 1;

  if v_staff_id is null or v_session is null then
    raise exception 'SESSION_REVOKED: session no longer valid';
  end if;

  update staff
  set session_heartbeat_at = now()
  where id = v_staff_id and active_session_id = v_session;

  if not found then
    raise exception 'SESSION_REVOKED: this account was signed in on another device';
  end if;

  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Release: only clears a session that still belongs to the caller. Never lets an
--    already-evicted device clear whoever now holds the claim.
-- ---------------------------------------------------------------------------
create or replace function public.release_staff_session()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
  v_session uuid := public.current_session_id();
begin
  select id into v_staff_id from staff where auth_user_id = auth.uid() and is_active limit 1;
  if v_staff_id is null then
    return true;
  end if;

  update staff
  set active_session_id = null,
      session_heartbeat_at = null
  where id = v_staff_id and active_session_id = v_session;

  return true;
end;
$$;

grant execute on function public.claim_staff_session() to authenticated;
grant execute on function public.heartbeat_staff_session() to authenticated;
grant execute on function public.release_staff_session() to authenticated;
revoke execute on function public.claim_staff_session() from public, anon;
revoke execute on function public.heartbeat_staff_session() from public, anon;
revoke execute on function public.release_staff_session() from public, anon;

-- ---------------------------------------------------------------------------
-- 5) The real enforcement: gate the three functions nearly every RLS policy and every
--    SECURITY DEFINER RPC in the schema already goes through. An evicted device's JWT is
--    still cryptographically valid, but current_staff_id()/current_staff_branch()/
--    current_staff_role() now return nothing for it, so RLS denies it and every RPC's own
--    "not a manager of this branch" style guard denies it too — no per-table, per-RPC edits.
--
--    Deliberately NOT applied to the "read staff" self-row policy (auth_user_id = auth.uid())
--    — fetchSessionStaff() reads that BEFORE claim_staff_session() has run on a fresh login,
--    so gating it would deadlock every login. An evicted device can still read its own bare
--    staff row; it cannot do anything current_staff_branch()/current_staff_role() gates.
-- ---------------------------------------------------------------------------
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.staff
  where auth_user_id = auth.uid()
    and is_active
    and active_session_id = public.current_session_id()
  limit 1;
$$;

create or replace function public.current_staff_branch()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select branch_id from public.staff
  where auth_user_id = auth.uid()
    and is_active
    and active_session_id = public.current_session_id()
  limit 1;
$$;

create or replace function public.current_staff_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.staff
  where auth_user_id = auth.uid()
    and is_active
    and active_session_id = public.current_session_id()
  limit 1;
$$;

-- Verify (apply in a dev/staging project first — this migration changes the behavior of
-- nearly every RLS policy in the schema):
--   -- as a signed-in staff member, after calling claim_staff_session() once:
--   select public.current_staff_id(), public.current_staff_branch(), public.current_staff_role();
--   -- should return this staff's own row, not null
--
--   -- simulate eviction: run claim_staff_session() as the SAME staff member from a second
--   -- browser/session, then re-run the query above from the FIRST session:
--   select public.current_staff_id(); -- should now be null
--   select public.heartbeat_staff_session(); -- should raise SESSION_REVOKED: ...
--
--   -- audit trail:
--   select * from public.audit_events where event_type = 'session_replaced' order by created_at desc limit 5;
