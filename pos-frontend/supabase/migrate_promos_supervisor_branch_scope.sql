-- Scope supervisor promo management to their assigned branch only.
-- Managers/admin/master keep access across all branches.

drop policy if exists "managers manage promo events" on promo_events;
drop policy if exists "managers manage promo rules" on promo_rules;
drop policy if exists "managers manage promo rule products" on promo_rule_products;

create policy "managers manage promo events" on promo_events for all to authenticated
  using (
    public.is_manager()
    or (public.current_staff_role() = 'supervisor' and branch_id = public.current_staff_branch())
  )
  with check (
    public.is_manager()
    or (public.current_staff_role() = 'supervisor' and branch_id = public.current_staff_branch())
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
