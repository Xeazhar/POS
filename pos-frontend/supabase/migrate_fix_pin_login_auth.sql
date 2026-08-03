-- CalePOS: fix PIN login (Auth password out of sync / unconfirmed email)
-- Safe to re-run. Run in Supabase SQL editor.

create extension if not exists pgcrypto with schema extensions;

-- Stable Auth password (separate from the PIN staff type at the till)
alter table public.staff add column if not exists auth_secret text;

-- Backfill: use current PIN as secret for existing PIN staff (then sync into Auth below)
update public.staff
set auth_secret = login_pin
where login_code is not null
  and login_code <> ''
  and (auth_secret is null or auth_secret = '')
  and login_pin is not null
  and login_pin <> '';

-- Confirm fake PIN emails + sync Auth password to staff.auth_secret
do $$
begin
  update auth.users u
  set
    encrypted_password = extensions.crypt(s.auth_secret, extensions.gen_salt('bf')),
    email_confirmed_at = coalesce(u.email_confirmed_at, now()),
    updated_at = now()
  from public.staff s
  where s.auth_user_id = u.id
    and s.auth_secret is not null
    and s.auth_secret <> ''
    and s.login_code is not null
    and s.login_code <> '';
exception
  when undefined_function then
    update auth.users u
    set
      encrypted_password = crypt(s.auth_secret, gen_salt('bf')),
      email_confirmed_at = coalesce(u.email_confirmed_at, now()),
      updated_at = now()
    from public.staff s
    where s.auth_user_id = u.id
      and s.auth_secret is not null
      and s.auth_secret <> ''
      and s.login_code is not null
      and s.login_code <> '';
end $$;

-- Auto-confirm future pin.*@calepos.local signups
create or replace function public.trg_confirm_pin_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth, extensions
as $$
begin
  if new.email is not null and new.email like 'pin.%@calepos.local' then
    new.email_confirmed_at := coalesce(new.email_confirmed_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists confirm_pin_auth_user on auth.users;
create trigger confirm_pin_auth_user
  before insert or update of email on auth.users
  for each row
  execute function public.trg_confirm_pin_auth_user();

-- Resolve PIN → Auth email + Auth password (auth_secret), after validating till PIN
drop function if exists public.resolve_pin_login(text, text);

create or replace function public.resolve_pin_login(p_login_code text, p_pin text)
returns table (
  auth_email text,
  auth_password text,
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
  v_password text;
begin
  if p_login_code is null or length(trim(p_login_code)) < 4 then
    raise exception 'Invalid staff code';
  end if;

  select s.* into v_staff
  from public.staff s
  where s.login_code = trim(p_login_code)
    and s.is_active
    and s.role in ('cashier', 'supervisor')
  limit 1;

  if not found then
    raise exception 'Invalid staff code or PIN';
  end if;

  if v_staff.login_pin is distinct from trim(p_pin) then
    raise exception 'Invalid staff code or PIN';
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_staff.auth_user_id;

  if v_email is null then
    raise exception 'Staff account is not linked to a login';
  end if;

  v_password := nullif(trim(coalesce(v_staff.auth_secret, '')), '');
  if v_password is null then
    v_password := trim(p_pin);
  end if;

  begin
    update auth.users
    set
      encrypted_password = extensions.crypt(v_password, extensions.gen_salt('bf')),
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      updated_at = now()
    where id = v_staff.auth_user_id;
  exception
    when undefined_function then
      update auth.users
      set
        encrypted_password = crypt(v_password, gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
      where id = v_staff.auth_user_id;
  end;

  if v_staff.auth_secret is null or v_staff.auth_secret = '' then
    update public.staff set auth_secret = v_password where id = v_staff.id;
  end if;

  auth_email := v_email;
  auth_password := v_password;
  staff_id := v_staff.id;
  full_name := v_staff.full_name;
  role := v_staff.role;
  branch_id := v_staff.branch_id;
  return next;
end;
$$;

grant execute on function public.resolve_pin_login(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
