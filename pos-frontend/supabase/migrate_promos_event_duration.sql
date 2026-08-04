-- Promo event duration (start/end) so cashiers can rely on time window

alter table promo_events
  add column if not exists starts_at timestamptz null,
  add column if not exists ends_at timestamptz null;

