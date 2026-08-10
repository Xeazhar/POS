-- void_sale_secure never accepted or recorded who approved a void — the client patched
-- transactions.void_approved_by after the fact (a second, non-atomic round trip), but the
-- append-only sale_events log (what the Void/Refund Log report reads its "Approved by"
-- column from) never got it, so that column stayed blank for every void. Mirrors how
-- refund_sale_items already records p_approved_by in both places.
--
-- Supersedes the void_sale_secure body from migrate_day_end_dual_control.sql (keeps its
-- assert_business_day_mutable check) — needs that migration applied first.

drop function if exists void_sale_secure(uuid, uuid, text);

create or replace function void_sale_secure(
  p_transaction_id uuid,
  p_staff_id uuid,
  p_reason text,
  p_approved_by uuid default null
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
    voided_by = p_staff_id,
    void_approved_by = p_approved_by
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
    jsonb_build_object('voided_at', v_txn.voided_at, 'approved_by', p_approved_by)
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

grant execute on function void_sale_secure(uuid, uuid, text, uuid) to authenticated;
