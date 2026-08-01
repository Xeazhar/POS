-- Safe inventory import: batches, hash dedupe, audit, revert

create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  staff_id uuid references staff(id) on delete set null,
  filename text not null,
  file_hash text not null,
  row_count integer not null default 0,
  created_count integer not null default 0,
  updated_count integer not null default 0,
  skipped_count integer not null default 0,
  status text not null default 'committed' check (status in ('committed', 'reverted')),
  created_at timestamptz not null default now(),
  reverted_at timestamptz,
  reverted_by uuid references staff(id) on delete set null
);
create index if not exists idx_import_batches_branch_hash
  on import_batches(branch_id, file_hash, created_at desc);
create index if not exists idx_import_batches_branch_created
  on import_batches(branch_id, created_at desc);

create table if not exists import_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references import_batches(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  action text not null check (action in ('create', 'restock')),
  quantity_added numeric(10,2) not null default 0,
  name text,
  sku text,
  barcode text
);
create index if not exists idx_import_batch_items_batch on import_batch_items(batch_id);

alter table import_batches enable row level security;
alter table import_batch_items enable row level security;

drop policy if exists "managers read import batches" on import_batches;
drop policy if exists "managers write import batches" on import_batches;
create policy "managers read import batches" on import_batches for select to authenticated
  using (public.is_manager());
create policy "managers write import batches" on import_batches for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "managers read import items" on import_batch_items;
drop policy if exists "managers write import items" on import_batch_items;
create policy "managers read import items" on import_batch_items for select to authenticated
  using (public.is_manager());
create policy "managers write import items" on import_batch_items for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

create or replace function public.revert_import_batch(p_batch_id uuid, p_staff_id uuid)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.import_batches;
  v_item public.import_batch_items;
begin
  if not public.is_manager() then
    raise exception 'Only managers can revert imports';
  end if;

  select * into v_batch from import_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Import batch not found';
  end if;
  if v_batch.status = 'reverted' then
    raise exception 'Import already reverted';
  end if;

  for v_item in
    select * from import_batch_items where batch_id = p_batch_id
  loop
    if v_item.quantity_added > 0 then
      perform public.record_stock_movement(
        v_batch.branch_id,
        v_item.product_id,
        p_staff_id,
        'adjustment',
        0,
        v_item.quantity_added,
        'revert:' || p_batch_id::text,
        'Revert import ' || coalesce(v_batch.filename, '')
      );
    end if;
    if v_item.action = 'create' then
      update products set is_active = false where id = v_item.product_id;
    end if;
  end loop;

  update import_batches
  set status = 'reverted', reverted_at = now(), reverted_by = p_staff_id
  where id = p_batch_id
  returning * into strict v_batch;

  return v_batch;
end;
$$;

grant execute on function public.revert_import_batch(uuid, uuid) to authenticated;
