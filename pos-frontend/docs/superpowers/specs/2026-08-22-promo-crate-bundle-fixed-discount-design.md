# Promo: Crate-to-Crate Bundle + Fixed ₱ Discount — Design

Status: approved by user in chat 2026-08-22. Ready for implementation plan.

## Problem

Two new promo capabilities for meat/kg-priced products, requested by the project owner:

1. **Crate-to-Crate Bundle** — a bundle promo across two or more kg-priced products (e.g.
   "15kg breast + 12kg legs") where the cashier must explicitly enter the weight of each
   product in the bundle at the POS, and the whole combo gets a % discount.
2. **Fixed ₱ discount for meats** — an alternative to percent-off promos: a flat peso
   amount knocked off the per-kilo price (e.g. "−₱5/kg"), instead of a percentage.

## Decisions (from user clarification, 2026-08-22)

- Crate bundle discount mechanism: **% off the combined weighted total** (not a flat bundle
  price, not a flat ₱-per-kg-of-combined-weight).
- Crate bundle product set: **pre-configured by the manager** when authoring the promo rule
  (same authoring pattern as existing `bundle_pct`) — cashier only enters weights at checkout,
  does not pick products ad hoc.
- Fixed ₱ discount scope: **kg-priced products only** (not offered for per-piece items).

## Current architecture (relevant facts, verified in code before designing)

- Promo engine: `pos-frontend/src/utils/promo.js` — `computePromoDiscounts()` is the single
  entry point Cart.jsx calls; it recomputes discounts live from `promoRules` + current cart
  contents on every render (a Cart line's discount is never "who added it", always "what's in
  the cart now" — `promoGroupId` on a cart item is a *display* grouping convenience only, not
  what drives the $ calculation).
- Rule types today: `item_pct`, `pair_pct`, `bundle_pct`, `bogo_pct` — enum enforced by DB
  check constraint `promo_rules_rule_type_check` (`promo_rules.rule_type`).
- `item_pct` is the **only** existing rule type that already applies to kg-priced (weighted)
  lines end to end — `pair_pct`/`bundle_pct`/`bogo_pct` explicitly zero out kg lines
  (`lineQtyForPromo(item, { allowKg: false })` default) because they need discrete unit counts,
  which a weight doesn't give you. `PromoEditorModal.jsx`'s `eligibleProducts` for those three
  types already filters kg products **out**.
- `posStore.js`'s `addItem(product, quantity, opts)` already accepts a weight as `quantity` for
  a kg product (`weight: quantity` in the stored line) **and** already threads
  `opts.promoGroup` (`{ id, type, name }`) into `promoGroupId`/`promoGroupType`/`promoGroupName`
  on the stored cart line — this is the exact mechanism `POS.jsx`'s existing `addPromoQuickSet()`
  uses today for BOGO/pair/bundle quick-add tiles (`POS.jsx:292-310`). **No store change is
  needed** for the crate-bundle POS flow — it's a new caller of code that already exists.
- `buildCartDisplayGroups()` (`utils/promo.js`) already groups cart lines that share an explicit
  `item.promoGroupId`, independent of rule type — a crate bundle's lines will be grouped for
  free once tagged.
- `MAX_PROMO_DISCOUNT_PCT` (99) is enforced three ways for existing pct rules: authoring
  validation (`validatePromoRuleDraft`), a defensive clamp inside `computePromoDiscounts`, and
  DB constraint `promo_rules_discount_pct_check`. Any new pct-based rule type must follow the
  same three-layer pattern — UI validation is explicitly documented as not the security boundary.
