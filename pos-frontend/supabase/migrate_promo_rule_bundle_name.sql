-- A name for a BUNDLE RULE itself (e.g. "Meryenda Bundle") — distinct from the promo
-- EVENT's name. An event can hold several rules (item/pair/bundle/BOGO, even several
-- bundles at once), so "the event is named X" doesn't tell a cashier which specific set of
-- products makes up which bundle. This lets a bundle carry its own label, shown on the POS
-- quick-add button and the promo badge, so "what's in the Meryenda Bundle" has an answer
-- that doesn't require opening Promos.
--
-- Nullable, and only meaningful for rule_type = 'bundle_pct' — every other rule type
-- ignores it. Apply any time after migrate_promos_events_and_rules.sql. Safe to re-run.

alter table public.promo_rules
  add column if not exists bundle_name text;
