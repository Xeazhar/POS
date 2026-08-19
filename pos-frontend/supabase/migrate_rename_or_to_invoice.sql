-- Rename OR (Official Receipt) terminology to Sales Invoice, per EOPT Act (RA 11976) /
-- RR 7-2024 — the invoice is the primary sales document, not the OR.
--
-- Renames only column/function names and the future-allocation prefix ('OR' -> 'SI').
-- Historical invoice_number text already stored on past sales (e.g. "OR-00000123") is left
-- exactly as printed/issued — this migration does not rewrite immutable fiscal records.
--
-- Apply after every earlier migrate_*.sql (this repeats the latest bodies of complete_sale,
-- void_sale_secure, refund_sale_items, guard_transaction_updates as currently defined).
-- Safe to re-run.

begin;

-- 1) branches: sequence-allocation columns
alter table branches rename column or_prefix to invoice_prefix;
alter table branches rename column or_next to invoice_next;
alter table branches rename constraint branches_or_next_check to branches_invoice_next_check;
alter table branches alter column invoice_prefix set default 'SI';
update branches set invoice_prefix = 'SI' where invoice_prefix = 'OR';

-- 2) transactions / sale_events: the fiscal number column
alter table transactions rename column or_number to invoice_number;
alter index uq_transactions_branch_or rename to uq_transactions_branch_invoice;
alter table sale_events rename column or_number to invoice_number;

-- 3) allocation RPCs
drop function if exists public.reserve_or_number(uuid, text);
drop function if exists public.allocate_or_number(uuid);

