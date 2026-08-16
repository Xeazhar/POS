-- Atomic checkout: complete_sale() collapses the checkout write path into one
-- server-side transaction instead of 4 sequential, independently-committed round trips.
--
-- WHY
-- ---
-- completeSale() (src/lib/api.js) currently does, one network hop at a time:
--   1. assert_till_open + allocate_or_number (parallel)
--   2. insert transactions                                    <- waits on 1
--   3. insert transaction_items                                <- waits on 2 (needs txn id)
--   4. record_stock_movement per cart line, in parallel        <- waits on 3
-- Each hop is its own autocommitted REST call — there is no transaction spanning all four.
-- If step 3 or 4 fails after step 2 committed, the result is a real transactions row with
-- no items and/or no inventory decrement: money recorded, sale incomplete. Worse, the
-- client_id idempotency fast path (loadTransactionByClientId, checked before any of this
-- runs) means a retried offline-queue push after such a partial failure finds the orphaned
-- row, treats the sale as already done, and never retries the missing items/inventory step.
--
-- Under concurrent load this also means every checkout pays for 4 sequential connection
-- acquisitions instead of 1, which is the dominant tail-latency cost at high VU counts (SQL
-- work inside each step is sub-millisecond; k6 load-test p95/p99 tracked round-trip count,
-- not query cost).
--
-- complete_sale() reuses the exact same building blocks (assert_till_open, reserve_or_number
-- / allocate_or_number, record_stock_movement) as plain function calls inside one plpgsql
-- transaction, so it is atomic — either the whole sale lands (transaction row + items +
-- inventory + audit event) or none of it does. All existing validations, RLS-equivalent
-- branch checks, OR sequencing, and the sale_events audit trail are preserved; nothing is
-- weakened.
--
-- Bonus correctness fix: assert_till_open now runs strictly BEFORE OR allocation (they used
-- to run in parallel from the client), so a locked-till attempt no longer burns a sequential
-- OR number.
--
-- src/lib/api.js's completeSale() tries this RPC first and falls back to the old multi-step
-- flow if the function doesn't exist yet (pre-migration databases) — this migration is safe
-- to apply independently and does not require a matching frontend deploy on the same day.
--
-- UPDATE (post-load-test fix): the first version of this function allocated the OR number
-- FIRST, via reserve_or_number/allocate_or_number's `SELECT ... FOR UPDATE` on the branch's
-- counter row -- then did the transaction insert, N item inserts, and N record_stock_movement
-- calls, ALL while still holding that row lock (a Postgres row lock from FOR UPDATE is held
-- until the enclosing transaction commits, regardless of statement order after it). Under
-- ~29 concurrent cashiers per branch, this turned a normally-microsecond lock into one held
-- for the sale's full processing time, producing a queueing convoy -- confirmed live via
-- Postgres logs on a 200-VU k6 run: 104 real deadlocks on the `branches` relation, and
-- `pg_stat_statements` showing 36ms mean but 7.6s max / 192ms stddev on the RPC-call bucket
-- matching iteration count (5.3x mean, the signature of lock-convoy, not slow SQL).
--
-- ATTEMPTED fix, reverted: moving OR allocation to the end (insert transactions with
-- or_number NULL, UPDATE it in once allocated) is blocked by guard_transaction_updates()
-- (migrate_bir_pos_compliance.sql) -- its BEFORE UPDATE trigger explicitly rejects any change
-- where `new.or_number is distinct from old.or_number`, raising "sale financial fields are
-- immutable". That is a deliberate, correct fiscal-integrity rule (an assigned OR number must
-- never be rewritten) and is not weakened here. transaction_items.transaction_id is also a
-- NOT NULL FK into transactions, so item inserts can't happen before the transactions row
-- exists either way -- OR allocation is structurally forced to happen before the transaction
-- insert, and the transaction insert before the item/stock-movement work. The branch
-- counter's row lock is therefore held for the sale's full processing time either way; that
-- is the cost of atomicity + immutable sequential OR numbers together, not a bug to engineer
-- around further without giving up one of those guarantees.
--
-- Fix actually applied: allocate_or_number's `SELECT ... FOR UPDATE` + separate `UPDATE` pair
-- collapses into one atomic `UPDATE ... SET or_next = or_next + 1 ... RETURNING` (order/logic
-- unchanged, still called before the transaction insert, same position as the original
-- version of this function). This doesn't shrink lock HOLD time, but it does remove the
-- specific two-statement lock-then-modify sequence -- multiple backends each doing
-- SELECT-FOR-UPDATE-then-UPDATE on the same hot row is a well-documented Postgres pattern for
-- exactly the tuple-lock-upgrade deadlocks seen in the logs (`waiting for ShareLock on
-- transaction N`); a single UPDATE has no such intermediate window. The client-supplied-OR-
-- number path (reserve_or_number) is untouched -- current production never populates it (see
-- CODEMAP.md's OR-number section) and its own validation isn't safely collapsible anyway.
--
-- Residual risk: some queueing/occasional deadlocks under heavy same-branch concurrency are
-- expected to remain -- this is inherent to "sequential OR numbers require serialization per
-- branch" and is not something this migration can fully remove without relaxing atomicity or
-- immutability. Deadlock victims are always safely rolled back (no partial state), so a
-- client-side retry-on-40P01 is the standard complementary mitigation; not added here pending
-- confirmation (see chat) since it's a separate, API-layer change.
--
-- Apply after every other migrate_*.sql that touches transactions/transaction_items/branches
-- columns or the assert_till_open / reserve_or_number / record_stock_movement functions —
-- i.e. put this at the end of the apply order.
--
-- Safe to re-run.

create or replace function public.complete_sale(
  p_branch_id uuid,
  p_staff_id uuid,
  p_items jsonb,
  p_total numeric,
  p_tendered numeric,
  p_client_id text default null,
  p_client_or_number text default null,
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
  v_or_number text;
  v_branch_type text;
  v_is_restaurant boolean;
  v_item jsonb;
  v_payment_method text;
  v_payment_reference text;
begin
  -- IS DISTINCT FROM, not <>: an anon/unauthenticated caller makes current_staff_branch()
  -- return NULL, and `NULL <> p_branch_id` evaluates to NULL (not true), which would let the
  -- `and not is_manager()` clause fall through IF THEN without raising — a real
  -- unauthenticated-bypass footgun this codebase's other RPCs already carry. DISTINCT FROM is
  -- NULL-safe: NULL is always "distinct" from a real branch id, so this actually raises.
  if public.current_staff_branch() is distinct from p_branch_id and not public.is_manager() then
    raise exception 'Branch access denied';
  end if;

  -- Idempotency fast path: same client_id + branch already has a sale, return it as-is
  -- instead of re-running the whole checkout (matches loadTransactionByClientId in api.js).
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

  -- Till check first, before any work — a locked till fails fast with nothing written yet.
  perform public.assert_till_open(p_branch_id);

  -- OR allocation before the transaction insert (transactions.or_number is immutable once
  -- set — guard_transaction_updates() forbids changing it later — and transaction_items has
  -- a NOT NULL FK to transactions.id, so items can't be inserted first either). Single
  -- UPDATE...RETURNING, not a separate SELECT FOR UPDATE + UPDATE pair — see WHY above.
  if p_client_or_number is not null and length(trim(p_client_or_number)) > 0 then
    v_or_number := public.reserve_or_number(p_branch_id, p_client_or_number);
  else
    update public.branches
    set or_next = or_next + 1
    where id = p_branch_id
    returning coalesce(nullif(or_prefix, ''), 'OR') || '-' || lpad((or_next - 1)::text, 8, '0')
    into v_or_number;

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
    payment_method, payment_reference, or_number, client_id,
    vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount,
    vat_rate_applied, discount_amount, discount_type, discount_id_note, shift_id,
    order_type, ulam_combo
  ) values (
    p_branch_id, p_staff_id, p_total, p_tendered, greatest(0, p_tendered - p_total), 'completed',
    v_payment_method, v_payment_reference, v_or_number, p_client_id,
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

  insert into public.sale_events (branch_id, transaction_id, staff_id, event_type, or_number, amount, payload)
  values (
    p_branch_id, v_txn.id, p_staff_id, 'sale', v_txn.or_number, p_total,
    jsonb_build_object('client_id', p_client_id, 'order_type', v_txn.order_type, 'ulam_combo', v_txn.ulam_combo)
  );

  return v_txn;
exception
  when unique_violation then
    -- Concurrent retry of the same offline-queued sale (same branch_id + client_id) —
    -- the unique index on transactions(branch_id, client_id) is the real guarantee here,
    -- this is just resolving the race in favor of "already done" instead of erroring.
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

-- Postgres grants EXECUTE to PUBLIC by default on every new function — explicitly revoke it
-- (same pattern migrate_harden_grants.sql, migrate_shift_cash_accountability.sql, etc. use for
-- every other authenticated-only RPC in this schema) so the anon/publishable key alone can't
-- call this. Belt-and-suspenders alongside the IS DISTINCT FROM fix above.
revoke all on function public.complete_sale(
  uuid, uuid, jsonb, numeric, numeric, text, text, text, text, text, text,
  numeric, numeric, numeric, numeric, numeric, numeric, numeric, text, text, uuid
) from public, anon;

notify pgrst, 'reload schema';
