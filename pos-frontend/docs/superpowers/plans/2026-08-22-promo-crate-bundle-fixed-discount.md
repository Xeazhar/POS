# Crate-to-Crate Bundle + Fixed ₱/kg Promo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two promo capabilities to CalePOS's manager promo system and POS checkout: (1) a
"Crate Bundle" rule type for kg-priced meat products where the cashier explicitly enters the
weight of each crate at checkout and gets a % discount on the combined weight; (2) a flat
₱-off-per-kilogram discount option (alternative to the existing % discount) for kg-priced
products under the existing `item_pct` rule type.

**Architecture:** Extends the existing promo engine (`src/utils/promo.js`'s
`computePromoDiscounts`, the single source of truth for cart discount math, called fresh on
every render from `promoRules` + current cart contents — never from stored per-line state) with
one new rule type (`crate_bundle_pct`) and one new discount-representation flag
(`discount_type: 'pct' | 'fixed_amount'` on the existing `item_pct` rule type). The POS entry
flow for crate bundles reuses `posStore.js`'s existing `addItem(product, weight, { promoGroup
})` call — already used by the current BOGO/pair/bundle quick-add tiles — behind one new modal
component that collects a weight per product before adding to cart.

**Tech Stack:** React 18, Zustand (`posStore.js`), Supabase Postgres + RLS, Tailwind, Vite. No
test framework is configured in this repo (`CLAUDE.md` confirms this) — verification is
`npm run lint`, `npm run build`, and manual exercise via `npm run dev`. For the pure-function
engine changes (Task 2) this plan additionally uses a throwaway Node ESM script (the project is
`"type": "module"`, so `node script.mjs` runs real `import` statements against `src/utils/promo.js`
with no build step) to get a genuine write-check/see-fail/implement/see-pass cycle despite no
test framework — the script is deleted before the task's commit.

**Spec:** `pos-frontend/docs/superpowers/specs/2026-08-22-promo-crate-bundle-fixed-discount-design.md`

## Global Constraints

- `MAX_PROMO_DISCOUNT_PCT` = 99 (`src/utils/promo.js`) — every pct-based rule (including the new
  `crate_bundle_pct`) must stay on the existing three-layer cap: authoring validation, runtime
  clamp in `computePromoDiscounts`, DB constraint `promo_rules_discount_pct_check`.
- A fixed ₱ discount must never be able to take a line negative — clamp
  `Math.min(discountAmount, unitPrice)` at the point of calculation (defense in depth, same
  philosophy as the pct clamp — UI validation is not the security boundary here per
  `CODEMAP.md`).
- No changes to `posStore.js`, `Cart.jsx`, or the promo dual-control/approval RPCs — verified in
  the spec that the existing `addItem`/`promoGroup`/`buildCartDisplayGroups` machinery already
  supports everything the new POS flow needs.
- Every DB migration must be additive and safe to re-run (`drop constraint if exists` /
  `add column if not exists`), matching every existing `migrate_promo_*.sql` in this repo.
- Do not bump `package.json` version or touch `CHANGELOG.md` — the project owner bumps versions
  explicitly, never automatically (`CLAUDE.md`). Flag this as a final open item instead.

---

## Task 1: Database migration + docs

**Files:**
- Create: `pos-frontend/supabase/migrate_promo_crate_bundle_and_fixed_discount.sql`
- Modify: `pos-frontend/supabase/README.md:20-30` (the "apply these on top of schema.sql" list)

**Interfaces:**
- Produces: `promo_rules.rule_type` enum gains `'crate_bundle_pct'`. `promo_rules` gains
  `discount_type text not null default 'pct' check (discount_type in ('pct','fixed_amount'))`
  and `discount_amount numeric(10,2)` (nullable). `discount_pct` becomes nullable. New check
  constraint `promo_rules_discount_consistency_check` enforces exactly one of
  (`discount_pct` set, `discount_type='pct'`) or (`discount_amount` set, `discount_type='fixed_amount'`).
  Every later task's SQL/JS reads/writes these exact column names.

- [ ] **Step 1: Write the migration**

```sql
-- pos-frontend/supabase/migrate_promo_crate_bundle_and_fixed_discount.sql
-- Adds two promo capabilities:
--  1. crate_bundle_pct rule type — % off a combined-weight bundle of 2+ kg-priced products,
--     cashier enters each product's crate weight at checkout (see CrateBundleModal.jsx).
--  2. discount_type='fixed_amount' on item_pct rules — flat ₱-off-per-kg instead of a percent,
--     for kg-priced products only.
-- Needs migrate_promos_events_and_rules.sql (creates promo_rules) and
-- migrate_promo_cap_discount_pct.sql (discount_pct check this touches) above. Safe to re-run.

alter table promo_rules drop constraint if exists promo_rules_rule_type_check;
alter table promo_rules add constraint promo_rules_rule_type_check
  check (rule_type in ('item_pct','pair_pct','bundle_pct','bogo_pct','crate_bundle_pct'));

alter table promo_rules add column if not exists discount_type text not null default 'pct'
  check (discount_type in ('pct','fixed_amount'));
alter table promo_rules add column if not exists discount_amount numeric(10,2);

alter table promo_rules alter column discount_pct drop not null;

alter table promo_rules drop constraint if exists promo_rules_discount_consistency_check;
alter table promo_rules add constraint promo_rules_discount_consistency_check check (
  (discount_type = 'pct' and discount_pct is not null and discount_amount is null) or
  (discount_type = 'fixed_amount' and discount_amount is not null and discount_amount > 0 and discount_pct is null)
);
```

- [ ] **Step 2: Update `supabase/README.md`**

Append the new filename to the "Apply these on top of `schema.sql`, in this order" list at
`README.md:20-30` (it currently ends with `migrate_promo_cap_discount_pct.sql`):

```
migrate_announcements.sql
migrate_announcements_backfill_permissions.sql
migrate_terminal_report_old_grand_total_rpc.sql
migrate_single_active_session_enforcement.sql
migrate_rename_or_to_invoice.sql   -- last: supersedes complete_sale/void_sale_secure/
                                    -- refund_sale_items bodies from every earlier file
migrate_promo_expire_supervisor_gate.sql
migrate_cash_movement_drawer_limit.sql
migrate_promo_cap_discount_pct.sql
migrate_promo_crate_bundle_and_fixed_discount.sql
```

- [ ] **Step 3: Apply the migration to your dev Supabase project**

Run the file's contents in the Supabase SQL editor for your dev project (or via
`mcp__plugin_supabase_supabase__apply_migration` if using the Supabase MCP tool against a linked
project). Confirm no errors. This step has no CLI-only verification — the later manual QA task
(Task 9) is what actually exercises it end to end.

- [ ] **Step 4: Commit**

```bash
git add pos-frontend/supabase/migrate_promo_crate_bundle_and_fixed_discount.sql pos-frontend/supabase/README.md
git commit -m "feat(db): add crate_bundle_pct rule type and fixed-amount discount columns to promo_rules"
```

---

## Task 2: Engine changes — `src/utils/promo.js`

**Files:**
- Modify: `src/utils/promo.js` (functions: `validatePromoRuleDraft` at line 32, `isSetBasedRuleType`
  at line 254, `computePromoDiscounts` at line 481, `promoUnitPrice` at line 196,
  `promoBadgeLabel` at line 209, `buildPromoByProductId` at line 89, `collectPromoQuickSets` at
  line 130, `inferPromoOfferMeta` at line 669, `PROMO_RULE_TYPE_LABELS` at line 638)
- Create (throwaway, deleted in Step 6): `pos-frontend/scripts/verify-promo-tmp.mjs`

**Interfaces:**
- Consumes: nothing new from other tasks — pure functions, no imports beyond what's already
  imported in this file (`lineTotal` from `./ulam`, `newUuidClientId` from
  `../offline/queueTypes`).
- Produces: `validatePromoRuleDraft({ ruleType, discountType, discountPct, discountAmount, ... })`
  (two new params, both optional, default `discountType = 'pct'`). `computePromoDiscounts`
  correctly handles `rule.ruleType === 'crate_bundle_pct'` and
  `rule.ruleType === 'item_pct' && rule.discountType === 'fixed_amount'`. New exported function
  `formatPromoRuleDiscount(rule)` returning a display string, consumed by Task 6 and Task 7.
  `collectPromoQuickSets` emits `{ type: 'crate_bundle', ruleId, bundleName, discountPct,
  products, sublabel, badge: 'Crate Bundle' }` entries for `crate_bundle_pct` rules — consumed
  by Task 8 (`POS.jsx`).

- [ ] **Step 1: Write the throwaway verification script (fails first)**

```js
// pos-frontend/scripts/verify-promo-tmp.mjs
import { computePromoDiscounts, validatePromoRuleDraft } from '../src/utils/promo.js'

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    console.error(`FAIL ${label}\n  actual:   ${a}\n  expected: ${e}`)
    process.exitCode = 1
  } else {
    console.log(`PASS ${label}`)
  }
}

