-- Company-wide idle auto-lock delay (minutes).
--
-- WHY: Settings → Session & Auto-lock lets a manager pick 5, 10, or 15 minutes.
-- The value has to live on company_profile so every till uses the same delay after
-- the next sign-in / profile pull. Floor is 5, ceiling is 15, never off — a forgotten
-- screen cannot be given an unbounded unlock window.
--
-- Apply after migrate_company_tin.sql (creates company_profile). Safe to re-run.

alter table public.company_profile
  add column if not exists idle_lock_minutes integer not null default 10;

alter table public.company_profile
  drop constraint if exists company_profile_idle_lock_minutes_chk;

alter table public.company_profile
  add constraint company_profile_idle_lock_minutes_chk
  check (idle_lock_minutes in (5, 10, 15));

comment on column public.company_profile.idle_lock_minutes is
  'Minutes of inactivity before Shell auto-locks. Allowed: 5, 10, 15. Manager-writable via company_profile RLS.';

-- Verify
--   select idle_lock_minutes from public.company_profile;
