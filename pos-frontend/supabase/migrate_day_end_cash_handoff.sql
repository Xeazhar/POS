-- Supervisor→manager cash handoff confirmation.
--
-- A supervisor closes a day (counts drawer, submits — day auto-closes, see
-- migrate_day_end_supervisor_autoclose.sql) and later physically hands that day's cash to
-- a manager — sometimes same day, sometimes days later for a branch that isn't close by.
-- This is deliberately NON-BLOCKING: it never gates Close day, Submit day, or Approve day.
-- A manager just confirms whenever the cash actually arrives, for record-keeping.
--
-- Prerequisite: base day_ends table + is_manager() (schema.sql / early migrations).

alter table public.day_ends
  add column if not exists handoff_confirmed_by uuid references public.staff(id) on delete set null,
  add column if not exists handoff_confirmed_at timestamptz;

create or replace function public.confirm_day_end_handoff(p_day_end_id uuid)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends%rowtype;
begin
  if not public.is_manager() then
    raise exception 'DAYEND_NOT_ALLOWED: only a manager can confirm a cash handoff';
  end if;

  select * into v_row from public.day_ends where id = p_day_end_id for update;
  if not found then
    raise exception 'DAYEND_NOT_FOUND: no day-end with id %', p_day_end_id;
  end if;

  if v_row.status <> 'closed' then
    raise exception 'DAYEND_NOT_CLOSED: only a closed day can have its cash handoff confirmed';
  end if;

  -- Idempotent: re-confirming an already-confirmed row is a no-op success, same pattern
  -- as receive_shift_handoff's early return.
  if v_row.handoff_confirmed_at is not null then
    return v_row;
  end if;

  update public.day_ends
  set handoff_confirmed_by = public.current_staff_id(),
      handoff_confirmed_at = now()
  where id = p_day_end_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.confirm_day_end_handoff(uuid) from public, anon;
grant execute on function public.confirm_day_end_handoff(uuid) to authenticated;
