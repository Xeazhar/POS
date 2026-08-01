-- Day-end lock: closed till blocks POS until manager reopen or next business day

alter table day_ends
  add column if not exists status text not null default 'closed'
    check (status in ('closed', 'reopened'));

alter table day_ends
  add column if not exists reopened_at timestamptz;

alter table day_ends
  add column if not exists reopened_by uuid references staff(id) on delete set null;

alter table branches
  add column if not exists day_open_hour integer not null default 7
    check (day_open_hour >= 0 and day_open_hour <= 23);

drop function if exists public.current_business_date();

create or replace function public.current_business_date(p_open_hour integer default 7)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when extract(hour from (timezone('Asia/Manila', now()))) < greatest(0, least(23, coalesce(p_open_hour, 7)))
      then (timezone('Asia/Manila', now()))::date - 1
    else (timezone('Asia/Manila', now()))::date
  end;
$$;

create or replace function public.assert_till_open(p_branch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_open_hour integer;
  v_biz_date date;
begin
  select coalesce(day_open_hour, 7) into v_open_hour
  from branches
  where id = p_branch_id;

  v_open_hour := coalesce(v_open_hour, 7);
  v_biz_date := public.current_business_date(v_open_hour);

  select status into v_status
  from day_ends
  where branch_id = p_branch_id
    and business_date = v_biz_date;

  if v_status = 'closed' then
    raise exception 'Till is closed for this business day. Ask a manager to reopen.';
  end if;
end;
$$;

grant execute on function public.current_business_date(integer) to authenticated;
grant execute on function public.assert_till_open(uuid) to authenticated;

drop policy if exists "update day ends" on day_ends;
create policy "update day ends" on day_ends for update to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

create or replace function public.reopen_day_end(p_day_end_id uuid, p_staff_id uuid)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare v_row public.day_ends;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reopen the till';
  end if;
  update day_ends
  set status = 'reopened',
      reopened_at = now(),
      reopened_by = p_staff_id
  where id = p_day_end_id
  returning * into strict v_row;
  return v_row;
end;
$$;

grant execute on function public.reopen_day_end(uuid, uuid) to authenticated;
