-- Harden PIN login:
-- 1) Rate-limit failed PIN attempts (Supabase-side; works without Cloudflare paid WAF)
-- 2) Stop returning Auth password to the browser
-- 3) Sync Auth password to till PIN so client signs in with PIN + captchaToken
-- 4) Allow complex PINs (letters + symbols), not digits-only
--
-- Run in Supabase SQL editor. Safe to re-run.

create table if not exists public.pin_login_attempts (
  login_code text primary key,
  fail_count integer not null default 0,
  locked_until timestamptz null,
  last_attempt_at timestamptz not null default now()
);

alter table public.pin_login_attempts enable row level security;

-- No client policies: only security definer functions touch this table.
drop policy if exists "deny all pin_login_attempts" on public.pin_login_attempts;
create policy "deny all pin_login_attempts" on public.pin_login_attempts
  for all to authenticated, anon
  using (false)
  with check (false);

create or replace function public.assert_pin_not_locked(p_login_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locked timestamptz;
begin
  select locked_until into v_locked
  from public.pin_login_attempts
  where login_code = trim(p_login_code);

  if v_locked is not null and v_locked > now() then
    raise exception 'Too many failed PIN attempts. Try again after %',
      to_char(v_locked at time zone 'UTC', 'HH24:MI "UTC"');
  end if;
end;
$$;

create or replace function public.record_pin_login_failure(p_login_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  insert into public.pin_login_attempts (login_code, fail_count, last_attempt_at, locked_until)
  values (trim(p_login_code), 1, now(), null)
  on conflict (login_code) do update
    set
      fail_count = case
        when public.pin_login_attempts.locked_until is not null
          and public.pin_login_attempts.locked_until <= now()
        then 1
        else public.pin_login_attempts.fail_count + 1
      end,
      last_attempt_at = now(),
      locked_until = case
        when (
          case
            when public.pin_login_attempts.locked_until is not null
              and public.pin_login_attempts.locked_until <= now()
            then 1
            else public.pin_login_attempts.fail_count + 1
          end
        ) >= 5
        then now() + interval '15 minutes'
        else null
      end;
end;
$$;

create or replace function public.clear_pin_login_failures(p_login_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.pin_login_attempts where login_code = trim(p_login_code);
end;
$$;

-- Resolve PIN → Auth email only (NO password returned).
-- Client must call signInWithPassword(auth_email, pin, captchaToken).
drop function if exists public.resolve_pin_login(text, text);

create or replace function public.resolve_pin_login(p_login_code text, p_pin text)
returns table (
  auth_email text,
  staff_id uuid,
  full_name text,
  role text,
  branch_id uuid
)
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
declare
  v_staff public.staff%rowtype;
  v_email text;
  v_pin text;
begin
  if p_login_code is null or length(trim(p_login_code)) < 4 then
    raise exception 'Invalid staff code';
  end if;

  v_pin := trim(coalesce(p_pin, ''));
  if length(v_pin) < 4 then
    raise exception 'Invalid staff code or PIN';
  end if;

  perform public.assert_pin_not_locked(trim(p_login_code));

  select s.* into v_staff
  from public.staff s
  where s.login_code = trim(p_login_code)
    and s.is_active
    and s.role in ('cashier', 'supervisor')
  limit 1;

  if not found then
    perform public.record_pin_login_failure(trim(p_login_code));
    raise exception 'Invalid staff code or PIN';
  end if;

  if v_staff.login_pin is distinct from v_pin then
    perform public.record_pin_login_failure(trim(p_login_code));
    raise exception 'Invalid staff code or PIN';
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_staff.auth_user_id;

  if v_email is null then
    raise exception 'Staff account is not linked to a login';
  end if;

  -- Keep Auth password synced to till PIN so client can sign in with PIN (never returned here).
  begin
    update auth.users
    set
      encrypted_password = extensions.crypt(v_pin, extensions.gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      updated_at = now()
    where id = v_staff.auth_user_id;
  exception
    when undefined_function then
      update auth.users
      set
        encrypted_password = crypt(v_pin, gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
      where id = v_staff.auth_user_id;
  end;

  update public.staff
  set auth_secret = v_pin
  where id = v_staff.id
    and (auth_secret is distinct from v_pin);

  perform public.clear_pin_login_failures(trim(p_login_code));

  auth_email := v_email;
  staff_id := v_staff.id;
  full_name := v_staff.full_name;
  role := v_staff.role;
  branch_id := v_staff.branch_id;
  return next;
end;
$$;

-- Keep anon execute (needed before Auth session), but function no longer leaks password.
grant execute on function public.resolve_pin_login(text, text) to anon, authenticated;
-- Internal helpers: no grants (security definer callers only).

-- Supervisor approval: same lockout + allow complex PIN (no digit stripping).
-- Must DROP first: return type changed from uuid → table (staff_id, full_name).
drop function if exists public.verify_supervisor_pin(uuid, text, text);

create or replace function public.verify_supervisor_pin(
  p_branch_id uuid,
  p_login_code text,
  p_pin text
)
returns table (staff_id uuid, full_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.staff%rowtype;
  v_pin text;
begin
  if p_branch_id is null then
    raise exception 'Branch required';
  end if;

  v_pin := trim(coalesce(p_pin, ''));
  if p_login_code is null or length(trim(p_login_code)) < 4 or length(v_pin) < 4 then
    raise exception 'Invalid supervisor code or PIN';
  end if;

  perform public.assert_pin_not_locked(trim(p_login_code));

  select s.* into v_staff
  from public.staff s
  where s.login_code = trim(p_login_code)
    and s.is_active
    and s.branch_id = p_branch_id
    and s.role in ('supervisor', 'manager', 'admin', 'master')
  limit 1;

  if not found or v_staff.login_pin is distinct from v_pin then
    perform public.record_pin_login_failure(trim(p_login_code));
    raise exception 'Invalid supervisor code or PIN';
  end if;

  perform public.clear_pin_login_failures(trim(p_login_code));

  staff_id := v_staff.id;
  full_name := v_staff.full_name;
  return next;
end;
$$;

grant execute on function public.verify_supervisor_pin(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
