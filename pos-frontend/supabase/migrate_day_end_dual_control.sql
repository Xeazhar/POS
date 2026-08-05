-- Dual-control day close: cashier submits → supervisor/manager approves
-- Closed/submitted days block voids/refunds; reopen requires reason + audit log

-- ── Extend day_ends ─────────────────────────────────────────────────
alter table day_ends add column if not exists expected_cash numeric(10,2);
alter table day_ends add column if not exists submitted_at timestamptz;
alter table day_ends add column if not exists submitted_by uuid references staff(id) on delete set null;
alter table day_ends add column if not exists approved_at timestamptz;
alter table day_ends add column if not exists approved_by uuid references staff(id) on delete set null;
alter table day_ends add column if not exists reopen_reason text;

alter table day_ends drop constraint if exists day_ends_status_check;
alter table day_ends add constraint day_ends_status_check
  check (status in ('submitted', 'closed', 'reopened'));

-- ── Business date for a timestamp (Asia/Manila, branch open hour) ───
create or replace function public.business_date_for(p_when timestamptz, p_open_hour integer default 7)
returns date
language sql
stable
set search_path = public
as $$
  select case
    when extract(hour from (timezone('Asia/Manila', p_when))) < greatest(0, least(23, coalesce(p_open_hour, 7)))
      then (timezone('Asia/Manila', p_when))::date - 1
    else (timezone('Asia/Manila', p_when))::date
  end;
$$;

-- ── Till open for new sales (submitted + closed lock POS) ───────────
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

  if v_status in ('closed', 'submitted') then
    raise exception 'Till is locked for this business day. Submit is pending approval or the day is closed — ask a manager.';
  end if;
end;
$$;

-- ── Block void/refund when business day is submitted or closed ───────
create or replace function public.assert_business_day_mutable(p_branch_id uuid, p_when timestamptz)
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

  v_biz_date := public.business_date_for(p_when, coalesce(v_open_hour, 7));

  select status into v_status
  from day_ends
  where branch_id = p_branch_id
    and business_date = v_biz_date;

  if v_status in ('closed', 'submitted') then
    raise exception 'This business day is locked. Voids and refunds require the day to be reopened first.';
  end if;
end;
$$;