- **Stale doc found during investigation**: `CODEMAP.md`'s "POS bundle quick-add buttons" note
  references `collectPromoBundles()` as what wires `POS.jsx`'s bundle tiles — that function is
  now dead code (zero call sites outside its own definition). The live mechanism is
  `collectPromoQuickSets()` + `promoQuickSets`/`addPromoQuickSet()` in `POS.jsx`. Fix this doc
  drift in the same commit as the CODEMAP update below (unrelated to this feature's logic, but
  touches the same doc section — call it out separately in the PR/commit description per
  CLAUDE.md's "mention unrelated issues separately" rule).

## Design

### 1. Data model — new migration

New file `pos-frontend/supabase/migrate_promo_crate_bundle_and_fixed_discount.sql`, additive,
safe to re-run (follows existing migration conventions: `drop constraint if exists` /
`add column if not exists`):

```sql
-- Add crate_bundle_pct to the rule type enum.
alter table promo_rules drop constraint if exists promo_rules_rule_type_check;
alter table promo_rules add constraint promo_rules_rule_type_check
  check (rule_type in ('item_pct','pair_pct','bundle_pct','bogo_pct','crate_bundle_pct'));

-- Fixed ₱-off-per-kg support: discount_type flag + discount_amount column.
alter table promo_rules add column if not exists discount_type text not null default 'pct'
  check (discount_type in ('pct','fixed_amount'));
alter table promo_rules add column if not exists discount_amount numeric(10,2);

-- discount_pct becomes optional (fixed_amount rules don't use it); enforce mutual exclusivity.
alter table promo_rules alter column discount_pct drop not null;
alter table promo_rules drop constraint if exists promo_rules_discount_consistency_check;
alter table promo_rules add constraint promo_rules_discount_consistency_check check (
  (discount_type = 'pct' and discount_pct is not null and discount_amount is null) or
  (discount_type = 'fixed_amount' and discount_amount is not null and discount_amount > 0 and discount_pct is null)
);
```

`bundle_name` (existing column, added by `migrate_promo_rule_bundle_name.sql`) is reused as-is
for the crate bundle's label — no new column needed there.

No RLS policy changes — same table, same policies (`managers manage promo rules` etc.), new
column/constraint doesn't change who can write.

Update `supabase/README.md`'s "Full apply order" list per its existing convention.

### 2. Fixed ₱-off-per-kg (extends `item_pct`, not a new rule type)

Deliberately reuses `item_pct` rather than forking a new rule type, because `item_pct` already
has full kg-line support wired through every layer (badge rendering, cart product matching,
`expandPromoRuleRows`, POS tile strike-price). Only the discount *amount* calculation differs.

- **`PromoEditorModal.jsx`**: when `ruleType === 'item_pct'`, add a segmented toggle
  ("% off" / "₱ off per kg") driving local state `discountType`. Selecting "₱ off per kg"
  swaps `eligibleProducts` to kg-priced products only (`pricingMode === 'kg'`) and swaps the
  discount `%` input for a peso amount `Field`. Selecting "% off" keeps current behavior
  unchanged (all products eligible, 0–99 pct field) — this is additive, existing rules/flows
  untouched.
- **`utils/promo.js`**:
  - `validatePromoRuleDraft`: branch on `discountType`. `'fixed_amount'` requires
    `discountAmount > 0` (no upper bound checkable here — no product price in scope; runtime
    clamp below is the real backstop, same "UI validation is not the security boundary"
    pattern as the pct cap) and requires every selected product be kg-priced. `'pct'` keeps the
    existing 0–99 check unchanged.
  - `computePromoDiscounts()`'s `item_pct` branch: compute `unitDiscount` as
    `discountType === 'fixed_amount' ? Math.min(discountAmount, unitPrice) : (lineTotal(item)/q) * pct`.
    The `Math.min(discountAmount, unitPrice)` clamp is the defense-in-depth layer (mirrors the
    existing `Math.min(rawPct, MAX_PROMO_DISCOUNT_PCT)` clamp) — a line can never go negative
    even if a bad value reaches the DB outside the authoring validation.
  - `promoUnitPrice()`: fixed-amount branch returns `listPrice - discountAmount` (floor 0).
  - `promoBadgeLabel()`: fixed-amount branch renders `"−₱{amount}/kg"` instead of `"{pct}% OFF"`.
- **`api/promos.js`**: `createPromoRule` / `fetchPromoRulesForEvent` / `loadPromoRulesForEvent`
  carry `discountType`/`discountAmount` through, with the same missing-column fallback already
  used for `bundleName` (pre-migration DB compatibility).
- **`Promos.jsx`**: rules table display — new column/inline text showing `"₱X/kg"` vs `"Y%"`
  depending on `discountType`.

### 3. Crate-to-Crate Bundle (new `rule_type = 'crate_bundle_pct'`)

**Authoring** (`PromoEditorModal.jsx`):
- New option in the rule-type selector: "Crate Bundle".
- Requires `bundleName` (reuses existing bundle-name field/validation) + ≥2 selected products,
  `eligibleProducts` filtered to `pricingMode === 'kg'` only (opposite filter direction from
  pair/bundle/bogo, which exclude kg).
- Single `discountPct` field, existing 0–99 cap (`MAX_PROMO_DISCOUNT_PCT`), existing three-layer
  enforcement (UI validation here, runtime clamp in `computePromoDiscounts`, DB constraint
  `promo_rules_discount_pct_check` — that constraint doesn't need to change, it already applies
  to whatever's in `discount_pct` regardless of `rule_type`).
- Duplicate-rule guard: `validatePromoRuleDraft`'s "product already used by a rule of this same
  type" check currently exempts only `bundle_pct` (a product can legitimately be in more than
  one named bundle). Extend that exemption to `crate_bundle_pct` for the same reason (e.g. pork
  belly could be in both a "Pork Crate Combo" and a "Weekend Meat Bundle").

**Engine** (`computePromoDiscounts()`, new branch alongside the existing `bundle_pct` one):

Unlike `bundle_pct`'s FIFO unit-matching (pairs/sets of *discrete* units — doesn't fit
continuous weights), the condition is presence-based, not ratio-based: if every product
configured on the rule has weight > 0 available in the cart, discount the *entire* available
weight of each configured product at `pct` off. There is no "1 crate of A per 1 crate of B"
ratio requirement — a crate bundle is "buy some of each, get the combo discount," not
"buy exactly matching amounts."

