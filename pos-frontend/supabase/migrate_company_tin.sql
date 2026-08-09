-- Two-level TIN: one main company TIN + a BIR branch code per branch.
--
-- WHY: a Philippine business has ONE TIN. Branches do not get their own TIN — they get a
-- branch code appended to it (head office 00000, then 00001, 00002, ...), printed on the
-- invoice as e.g. 123-456-789-00001. Storing a separate free-text TIN per branch let two
-- branches of the same company drift apart, which is a fiscal-output defect: the invoice
-- and the BIR reading would both carry a TIN the business does not actually hold.
--
-- Apply AFTER migrate_bir_pos_compliance.sql (which created branches.tin).
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Company profile (singleton row)
-- ---------------------------------------------------------------------------
create table if not exists public.company_profile (
  -- Singleton: the check constraint means only `true` is a legal key, so a second row
  -- cannot be inserted. One business, one TIN.
  id boolean primary key default true check (id),
  business_name text,
  tin text,
  address text,
  updated_at timestamptz not null default now()
);

insert into public.company_profile (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Per-branch BIR branch code
-- ---------------------------------------------------------------------------
alter table public.branches
  add column if not exists branch_tin_code text;

-- Backfill from whatever is already in branches.tin.
--   * If it looks like a full TIN with a branch code (9 digits + 3-5 digit suffix),
--     split it: the first 9 digits seed the company TIN, the suffix becomes the code.
--   * Otherwise leave both alone — a half-parsed TIN on a fiscal document is worse than
--     an untouched one, so anything unrecognised stays for a human to set.
do $$
declare
  seed text;
begin
  select regexp_replace(tin, '\D', '', 'g')
    into seed
  from public.branches
  where tin is not null
    and regexp_replace(tin, '\D', '', 'g') ~ '^\d{12,14}$'
  order by sort_order nulls last, name
  limit 1;

  if seed is not null then
    update public.company_profile
    set tin = coalesce(nullif(tin, ''),
          substr(seed, 1, 3) || '-' || substr(seed, 4, 3) || '-' || substr(seed, 7, 3)),
        updated_at = now()
    where id;
  end if;
end $$;

update public.branches
set branch_tin_code = lpad(substr(regexp_replace(tin, '\D', '', 'g'), 10), 5, '0')
where branch_tin_code is null
  and tin is not null
  and regexp_replace(tin, '\D', '', 'g') ~ '^\d{12,14}$';

-- Branches with no recognisable code default to head office.
update public.branches
set branch_tin_code = '00000'
where branch_tin_code is null;

-- branches.tin is deliberately NOT dropped. It stays as a per-branch override for the
-- rare case a branch really is registered separately, and as the fallback the app reads
-- when company_profile.tin has not been filled in yet.

-- ---------------------------------------------------------------------------
-- 3) RLS — every signed-in staff member READS it (receipts print it);
--    only managers WRITE it.
-- ---------------------------------------------------------------------------
alter table public.company_profile enable row level security;

drop policy if exists "read company profile" on public.company_profile;
drop policy if exists "write company profile" on public.company_profile;

create policy "read company profile" on public.company_profile
  for select to authenticated
  using (true);

create policy "write company profile" on public.company_profile
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- Verify
--   select * from public.company_profile;
--   select name, tin, branch_tin_code from public.branches order by name;