// --- crate_bundle_pct: both products present with weight, 10% off combined ---
{
  const items = [
    { id: 'breast', name: 'Breast', pricingMode: 'kg', price: 200, weight: 15, quantity: 1 },
    { id: 'legs', name: 'Legs', pricingMode: 'kg', price: 180, weight: 12, quantity: 1 },
  ]
  const rules = [{
    ruleType: 'crate_bundle_pct',
    discountPct: 10,
    bundleName: 'Pork Crate Combo',
    eventName: 'Crate Promo',
    products: [{ productId: 'breast' }, { productId: 'legs' }],
  }]
  const result = computePromoDiscounts(items, rules)
  // breast: 200*15=3000 * 10% = 300; legs: 180*12=2160 * 10% = 216; total 516
  assertEqual(result?.promoDiscountAmount, 516, 'crate bundle: combined 10% off')
}

// --- crate_bundle_pct: only ONE product present — must NOT discount ---
{
  const items = [{ id: 'breast', name: 'Breast', pricingMode: 'kg', price: 200, weight: 15, quantity: 1 }]
  const rules = [{
    ruleType: 'crate_bundle_pct',
    discountPct: 10,
    bundleName: 'Pork Crate Combo',
    products: [{ productId: 'breast' }, { productId: 'legs' }],
  }]
  const result = computePromoDiscounts(items, rules)
  assertEqual(result, null, 'crate bundle: no discount when only one product present')
}

// --- item_pct fixed_amount: ₱5 off per kg ---
{
  const items = [{ id: 'pork', name: 'Pork', pricingMode: 'kg', price: 200, weight: 3, quantity: 1 }]
  const rules = [{
    ruleType: 'item_pct',
    discountType: 'fixed_amount',
    discountAmount: 5,
    eventName: 'Meat Sale',
    products: [{ productId: 'pork' }],
  }]
  const result = computePromoDiscounts(items, rules)
  assertEqual(result?.promoDiscountAmount, 15, 'item_pct fixed_amount: 5/kg * 3kg = 15')
}

// --- item_pct fixed_amount: clamp so line never goes negative ---
{
  const items = [{ id: 'pork', name: 'Pork', pricingMode: 'kg', price: 10, weight: 1, quantity: 1 }]
  const rules = [{
    ruleType: 'item_pct',
    discountType: 'fixed_amount',
    discountAmount: 999,
    products: [{ productId: 'pork' }],
  }]
  const result = computePromoDiscounts(items, rules)
  assertEqual(result?.promoDiscountAmount, 10, 'item_pct fixed_amount: clamped to unit price, never negative')
}

// --- validatePromoRuleDraft: fixed_amount requires discountAmount > 0 ---
{
  const result = validatePromoRuleDraft({
    ruleType: 'item_pct',
    discountType: 'fixed_amount',
    discountAmount: 0,
    selectedProductsForRule: ['pork'],
    usedProductIdsByType: new Map(),
  })
  assertEqual(result?.message, 'Enter a ₱ discount amount greater than 0.', 'validate: fixed_amount needs amount > 0')
}

// --- validatePromoRuleDraft: crate_bundle_pct needs bundleName + 2 products ---
{
  const result = validatePromoRuleDraft({
    ruleType: 'crate_bundle_pct',
    discountPct: 10,
    bundleName: '',
    bundleSelected: ['a', 'b'],
    selectedProductsForRule: ['a', 'b'],
    usedProductIdsByType: new Map(),
  })
  assertEqual(result?.message, 'Enter a bundle name before adding this rule.', 'validate: crate bundle needs a name')
}