```js
else if (ruleType === 'crate_bundle_pct' && products.length >= 2) {
  const availableFor = (p) =>
    indicesForProduct(p.productId || p.product_id, p.sku).reduce(
      (s, idx) => s + Math.max(0, lineQtyForPromo(items[idx], { allowKg: true }) - unitsUsedPerLine[idx]), 0)
  const allPresent = products.every((p) => availableFor(p) > 0)
  if (allPresent) {
    const perUnit = (idx, take) => (lineTotal(items[idx]) / lineQtyForPromo(items[idx], { allowKg: true })) * take * pct
    for (const p of products) {
      const avail = availableFor(p)
      allocateUnitsForProduct(ruleDiscounts, p.productId || p.product_id, p.sku, avail, perUnit, true)
    }
  }
}
```

Placed in the existing `setRules` bucket (runs before `item_pct`, same "set-based rules claim
units first" ordering already documented for pair/bundle/BOGO) — `isSetBasedRuleType()` gets
`crate_bundle_pct` added.

**POS entry flow** (the part that needs the explicit weight-entry step):

- `collectPromoQuickSets()` (`utils/promo.js`) gets a new branch producing a `{ type:
  'crate_bundle', ruleId, bundleName, discountPct, products }` entry per `crate_bundle_pct`
  rule — same shape family as the existing bundle/pair/bogo entries, rendered as a tile in the
  same Promos-category quick-set row in `POS.jsx` (no new UI surface for the tile itself).
- Tapping the tile does **not** call `addPromoQuickSet()` directly (that function adds fixed
  qty=1 immediately, wrong for kg product weight entry). Instead it opens a new modal,
  `pos-frontend/src/components/pos/CrateBundleModal.jsx` (sibling of the existing
  `WeightModal.jsx`, reusing its `Field`/`NumPad` weight-entry pattern) — lists each configured
  product with its own weight input, shows a running combined-price preview, one "Add to cart"
  action.
- On submit: loop the bundle's products, one `addItem(product, enteredWeight, { promoGroup: {
  id: newPromoGroupId(), type: 'crate_bundle_pct', name: bundleName } })` call each — reusing
  `POS.jsx`'s existing `newPromoGroupId()` helper and the existing `addItem` weight+promoGroup
  path verified above. **No `posStore.js` changes required.**
- Validation: block submit until every listed product has weight > 0 (mirrors `WeightModal`'s
  `disabled={amount <= 0}` pattern).

### 4. Files touched

| File | Change |
|---|---|
| `supabase/migrate_promo_crate_bundle_and_fixed_discount.sql` | new |
| `supabase/README.md` | append to apply order |
| `src/utils/promo.js` | `computePromoDiscounts` (2 branches), `validatePromoRuleDraft`, `promoUnitPrice`, `promoBadgeLabel`, `collectPromoQuickSets`, `isSetBasedRuleType` |
| `src/components/promos/PromoEditorModal.jsx` | rule-type option, discount-type toggle, eligibleProducts filters |
| `src/lib/api/promos.js` | carry `discountType`/`discountAmount` through create/fetch |
| `src/pages/manager/Promos.jsx` | rules table display for fixed-₱ + crate bundle rows |
| `src/pages/POS.jsx` | wire crate bundle tile → new modal instead of `addPromoQuickSet` |
| `src/components/pos/CrateBundleModal.jsx` | new |
| `docs/CODEMAP.md` | promo section: document both features; fix stale `collectPromoBundles` reference |

### 5. Verification

- `npm run lint`, `npm run build`.
- Manual, `npm run dev`: as manager, create (a) a crate bundle rule with 2 kg products, (b) a
  fixed-₱/kg `item_pct` rule. Ring both up in POS — confirm cart math, receipt breakdown
  (`Transactions.jsx` promo panel), and that the 99%-cap / per-unit-price clamp both still hold
  (try to enter a discount amount larger than the product's price and confirm it clamps instead
  of going negative).
- Confirm existing `bundle_pct`/`pair_pct`/`bogo_pct`/plain `item_pct` promos are unaffected
  (regression check — this is an additive change to a shared engine function).

## Open item — version bump

Per `CLAUDE.md`, this is a MINOR bump (new capability, no existing behavior changed) with a
`CHANGELOG.md` entry, in the same commit as the change. Per the project's explicit rule, the
version is only bumped when the user accepts — confirm at implementation time, not assumed here.
