-- Promo set refund grouping: bundle / pair / BOGO lines sold together share one id.
-- Apply after migrate_promo_line_attribution.sql (promo_name column exists).

ALTER TABLE transaction_items
  ADD COLUMN IF NOT EXISTS promo_group_id uuid;

COMMENT ON COLUMN transaction_items.promo_group_id IS
  'Shared id for lines sold as one promo set (bundle, pair, BOGO). Refunds must include every line in the group.';