if (process.exitCode === 1) {
  console.error('\nSome checks FAILED (expected right now — implementation not written yet).')
} else {
  console.log('\nAll checks passed.')
}
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd pos-frontend && node scripts/verify-promo-tmp.mjs`
Expected: several `FAIL` lines (crate bundle branch and fixed_amount branch don't exist yet, so
`computePromoDiscounts` returns `null` for the first two and mishandles the fixed_amount cases;
`validatePromoRuleDraft` doesn't recognize `discountType` yet).

- [ ] **Step 3: Implement — `isSetBasedRuleType`**

At `src/utils/promo.js:254`:

```js
function isSetBasedRuleType(ruleType) {
  return ruleType === 'pair_pct' || ruleType === 'bundle_pct' || ruleType === 'bogo_pct' || ruleType === 'crate_bundle_pct'
}
```

- [ ] **Step 4: Implement — `validatePromoRuleDraft`**

Replace the whole function at `src/utils/promo.js:32-61`:

```js
export function validatePromoRuleDraft({
  ruleType,
  discountType = 'pct',
  discountPct,
  discountAmount,
  productA,
  productB,
  bundleName,
  bundleSelected,
  selectedProductsForRule,
  usedProductIdsByType,
}) {
  if (!selectedProductsForRule.length) {
    return { message: 'Select at least one product for this rule.' }
  }
  if (discountType === 'fixed_amount') {
    if (!(Number(discountAmount) > 0)) {
      return { message: 'Enter a ₱ discount amount greater than 0.' }
    }
  } else if (discountPct < 0 || discountPct > MAX_PROMO_DISCOUNT_PCT) {
    return { message: `Discount must be between 0 and ${MAX_PROMO_DISCOUNT_PCT} — an item can never be 100% off.` }
  }
  if (ruleType === 'pair_pct' && productA && productB && productA === productB) {
    return { message: 'Pair rule needs two different products.' }
  }
  if (ruleType === 'bundle_pct' || ruleType === 'crate_bundle_pct') {
    if (!bundleName.trim()) return { message: 'Enter a bundle name before adding this rule.' }
    if (bundleSelected.length < 2) return { message: 'Select at least 2 products for a bundle.' }
  }
  if (ruleType !== 'bundle_pct' && ruleType !== 'crate_bundle_pct') {
    const usedForType = usedProductIdsByType.get(ruleType) || new Set()
    const duplicateIds = selectedProductsForRule.filter((id) => usedForType.has(id))
    if (duplicateIds.length) return { duplicateIds }
  }
  return null
}
```

(The `₱` above is a literal peso sign — copy it as-is, matching every other peso sign already
in this codebase, e.g. `promo.js:46`'s existing message strings.)

- [ ] **Step 5: Implement — `computePromoDiscounts`'s `applyRule`**

Replace the whole `applyRule` function body at `src/utils/promo.js:522-611` (keep the
surrounding `computePromoDiscounts` function, `setRules`/`itemRules` loop, and final
aggregation at lines 613-635 unchanged):

```js
  const applyRule = (rule) => {
    const ruleType = normalizeRuleType(rule.ruleType || rule.rule_type)
    const discountType = rule.discountType === 'fixed_amount' || rule.discount_type === 'fixed_amount'
      ? 'fixed_amount'
      : 'pct'
    const rawPct = Number(rule.discountPct ?? rule.discount_pct ?? 0)
    // Defense in depth: clamp even if a bad value reached the DB outside this validation
    // (older row, direct SQL edit) — an item must never ring up free.
    const pct = Math.min(rawPct, MAX_PROMO_DISCOUNT_PCT) / 100
    const rawAmount = Number(rule.discountAmount ?? rule.discount_amount ?? 0)

    if (discountType === 'pct' && pct <= 0) return
    if (discountType === 'fixed_amount' && rawAmount <= 0) return

    const products = rule.products || []
    if (!products.length) return

    const ruleDiscounts = items.map(() => 0)

    if (ruleType === 'item_pct' && discountType === 'fixed_amount') {
      for (const p of products) {
        const productId = p.productId || p.product_id
        for (const idx of indicesForProduct(productId, p.sku)) {
          const q = lineQtyForPromo(items[idx], { allowKg: true })
          const available = q - unitsUsedPerLine[idx]
          if (available <= 0) continue
          const unitPrice = lineTotal(items[idx]) / q
          // Clamp so a fixed ₱ discount can never exceed the item's own unit price —
          // same "never ring up free/negative" defense as the pct cap above.
          const unitDiscount = Math.min(rawAmount, unitPrice)
          ruleDiscounts[idx] = Number((ruleDiscounts[idx] + unitDiscount * available).toFixed(2))
          unitsUsedPerLine[idx] += available
        }
      }
    } else if (ruleType === 'item_pct') {
      for (const p of products) {
        const productId = p.productId || p.product_id
        for (const idx of indicesForProduct(productId, p.sku)) {
          const q = lineQtyForPromo(items[idx], { allowKg: true })
          const available = q - unitsUsedPerLine[idx]
          if (available <= 0) continue
          const unitDiscount = (lineTotal(items[idx]) / q) * pct
          ruleDiscounts[idx] = Number((ruleDiscounts[idx] + unitDiscount * available).toFixed(2))
          unitsUsedPerLine[idx] += available
        }
      }
    } else if (ruleType === 'pair_pct') {
      const [a, b] = products
      const idA = a?.productId || a?.product_id
      const idB = b?.productId || b?.product_id
      if (idA && idB) {
        const totalA = indicesForProduct(idA, a?.sku).reduce(
          (s, idx) => s + Math.max(0, lineQtyForPromo(items[idx]) - unitsUsedPerLine[idx]),
          0,
        )
        const totalB = indicesForProduct(idB, b?.sku).reduce(
          (s, idx) => s + Math.max(0, lineQtyForPromo(items[idx]) - unitsUsedPerLine[idx]),
          0,
        )
        const pairs = Math.min(totalA, totalB)
        if (pairs > 0) {
          const perUnit = (idx, take) => Number(items[idx]?.price ?? 0) * take * pct
          allocateUnitsForProduct(ruleDiscounts, idA, a?.sku, pairs, perUnit, false)
          allocateUnitsForProduct(ruleDiscounts, idB, b?.sku, pairs, perUnit, false)
        }
      }
    } else if (ruleType === 'bundle_pct' && products.length >= 2) {
      const totals = products.map((p) =>
        indicesForProduct(p.productId || p.product_id, p.sku).reduce(
          (s, idx) => s + Math.max(0, lineQtyForPromo(items[idx]) - unitsUsedPerLine[idx]),
          0,
        ),
      )
      const bundles = Math.min(...totals)
      if (bundles > 0) {
        const perUnit = (idx, take) => Number(items[idx]?.price ?? 0) * take * pct
        for (const p of products) {
          allocateUnitsForProduct(ruleDiscounts, p.productId || p.product_id, p.sku, bundles, perUnit, false)
        }
      }
    } else if (ruleType === 'bogo_pct') {
      const p = products[0]
      const productId = p?.productId || p?.product_id
      if (productId || p?.sku) {
        const total = indicesForProduct(productId, p?.sku).reduce(
          (s, idx) => s + Math.max(0, lineQtyForPromo(items[idx]) - unitsUsedPerLine[idx]),
          0,
        )
        const buyQty = Number(rule.buyQty ?? rule.buy_qty ?? 1)
        const getQty = Number(rule.getQty ?? rule.get_qty ?? 1)
        const group = buyQty + getQty
        if (total > 0 && group > 0) {
          const fullGroups = Math.floor(total / group)
          const remainder = total % group
          const freeUnits = fullGroups * getQty + Math.max(0, remainder - buyQty)
          if (freeUnits > 0) {
            const perUnit = (idx, take) => Number(items[idx]?.price ?? 0) * take * pct
            allocateUnitsForProduct(ruleDiscounts, productId, p?.sku, freeUnits, perUnit, false)
          }
        }
      }
    } else if (ruleType === 'crate_bundle_pct' && products.length >= 2) {
      // Presence-based, not ratio-based: unlike bundle_pct's FIFO unit-matching (which needs
      // discrete unit counts), a crate bundle is "buy some weight of each configured product,
      // get the combo % off the entire weight of each" — there's no "1 crate of A per 1 crate
      // of B" requirement, since crate weights are cashier-entered and naturally uneven
      // (e.g. 15kg breast + 12kg legs).
      const availableFor = (p) =>
        indicesForProduct(p.productId || p.product_id, p.sku).reduce(
          (s, idx) => s + Math.max(0, lineQtyForPromo(items[idx], { allowKg: true }) - unitsUsedPerLine[idx]),
          0,
        )
      const allPresent = products.every((p) => availableFor(p) > 0)
      if (allPresent) {
        const perUnit = (idx, take) =>
          (lineTotal(items[idx]) / lineQtyForPromo(items[idx], { allowKg: true })) * take * pct
        for (const p of products) {
          const avail = availableFor(p)
          allocateUnitsForProduct(ruleDiscounts, p.productId || p.product_id, p.sku, avail, perUnit, true)
        }
      }
    }

    for (let i = 0; i < ruleDiscounts.length; i += 1) {
      if (ruleDiscounts[i] > lineDiscounts[i]) {
        lineDiscounts[i] = ruleDiscounts[i]
        linePromoNames[i] = rule.eventName || null
        lineBundleNames[i] = rule.bundleName || null
      }
    }
  }
