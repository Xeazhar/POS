-- Per-branch peripheral enable/disable (manager policy).
-- Connection state stays in branch_devices; this controls whether the till may use the device.
-- Default OFF until hardware is connected / manager turns it on.

alter table branches
  add column if not exists device_settings jsonb not null default '{
    "barcode_scanner": false,
    "receipt_printer": false,
    "cash_drawer": false
  }'::jsonb;

-- Existing rows that still have the old all-true default stay as-is until
-- the app auto-offs disconnected devices on the branch dashboard.

comment on column branches.device_settings is
  'Manager toggles: barcode_scanner, receipt_printer, cash_drawer (boolean). false = disabled until ready.';

notify pgrst, 'reload schema';
