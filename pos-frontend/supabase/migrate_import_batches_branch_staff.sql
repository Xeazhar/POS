-- Allow branch staff (supervisors/cashiers) to import products for their own branch.
-- Managers keep full access across branches. Revert stays manager-only.

drop policy if exists "managers read import batches" on import_batches;
drop policy if exists "managers write import batches" on import_batches;
drop policy if exists "branch read import batches" on import_batches;
drop policy if exists "branch write import batches" on import_batches;

create policy "branch read import batches" on import_batches for select to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager());

create policy "branch write import batches" on import_batches for all to authenticated
  using (branch_id = public.current_staff_branch() or public.is_manager())
  with check (branch_id = public.current_staff_branch() or public.is_manager());

drop policy if exists "managers read import items" on import_batch_items;
drop policy if exists "managers write import items" on import_batch_items;
drop policy if exists "branch read import items" on import_batch_items;
drop policy if exists "branch write import items" on import_batch_items;

create policy "branch read import items" on import_batch_items for select to authenticated
  using (
    exists (
      select 1 from import_batches b
      where b.id = batch_id
        and (b.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );

create policy "branch write import items" on import_batch_items for all to authenticated
  using (
    exists (
      select 1 from import_batches b
      where b.id = batch_id
        and (b.branch_id = public.current_staff_branch() or public.is_manager())
    )
  )
  with check (
    exists (
      select 1 from import_batches b
      where b.id = batch_id
        and (b.branch_id = public.current_staff_branch() or public.is_manager())
    )
  );
