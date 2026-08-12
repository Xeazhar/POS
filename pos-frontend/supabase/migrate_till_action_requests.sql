-- Till action requests: remote manager approval for POS cart gates (line remove).
-- Mirrors refund_requests / cash_movements pending pattern — in-app + realtime, no FCM.
-- Safe to re-run.

create table if not exists public.till_action_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid unique,
  branch_id uuid not null references public.branches(id),
  action text not null check (action in ('cart_line_remove')),
  detail text not null default '',
  meta jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'self_allowed', 'cancelled')),
  requested_by uuid not null references public.staff(id),
  requested_at timestamptz not null default now(),
  resolved_by uuid references public.staff(id),
  resolved_at timestamptz,
  self_record_ack boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_till_action_requests_pending
  on public.till_action_requests(branch_id, requested_at desc)
  where status = 'pending';

alter table public.till_action_requests enable row level security;

drop policy if exists "read till action requests" on public.till_action_requests;
drop policy if exists "insert till action requests" on public.till_action_requests;

create policy "read till action requests" on public.till_action_requests for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

create policy "insert till action requests" on public.till_action_requests for insert to authenticated
  with check (
    (branch_id = public.current_staff_branch() and requested_by = public.current_staff_id())
    or public.is_manager()
  );

-- Writes via RPCs only.

create or replace function public.create_till_action_request(
  p_branch_id uuid,
  p_requested_by uuid,
  p_action text,
  p_detail text,
  p_meta jsonb default '{}'::jsonb,
  p_client_id uuid default null
)
returns public.till_action_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.till_action_requests%rowtype;
begin
  if p_action not in ('cart_line_remove') then
    raise exception 'TILL_ACT01: invalid action';
  end if;

  insert into public.till_action_requests (
    client_id, branch_id, action, detail, meta, requested_by, status
  ) values (
    p_client_id, p_branch_id, p_action,
    coalesce(nullif(trim(p_detail), ''), p_action),
    coalesce(p_meta, '{}'::jsonb),
    p_requested_by, 'pending'
  )
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_requested_by, 'till_action_requested',
    v_row.detail,
    jsonb_build_object('till_action_id', v_row.id, 'action', v_row.action)
  );

  return v_row;
end;
$$;

create or replace function public.resolve_till_action_request(
  p_id uuid,
  p_resolved_by uuid,
  p_status text,
  p_ack boolean default false
)
returns public.till_action_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.till_action_requests%rowtype;
begin
  if p_status not in ('approved', 'denied', 'self_allowed', 'cancelled') then
    raise exception 'TILL_ACT02: invalid status';
  end if;

  select * into v_row from public.till_action_requests where id = p_id for update;
  if not found then
    raise exception 'TILL_ACT03: request not found';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'TILL_ACT04: request already resolved';
  end if;

  if p_status = 'self_allowed' then
    if v_row.requested_by is distinct from p_resolved_by then
      raise exception 'TILL_ACT05: only requester can self-allow';
    end if;
    if p_ack is not true then
      raise exception 'TILL_ACT06: acknowledgment required';
    end if;
  elsif p_status in ('approved', 'denied') then
    if not (public.is_manager() or public.is_supervisor_or_above()) then
      raise exception 'TILL_ACT07: supervisor or manager required';
    end if;
    if p_resolved_by = v_row.requested_by then
      raise exception 'TILL_ACT08: cannot resolve your own request';
    end if;
  elsif p_status = 'cancelled' then
    if v_row.requested_by is distinct from p_resolved_by and not public.is_manager() then
      raise exception 'TILL_ACT09: only requester or manager can cancel';
    end if;
  end if;

  update public.till_action_requests
  set status = p_status,
      resolved_by = p_resolved_by,
      resolved_at = now(),
      self_record_ack = case when p_status = 'self_allowed' then true else self_record_ack end
  where id = p_id
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_resolved_by, 'till_action_' || p_status,
    v_row.detail,
    jsonb_build_object('till_action_id', v_row.id, 'action', v_row.action, 'status', p_status)
  );

  return v_row;
end;
$$;

grant execute on function public.create_till_action_request(uuid, uuid, text, text, jsonb, uuid) to authenticated;
grant execute on function public.resolve_till_action_request(uuid, uuid, text, boolean) to authenticated;

do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'till_action_requests')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'till_action_requests'
    )
  then
    alter publication supabase_realtime add table public.till_action_requests;
  end if;
end $$;

notify pgrst, 'reload schema';