-- ── Cashier / staff: submit for closing (not final close) ────────────
create or replace function public.submit_day_end(
  p_branch_id uuid,
  p_staff_id uuid,
  p_business_date date,
  p_recorded_cash numeric,
  p_cash_on_hand numeric,
  p_variance numeric,
  p_expected_cash numeric,
  p_note text default null,
  p_day_report jsonb default null,
  p_day_end_id uuid default null
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
begin
  if p_branch_id is distinct from public.current_staff_branch() and not public.is_manager() then
    raise exception 'Not authorized for this branch';
  end if;

  select * into v_row
  from day_ends
  where branch_id = p_branch_id
    and business_date = p_business_date
  for update;

  if found and v_row.status = 'closed' then
    raise exception 'Day is already closed';
  end if;

  if found then
    update day_ends
    set
      staff_id = p_staff_id,
      recorded_cash = p_recorded_cash,
      cash_on_hand = p_cash_on_hand,
      variance = p_variance,
      expected_cash = p_expected_cash,
      note = p_note,
      day_report = coalesce(p_day_report, day_report),
      status = 'submitted',
      submitted_at = now(),
      submitted_by = p_staff_id,
      approved_at = null,
      approved_by = null,
      closed_at = coalesce(closed_at, now()),
      reopened_at = null,
      reopened_by = null,
      reopen_reason = null
    where id = v_row.id
    returning * into v_row;
    return v_row;
  end if;

  insert into day_ends (
    branch_id, staff_id, business_date,
    recorded_cash, cash_on_hand, variance, expected_cash,
    note, day_report, status,
    submitted_at, submitted_by, closed_at
  ) values (
    p_branch_id, p_staff_id, p_business_date,
    p_recorded_cash, p_cash_on_hand, p_variance, p_expected_cash,
    p_note, p_day_report, 'submitted',
    now(), p_staff_id, now()
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- ── Supervisor+: approve and close day ─────────────────────────────
create or replace function public.approve_day_end(p_day_end_id uuid, p_staff_id uuid)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
begin
  if not public.is_supervisor_or_above() then
    raise exception 'Only supervisors or managers can approve day close';
  end if;

  update day_ends
  set
    status = 'closed',
    approved_at = now(),
    approved_by = p_staff_id,
    closed_at = coalesce(closed_at, now())
  where id = p_day_end_id
    and status = 'submitted'
  returning * into v_row;

  if not found then
    raise exception 'No submitted day end found to approve';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_approved',
    'Approved close for ' || v_row.business_date::text,
    jsonb_build_object(
      'day_end_id', v_row.id,
      'business_date', v_row.business_date,
      'variance', v_row.variance,
      'cash_on_hand', v_row.cash_on_hand
    )
  );

  return v_row;
end;
$$;

-- ── Manager: reopen with required reason ───────────────────────────
drop function if exists public.reopen_day_end(uuid, uuid);

create or replace function public.reopen_day_end(
  p_day_end_id uuid,
  p_staff_id uuid,
  p_reason text
)
returns public.day_ends
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.day_ends;
  v_reason text;
begin
  if not public.is_manager() then
    raise exception 'Only managers can reopen the till';
  end if;

  v_reason := nullif(trim(p_reason), '');
  if v_reason is null then
    raise exception 'Reopen reason is required';
  end if;

  update day_ends
  set
    status = 'reopened',
    reopened_at = now(),
    reopened_by = p_staff_id,
    reopen_reason = v_reason
  where id = p_day_end_id
    and status = 'closed'
  returning * into v_row;

  if not found then
    raise exception 'Only a closed day can be reopened';
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id,
    p_staff_id,
    'day_end_reopen',
    'Reopened till for ' || v_row.business_date::text || ': ' || left(v_reason, 200),
    jsonb_build_object(
      'day_end_id', v_row.id,
      'business_date', v_row.business_date,
      'reason', v_reason
    )
  );

  return v_row;
end;
$$;

-- ── Void / refund: respect closed day ──────────────────────────────
create or replace function void_sale_secure(
  p_transaction_id uuid,
  p_staff_id uuid,
  p_reason text
)
returns transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn transactions;
  v_line record;
begin
  select * into v_txn from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaction not found';
  end if;

  perform public.assert_business_day_mutable(v_txn.branch_id, v_txn.created_at);

  if v_txn.status = 'voided' then
    raise exception 'Transaction already voided';
  end if;

  update transactions
  set
    status = 'voided',
    void_reason = coalesce(nullif(trim(p_reason), ''), 'Voided'),
    voided_at = now(),
    voided_by = p_staff_id
  where id = p_transaction_id
  returning * into v_txn;

  for v_line in
    select product_id, quantity from transaction_items where transaction_id = p_transaction_id
  loop
    perform record_stock_movement(
      v_txn.branch_id,
      v_line.product_id,
      p_staff_id,
      'restock',
      v_line.quantity,
      0,
      v_txn.id::text,
      'Void restock ' || coalesce(v_txn.or_number, v_txn.id::text)
    );
  end loop;

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'void',
    v_txn.or_number,
    v_txn.void_reason,
    v_txn.total_amount,
    jsonb_build_object('voided_at', v_txn.voided_at)
  );

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_void',
    'Voided ' || coalesce(v_txn.or_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'reason', v_txn.void_reason)
  );

  return v_txn;
end;
$$;