```

- [ ] **Step 6: Run the verification script again, confirm it passes, then delete it**

Run: `cd pos-frontend && node scripts/verify-promo-tmp.mjs`
Expected: all `PASS` lines, `All checks passed.`

```bash
rm pos-frontend/scripts/verify-promo-tmp.mjs
```

- [ ] **Step 7: Implement — `buildPromoByProductId`, `promoUnitPrice`, `promoBadgeLabel`**

At `src/utils/promo.js:89-113` (`buildPromoByProductId`), change the per-product map entry so
fixed-amount rules carry their amount through, and rank a fixed-amount offer only against a
tied/empty slot (ranking pct-vs-fixed precisely needs the product's price, which isn't in scope
here — this map only feeds the POS tile's cosmetic strike-price badge, not checkout totals,
which are computed independently and correctly by `computePromoDiscounts` above):

```js
export function buildPromoByProductId(rules = [], fallbackEventName = '') {
  const map = new Map()
  for (const rule of rules || []) {
    const discountType = rule.discountType === 'fixed_amount' ? 'fixed_amount' : 'pct'
    const pct = discountType === 'fixed_amount' ? 0 : Number(rule.discountPct || 0)
    for (const p of rule.products || []) {
      const productId = p.productId
      if (!productId) continue
      const existing = map.get(productId)
      const existingPct = existing?.discountType === 'fixed_amount' ? 0 : Number(existing?.discountPct || 0)
      if (!existing || pct > existingPct) {
        map.set(productId, {
          ruleType: rule.ruleType,
          discountPct: pct,
          discountType,
          discountAmount: Number(rule.discountAmount || 0),
          buyQty: Number(rule.buyQty ?? 1),
          getQty: Number(rule.getQty ?? 1),
          eventName: rule.eventName || fallbackEventName || '',
          bundleName: rule.ruleType === 'bundle_pct' || rule.ruleType === 'crate_bundle_pct' ? rule.bundleName || null : null,
          partners: (rule.products || [])
            .filter((p2) => p2.productId !== productId)
            .map((p2) => ({ productId: p2.productId, productName: p2.productName })),
        })
      }
    }
  }
  return map
}
```

At `src/utils/promo.js:196-203` (`promoUnitPrice`):

```js
export function promoUnitPrice(listPrice, info) {
  if (!info || info.ruleType !== 'item_pct') return null
  const price = Number(listPrice || 0)
  if (!(price > 0)) return null
  if (info.discountType === 'fixed_amount') {
    const amount = Number(info.discountAmount || 0)
    if (!(amount > 0)) return null
    return Number(Math.max(0, price - amount).toFixed(2))
  }
  const pct = Number(info.discountPct || 0)
  if (!(pct > 0)) return null
  return Number((price * (1 - pct / 100)).toFixed(2))
}
```

At `src/utils/promo.js:209-216` (`promoBadgeLabel`):

```js
export function promoBadgeLabel(info) {
  if (!info) return null
  if (info.ruleType === 'item_pct' && info.discountType === 'fixed_amount') return `₱${info.discountAmount} OFF/KG`
  if (info.ruleType === 'item_pct') return `${info.discountPct}% OFF`
  if (info.ruleType === 'bogo_pct') return `Buy ${info.buyQty} Get ${info.getQty}`
  if (info.ruleType === 'pair_pct') return `Pair ${info.discountPct}%`
  if (info.ruleType === 'bundle_pct') return `Bundle ${info.discountPct}%`
  if (info.ruleType === 'crate_bundle_pct') return `Crate Bundle ${info.discountPct}%`
  return 'PROMO'
}
```

- [ ] **Step 8: Implement — `collectPromoQuickSets`**

At `src/utils/promo.js:130-193`, insert a new branch inside the `for (const rule of rules)` loop,
placed after the existing `bundle_pct` branch (around line 154) and before the `pair_pct` check:

```js
    if (ruleType === 'crate_bundle_pct' && rule.bundleName && products.length >= 2) {
      const names = products.map((p) => p.productName).filter(Boolean)
      sets.push({
        ruleId: rule.id,
        type: 'crate_bundle',
        name: rule.bundleName,
        discountPct,
        products,
        sublabel: names.join(' · '),
        badge: 'Crate Bundle',
      })
      continue
    }
```

- [ ] **Step 9: Implement — `inferPromoOfferMeta` (sales stats attribution)**

At `src/utils/promo.js:669-729`, insert a new branch after the existing `bundle_pct` branch
(around line 694), before the `pair_pct` branch:

```js
    if (
      ruleType === 'crate_bundle_pct' &&
      rule.bundleName &&
      ruleProductIds.length >= 2 &&
      ruleProductIds.every((id) => productIds.includes(id))
    ) {
      return { label: rule.bundleName, badge: 'Crate Bundle', kind: 'crate_bundle' }
    }
```

- [ ] **Step 10: Implement — `PROMO_RULE_TYPE_LABELS` and new `formatPromoRuleDiscount` export**

At `src/utils/promo.js:638-643`:

```js
const PROMO_RULE_TYPE_LABELS = {
  item_pct: 'Item %',
  pair_pct: 'Pair %',
  bundle_pct: 'Bundle %',
  bogo_pct: 'BOGO %',
  crate_bundle_pct: 'Crate Bundle %',
}
```

Add this new exported function right after `expandPromoRuleRows` (after line 872, before the
`promoEntryUnits` comment block at line 874):

```js
/** Display string for a rule's discount, in either representation — used by both the promo
 * editor's staged-rules table and the branch-managing panel's read-only rules table. */
