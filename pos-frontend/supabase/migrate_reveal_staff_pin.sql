-- Manager-only PIN reveal — never let the client SELECT login_pin from staff directly.
--
-- WHY: RLS on `staff` is row-level, not column-level. Managers legitimately read the table,
-- but a direct client SELECT is harder to audit and easier to misuse than a narrow RPC.
-- Supervisors must never reach this function — they use branch_staff_roster() instead
-- (migrate_branch_staff_roster.sql).
--
-- Apply after migrate_branch_staff_roster.sql. Safe to re-run.

create or replace function public.reveal_staff_pin(p_staff_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row jsonb;
begin
  if not public.is_manager() then
    raise exception 'Not authorized to reveal staff PIN';
  end if;

  select jsonb_build_object(
    'id', s.id,
    'full_name', s.full_name,
    'login_code', s.login_code,
    'login_pin', s.login_pin,
    'role', s.role
  )
  into v_row
  from public.staff s
  where s.id = p_staff_id;

  if v_row is null then
    raise exception 'Staff not found';
  end if;

  return v_row;
end;
$$;

grant execute on function public.reveal_staff_pin(uuid) to authenticated;

-- Verify (as manager):
--   select public.reveal_staff_pin('<cashier-staff-id>');
-- Verify (as supervisor — must fail):
--   select public.reveal_staff_pin('<cashier-staff-id>');
