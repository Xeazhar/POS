-- Ulam / carinderia ordering: menu kinds, budget prices, dine-in/takeout, line price tiers
-- Safe to re-run. Does NOT update existing sales rows (BIR immutability triggers).

alter table products
  add column if not exists menu_kind text,
  add column if not exists budget_price numeric(10,2);

update products
set menu_kind = case
  when lower(coalesce((select name from categories c where c.id = products.category_id), '')) like '%meat%'
    and lower(coalesce((select name from categories c where c.id = products.category_id), '')) like '%veggie%'
    then 'meat'
  when lower(coalesce((select name from categories c where c.id = products.category_id), '')) like '%veggie%'
    then 'veggie'
  when lower(coalesce((select name from categories c where c.id = products.category_id), '')) like '%pancit%'
    then 'pancit'
  when lower(coalesce((select name from categories c where c.id = products.category_id), '')) like '%drink%'
    then 'drink'
  when lower(coalesce((select name from categories c where c.id = products.category_id), '')) like '%rice%'
    then 'rice'
  else coalesce(menu_kind, 'extra')
end
where menu_kind is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_menu_kind_check'
  ) then
    alter table products
      add constraint products_menu_kind_check
      check (menu_kind is null or menu_kind in ('meat', 'veggie', 'pancit', 'drink', 'rice', 'extra'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'products_budget_price_nonneg'
  ) then
    alter table products
      add constraint products_budget_price_nonneg
      check (budget_price is null or budget_price >= 0);
  end if;
end $$;

alter table transactions
  add column if not exists order_type text,
  add column if not exists ulam_combo text;

-- Do not backfill order_type on existing rows — guard_transaction_updates blocks UPDATE.
-- New sales set order_type on INSERT. Null is allowed and treated as dine_in in the app.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_order_type_check'
  ) then
    alter table transactions
      add constraint transactions_order_type_check
      check (order_type is null or order_type in ('dine_in', 'takeout'));
  end if;
end $$;

alter table transaction_items
  add column if not exists price_tier text;

-- Do not backfill price_tier — transaction_items are immutable (BIR).
-- New lines set price_tier on INSERT; null is treated as regular in the app.

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transaction_items_price_tier_check'
  ) then
    alter table transaction_items
      add constraint transaction_items_price_tier_check
      check (price_tier is null or price_tier in ('regular', 'budget'));
  end if;
end $$;

insert into categories (name) values
  ('Meat'),
  ('Veggie'),
  ('Pancit'),
  ('Drink'),
  ('Rice'),
  ('Extra')
on conflict (name) do nothing;

-- Refresh PostgREST schema cache so budget_price / menu_kind are visible immediately
notify pgrst, 'reload schema';
