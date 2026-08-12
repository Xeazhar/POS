-- Promo edit reapproval: approved promos are frozen; edits clone to a pending revision.
-- Apply after migrate_schema_cleanup_v1.sql (uses current approve_promo_event shape).

alter table promo_events add column if not exists supersedes_event_id uuid references promo_events(id) on delete set null;

create index if not exists idx_promo_events_supersedes on promo_events(supersedes_event_id)
  where supersedes_event_id is not null;

-- Clone a live promo into a pending revision (rules + products copied server-side).
create or replace function public.request_promo_edit(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.promo_events;
  v_new public.promo_events;
  v_rule record;
  v_prod record;
  v_new_rule_id uuid;
begin
  select * into v_source
  from promo_events
  where id = p_promo_event_id
  for update;

  if not found then
    raise exception 'Promo not found';
  end if;

  if v_source.status not in ('active', 'stop_pending') then
    raise exception 'Only live promos can be edited via reapproval';
  end if;

  if exists (
    select 1 from promo_events
    where supersedes_event_id = p_promo_event_id
      and status = 'pending'
  ) then
    raise exception 'An edit for this promo is already pending approval';
  end if;

  insert into promo_events (
    branch_id, name, description, status, starts_at, ends_at,
    requested_by, supersedes_event_id
  )
  values (
    v_source.branch_id,
    v_source.name,
    v_source.description,
    'pending',
    v_source.starts_at,
    v_source.ends_at,
    p_staff_id,
    v_source.id
  )
  returning * into v_new;

  for v_rule in
    select * from promo_rules where promo_event_id = v_source.id
  loop
    insert into promo_rules (
      promo_event_id, rule_type, discount_pct, buy_qty, get_qty, bundle_name
    )
    values (
      v_new.id,
      v_rule.rule_type,
      v_rule.discount_pct,
      v_rule.buy_qty,
      v_rule.get_qty,
      v_rule.bundle_name
    )
    returning id into v_new_rule_id;

    for v_prod in
      select * from promo_rule_products where promo_rule_id = v_rule.id
    loop
      insert into promo_rule_products (
        promo_rule_id, product_id, product_index, quantity_required
      )
      values (
        v_new_rule_id,
        v_prod.product_id,
        v_prod.product_index,
        v_prod.quantity_required
      );
    end loop;
  end loop;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_new.branch_id, p_staff_id, 'promo_edit_requested',
    'Requested edit for promo: ' || v_source.name,
    jsonb_build_object(
      'promo_event_id', v_new.id,
      'supersedes_event_id', v_source.id
    )
  );

  return v_new;
end;
$$;

create or replace function public.approve_promo_event(p_promo_event_id uuid, p_staff_id uuid)
returns public.promo_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.promo_events;
  v_rule_count int;
begin
  if not public.is_manager() then
    raise exception 'Only managers can approve promos';
  end if;

  select count(*) into v_rule_count
  from promo_rules
  where promo_event_id = p_promo_event_id;

  if coalesce(v_rule_count, 0) < 1 then
    raise exception 'Promo must have at least one rule before approval';
  end if;

  select * into v_row
  from promo_events
  where id = p_promo_event_id
    and status = 'pending'
  for update;

  if not found then
    raise exception 'No pending promo found to approve';
  end if;

  if v_row.supersedes_event_id is not null then
    update promo_events
    set status = 'stopped',
        stopped_by = p_staff_id,
        stopped_at = coalesce(stopped_at, now())
    where id = v_row.supersedes_event_id
      and status in ('active', 'stop_pending');
  end if;

  update promo_events
  set status = 'active',
      approved_by = p_staff_id,
      approved_at = now()
  where id = p_promo_event_id
    and status = 'pending'
  returning * into v_row;

  insert into audit_events (branch_id, staff_id, event_type, detail, meta)
  values (
    v_row.branch_id, p_staff_id, 'promo_approved',
    case
      when v_row.supersedes_event_id is not null then 'Approved promo edit: ' || v_row.name
      else 'Approved promo: ' || v_row.name
    end,
    jsonb_build_object(
      'promo_event_id', v_row.id,
      'supersedes_event_id', v_row.supersedes_event_id
    )
  );

  return v_row;
end;
$$;
