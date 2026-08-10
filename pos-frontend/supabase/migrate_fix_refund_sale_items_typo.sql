-- Fixes three regressions introduced when migrate_day_end_dual_control.sql "patched"
-- refund_sale_items (to add the business-day-lock assert) by pasting in a body that had
-- silently dropped pieces of the original migrate_refund_sale_items.sql:
--
-- 1. The final audit_events insert referenced "p_txn" — never declared (only v_txn exists)
--    — so every item refund, any number of items, failed at that unconditional line with
--    "missing FROM-clause entry for table p_txn". A full refund (void_sale_secure, a
--    separate RPC) was never affected.
-- 2. Both sale_events inserts (the 'refund' event itself, and the 'void' event when a
--    refund happens to consume every remaining unit) were dropped entirely. Item refunds
--    never showed up on the Void/Refund Log report — not even with a blank approver, the
--    row just never existed.
-- 3. The returned jsonb dropped the `fully_voided` key. posStore.js's
--    refundTransactionItems() branches on `result?.fully_voided` to flip the transaction to
--    "Voided" in local state — without it, a refund that fully consumed a sale left the UI
--    showing it as still Paid even though the DB had already voided it.
--
-- Same signature as before, so no drop needed — only the body changes.

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
  v_sold_total numeric;
  v_refunded_total numeric;
  v_fully_voided boolean;
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

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'refund',
    v_txn.or_number,
    coalesce(nullif(trim(p_reason), ''), 'Item refund'),
    v_total,
    jsonb_build_object('items', p_items, 'approved_by', p_approved_by, 'partial', true)
  );

  select coalesce(sum(quantity), 0) into v_sold_total
  from transaction_items where transaction_id = p_transaction_id;

  select coalesce(sum(quantity), 0) into v_refunded_total
  from sale_refund_lines where transaction_id = p_transaction_id;

  v_fully_voided := v_sold_total > 0 and v_refunded_total >= v_sold_total;

  update transactions
  set refunded_amount = coalesce(refunded_amount, 0) + v_total
  where id = p_transaction_id;

  if v_fully_voided then
    update transactions
    set status = 'voided',
        void_reason = coalesce(nullif(trim(p_reason), ''), 'Fully refunded'),
        voided_at = now(),
        voided_by = p_staff_id,
        void_approved_by = p_approved_by
    where id = p_transaction_id;

    insert into sale_events (branch_id, transaction_id, staff_id, event_type, or_number, reason, amount, payload)
    values (
      v_txn.branch_id,
      v_txn.id,
      p_staff_id,
      'void',
      v_txn.or_number,
      'Auto-void after full item refund',
      v_txn.total_amount,
      jsonb_build_object('from_full_item_refund', true, 'approved_by', p_approved_by)
    );
  end if;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_refund',
    'Refunded ' || v_count || ' line(s) on ' || coalesce(v_txn.or_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'amount', v_total, 'reason', p_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'refunded_amount', v_total,
    'line_count', v_count,
    'fully_voided', v_fully_voided
  );
end;
$$;

grant execute on function public.refund_sale_items(uuid, uuid, text, jsonb, uuid) to authenticated;
