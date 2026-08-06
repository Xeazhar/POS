-- Allow manager / admin / master PIN approval on any branch (supervisor cover).
-- Supervisors remain branch-scoped.

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

  -- Branch supervisors first
  select s.* into v_staff
  from public.staff s
  where s.login_code = trim(p_login_code)
    and s.is_active
    and s.branch_id = p_branch_id
    and s.role = 'supervisor'
  limit 1;

  -- Managers / admin / master may approve any cashier branch (cover when supervisor away)
  if not found then
    select s.* into v_staff
    from public.staff s
    where s.login_code = trim(p_login_code)
      and s.is_active
      and s.role in ('manager', 'admin', 'master')
    limit 1;
  end if;

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
