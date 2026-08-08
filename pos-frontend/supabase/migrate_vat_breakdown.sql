-- BIR VAT breakdown: SC/PWD sales are VAT-exempt outright, not just 20% off a still-taxed
-- price. These columns freeze the full breakdown at time of sale (src/utils/vat.js
-- computeVatBreakdown) so a future VAT rate change never alters historical receipts.
--
-- Existing `total_amount` already holds the post-discount amount the customer paid
-- (BIR "amount due"); the pre-discount VAT-inclusive "Total Sales" figure is derived
-- on read as total_amount + discount_amount, so it is not duplicated as a column here.

alter table transactions
  add column if not exists vat_exempt_sales numeric(12,2) not null default 0,
  add column if not exists zero_rated_sales numeric(12,2) not null default 0,
  add column if not exists sc_pwd_discount numeric(12,2) not null default 0,
  add column if not exists vat_rate_applied numeric(6,4) not null default 0.12;

alter table transaction_items
  add column if not exists vat_category text not null default 'vatable';

alter table transaction_items drop constraint if exists transaction_items_vat_category_check;
alter table transaction_items add constraint transaction_items_vat_category_check
  check (vat_category in ('vatable', 'exempt', 'zero_rated'));

-- Cheap sanity bound, not a full recompute (the pricing engine — promos, kg pricing,
-- ulam combos — stays client-side given the offline-first architecture; this only
-- catches gross mismatches/tampering, the same trust model total_amount already has).
--
-- Identity: total_amount is (VATable + VAT-Exempt + Zero-Rated + VAT) less the SC/PWD
-- discount — promo discounts are already netted into vatable_sales (no separate BIR
-- "Less:" line for those), so they don't appear in this check. See src/utils/vat.js.
-- NOT VALID: only enforced for rows written from now on. Historical rows created
-- before vat_exempt_sales/sc_pwd_discount existed (or even before vat_amount/
-- vatable_sales existed) legitimately don't satisfy this identity and must not
-- block the migration or get rewritten — sale records are immutable.
alter table transactions drop constraint if exists transactions_vat_breakdown_sane_check;
alter table transactions add constraint transactions_vat_breakdown_sane_check
  check (
    abs(
      (total_amount + sc_pwd_discount)
      - (vatable_sales + vat_amount + vat_exempt_sales + zero_rated_sales)
    ) < 1.00
  ) not valid;
