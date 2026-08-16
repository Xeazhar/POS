-- One-time backfill: Staff.jsx's create-staff form writes an explicit permissions array
-- snapshotted from defaultPermissionsFor(role) at creation time (never leaves the DB column
-- null), so every account that already existed before cashier_dashboard/manager_announcements
-- were added to roles.js DEFAULTS is stuck without them — effectivePermissions() only falls
-- back to DEFAULTS when permissions IS NULL, which is never true for a previously-created
-- account. Grant both new modules to every account that would have gotten them under the
-- CURRENT DEFAULTS but is missing them because its permissions array predates this change.
-- Safe to re-run.

update public.staff
set permissions = permissions || '["cashier_dashboard"]'::jsonb
where role = 'cashier'
  and permissions is not null
  and not (permissions @> '["cashier_dashboard"]'::jsonb);

update public.staff
set permissions = permissions || '["manager_announcements"]'::jsonb
where role in ('manager', 'admin', 'master')
  and permissions is not null
  and not (permissions @> '["manager_announcements"]'::jsonb);

notify pgrst, 'reload schema';
