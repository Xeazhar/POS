-- Per-line promo attribution, so the Promos -> Sales report stays accurate now
-- that several promo events can be live on a branch at once (see
-- migrate_promo_multi_active.sql). transactions.discount_type is a single text
-- field set to whichever promo name(s) won the whole cart (joined with " + "
-- when a cart mixes two promos) — it can't be exact-matched per promo anymore.
-- transaction_items.promo_name instead records, per line, exactly which promo
-- event discounted that line (null for PWD/Senior or undiscounted lines), so
-- Promos -> Sales can attribute correctly even when a cart mixes promos.

alter table transaction_items add column if not exists promo_name text;

create index if not exists idx_transaction_items_promo_name
  on transaction_items(promo_name)
  where promo_name is not null;
