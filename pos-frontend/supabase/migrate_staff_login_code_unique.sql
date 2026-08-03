-- CalePOS: staff login codes must be unique across all branches
-- (same staff code e.g. 1234 cannot be assigned to two people)
-- Run after migrate_staff_pin_payments_roles_finance.sql if that already ran.

-- Drop older per-branch uniqueness if present
drop index if exists staff_branch_login_code_uidx;

-- Fail loudly if duplicates already exist (clean them up first)
do $$
declare
  dup_count int;
begin
  select count(*) into dup_count
  from (
    select login_code
    from staff
    where login_code is not null and login_code <> ''
    group by login_code
    having count(*) > 1
  ) d;
  if dup_count > 0 then
    raise exception
      'Cannot enforce unique staff codes: % duplicate login_code value(s) already exist. Clear or change duplicate codes on Staff, then re-run.',
      dup_count;
  end if;
end $$;

create unique index if not exists staff_login_code_uidx
  on staff (login_code)
  where login_code is not null and login_code <> '';
