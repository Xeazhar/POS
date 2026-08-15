-- Login perf: stop rehashing + rewriting auth.users.encrypted_password on every login.
--
-- WHY
-- ---
-- resolve_pin_login() currently calls extensions.crypt(v_password, extensions.gen_salt('bf'))
-- and UPDATEs auth.users unconditionally on every single call, even when the PIN hasn't
-- changed. gen_salt('bf') draws a fresh random salt each time, so encrypted_password churns
-- on every login regardless — real bcrypt CPU cost plus a real row UPDATE + WAL write on
-- auth.users (a table GoTrue itself reads on the very next request, the password-grant call
-- this RPC's caller always makes right after). Under concurrent load this is pure waste on
-- the hot path: the write only ever needs to happen once, the first time a PIN is set or
-- changed.
--
-- Fix: verify the existing hash first (crypt(v_password, encrypted_password) = encrypted_password);
-- only rehash + write when it does not already match. Same self-healing behavior (out-of-sync
-- password still gets repaired), same security semantics — just skips redundant work in the
-- common case. Apply after migrate_fix_pin_login_auth.sql.
--
-- Safe to re-run.

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
  v_current_hash text;
  v_hash_ok boolean;
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

  select u.email, u.encrypted_password into v_email, v_current_hash
  from auth.users u
  where u.id = v_staff.auth_user_id;

  if v_email is null then
    raise exception 'Staff account is not linked to a login';
  end if;

  v_password := nullif(trim(coalesce(v_staff.auth_secret, '')), '');
  if v_password is null then
    v_password := trim(p_pin);
  end if;

  -- Only rehash + write when the stored hash doesn't already verify against v_password.
  v_hash_ok := false;
  if v_current_hash is not null and v_current_hash <> '' then
    begin
      v_hash_ok := extensions.crypt(v_password, v_current_hash) = v_current_hash;
    exception
      when undefined_function then
        v_hash_ok := crypt(v_password, v_current_hash) = v_current_hash;
      when others then
        v_hash_ok := false;
    end;
  end if;

  if not v_hash_ok then
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
  elsif v_email is not null then
    -- Hash already valid — still make sure email_confirmed_at is set, without touching
    -- encrypted_password (avoids the unnecessary write + WAL churn on the hot path).
    update auth.users
    set email_confirmed_at = coalesce(email_confirmed_at, now())
    where id = v_staff.auth_user_id and email_confirmed_at is null;
  end if;

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
