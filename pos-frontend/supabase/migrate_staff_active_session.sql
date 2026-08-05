-- Single active session per staff: block second login while heartbeat is fresh

alter table staff add column if not exists active_session_id uuid;
alter table staff add column if not exists session_heartbeat_at timestamptz;

create or replace function public.claim_staff_session(p_staff_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_heartbeat timestamptz;
  v_stale interval := interval '15 minutes';
begin
  if p_staff_id is null or p_session_id is null then
    raise exception 'Session claim requires staff and session id';
  end if;

  select active_session_id, session_heartbeat_at
    into v_existing, v_heartbeat
  from staff
  where id = p_staff_id
  for update;

  if not found then
    raise exception 'Staff not found';
  end if;

  -- Same device reclaiming / refreshing its own session
  if v_existing is not distinct from p_session_id then
    update staff
    set session_heartbeat_at = now()
    where id = p_staff_id;
    return true;
  end if;

  -- Another session is live (heartbeat within stale window)
  if v_existing is not null
     and v_heartbeat is not null
     and v_heartbeat > now() - v_stale then
    raise exception 'Already signed in on another device. Sign out there first.';
  end if;

  update staff
  set active_session_id = p_session_id,
      session_heartbeat_at = now()
  where id = p_staff_id;

  return true;
end;
$$;

create or replace function public.heartbeat_staff_session(p_staff_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update staff
  set session_heartbeat_at = now()
  where id = p_staff_id
    and active_session_id = p_session_id;

  if not found then
    raise exception 'Session is no longer active';
  end if;
  return true;
end;
$$;

create or replace function public.release_staff_session(p_staff_id uuid, p_session_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update staff
  set active_session_id = null,
      session_heartbeat_at = null
  where id = p_staff_id
    and (active_session_id = p_session_id or active_session_id is null);
  return true;
end;
$$;

-- Unlock lock screen: verify current staff PIN without creating a new auth session
create or replace function public.verify_own_pin(p_staff_id uuid, p_pin text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  -- Must be the currently authenticated staff member
  if p_staff_id is distinct from (
    select id from staff where auth_user_id = auth.uid() and is_active limit 1
  ) then
    raise exception 'Not authorized';
  end if;

  select exists (
    select 1
    from staff s
    where s.id = p_staff_id
      and s.is_active
      and s.login_pin is not null
      and s.login_pin = trim(p_pin)
  ) into v_ok;

  if not v_ok then
    -- Also allow Auth password for email-login managers unlocking
    begin
      -- Fallback: PIN matches auth_secret hash path not available here;
      -- email managers unlock via client signIn check. Return false.
      null;
    end;
  end if;

  if not coalesce(v_ok, false) then
    raise exception 'Invalid PIN';
  end if;
  return true;
end;
$$;

grant execute on function public.claim_staff_session(uuid, uuid) to authenticated;
grant execute on function public.heartbeat_staff_session(uuid, uuid) to authenticated;
grant execute on function public.release_staff_session(uuid, uuid) to authenticated;
grant execute on function public.verify_own_pin(uuid, text) to authenticated;
