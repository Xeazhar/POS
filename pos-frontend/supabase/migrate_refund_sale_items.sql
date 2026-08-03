-- CalePOS: item-level refunds (partial) + track refunded qty
-- Full refund still voids the sale via void_sale_secure.
-- Safe to re-run.

create table if not exists sale_refund_lines (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  transaction_item_id uuid not null references transaction_items(id) on delete restrict,
  product_id uuid references products(id) on delete set null,
  quantity numeric(12,3) not null check (quantity > 0),
  amount numeric(12,2) not null default 0,
  staff_id uuid references staff(id) on delete set null,
  approved_by uuid references staff(id) on delete set null,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_sale_refund_lines_txn on sale_refund_lines(transaction_id);
create index if not exists idx_sale_refund_lines_item on sale_refund_lines(transaction_item_id);

alter table sale_refund_lines enable row level security;
drop policy if exists "read sale refund lines" on sale_refund_lines;
create policy "read sale refund lines" on sale_refund_lines for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());
drop policy if exists "insert sale refund lines" on sale_refund_lines;
create policy "insert sale refund lines" on sale_refund_lines for insert to authenticated
  with check (branch_id = public.current_staff_branch() or public.is_manager());

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

    -- Restock (no-op harmlessly if inventory RPC handles restaurant)
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
      -- keep refund recorded even if stock movement unavailable
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

  -- If every sold unit is refunded, auto full-void the sale
  select coalesce(sum(quantity), 0) into v_sold_all
  from transaction_items where transaction_id = p_transaction_id;
  select coalesce(sum(quantity), 0) into v_remaining_all
  from sale_refund_lines where transaction_id = p_transaction_id;

  if v_remaining_all >= v_sold_all and v_sold_all > 0 then
    -- Mark void without double-restocking (stock already returned above)
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
