-- Restaurant / carinderia branch mode for CalePOS
-- One special branch type focused on daily menus (no inventory tracking on sale).

alter table branches
  add column if not exists branch_type text not null default 'retail';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'branches_branch_type_check'
  ) then
    alter table branches
      add constraint branches_branch_type_check
      check (branch_type in ('retail', 'restaurant'));
  end if;
end $$;

alter table products
  add column if not exists available_today boolean not null default true;

-- Typical Filipino carinderia / kalenderya plate categories
insert into categories (name) values
  ('Meat on Meat'),
  ('Meat on Veggie'),
  ('Veggie on Veggie'),
  ('Rice'),
  ('Drinks'),
  ('Extra')
on conflict (name) do nothing;
