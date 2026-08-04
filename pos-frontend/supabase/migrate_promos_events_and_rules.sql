-- Promo system (Manager-hosted events with multiple rules)
-- One active promo event per branch at a time.

-- Keep "manager" semantics aligned with frontend roles (master should also manage promos).
create or replace function public.is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_staff_role() in ('manager', 'admin', 'master'), false);
$$;

create table if not exists promo_events (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches(id) on delete cascade,
  name text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists promo_rules (
  id uuid primary key default gen_random_uuid(),
  promo_event_id uuid not null references promo_events(id) on delete cascade,
  rule_type text not null check (rule_type in ('item_pct', 'pair_pct', 'bundle_pct', 'bogo_pct')),
  discount_pct numeric(5,2) not null check (discount_pct >= 0 and discount_pct <= 100),
  buy_qty numeric(10,2) not null default 1 check (buy_qty > 0),
  get_qty numeric(10,2) not null default 1 check (get_qty > 0),
  created_at timestamptz not null default now()
);

create table if not exists promo_rule_products (
  id uuid primary key default gen_random_uuid(),
  promo_rule_id uuid not null references promo_rules(id) on delete cascade,
  product_id uuid not null references products(id) on delete restrict,
  product_index integer not null default 0,
  quantity_required numeric(10,2) not null default 1 check (quantity_required > 0)
);

create index if not exists idx_promo_rules_event on promo_rules(promo_event_id);
create index if not exists idx_promo_rule_products_rule on promo_rule_products(promo_rule_id);
create index if not exists idx_promo_events_branch on promo_events(branch_id);

-- Enforce one active event per branch (at most one row can have is_active=true)
create unique index if not exists uniq_active_promo_event_per_branch
  on promo_events(branch_id)
  where is_active = true;

-- RLS
alter table promo_events enable row level security;
alter table promo_rules enable row level security;
alter table promo_rule_products enable row level security;

drop policy if exists "branch staff reads promo events" on promo_events;
drop policy if exists "managers manage promo events" on promo_events;
drop policy if exists "branch staff reads promo rules" on promo_rules;
drop policy if exists "managers manage promo rules" on promo_rules;
drop policy if exists "branch staff reads promo rule products" on promo_rule_products;
drop policy if exists "managers manage promo rule products" on promo_rule_products;

create policy "branch staff reads promo events" on promo_events for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

-- Managers: all branches. Supervisors: own branch only.
create policy "managers manage promo events" on promo_events for all to authenticated
  using (
    public.is_manager()
    or (public.current_staff_role() = 'supervisor' and branch_id = public.current_staff_branch())
  )
  with check (
    public.is_manager()
    or (public.current_staff_role() = 'supervisor' and branch_id = public.current_staff_branch())
  );

create policy "branch staff reads promo rules" on promo_rules for select to authenticated
  using (
    exists (
      select 1 from promo_events e
      where e.id = promo_rules.promo_event_id
        and (e.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );

create policy "managers manage promo rules" on promo_rules for all to authenticated
  using (
    exists (
      select 1 from promo_events e
      where e.id = promo_rules.promo_event_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  )
  with check (
    exists (
      select 1 from promo_events e
      where e.id = promo_rules.promo_event_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  );

create policy "branch staff reads promo rule products" on promo_rule_products for select to authenticated
  using (
    exists (
      select 1 from promo_rules r
      join promo_events e on e.id = r.promo_event_id
      where r.id = promo_rule_products.promo_rule_id
        and (e.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );

create policy "managers manage promo rule products" on promo_rule_products for all to authenticated
  using (
    exists (
      select 1 from promo_rules r
      join promo_events e on e.id = r.promo_event_id
      where r.id = promo_rule_products.promo_rule_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  )
  with check (
    exists (
      select 1 from promo_rules r
      join promo_events e on e.id = r.promo_event_id
      where r.id = promo_rule_products.promo_rule_id
        and (
          public.is_manager()
          or (public.current_staff_role() = 'supervisor' and e.branch_id = public.current_staff_branch())
        )
    )
  );

