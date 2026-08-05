-- AM / PM shift label on clock-in (explicit, not inferred from time alone).
alter table staff_shifts
  add column if not exists shift_period text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'staff_shifts_shift_period_check'
  ) then
    alter table staff_shifts
      add constraint staff_shifts_shift_period_check
      check (shift_period is null or shift_period in ('am', 'pm'));
  end if;
end $$;

comment on column staff_shifts.shift_period is 'Declared shift window: am or pm';
