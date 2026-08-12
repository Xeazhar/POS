-- Offline OR reservation: client assigns OR at sale time; server accepts on sync.
-- Apply after migrate_bir_pos_compliance.sql (needs branches.or_next / allocate_or_number).
--
-- When p_or_number is null, behaves like allocate_or_number.
-- When set, validates prefix + sequence for the branch, rejects duplicates, and bumps
-- branches.or_next to at least (sequence + 1) without decreasing the counter.

create or replace function reserve_or_number(p_branch_id uuid, p_or_number text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text;
  v_next bigint;
  v_seq bigint;
  v_expected text;
begin
  if p_or_number is null or trim(p_or_number) = '' then
    return allocate_or_number(p_branch_id);
  end if;

  select or_prefix, or_next
  into v_prefix, v_next
  from branches
  where id = p_branch_id
  for update;

  if not found then
    raise exception 'Branch not found';
  end if;

  v_seq := nullif(regexp_replace(trim(p_or_number), '^.*[^0-9]', '', 'g'), '')::bigint;
  if v_seq is null or v_seq < 1 then
    raise exception 'Invalid OR number format';
  end if;

  v_expected := coalesce(nullif(trim(v_prefix), ''), 'OR') || '-' || lpad(v_seq::text, 8, '0');
  if trim(p_or_number) <> v_expected then
    raise exception 'OR number does not match branch prefix/sequence';
  end if;

  if exists (
    select 1
    from transactions
    where branch_id = p_branch_id
      and or_number = trim(p_or_number)
  ) then
    raise exception 'OR number already in use';
  end if;

  update branches
  set or_next = greatest(or_next, v_seq + 1)
  where id = p_branch_id;

  return trim(p_or_number);
end;
$$;

grant execute on function reserve_or_number(uuid, text) to authenticated;