export function formatPromoRuleDiscount(rule) {
  if (rule.discountType === 'fixed_amount') {
    return `₱${Number(rule.discountAmount || 0).toFixed(2)} off/kg`
  }
  return `${rule.discountPct}% off`
}
```

- [ ] **Step 11: Lint and build**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors.

Run: `cd pos-frontend && npm run build`
Expected: succeeds.

- [ ] **Step 12: Commit**

```bash
git add pos-frontend/src/utils/promo.js
git commit -m "feat(promo): add crate_bundle_pct rule type and fixed-amount discount to the promo engine"
```

---

## Task 3: API layer — `src/lib/api/promos.js`

**Files:**
- Modify: `src/lib/api/promos.js` (`loadPromoRulesForEvent` line 109, `fetchPromoRulesForEvent`
  line 178, `createPromoWithRules` line 727, `createPromoAcrossBranches`'s
  `PROMO_RULE_MIN_PRODUCTS` line 761, `copyPromoEventToBranches` line 846, `createPromoRule`
  line 882)

**Interfaces:**
- Consumes: nothing from Task 2 directly (this file doesn't import `utils/promo.js`).
- Produces: every function here now round-trips `discountType`/`discountAmount` alongside the
  existing `ruleType`/`discountPct`/`bundleName` fields — consumed by Task 4
  (`PromoEditorModal.jsx`) and Task 5 (`Promos.jsx`), both of which already call these functions
  today and just start passing/reading two more fields.

- [ ] **Step 1: `loadPromoRulesForEvent` — read `discount_type`/`discount_amount`**

At `src/lib/api/promos.js:109-176`, replace the whole function:

```js
async function loadPromoRulesForEvent(event, respectDuration = true) {
  if (respectDuration) {
    const now = new Date()
    const startOk = !event.starts_at || new Date(event.starts_at) <= now
    const endOk = !event.ends_at || new Date(event.ends_at) >= now
    if (!startOk || !endOk) return null
  }

  let { data: rules, error: rulesError } = await supabase
    .from('promo_rules')
    .select('id,rule_type,discount_pct,buy_qty,get_qty,bundle_name,discount_type,discount_amount')
    .eq('promo_event_id', event.id)

  if (rulesError && (isMissingColumnError(rulesError, 'discount_type') || isMissingColumnError(rulesError, 'discount_amount'))) {
    ;({ data: rules, error: rulesError } = await supabase
      .from('promo_rules')
      .select('id,rule_type,discount_pct,buy_qty,get_qty,bundle_name')
      .eq('promo_event_id', event.id))
  }
  if (rulesError && isMissingColumnError(rulesError, 'bundle_name')) {
    ;({ data: rules, error: rulesError } = await supabase
      .from('promo_rules')
      .select('id,rule_type,discount_pct,buy_qty,get_qty')
      .eq('promo_event_id', event.id))
  }
  if (rulesError) throw rulesError

  const ruleIds = (rules || []).map((r) => r.id)
  const { data: ruleProducts, error: rpError } = ruleIds.length
    ? await supabase
        .from('promo_rule_products')
        .select('promo_rule_id,product_id,product_index,quantity_required, products(name,sku)')
        .in('promo_rule_id', ruleIds)
    : { data: [], error: null }

  if (rpError) throw rpError

  const productsByRule = (ruleProducts || []).reduce((acc, row) => {
    if (!acc[row.promo_rule_id]) acc[row.promo_rule_id] = []
    acc[row.promo_rule_id].push(row)
    return acc
  }, {})

  const normalizedRules = (rules || []).map((r) => {
    const rows = productsByRule[r.id] || []
    rows.sort((a, b) => Number(a.product_index) - Number(b.product_index))
    return {
      id: r.id,
      ruleType: r.rule_type,
      discountPct: r.discount_pct != null ? Number(r.discount_pct) : null,
      discountType: r.discount_type || 'pct',
      discountAmount: r.discount_amount != null ? Number(r.discount_amount) : null,
      buyQty: Number(r.buy_qty ?? 1),
      getQty: Number(r.get_qty ?? 1),
      bundleName: r.bundle_name || null,
      products: rows.map((x) => ({
        productId: x.product_id,
        quantityRequired: Number(x.quantity_required ?? 1),
        productName: x.products?.name || null,
        sku: x.products?.sku || null,
      })),
    }
  })

  return {
    event: {
      id: event.id,
      name: event.name,
      status: event.status || 'stopped',
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      stopReason: event.stop_reason || null,
    },
    rules: normalizedRules,
  }
}
```

- [ ] **Step 2: `fetchPromoRulesForEvent` — same treatment**

At `src/lib/api/promos.js:178-223`, replace the whole function:

```js
export async function fetchPromoRulesForEvent(promoEventId) {
  let { data: rules, error } = await supabase
    .from('promo_rules')
    .select('id,rule_type,discount_pct,buy_qty,get_qty,bundle_name,discount_type,discount_amount')
    .eq('promo_event_id', promoEventId)
  if (error && (isMissingColumnError(error, 'discount_type') || isMissingColumnError(error, 'discount_amount'))) {
    ;({ data: rules, error } = await supabase
      .from('promo_rules')
      .select('id,rule_type,discount_pct,buy_qty,get_qty,bundle_name')
      .eq('promo_event_id', promoEventId))
  }
  if (error && isMissingColumnError(error, 'bundle_name')) {
    ;({ data: rules, error } = await supabase
      .from('promo_rules')
      .select('id,rule_type,discount_pct,buy_qty,get_qty')
      .eq('promo_event_id', promoEventId))
  }
  if (error) throw error
  if (!rules?.length) return []

  const ruleIds = rules.map((r) => r.id)
  const { data: ruleProducts, error: rpError } = await supabase
    .from('promo_rule_products')
    .select('promo_rule_id,product_id,product_index,quantity_required, products(name,sku)')
    .in('promo_rule_id', ruleIds)
  if (rpError) throw rpError

  const productsByRule = (ruleProducts || []).reduce((acc, row) => {
    if (!acc[row.promo_rule_id]) acc[row.promo_rule_id] = []
    acc[row.promo_rule_id].push(row)
    return acc
  }, {})

  return rules.map((r) => {
    const rows = productsByRule[r.id] || []
    rows.sort((a, b) => Number(a.product_index) - Number(b.product_index))
    return {
      id: r.id,
      ruleType: r.rule_type,
      discountPct: r.discount_pct != null ? Number(r.discount_pct) : null,
      discountType: r.discount_type || 'pct',
      discountAmount: r.discount_amount != null ? Number(r.discount_amount) : null,
      buyQty: Number(r.buy_qty ?? 1),
      getQty: Number(r.get_qty ?? 1),
      bundleName: r.bundle_name || null,
      products: rows.map((x) => ({
        productId: x.product_id,
        quantityRequired: Number(x.quantity_required ?? 1),
        productName: x.products?.name || null,
        sku: x.products?.sku || null,
      })),
    }
  })
}
```

- [ ] **Step 3: `createPromoRule` — write `discount_type`/`discount_amount`**

At `src/lib/api/promos.js:882-925`, replace the function signature and payload construction
(keep the `promo_rule_products` insert logic below it, lines 913-925 in the original,
unchanged):

```js
export async function createPromoRule({
  promoEventId,
  ruleType,
  discountType = 'pct',
  discountPct,
  discountAmount = null,
  productIds,
  buyQty = 1,
  getQty = 1,
  bundleName = null,
}) {
  await assertPromoEventPending(promoEventId)
  const payload = {
    promo_event_id: promoEventId,
    rule_type: ruleType,
    discount_pct: discountType === 'fixed_amount' ? null : discountPct,
    buy_qty: buyQty,
    get_qty: getQty,
    // Only bundle_pct/crate_bundle_pct rules ever carry a name — every other rule type passes
    // null, which is a no-op write, not worth a separate branch.
    ...(bundleName ? { bundle_name: bundleName } : {}),
    // Only sent for fixed_amount rules — omitting it for 'pct' rules keeps this call working
    // against a pre-migration DB that lacks these columns entirely (same reasoning as
    // bundle_name above; a pre-migration attempt to create a fixed_amount rule is expected to
    // fail with a real DB error prompting the migration, not silently degrade).
    ...(discountType === 'fixed_amount' ? { discount_type: discountType, discount_amount: discountAmount } : {}),
  }
  let { data: rule, error: ruleError } = await supabase.from('promo_rules').insert(payload).select('id').single()
  if (ruleError && isMissingColumnError(ruleError, 'bundle_name')) {
    const withoutBundleName = { ...payload }
    delete withoutBundleName.bundle_name
    ;({ data: rule, error: ruleError } = await supabase
      .from('promo_rules')
      .insert(withoutBundleName)
      .select('id')
      .single())
  }

  if (ruleError) throw ruleError

  const rows = (productIds || []).map((productId, idx) => ({
    promo_rule_id: rule.id,
    product_id: productId,
    product_index: idx,
    quantity_required: 1,
  }))

  if (rows.length) {
    const { error: rpError } = await supabase.from('promo_rule_products').insert(rows)
    if (rpError) throw rpError
```

(Leave everything after that line — the rest of the original function body — exactly as it is.)

- [ ] **Step 4: `createPromoWithRules` — pass the new fields through**

At `src/lib/api/promos.js:747-757`:

```js
  for (const rule of rules) {
    await createPromoRule({
      promoEventId: event.id,
      ruleType: rule.ruleType,
      discountType: rule.discountType ?? 'pct',
      discountPct: rule.discountPct,
      discountAmount: rule.discountAmount ?? null,
      productIds: rule.productIds,
      buyQty: rule.buyQty ?? 1,
      getQty: rule.getQty ?? 1,
      bundleName: rule.bundleName ?? null,
    })
  }
```

- [ ] **Step 5: `PROMO_RULE_MIN_PRODUCTS` — add crate bundle minimum**

At `src/lib/api/promos.js:761`:

```js
const PROMO_RULE_MIN_PRODUCTS = { pair_pct: 2, bundle_pct: 2, item_pct: 1, bogo_pct: 1, crate_bundle_pct: 2 }
```

- [ ] **Step 6: `copyPromoEventToBranches` — carry fields through the clone**

At `src/lib/api/promos.js:871-878`:

```js
    rules: rules.map((r) => ({
      ruleType: r.ruleType,
      discountType: r.discountType,
      discountPct: r.discountPct,
      discountAmount: r.discountAmount,
      buyQty: r.buyQty,
      getQty: r.getQty,
      bundleName: r.bundleName,
      skus: (r.products || []).map((p) => p.sku).filter(Boolean),
    })),
```

- [ ] **Step 7: Lint and build**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors.

Run: `cd pos-frontend && npm run build`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add pos-frontend/src/lib/api/promos.js
git commit -m "feat(api): round-trip discount_type/discount_amount and crate bundle min-products through promo API"
```

---

## Task 4: Promo authoring UI — `src/components/promos/PromoEditorModal.jsx`

**Files:**
- Modify: `src/components/promos/PromoEditorModal.jsx`

**Interfaces:**
- Consumes: `validatePromoRuleDraft`, `formatPromoRuleDiscount` (Task 2, `utils/promo.js`);
  `createPromoRule`, `fetchPromoRulesForEvent`, `createPromoAcrossBranches`,
  `createPromoWithRules` (Task 3, `lib/api/promos.js`) — all already imported here except
  `formatPromoRuleDiscount`, which is new.
- Produces: staged/server rule objects now always carry `discountType`/`discountAmount`
  alongside the existing fields — consumed nowhere else in this task's file beyond its own
  table render and submit calls (both already covered by this task).

- [ ] **Step 1: Import `formatPromoRuleDiscount`**

At `src/components/promos/PromoEditorModal.jsx:13-18`:

```jsx
import {
  MAX_PROMO_DISCOUNT_PCT,
  expandPromoRuleRows,
  formatPromoRuleDiscount,
  validatePromoDates,
  validatePromoRuleDraft,
} from '../../utils/promo'
```

- [ ] **Step 2: `RULE_TYPE_LABELS` — add crate bundle**

At `src/components/promos/PromoEditorModal.jsx:132-137`:

```js
const RULE_TYPE_LABELS = {
  item_pct: 'individual item %',
  pair_pct: 'pair %',
  bundle_pct: 'bundle %',
  bogo_pct: 'buy-1-take-1',
  crate_bundle_pct: 'crate bundle %',
}
```

- [ ] **Step 3: New state — `discountType`, `discountAmount`**

At `src/components/promos/PromoEditorModal.jsx:183-184`, add two new `useState` calls right
after the existing `discountPct` one:

```js
  const [ruleType, setRuleType] = useState('item_pct')
  const [discountPct, setDiscountPct] = useState(20)
  const [discountType, setDiscountType] = useState('pct')
  const [discountAmount, setDiscountAmount] = useState(5)
```

- [ ] **Step 4: `eligibleProducts` — kg-only for crate bundle and fixed-amount item rules**

At `src/components/promos/PromoEditorModal.jsx:279-284`:

```jsx
  const eligibleProducts = useMemo(() => {
    if (ruleType === 'pair_pct' || ruleType === 'bundle_pct' || ruleType === 'bogo_pct') {
      return productList.filter((p) => p.pricingMode !== 'kg')
    }
    if (ruleType === 'crate_bundle_pct' || (ruleType === 'item_pct' && discountType === 'fixed_amount')) {
      return productList.filter((p) => p.pricingMode === 'kg')
    }
    return productList
  }, [ruleType, discountType, productList])
```

- [ ] **Step 5: `selectedProductsForRule` — crate bundle reuses the bundle picker state**

At `src/components/promos/PromoEditorModal.jsx:294-300`:

```jsx
  const selectedProductsForRule = useMemo(() => {
    if (ruleType === 'item_pct') return itemSelected
    if (ruleType === 'bogo_pct') return [productSingle].filter(Boolean)
    if (ruleType === 'pair_pct') return [productA, productB].filter(Boolean)
    if (ruleType === 'bundle_pct' || ruleType === 'crate_bundle_pct') return bundleSelected
    return []
  }, [ruleType, itemSelected, productSingle, productA, productB, bundleSelected])
```

- [ ] **Step 6: `resetRuleForm` — reset the new state too**

At `src/components/promos/PromoEditorModal.jsx:324-333`:

```jsx
  const resetRuleForm = () => {
    setProductSingle(null)
    setProductA(null)
    setProductB(null)
    setBundleSelected([])
    setBundleName('')
    setItemSelected([])
    setDiscountType('pct')
    setRuleError('')
    setRuleAttempted(false)
  }
```

- [ ] **Step 7: `handleAddRule` — pass discount fields to validation and to the payload**

At `src/components/promos/PromoEditorModal.jsx:338-402`, change the `validatePromoRuleDraft`
call (lines 340-349) and the `rulePayload` construction (lines 365-372):

```jsx
    const result = validatePromoRuleDraft({
      ruleType,
      discountType,
      discountPct,
      discountAmount,
      productA,
      productB,
      bundleName,
      bundleSelected,
      selectedProductsForRule,
      usedProductIdsByType,
    })
```

```jsx
      const rulePayload = {
        ruleType,
        discountType,
        discountPct: discountType === 'fixed_amount' ? null : Number(discountPct),
        discountAmount: discountType === 'fixed_amount' ? Number(discountAmount) : null,
        productIds: selectedProductsForRule,
        buyQty: 1,
        getQty: 1,
        bundleName: ruleType === 'bundle_pct' || ruleType === 'crate_bundle_pct' ? bundleName.trim() : null,
      }
```

- [ ] **Step 8: Rule-type select — add the Crate Bundle option, reset discount type on change**

At `src/components/promos/PromoEditorModal.jsx:711-725`:

```jsx
          <SelectField
            label="Rule type"
            value={ruleType}
            onChange={(e) => {
              const next = e.target.value
              setRuleType(next)
              if (next !== 'item_pct') setDiscountType('pct')
              setRuleError('')
              setRuleAttempted(false)
            }}
          >
            <option value="item_pct">Individual item % off</option>
            <option value="pair_pct">Pair % off (both items)</option>
            <option value="bundle_pct">Bundle % off (all bundle items)</option>
            <option value="bogo_pct">Buy 1 Take 1 % off second (B1T1)</option>
            <option value="crate_bundle_pct">Crate Bundle % off (kg products, combined weight)</option>
          </SelectField>
```

- [ ] **Step 9: Discount input — toggle + amount field for `item_pct`, unchanged elsewhere**

Replace the single `Field` block at `src/components/promos/PromoEditorModal.jsx:726-735` with:

```jsx
          {ruleType === 'item_pct' ? (
            <div>
              <span className="mb-1 block text-xs font-bold text-brand-n700">Discount type</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={`rounded border px-3 py-2 text-xs font-bold ${discountType === 'pct' ? 'border-brand-ink bg-brand-n100 text-brand-ink' : 'border-brand-line bg-brand-card text-brand-subtle'}`}
                  onClick={() => setDiscountType('pct')}
                >
                  % off
                </button>
                <button
                  type="button"
                  className={`rounded border px-3 py-2 text-xs font-bold ${discountType === 'fixed_amount' ? 'border-brand-ink bg-brand-n100 text-brand-ink' : 'border-brand-line bg-brand-card text-brand-subtle'}`}
                  onClick={() => setDiscountType('fixed_amount')}
                >
                  ₱ off per kg
                </button>
              </div>
            </div>
          ) : (
            <Field
              label={`Discount % (0-${MAX_PROMO_DISCOUNT_PCT})`}
              inputMode="decimal"
              value={String(discountPct)}
              onChange={(e) =>
                setDiscountPct(
                  Math.min(MAX_PROMO_DISCOUNT_PCT, Number(e.target.value.replace(/[^\d.]/g, '')) || 0),
                )
              }
            />
          )}
          {ruleType === 'item_pct' && (
            discountType === 'fixed_amount' ? (
              <Field
                label="₱ off per kilogram"
                className="sm:col-span-2"
                inputMode="decimal"
                value={String(discountAmount)}
                onChange={(e) => setDiscountAmount(Number(e.target.value.replace(/[^\d.]/g, '')) || 0)}
              />
            ) : (
              <Field
                label={`Discount % (0-${MAX_PROMO_DISCOUNT_PCT})`}
                className="sm:col-span-2"
                inputMode="decimal"
                value={String(discountPct)}
                onChange={(e) =>
                  setDiscountPct(
                    Math.min(MAX_PROMO_DISCOUNT_PCT, Number(e.target.value.replace(/[^\d.]/g, '')) || 0),
                  )
                }
              />
            )
          )}
```

- [ ] **Step 10: Crate Bundle product picker — reuse the bundle form block**

At `src/components/promos/PromoEditorModal.jsx:797-818`, change the condition from
`ruleType === 'bundle_pct'` to include crate bundle, and adjust the copy:

```jsx
          {(ruleType === 'bundle_pct' || ruleType === 'crate_bundle_pct') && (
            <>
              <Field
                label="Bundle name"
                value={bundleName}
                onChange={(e) => setBundleName(e.target.value)}
                placeholder={ruleType === 'crate_bundle_pct' ? 'e.g. Pork Crate Combo' : 'e.g. Meryenda Bundle'}
                error={ruleAttempted && !bundleName.trim() ? 'Required' : ''}
              />
              <ProductMultiSelect
                label={ruleType === 'crate_bundle_pct' ? 'Crate bundle products (kg only)' : 'Bundle products'}
                products={eligibleProducts}
                selected={bundleSelected}
                onChange={(ids) => {
                  setBundleSelected(ids)
                  setRuleError('')
                }}
                hint={bundleSelected.length < 2 ? 'Select at least 2 products.' : null}
                invalid={ruleAttempted && bundleSelected.length < 2}
              />
            </>
          )}
```

- [ ] **Step 11: Rules table — use `formatPromoRuleDiscount` instead of raw `discountPct`**

At `src/components/promos/PromoEditorModal.jsx:669`:

```jsx
                    <td className="px-3 py-2">{formatPromoRuleDiscount(r)}</td>
```

- [ ] **Step 12: Submit payloads — carry the new fields through both branches**

At `src/components/promos/PromoEditorModal.jsx:473-480` (multi-branch create):

```jsx
          rules: stagedRules.map((r) => ({
            ruleType: r.ruleType,
            discountType: r.discountType,
            discountPct: r.discountPct,
            discountAmount: r.discountAmount,
            buyQty: r.buyQty,
            getQty: r.getQty,
            bundleName: r.bundleName,
            skus: (r.products || []).map((p) => p.sku).filter(Boolean),
          })),
```

At `src/components/promos/PromoEditorModal.jsx:511-518` (single-branch create):

```jsx
          rules: stagedRules.map((r) => ({
            ruleType: r.ruleType,
            discountType: r.discountType,
            discountPct: r.discountPct,
            discountAmount: r.discountAmount,
            productIds: r.productIds,
            buyQty: r.buyQty,
            getQty: r.getQty,
            bundleName: r.bundleName,
          })),
```

- [ ] **Step 13: Lint and build**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors.

Run: `cd pos-frontend && npm run build`
Expected: succeeds.

- [ ] **Step 14: Commit**

```bash
git add pos-frontend/src/components/promos/PromoEditorModal.jsx
git commit -m "feat(promo-editor): add Crate Bundle rule type and fixed-₱-per-kg discount toggle to promo authoring"
```

---

## Task 5: Promo management display — `src/pages/manager/Promos.jsx`

**Files:**
- Modify: `src/pages/manager/Promos.jsx`

**Interfaces:**
- Consumes: `formatPromoRuleDiscount` (Task 2, `utils/promo.js`) — new import.

- [ ] **Step 1: Import `formatPromoRuleDiscount`**

Find this file's existing import from `'../../utils/promo'` (it already imports
`expandPromoRuleRows` per the codebase grep — confirm the exact existing import line by opening
the file's import block, then add `formatPromoRuleDiscount` to that same import statement.)

- [ ] **Step 2: Managing panel rules table — use the formatter**

At `src/pages/manager/Promos.jsx:1631`:

```jsx
                        <td className="px-3 py-2">{formatPromoRuleDiscount(r)}</td>
```

- [ ] **Step 3: Lint and build**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors.

Run: `cd pos-frontend && npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add pos-frontend/src/pages/manager/Promos.jsx
git commit -m "feat(promos): show fixed-₱/kg and crate bundle discounts correctly in the rules table"
```

---

## Task 6: POS crate bundle entry — new `CrateBundleModal.jsx` + `POS.jsx` wiring

**Files:**
- Create: `src/components/pos/CrateBundleModal.jsx`
- Modify: `src/pages/POS.jsx`

**Interfaces:**
- Consumes: `money` from `utils/format.js` (already used elsewhere in this component family, see
  `WeightModal.jsx`); `Eyebrow`, `Field`, `Modal`, `PrimaryButton` from `components/ui`
  (same imports `WeightModal.jsx` already uses).
- Produces: `CrateBundleModal({ set, products, close, add })` where `set` is one entry from
  `collectPromoQuickSets()`'s new `'crate_bundle'` output (Task 2) — `{ name, discountPct,
  products: [{ productId, productName }] }` — and `add(weightsByProductId)` is called with
  `{ [productId]: weightNumber }` for every product in the set.

- [ ] **Step 1: Create `CrateBundleModal.jsx`**

```jsx
// pos-frontend/src/components/pos/CrateBundleModal.jsx
import { useState } from 'react'
import { Eyebrow, Field, Modal, PrimaryButton } from '../ui'
import { money } from '../../utils/format'

/** Cashier enters the weight of each crate in a Crate Bundle rule, then all products are
 * added to the cart at once, tagged with a shared promoGroupId — the same addItem(product,
 * weight, { promoGroup }) path the BOGO/pair/bundle quick-add tiles already use. */
function CrateBundleModal({ set, products, close, add }) {
  const items = set.products
    .map((p) => products.find((prod) => prod.id === p.productId))
    .filter(Boolean)
  const [weights, setWeights] = useState(() => Object.fromEntries(items.map((p) => [p.id, ''])))

  const setWeight = (id, value) => setWeights((prev) => ({ ...prev, [id]: value }))

  const combinedTotal = items.reduce(
    (sum, p) => sum + (Number(weights[p.id]) || 0) * Number(p.price || 0),
    0,
  )
  const discountAmount = combinedTotal * (Number(set.discountPct || 0) / 100)
  const allEntered = items.every((p) => Number(weights[p.id]) > 0)

  const handleAdd = () => {
    const weightsByProductId = {}
    for (const p of items) weightsByProductId[p.id] = Number(weights[p.id]) || 0
    add(weightsByProductId)
  }

  return (
    <Modal onClose={close}>
      <Eyebrow>CRATE BUNDLE</Eyebrow>
      <h2 className="mb-[5px] text-[22px]">{set.name}</h2>
      <p className="text-[13px] text-brand-muted">{set.discountPct}% off combined weight</p>

      <div className="mt-5 flex flex-col gap-3">
        {items.map((p, idx) => (
          <Field
            key={p.id}
            label={`${p.name} · weight (kg)`}
            autoFocus={idx === 0}
            inputMode="decimal"
            value={weights[p.id]}
            onChange={(e) => setWeight(p.id, e.target.value.replace(/[^\d.]/g, ''))}
          />
        ))}
      </div>

      {combinedTotal > 0 && (
        <p className="mt-3 mb-0 text-xs text-brand-subtle">
          Combined: {money(combinedTotal)} · Discount: {money(discountAmount)}
        </p>
      )}

      <PrimaryButton className="mt-4" disabled={!allEntered} onClick={handleAdd}>
        Add to cart · {money(combinedTotal - discountAmount)}
      </PrimaryButton>
    </Modal>
  )
}

export default CrateBundleModal
```

(The `·` above is a literal middle-dot, same character already used elsewhere in this file
family, e.g. `WeightModal.jsx:16`'s `"per kilogram"` line — copy it as-is.)

- [ ] **Step 2: `POS.jsx` — import the new modal**

Near the existing `import WeightModal from '../components/pos/WeightModal'` (line 6):

```jsx
import WeightModal from '../components/pos/WeightModal'
import CrateBundleModal from '../components/pos/CrateBundleModal'
```

- [ ] **Step 3: `POS.jsx` — new state**

Near `const [weighted, setWeighted] = useState(null)` (line 74):

```jsx
  const [weighted, setWeighted] = useState(null)
  const [crateBundleSet, setCrateBundleSet] = useState(null)
```

- [ ] **Step 4: `POS.jsx` — quick-set tile click routes crate bundles to the modal**

At `src/pages/POS.jsx:637`, change the tile's `onClick`:

```jsx
                      onClick={() => (set.type === 'crate_bundle' ? setCrateBundleSet(set) : addPromoQuickSet(set))}
```

- [ ] **Step 5: `POS.jsx` — render the modal, wire `add` to `addItem`**

Near the existing `WeightModal` render block (`src/pages/POS.jsx:986-994`), add a sibling block:

```jsx
      {weighted && !tillClosed && (
        <WeightModal
          product={weighted}
          close={() => setWeighted(null)}
          add={(weight) => {
            addItem(weighted, weight)
            setWeighted(null)
          }}
        />
      )}
      {crateBundleSet && !tillClosed && (
        <CrateBundleModal
          set={crateBundleSet}
          products={products}
          close={() => setCrateBundleSet(null)}
          add={(weightsByProductId) => {
            const group = { id: newPromoGroupId(), type: 'crate_bundle_pct', name: crateBundleSet.name }
            for (const p of crateBundleSet.products) {
              const product = products.find((item) => item.id === p.productId)
              const weight = weightsByProductId[p.productId]
              if (product && weight > 0) addItem(product, weight, { promoGroup: group })
            }
            setCrateBundleSet(null)
          }}
        />
      )}
```

(Match this to whatever the existing `WeightModal` block's exact surrounding JSX looks like at
that point in the file — insert the new block as its sibling, don't restructure what's there.)

- [ ] **Step 6: `POS.jsx` — close the search popup while the crate bundle modal is open**

At `src/pages/POS.jsx:352-356`:

```jsx
  useEffect(() => {
    if (cartOverlayOpen || awaitingPriceApproval || priceTarget || weighted || inquiryProduct || crateBundleSet) {
      setSearchPopupOpen(false)
    }
  }, [cartOverlayOpen, awaitingPriceApproval, priceTarget, weighted, inquiryProduct, crateBundleSet])
```

- [ ] **Step 7: Lint and build**

Run: `cd pos-frontend && npm run lint`
Expected: no new errors.

Run: `cd pos-frontend && npm run build`
Expected: succeeds.

- [ ] **Step 8: Commit**

```bash
git add pos-frontend/src/components/pos/CrateBundleModal.jsx pos-frontend/src/pages/POS.jsx
git commit -m "feat(pos): add Crate Bundle weight-entry modal wired to the promo quick-set tile"
```

---

## Task 7: Documentation — `docs/CODEMAP.md`

**Files:**
- Modify: `pos-frontend/docs/CODEMAP.md` (the "Manager Promo events (item/pair/bundle/BOGO)"
  section starting at line 2475, and the "Promo discount % is capped at 99" bullet at line 2594)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Fix the stale `collectPromoBundles` reference**

At `CODEMAP.md:2578-2584` ("POS bundle quick-add buttons"), `collectPromoBundles()` is described
as what wires `POS.jsx`'s bundle tiles, but that function has zero call sites — the live
mechanism is `collectPromoQuickSets()` + `promoQuickSets`/`addPromoQuickSet()` in `POS.jsx`
(verified during this feature's investigation, 2026-08-22). Rewrite that bullet to name the
correct functions.

- [ ] **Step 2: Document the two new capabilities**

Add a new bullet after the "Promo discount % is capped at 99" bullet (`CODEMAP.md:2594-2600`),
covering (in CODEMAP's existing terse documentation style, matching the surrounding bullets):
- `crate_bundle_pct` rule type: kg-only products, presence-based (not FIFO unit-matching like
  `bundle_pct`) — % off the full available weight of every configured product once all are
  present in the cart, entered via the new `CrateBundleModal.jsx` reached from the same
  quick-set tile row as BOGO/pair/bundle.
- `discount_type` on `item_pct`: `'pct'` (unchanged default) or `'fixed_amount'` (flat ₱ off per
  kg, kg-priced products only), clamped at runtime to the unit price so a line can never go
  negative.
- Update the rule-type heading itself from "Manager Promo events (item/pair/bundle/BOGO)" to
  "Manager Promo events (item/pair/bundle/BOGO/crate bundle)".

- [ ] **Step 3: Commit**

```bash
git add pos-frontend/docs/CODEMAP.md
git commit -m "docs: document crate bundle rule type and fixed-per-kg discount; fix stale collectPromoBundles reference"
```

---

## Task 8: Manual end-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Apply the Task 1 migration to your dev Supabase project (if not already done)**

- [ ] **Step 2: Start the dev server**

Run: `cd pos-frontend && npm run dev`

- [ ] **Step 3: Manager flow — create a Crate Bundle rule**

Log in as a manager. Go to Promos → Create promo, pick a branch. Add a rule: Rule type =
"Crate Bundle % off", enter a bundle name (e.g. "Pork Crate Combo"), pick 2 kg-priced products,
set 10% discount. Confirm the product picker only shows kg-priced products. Submit and approve
the promo (or use a manager account that auto-activates, per this repo's existing dual-control
flow).

- [ ] **Step 4: Manager flow — create a fixed-₱/kg rule**

Add another promo rule: Rule type = "Individual item % off", toggle to "₱ off per kg", confirm
the product picker narrows to kg-priced products only, pick one, set ₱5. Submit/approve.

- [ ] **Step 5: POS flow — ring up the Crate Bundle**

Go to POS, select the branch with the new promo. Confirm a "Crate Bundle" tile appears in the
Promos category quick-set row. Tap it — confirm the new modal opens with one weight field per
product. Enter e.g. 15 and 12. Confirm the combined total / discount preview updates live. Add
to cart. Confirm both lines appear in the cart grouped under the bundle name, and the discount
shown matches 10% of the combined weighted total.

- [ ] **Step 6: POS flow — ring up the fixed-₱/kg item**

Add the kg-priced product from Step 4 to the cart via a normal weight entry (not the crate
bundle flow). Confirm its line shows a ₱5/kg discount, not a percent.

- [ ] **Step 7: Regression check — existing rule types unaffected**

If any existing `item_pct`/`pair_pct`/`bundle_pct`/`bogo_pct` promo is active in your dev data,
ring one up too and confirm its math is unchanged from before this feature.

- [ ] **Step 8: Edge case — fixed discount clamp**

Create a fixed-₱/kg rule with an amount larger than the product's price (e.g. ₱9999). Ring it up
in POS. Confirm the line discounts down to ₱0.00, never negative.

- [ ] **Step 9: Receipt / Transactions check**

Complete both sales. Open Transactions → the completed sale → confirm the promo breakdown panel
shows sensible line items for both the crate bundle and the fixed-amount discount.

---

## Open item — version bump

Per `CLAUDE.md`, this is a MINOR version bump (new capability, no existing behavior changed)
with a `CHANGELOG.md` entry in the same commit as the change. The project's explicit rule is
that the version is only bumped when the user accepts it — ask the user now that implementation
is verified, rather than bumping automatically.
