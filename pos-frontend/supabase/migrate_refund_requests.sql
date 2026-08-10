-- Remote manager approval for refunds/voids: a cashier with no supervisor on
-- site ticks "notify manager instead" (Transactions.jsx). That creates a
-- pending row here instead of writing straight to `transactions` — the
-- guard_transaction_updates() trigger (migrate_refund_amount_on_transactions.sql)
-- only allows completed->voided or a refunded_amount increase, and rejects any
-- update once a row is voided, so a pending/awaiting state cannot live on
-- `transactions` itself. Mirrors promo dual-control (migrate_promo_dual_control.sql,
-- migrate_promo_reject_reason.sql): status/requested_by/approved_by columns +
-- approve/reject RPCs, manager-only via is_manager() (no branch scoping, so a
-- remote manager on any device can act on any branch's request).
--
-- Requires migrate_fix_refund_sale_items_typo.sql and migrate_void_sale_approved_by.sql
-- (this migration calls both functions with their p_approved_by parameter).

create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id),
  branch_id uuid not null references public.branches(id),
  mode text not null check (mode in ('full', 'items')),
  reason text not null,
  items jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null references public.staff(id),
  requested_at timestamptz not null default now(),
  approved_by uuid references public.staff(id),
  approved_at timestamptz,
  reject_reason text
);

-- Only one open request per sale at a time.
create unique index if not exists uq_refund_requests_pending_txn
  on public.refund_requests(transaction_id)
  where status = 'pending';

create index if not exists idx_refund_requests_branch_status
  on public.refund_requests(branch_id, status);

alter table public.refund_requests enable row level security;

drop policy if exists "read refund requests" on public.refund_requests;
drop policy if exists "create refund requests" on public.refund_requests;
drop policy if exists "update refund requests" on public.refund_requests;

create policy "read refund requests" on public.refund_requests for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

create policy "create refund requests" on public.refund_requests for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());

create policy "update refund requests" on public.refund_requests for update to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

create or replace function public.request_refund_approval(
  p_transaction_id uuid,
  p_staff_id uuid,
  p_branch_id uuid,
  p_mode text,
  p_reason text,
  p_items jsonb default null
)
returns public.refund_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.refund_requests;
begin
  if p_mode not in ('full', 'items') then
    raise exception 'Invalid refund mode';
  end if;
  if p_mode = 'items' and (p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0) then
    raise exception 'Select at least one item to refund';
  end if;

  insert into refund_requests (transaction_id, branch_id, mode, reason, items, requested_by)
  values (
    p_transaction_id, p_branch_id, p_mode,
    coalesce(nullif(trim(p_reason), ''), 'Refund'),
    case when p_mode = 'items' then p_items else null end,
    p_staff_id
  )
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'refund_requested',
    'Requested manager approval for refund on ' || v_row.transaction_id::text,
    jsonb_build_object('refund_request_id', v_row.id, 'transaction_id', v_row.transaction_id, 'mode', v_row.mode)
  );

  return v_row;
exception
  when unique_violation then
    raise exception 'A refund request is already pending for this sale';
end;
$$;

create or replace function public.approve_refund_request(p_request_id uuid, p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req public.refund_requests;
  v_result jsonb;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve refund requests';
  end if;

  select * into v_req from refund_requests where id = p_request_id and status = 'pending' for update;
  if not found then
    raise exception 'No pending refund request found';
  end if;

  if v_req.mode = 'full' then
    perform public.void_sale_secure(v_req.transaction_id, v_req.requested_by, v_req.reason, p_staff_id);
    v_result := jsonb_build_object('ok', true, 'fully_voided', true);
  else
    select public.refund_sale_items(v_req.transaction_id, v_req.requested_by, v_req.reason, v_req.items, p_staff_id)
      into v_result;
  end if;

  update refund_requests
  set status = 'approved', approved_by = p_staff_id, approved_at = now()
  where id = p_request_id;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_req.branch_id, p_staff_id, 'refund_request_approved',
    'Approved refund request on ' || v_req.transaction_id::text,
    jsonb_build_object('refund_request_id', v_req.id, 'transaction_id', v_req.transaction_id)
  );

  return v_result;
end;
$$;

create or replace function public.reject_refund_request(p_request_id uuid, p_staff_id uuid, p_reason text)
returns public.refund_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.refund_requests;
  v_reason text;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reject refund requests';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reject reason is required';
  end if;

  update refund_requests
  set status = 'rejected', approved_by = p_staff_id, approved_at = now(), reject_reason = v_reason
  where id = p_request_id and status = 'pending'
  returning * into v_row;

  if not found then
    raise exception 'No pending refund request found';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'refund_request_rejected',
    'Rejected refund request on ' || v_row.transaction_id::text || ' — ' || left(v_reason, 200),
    jsonb_build_object('refund_request_id', v_row.id, 'transaction_id', v_row.transaction_id, 'reason', v_reason)
  );

  return v_row;
end;
$$;

create or replace function public.cancel_refund_request(p_request_id uuid, p_staff_id uuid)
returns public.refund_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.refund_requests;
begin
  update refund_requests
  set status = 'cancelled'
  where id = p_request_id
    and status = 'pending'
    and (requested_by = p_staff_id or public.is_manager())
  returning * into v_row;

  if not found then
    raise exception 'No pending refund request found';
  end if;

  return v_row;
end;
$$;

grant execute on function public.request_refund_approval(uuid, uuid, uuid, text, text, jsonb) to authenticated;
grant execute on function public.approve_refund_request(uuid, uuid) to authenticated;
grant execute on function public.reject_refund_request(uuid, uuid, text) to authenticated;
grant execute on function public.cancel_refund_request(uuid, uuid) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'refund_requests'
  ) then
    alter publication supabase_realtime add table public.refund_requests;
  end if;
end $$;

notify pgrst, 'reload schema';
