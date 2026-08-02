-- Day-end sales + restock snapshot for next-morning alerts.
-- Structure (day_report jsonb):
-- {
--   "orderCount": 12,
--   "revenue": 4500.5,
--   "sold": [{ "productId", "name", "sku", "pricingMode", "qty", "revenue" }],
--   "restock": [{ "productId", "name", "sku", "pricingMode", "soldQty", "onHand", "lowStockAt", "suggestedQty" }],
--   "generatedAt": "ISO"
-- }

alter table day_ends
  add column if not exists day_report jsonb;

comment on column day_ends.day_report is
  'Snapshot at close: sold lines + restock suggestions for the next business day.';

notify pgrst, 'reload schema';
