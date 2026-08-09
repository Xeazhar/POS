-- Promo description: what a promo is about, shown to managers/supervisors in
-- Promo History. Purely informational — never read by the discount engine.

alter table promo_events add column if not exists description text;
