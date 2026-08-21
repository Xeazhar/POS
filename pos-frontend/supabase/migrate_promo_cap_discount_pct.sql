-- Cap promo_rules.discount_pct at 99 — an item must never ring up 100% off (free).
-- Needs migrate_promos_events_and_rules.sql above (creates promo_rules + the check
-- constraint this replaces). Safe to re-run.

-- Clamp any existing rows before tightening the constraint, so this doesn't fail
-- on data written before the app-side cap (src/utils/promo.js MAX_PROMO_DISCOUNT_PCT).
update promo_rules set discount_pct = 99 where discount_pct > 99;

alter table promo_rules drop constraint if exists promo_rules_discount_pct_check;
alter table promo_rules
  add constraint promo_rules_discount_pct_check check (discount_pct >= 0 and discount_pct <= 99);