create or replace function public.allocate_invoice_number(p_branch_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prefix text;
  v_next bigint;
  v_invoice text;
begin
  select invoice_prefix, invoice_next
  into v_prefix, v_next
  from branches
  where id = p_branch_id
  for update;

  if not found then
    raise exception 'Branch not found';
  end if;

  v_invoice := coalesce(nullif(v_prefix, ''), 'SI') || '-' || lpad(v_next::text, 8, '0');
  update branches set invoice_next = v_next + 1 where id = p_branch_id;
  return v_invoice;
end;
$function$;
-- Hardened: only reachable from within complete_sale()/reserve_invoice_number() flows.
revoke execute on function public.allocate_invoice_number(uuid) from public;
grant execute on function public.allocate_invoice_number(uuid) to authenticated;

create or replace function public.reserve_invoice_number(p_branch_id uuid, p_invoice_number text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_prefix text;
  v_next bigint;
  v_seq bigint;
  v_expected text;
begin
  if p_invoice_number is null or trim(p_invoice_number) = '' then
    return allocate_invoice_number(p_branch_id);
  end if;

  select invoice_prefix, invoice_next
  into v_prefix, v_next
  from branches
  where id = p_branch_id
  for update;

  if not found then
    raise exception 'Branch not found';
  end if;

  v_seq := nullif(regexp_replace(trim(p_invoice_number), '^.*[^0-9]', '', 'g'), '')::bigint;
  if v_seq is null or v_seq < 1 then
    raise exception 'Invalid invoice number format';
  end if;

  v_expected := coalesce(nullif(trim(v_prefix), ''), 'SI') || '-' || lpad(v_seq::text, 8, '0');
  if trim(p_invoice_number) <> v_expected then
    raise exception 'Invoice number does not match branch prefix/sequence';
  end if;

  if exists (
    select 1
    from transactions
    where branch_id = p_branch_id
      and invoice_number = trim(p_invoice_number)
  ) then
    raise exception 'Invoice number already in use';
  end if;

  update branches
  set invoice_next = greatest(invoice_next, v_seq + 1)
  where id = p_branch_id;

  return trim(p_invoice_number);
end;
$function$;
-- Hardened: reserve_invoice_number/allocate_invoice_number are the invoice-numbering
-- authority for BIR compliance — must never be reachable anonymously.
revoke execute on function public.reserve_invoice_number(uuid, text) from public;
grant execute on function public.reserve_invoice_number(uuid, text) to authenticated;

-- 4) complete_sale: checkout RPC (param p_client_or_number -> p_client_invoice_number)
-- CREATE OR REPLACE cannot rename a parameter (42P13) — drop first.
drop function if exists public.complete_sale(
  uuid, uuid, jsonb, numeric, numeric, text, text, text, text, text, text,
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, text, uuid
);
create or replace function public.complete_sale(
  p_branch_id uuid,
  p_staff_id uuid,
  p_items jsonb,
  p_total numeric,
  p_tendered numeric,
  p_client_id text default null,
  p_client_invoice_number text default null,
  p_order_type text default 'dine_in',
  p_ulam_combo text default null,
  p_payment_method text default 'cash',
  p_payment_reference text default null,
  p_vat_amount numeric default 0,
  p_vatable_sales numeric default 0,
  p_vat_exempt_sales numeric default 0,
  p_zero_rated_sales numeric default 0,
  p_sc_pwd_discount numeric default 0,
  p_vat_rate_applied numeric default 0.12,
  p_discount_amount numeric default 0,
  p_discount_type text default null,
  p_discount_id_note text default null,
  p_shift_id uuid default null
)
returns transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn public.transactions;
  v_existing public.transactions;
  v_invoice_number text;
  v_branch_type text;
  v_is_restaurant boolean;
  v_item jsonb;
  v_payment_method text;
  v_payment_reference text;
begin
  if public.current_staff_branch() is distinct from p_branch_id and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;

  if p_client_id is not null then
    select * into v_existing
    from public.transactions
    where branch_id = p_branch_id and client_id = p_client_id;
    if found then
      return v_existing;
    end if;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'complete_sale requires at least one cart line';
  end if;

  perform public.assert_till_open(p_branch_id);

  -- Invoice allocation before the transaction insert (transactions.invoice_number is
  -- immutable once set — guard_transaction_updates() forbids changing it later — and
  -- transaction_items has a NOT NULL FK to transactions.id, so items can't be inserted
  -- first either). Single UPDATE...RETURNING, not a separate SELECT FOR UPDATE + UPDATE
  -- pair (avoids the lock-convoy pattern; see migrate_complete_sale_rpc.sql).
  if p_client_invoice_number is not null and length(trim(p_client_invoice_number)) > 0 then
    v_invoice_number := public.reserve_invoice_number(p_branch_id, p_client_invoice_number);
  else
    update public.branches
    set invoice_next = invoice_next + 1
    where id = p_branch_id
    returning coalesce(nullif(invoice_prefix, ''), 'SI') || '-' || lpad((invoice_next - 1)::text, 8, '0')
    into v_invoice_number;

    if not found then
      raise exception 'Branch not found';
    end if;
  end if;

  select branch_type into v_branch_type from public.branches where id = p_branch_id;
  v_is_restaurant := v_branch_type = 'restaurant';

  v_payment_method := case when p_payment_method in ('cash', 'card', 'ewallet') then p_payment_method else 'cash' end;
  v_payment_reference := case
    when p_payment_method = 'ewallet' then nullif(trim(coalesce(p_payment_reference, '')), '')
    else null
  end;

  insert into public.transactions (
    branch_id, staff_id, total_amount, amount_tendered, change_given, status,
    payment_method, payment_reference, invoice_number, client_id,
    vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount,
    vat_rate_applied, discount_amount, discount_type, discount_id_note, shift_id,
    order_type, ulam_combo
  ) values (
    p_branch_id, p_staff_id, p_total, p_tendered, greatest(0, p_tendered - p_total), 'completed',
    v_payment_method, v_payment_reference, v_invoice_number, p_client_id,
    coalesce(p_vat_amount, 0), coalesce(p_vatable_sales, 0), coalesce(p_vat_exempt_sales, 0),
    coalesce(p_zero_rated_sales, 0), coalesce(p_sc_pwd_discount, 0), coalesce(p_vat_rate_applied, 0.12),
    coalesce(p_discount_amount, 0), p_discount_type, p_discount_id_note, p_shift_id,
    case when v_is_restaurant then (case when p_order_type = 'takeout' then 'takeout' else 'dine_in' end) else null end,
    case when v_is_restaurant then p_ulam_combo else null end
  )
  returning * into v_txn;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.transaction_items (
      transaction_id, product_id, quantity, unit_price, line_total,
      discount_eligible, discount_amount, promo_name, promo_group_id, vat_category, price_tier
    ) values (
      v_txn.id,
      (v_item ->> 'product_id')::uuid,
      (v_item ->> 'quantity')::numeric,
      (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'line_total')::numeric,
      coalesce((v_item ->> 'discount_eligible')::boolean, false),
      coalesce((v_item ->> 'discount_amount')::numeric, 0),
      nullif(v_item ->> 'promo_name', ''),
      nullif(v_item ->> 'promo_group_id', '')::uuid,
      coalesce(nullif(v_item ->> 'vat_category', ''), 'vatable'),
      case when v_is_restaurant then coalesce(nullif(v_item ->> 'price_tier', ''), 'regular') else null end
    );

    if not v_is_restaurant then
      perform public.record_stock_movement(
        p_branch_id,
        (v_item ->> 'product_id')::uuid,
        p_staff_id,
        'sale',
        0,
        (v_item ->> 'quantity')::numeric,
        v_txn.id::text,
        coalesce(nullif(v_item ->> 'detail', ''), v_item ->> 'product_id')
      );
    end if;
  end loop;

  insert into public.sale_events (branch_id, transaction_id, staff_id, event_type, invoice_number, amount, payload)
  values (
    p_branch_id, v_txn.id, p_staff_id, 'sale', v_txn.invoice_number, p_total,
    jsonb_build_object('client_id', p_client_id, 'order_type', v_txn.order_type, 'ulam_combo', v_txn.ulam_combo)
  );

  return v_txn;
exception
  when unique_violation then
    if p_client_id is not null then
      select * into v_existing
      from public.transactions
      where branch_id = p_branch_id and client_id = p_client_id;
      if found then
        return v_existing;
      end if;
    end if;
    raise;
end;
$$;

grant execute on function public.complete_sale(
  uuid, uuid, jsonb, numeric, numeric, text, text, text, text, text, text,
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, text, uuid
) to authenticated;
revoke all on function public.complete_sale(
  uuid, uuid, jsonb, numeric, numeric, text, text, text, text, text, text,
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, text, uuid
) from public, anon;

-- 5) void_sale_secure: body-only change (v_txn.or_number -> v_txn.invoice_number)
create or replace function public.void_sale_secure(p_transaction_id uuid, p_staff_id uuid, p_reason text, p_approved_by uuid DEFAULT NULL::uuid)
 RETURNS transactions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'Void restock ' || coalesce(v_txn.invoice_number, v_txn.id::text)
    );
  end loop;

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, invoice_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'void',
    v_txn.invoice_number,
    v_txn.void_reason,
    v_txn.total_amount,
    jsonb_build_object('voided_at', v_txn.voided_at, 'approved_by', p_approved_by)
  );

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_txn.branch_id,
    p_staff_id,
    'sale_void',
    'Voided ' || coalesce(v_txn.invoice_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'reason', v_txn.void_reason)
  );

  return v_txn;