-- Patch refund_sale_items (body from latest migration + assert at start)
create or replace function public.refund_sale_items(
  p_transaction_id uuid,
  p_staff_id uuid,
  p_reason text,
  p_items jsonb,
  p_approved_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn transactions;
  v_entry jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_line record;
  v_already numeric;
  v_refund_qty numeric;
  v_amount numeric;
  v_total numeric := 0;
  v_count int := 0;
  v_remaining_all numeric;
  v_sold_all numeric;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Select at least one item to refund';
  end if;

  select * into v_txn from transactions where id = p_transaction_id for update;
  if not found then
    raise exception 'Transaction not found';
  end if;

  perform public.assert_business_day_mutable(v_txn.branch_id, v_txn.created_at);

  if v_txn.status = 'voided' then
    raise exception 'Transaction already fully refunded / voided';
  end if;
  if v_txn.status is distinct from 'completed' then
    raise exception 'Only completed sales can be refunded';
  end if;

  for v_entry in select * from jsonb_array_elements(p_items)
  loop
    v_item_id := nullif(v_entry->>'item_id', '')::uuid;
    v_qty := coalesce((v_entry->>'quantity')::numeric, 0);
    if v_item_id is null or v_qty <= 0 then
      raise exception 'Invalid refund line';
    end if;

    select ti.id, ti.product_id, ti.quantity, ti.unit_price, ti.line_total
      into v_line
    from transaction_items ti
    where ti.id = v_item_id and ti.transaction_id = p_transaction_id;

    if not found then
      raise exception 'Refund item does not belong to this sale';
    end if;

    select coalesce(sum(quantity), 0) into v_already
    from sale_refund_lines
    where transaction_item_id = v_item_id;

    v_refund_qty := least(v_qty, greatest(0, v_line.quantity - v_already));
    if v_refund_qty <= 0 then
      raise exception 'Item already fully refunded';
    end if;

    v_amount := round((v_line.unit_price * v_refund_qty)::numeric, 2);
    v_total := v_total + v_amount;
    v_count := v_count + 1;

    insert into sale_refund_lines (
      branch_id, transaction_id, transaction_item_id, product_id,
      quantity, amount, staff_id, approved_by, reason
    ) values (
      v_txn.branch_id, p_transaction_id, v_item_id, v_line.product_id,
      v_refund_qty, v_amount, p_staff_id, p_approved_by,
      coalesce(nullif(trim(p_reason), ''), 'Item refund')
    );

    begin
      perform record_stock_movement(
        v_txn.branch_id,
        v_line.product_id,
        p_staff_id,
        'restock',
        v_refund_qty,
        0,
        v_txn.id::text,
        'Refund restock ' || coalesce(v_txn.or_number, v_txn.id::text)
      );
    exception when others then
      null;
    end;
  end loop;

  select coalesce(sum(quantity), 0) into v_remaining_all
  from transaction_items where transaction_id = p_transaction_id;

  select coalesce(sum(quantity), 0) into v_sold_all
  from sale_refund_lines where transaction_id = p_transaction_id;

  update transactions
  set refunded_amount = coalesce(refunded_amount, 0) + v_total
  where id = p_transaction_id;

  if v_sold_all >= v_remaining_all then
    update transactions
    set status = 'voided',
        void_reason = coalesce(nullif(trim(p_reason), ''), 'Fully refunded'),
        voided_at = now(),
        voided_by = p_staff_id
    where id = p_transaction_id;
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_refund',
    'Refunded ' || v_count || ' line(s) on ' || coalesce(v_txn.or_number, v_txn.id::text),
    jsonb_build_object('transaction_id', p_txn.id, 'amount', v_total, 'reason', p_reason)
  );

  return jsonb_build_object('refunded_amount', v_total, 'line_count', v_count);
end;
$$;

grant execute on function public.business_date_for(timestamptz, integer) to authenticated;
grant execute on function public.assert_business_day_mutable(uuid, timestamptz) to authenticated;
grant execute on function public.submit_day_end(uuid, uuid, date, numeric, numeric, numeric, numeric, text, jsonb, uuid) to authenticated;
grant execute on function public.approve_day_end(uuid, uuid) to authenticated;
grant execute on function public.reopen_day_end(uuid, uuid, text) to authenticated;
