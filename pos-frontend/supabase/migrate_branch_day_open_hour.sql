-- Per-branch till open hour (when business day rolls / auto-unlocks)

alter table branches
  add column if not exists day_open_hour integer not null default 7
    check (day_open_hour >= 0 and day_open_hour <= 23);

comment on column branches.day_open_hour is
  'Local hour (Asia/Manila) when the business day starts and a prior day-end stop blocking sales.';

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
