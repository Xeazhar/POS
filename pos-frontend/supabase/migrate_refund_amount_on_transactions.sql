-- Track cumulative refunded amount on sales for net totals in UI / day-end.
-- Safe to re-run.

alter table transactions
  add column if not exists refunded_amount numeric(12,2) not null default 0;

-- Allow refunded_amount updates (partial refunds). Other sale fields stay locked.
create or replace function guard_transaction_updates()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'transactions cannot be deleted';
  end if;

  if old.status = 'voided' then
    raise exception 'voided transactions are locked';
  end if;

  if new.branch_id is distinct from old.branch_id
     or new.total_amount is distinct from old.total_amount
     or new.amount_tendered is distinct from old.amount_tendered
     or new.change_given is distinct from old.change_given
     or new.or_number is distinct from old.or_number
     or new.created_at is distinct from old.created_at
     or new.staff_id is distinct from old.staff_id
     or new.client_id is distinct from old.client_id then
    raise exception 'sale financial fields are immutable';
  end if;

  if new.status = 'voided' and old.status = 'completed' then
    new.voided_at := coalesce(new.voided_at, now());
    return new;
  end if;

  -- Partial refunds: only refunded_amount may change on a completed sale
  if old.status = 'completed'
     and new.status = 'completed'
     and new.refunded_amount is distinct from old.refunded_amount
     and coalesce(new.refunded_amount, 0) >= coalesce(old.refunded_amount, 0) then
    return new;
  end if;

  raise exception 'transactions are immutable except for voiding a completed sale';
end;
$$;

-- Backfill from existing refund lines
update transactions as t
set refunded_amount = s.total
from (
  select transaction_id, coalesce(sum(amount), 0)::numeric(12,2) as total
  from sale_refund_lines
  group by transaction_id
) as s
where t.id = s.transaction_id;

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

  update transactions
  set refunded_amount = coalesce(refunded_amount, 0) + v_total
  where id = p_transaction_id;

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'refund',
    v_txn.or_number,
    coalesce(nullif(trim(p_reason), ''), 'Item refund'),
    v_total,
    jsonb_build_object(
      'items', p_items,
      'approved_by', p_approved_by,
      'partial', true
    )
  );

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_refund',
    'Refund on ' || coalesce(v_txn.or_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'amount', v_total, 'lines', v_count)
  );

  select coalesce(sum(quantity), 0) into v_sold_all
  from transaction_items where transaction_id = p_transaction_id;
  select coalesce(sum(quantity), 0) into v_remaining_all
  from sale_refund_lines where transaction_id = p_transaction_id;

  if v_remaining_all >= v_sold_all and v_sold_all > 0 then
    begin
      update transactions
      set
        status = 'voided',
        void_reason = coalesce(nullif(trim(p_reason), ''), 'Fully refunded'),
        voided_at = now(),
        voided_by = p_staff_id,
        void_approved_by = coalesce(p_approved_by, p_staff_id)
      where id = p_transaction_id;
    exception when undefined_column then
      update transactions
      set
        status = 'voided',
        void_reason = coalesce(nullif(trim(p_reason), ''), 'Fully refunded'),
        voided_at = now(),
        voided_by = p_staff_id
      where id = p_transaction_id;
    end;

    insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
    values (
      v_txn.branch_id,
      v_txn.id,
      p_staff_id,
      'void',
      v_txn.or_number,
      'Auto-void after full item refund',
      v_txn.total_amount,
      jsonb_build_object('from_full_item_refund', true)
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'refunded_amount', v_total,
    'lines', v_count,
    'fully_voided', v_remaining_all >= v_sold_all
  );
end;
$$;

grant execute on function public.refund_sale_items(uuid, uuid, text, jsonb, uuid) to authenticated;

notify pgrst, 'reload schema';