end;
$function$;
revoke execute on function public.void_sale_secure(uuid, uuid, text, uuid) from public;
grant execute on function public.void_sale_secure(uuid, uuid, text, uuid) to authenticated;

-- 6) refund_sale_items: body-only change
create or replace function public.refund_sale_items(p_transaction_id uuid, p_staff_id uuid, p_reason text, p_items jsonb, p_approved_by uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if v_txn.status <> 'completed' then
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
        'Refund restock ' || coalesce(v_txn.invoice_number, v_txn.id::text)
      );
    exception when others then
      null;
    end;
  end loop;

  insert into sale_events (branch_id, transaction_id, staff_id, event_type, invoice_number, reason, amount, payload)
  values (
    v_txn.branch_id,
    v_txn.id,
    p_staff_id,
    'refund',
    v_txn.invoice_number,
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

    insert into sale_events (branch_id, transaction_id, staff_id, event_type, invoice_number, reason, amount, payload)
    values (
      v_txn.branch_id,
      v_txn.id,
      p_staff_id,
      'void',
      v_txn.invoice_number,
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
    'Refunded ' || v_count || ' line(s) on ' || coalesce(v_txn.invoice_number, v_txn.id::text),
    jsonb_build_object('transaction_id', v_txn.id, 'amount', v_total, 'reason', p_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'refunded_amount', v_total,
    'line_count', v_count,
    'fully_voided', v_fully_voided
  );
end;
$function$;
revoke execute on function public.refund_sale_items(uuid, uuid, text, jsonb, uuid) from public;
grant execute on function public.refund_sale_items(uuid, uuid, text, jsonb, uuid) to authenticated;

-- 7) fiscal-immutability trigger: body-only change
create or replace function public.guard_transaction_updates()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
     or new.invoice_number is distinct from old.invoice_number
     or new.created_at is distinct from old.created_at
     or new.staff_id is distinct from old.staff_id
     or new.client_id is distinct from old.client_id then
    raise exception 'sale financial fields are immutable';
  end if;

  if new.status = 'voided' and old.status = 'completed' then
    new.voided_at := coalesce(new.voided_at, now());
    return new;
  end if;

  if old.status = 'completed'
     and new.status = 'completed'
     and new.refunded_amount is distinct from old.refunded_amount
     and coalesce(new.refunded_amount, 0) >= coalesce(old.refunded_amount, 0) then
    return new;
  end if;

  raise exception 'transactions are immutable except for voiding a completed sale';
end;
$function$;

notify pgrst, 'reload schema';

commit;
