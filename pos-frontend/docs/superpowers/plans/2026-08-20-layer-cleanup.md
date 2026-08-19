# UI/Business-Logic Layer Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move business logic (money math, validation rules, duplicated formulas) that currently lives inline inside `src/pages/*` / `src/components/*` files out into `src/utils/*` (or, where genuinely duplicated across two files, a shared exported function), so the UI layer only renders and calls store actions / utils functions — per the layering rule now documented in `docs/CODEMAP.md`.

**Architecture:** No new files, no new layer. Follows the codebase's existing `src/utils/*` convention (`format.js`, `validate.js`, `promo.js`, `vat.js`, `ulam.js`, `terminalReports.js`). Every task is a **behavior-preserving extraction** unless explicitly marked otherwise — same inputs must produce byte-identical outputs before and after, verified by manually tracing one concrete example through the old and new code.

**Tech Stack:** React + Vite, Zustand stores, no test framework (verify via `npm run lint`, `npm run build`, manual trace — see Global Constraints).

**Spec:** This plan was scoped directly in conversation (see chat history for the full audit) — no separate spec doc; the audit findings and their risk classification below stand in for one.

## Global Constraints

- No automated test suite exists in this repo. Every task's verification step is: (1) `npm run lint` clean, (2) `npm run build` clean, (3) a manual trace of one concrete example input through the OLD code and the NEW code, written out in the task, confirming identical output. Do not invent test files.
- Do NOT run `git commit`. Leave changes staged/unstaged for the user to review and commit manually.
- Every task except Task 10 (SupervisorCatalogAdopt stock tone) is a pure refactor: **do not change any computed value, formatting string, error message text, or control flow** — only move code and update call sites/imports.
- New business logic goes in `src/utils/*` (pure functions) unless it needs live store state, per `docs/CODEMAP.md`'s layer rule. Do not create new files unless a task says to — extend the existing `utils/*.js` file that already owns that domain (validate.js for validation rules, promo.js for promo math, vat.js for checkout money, format.js for everything else).
- `src/pages/**` and `src/components/**` already have an ESLint `no-restricted-imports` rule blocking direct `src/lib/supabase` imports (done in a prior task, not part of this plan) — nothing here should trip it.
- **Explicitly out of scope — do not touch, even if it looks like duplication:**
  - `DayEnd.jsx`'s three "expected cash" formulas (`shiftStore.js` `localCashPosition`, `DayEnd.jsx` `shiftExpectedCash`, `DayEnd.jsx` `expectedCash`) — these are intentionally different per-scope calculations (offline single-shift / online single-shift / day-wide), each with extensive comments explaining why. Unifying them would change real BIR cash-reconciliation output.
  - `Overview.jsx`'s client-side fallback aggregation (lines ~216-237, ~282-305) — a deliberate resilience fallback for when the manager-overview RPC is unavailable, not a layering mistake.
  - `ShiftGate.jsx`'s shift-start eligibility logic — genuinely belongs in `shiftStore.js` per the layering rule, but gates real drawer/shift creation and needs its own dedicated read-and-plan pass, not a bundled mechanical move. Flag as follow-up, do not include here.
  - `Staff.jsx`'s `shiftStatus`/`auditStaffChange`/staff-code helpers and `Branches.jsx`'s `DAY_END_CUTOFF_HOUR`/`dayNotEnded` — already isolated as named module-level functions outside their component bodies (matching this codebase's existing convention, e.g. `DayEnd.jsx`'s `shiftExpectedCash`), single-file use only, no cross-file duplication. Moving them to `utils/*` would be an abstraction with no reuse benefit — leave as-is.
  - `ManagerNetworkCatalog.jsx`'s `saveEditor` batch SKU-duplicate check — has different semantics from a single-item duplicate check (must dedupe against a running "already processed in this batch" set), not a drop-in reuse of `findProductDuplicate`.

---

## Task 1: Dedupe change calculation in Cart.jsx

**Files:**
- Modify: `src/utils/vat.js`
- Modify: `src/components/pos/Cart.jsx:457, 1174`

**Interfaces:**
- Produces: `computeChange(tendered, total)` — exported from `src/utils/vat.js`.

- [ ] **Step 1: Add `computeChange` to `src/utils/vat.js`**

Add near the bottom of the file, before `function round2`:

```js
/** Change owed on a cash sale — never negative even if tendered is short. */
export function computeChange(tendered, total) {
  return Math.max(0, Number(tendered || 0) - Number(total || 0))
}
```

- [ ] **Step 2: Use it in Cart.jsx**

Add `computeChange` to the existing `from '../../utils/vat'` import in `Cart.jsx` (currently `computeVatBreakdown, VAT_RATE_DEFAULT` — check the exact import line near the top of the file first).

Replace line 457:
```js
const change = Math.max(0, cash - payTotal)
```
with:
```js
const change = computeChange(cash, payTotal)
```

Replace line 1174:
```js
{money(Math.max(0, Number(tendered || 0) - payTotal))}
```
with:
```js
{money(computeChange(tendered, payTotal))}
```

- [ ] **Step 3: Verify**

Trace: `cash=500, payTotal=320` → old `Math.max(0, 500-320)=180`; new `computeChange(500,320)=180`. Same for the live-display case with `tendered=''` (old: `Math.max(0, 0-320)=0`; new: `computeChange('',320)=0`).

Run `npm run lint` and `npm run build` — both must be clean.

- [ ] **Step 4: Commit** — leave changes for the user to commit; do not run `git commit`.

---

## Task 2: Extract checkout-readiness rule (`canPay`) from Cart.jsx

**Files:**
- Modify: `src/utils/vat.js`
- Modify: `src/components/pos/Cart.jsx:367-374`

**Interfaces:**
- Consumes: nothing new.
- Produces: `canCompleteSale(params)` — exported from `src/utils/vat.js`.

- [ ] **Step 1: Add `canCompleteSale` to `src/utils/vat.js`**

```js
/** Whether Complete Sale can be pressed right now — till open, cart non-empty, tender/reference/ID-note requirements met per payment method and discount type. */
export function canCompleteSale({
  tillClosed,
  itemCount,
  paying,
  paymentMethod,
  tendered,
  payTotal,
  paymentReference,
  discountType,
  discountIdNote,
}) {
  const needsCash = paymentMethod === 'cash'
  return (
    !tillClosed &&
    itemCount > 0 &&
    !paying &&
    (needsCash ? Number(tendered) >= payTotal : true) &&
    (paymentMethod !== 'ewallet' || String(paymentReference).trim().length > 0) &&
    (!(discountType === 'pwd' || discountType === 'senior') || String(discountIdNote).trim().length > 0)
  )
}
```

- [ ] **Step 2: Use it in Cart.jsx**

Add `canCompleteSale` to the `utils/vat` import. Replace lines 368-374:
```js
const canPay =
  !tillClosed &&
  items.length > 0 &&
  !paying &&
  (needsCash ? Number(tendered) >= payTotal : true) &&
  (paymentMethod !== 'ewallet' || String(paymentReference).trim().length > 0) &&
  (!(discountType === 'pwd' || discountType === 'senior') || String(discountIdNote).trim().length > 0)
```
with:
```js
const canPay = canCompleteSale({
  tillClosed,
  itemCount: items.length,
  paying,
  paymentMethod,
  tendered,
  payTotal,
  paymentReference,
  discountType,
  discountIdNote,
})
```
Leave the `const needsCash = paymentMethod === 'cash'` line above it in place — it's used elsewhere in the file for rendering (grep `needsCash` in Cart.jsx to confirm other uses before deciding whether to keep or remove; if unused elsewhere, remove it since `canCompleteSale` now computes its own copy internally).

- [ ] **Step 3: Verify**

Trace one true case (cash, tendered ≥ total, till open, cart non-empty) and one false case (ewallet with empty reference) through old inline expression vs new `canCompleteSale(...)` call — same boolean both times.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 3: Extract day-end nudge timing rule from Cart.jsx

**Files:**
- Modify: `src/utils/format.js`
- Modify: `src/components/pos/Cart.jsx:376-393, 551`

**Interfaces:**
- Produces: `shouldNudgeDayEnd(dayOpenHour)`, `dayEndNudgeMessage(dayOpenHour)` — exported from `src/utils/format.js`. `formatOpenHourLabel` already exists in this file — reuse it, do not duplicate.

- [ ] **Step 1: Add both functions to `src/utils/format.js`**

Add near `formatOpenHourLabel` (find it first with grep to place these next to it):

```js
/** Soft nudge window: last 2h before typical close (open+14h), or after 8pm, or after 10pm on an overnight-close schedule. */
export function shouldNudgeDayEnd(dayOpenHour) {
  const hour = new Date().getHours()
  const open = Number(dayOpenHour ?? 7)
  const closeHour = (open + 14) % 24
  if (hour >= 20) return true
  if (closeHour > open) return hour >= closeHour - 2
  return hour >= 22
}

export function dayEndNudgeMessage(dayOpenHour) {
  const open = Number(dayOpenHour ?? 7)
  const closeHour = (open + 14) % 24
  const closeLabel = formatOpenHourLabel(closeHour)
  const now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `It's ${now}. Typical day-end is around ${closeLabel} (or after 8:00 PM). Close the till when you're ready.`
}
```

- [ ] **Step 2: Use them in Cart.jsx**

Delete the local `shouldNudgeDayEnd`/`dayEndNudgeMessage` function definitions (lines 376-393). Add `shouldNudgeDayEnd, dayEndNudgeMessage` to the existing `utils/format` import.

At line 551 (`if (shouldNudgeDayEnd() && !isManagerRole(user?.role)) {`), change the call to pass the arg: `if (shouldNudgeDayEnd(dayOpenHour) && !isManagerRole(user?.role)) {`. Search the file for any other call sites of `shouldNudgeDayEnd()` or `dayEndNudgeMessage()` and update them the same way (add `dayOpenHour` arg) — there may be a usage that renders the message text somewhere in the nudge banner JSX; find it with grep before editing.

- [ ] **Step 3: Verify**

Trace with `dayOpenHour=7` at `hour=21` (old inline: `hour>=20` → true; new: `shouldNudgeDayEnd(7)` → true). Trace the message string for the same inputs — identical text.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 4: Dedupe cart quantity-step rule between Cart.jsx and posStore.js

**Files:**
- Modify: `src/utils/validate.js`
- Modify: `src/components/pos/Cart.jsx:580-598`
- Modify: `src/stores/posStore.js:455-471`

**Interfaces:**
- Produces: `nextCartQuantity(item, delta)` → `{ next: number, shouldRemove: boolean }`, exported from `src/utils/validate.js`.

This is a real duplicate: `Cart.jsx`'s `bumpQty` and `posStore.js`'s `adjustQuantity` each independently compute "next weight/qty, is it ≤ 0" with the same 0.1kg-step rule. Unifying removes the duplicate, not just moves it.

- [ ] **Step 1: Add `nextCartQuantity` to `src/utils/validate.js`**

```js
/** Next cart-line quantity for a +/- tap: 0.1kg steps for weighed items, whole units otherwise. shouldRemove is true when the step would take the line to zero or below. */
export const nextCartQuantity = (item, delta) => {
  if (item?.pricingMode === 'kg') {
    const next = Number((Number(item.weight || 0) + Number(delta) * 0.1).toFixed(3))
    return { next, shouldRemove: next <= 0 }
  }
  const next = Number(item?.quantity || 0) + Number(delta)
  return { next, shouldRemove: next <= 0 }
}
```

- [ ] **Step 2: Use it in `posStore.js`'s `adjustQuantity`**

Replace lines 455-471:
```js
adjustQuantity: (index, delta) => set((state) => {
  const item = state.items[index]
  if (!item) return state
  // kg lines: adjust weight by 0.1 kg steps
  if (item.pricingMode === 'kg') {
    const nextWeight = Number((Number(item.weight || 0) + Number(delta) * 0.1).toFixed(3))
    if (nextWeight <= 0) return state // removal handled separately (needs supervisor)
    return {
      items: state.items.map((row, i) => (i === index ? { ...row, weight: nextWeight } : row)),
    }
  }
  const nextQty = Number(item.quantity || 0) + Number(delta)
  if (nextQty <= 0) return state
  return {
    items: state.items.map((row, i) => (i === index ? { ...row, quantity: nextQty } : row)),
  }
}),
```
with:
```js
adjustQuantity: (index, delta) => set((state) => {
  const item = state.items[index]
  if (!item) return state
  const { next, shouldRemove } = nextCartQuantity(item, delta)
  if (shouldRemove) return state // removal handled separately (needs supervisor)
  const field = item.pricingMode === 'kg' ? 'weight' : 'quantity'
  return {
    items: state.items.map((row, i) => (i === index ? { ...row, [field]: next } : row)),
  }
}),
```
Add `nextCartQuantity` to `posStore.js`'s existing `from '../utils/validate'` import — check whether `posStore.js` already imports anything from `utils/validate`; if not, add a new import line near the other `utils/*` imports (it currently imports from `utils/errors`, `utils/withTimeout`, `utils/format`, `utils/roles`, `utils/ulam`).

- [ ] **Step 3: Use it in `Cart.jsx`'s `bumpQty`**

Replace lines 580-598:
```js
const bumpQty = (index, delta) => {
  const item = items[index]
  if (!item) return
  if (item.pricingMode === 'kg') {
    const next = Number(item.weight || 0) + delta * 0.1
    if (next <= 0) {
      requestRemove(index)
      return
    }
    adjustQuantity(index, delta)
    return
  }
  const next = Number(item.quantity || 0) + delta
  if (next <= 0) {
    requestRemove(index)
    return
  }
  adjustQuantity(index, delta)
}
```
with:
```js
const bumpQty = (index, delta) => {
  const item = items[index]
  if (!item) return
  const { shouldRemove } = nextCartQuantity(item, delta)
  if (shouldRemove) {
    requestRemove(index)
    return
  }
  adjustQuantity(index, delta)
}
```
Add `nextCartQuantity` to Cart.jsx's `utils/validate` import (check whether it already imports from there first; if not, add the import line).

- [ ] **Step 4: Verify**

Trace a kg item at `weight=0.05, delta=-1`: old → `next = 0.05 - 0.1 = -0.05 ≤ 0` → remove. New → `nextCartQuantity` → `next = -0.050, shouldRemove: true` → same. Trace a piece item at `quantity=1, delta=1`: old → `adjustQuantity(index,1)` sets quantity to 2. New → same path, same result.

Run `npm run lint` and `npm run build`.

- [ ] **Step 5: Commit** — leave for user.

---

## Task 5: Move promo proportional-split math out of Cart.jsx

**Files:**
- Modify: `src/utils/promo.js`
- Modify: `src/components/pos/Cart.jsx:224-259`

**Interfaces:**
- Produces: `promoEntryGross(entry, items)`, `promoEntryDiscount(entry, items, lineDiscounts)`, `promoEntryNet(entry, items, lineBreakdown)`, `promoGroupGross(group, items)`, `promoGroupDiscount(group, items, lineDiscounts)`, `promoGroupNet(group, items, lineBreakdown)` — all exported from `src/utils/promo.js`. Uses the already-imported `lineTotal` from `./ulam` (top of `promo.js`).

- [ ] **Step 1: Add the functions to `src/utils/promo.js`**

Add near the other export functions (after `expandPromoRuleRows` is fine):

```js
function promoEntryUnits(item) {
  return item?.pricingMode === 'kg' ? Number(item.weight || 0) : Number(item.quantity || 0)
}

/** Cart-checkout display: gross/discount/net share of a promo-group entry, prorated by unit count against the line's own total. */
export function promoEntryGross(entry, items) {
  const item = items[entry.lineIndex]
  if (!item) return 0
  const units = promoEntryUnits(item)
  if (!(units > 0)) return 0
  return (lineTotal(item) / units) * Number(entry.units || 0)
}

export function promoEntryDiscount(entry, items, lineDiscounts) {
  const item = items[entry.lineIndex]
  if (!item) return 0
  const units = promoEntryUnits(item)
  if (!(units > 0)) return 0
  return ((lineDiscounts[entry.lineIndex] || 0) / units) * Number(entry.units || 0)
}

export function promoEntryNet(entry, items, lineBreakdown) {
  const item = items[entry.lineIndex]
  if (!item) return 0
  const units = promoEntryUnits(item)
  if (!(units > 0)) return 0
  const net = Number(lineBreakdown[entry.lineIndex]?.netAmount ?? lineTotal(item))
  return (net / units) * Number(entry.units || 0)
}

export function promoGroupGross(group, items) {
  return group.entries.reduce((sum, entry) => sum + promoEntryGross(entry, items), 0)
}

export function promoGroupDiscount(group, items, lineDiscounts) {
  return group.entries.reduce((sum, entry) => sum + promoEntryDiscount(entry, items, lineDiscounts), 0)
}

export function promoGroupNet(group, items, lineBreakdown) {
  return group.entries.reduce((sum, entry) => sum + promoEntryNet(entry, items, lineBreakdown), 0)
}
```

Note: `promoEntryUnits` deliberately does NOT reuse the existing private `lineDisplayUnits` in this file — that one defaults non-kg quantity to `1` when falsy; Cart.jsx's original `lineUnits` defaults to `0`. Keep them separate; do not merge.

- [ ] **Step 2: Use them in Cart.jsx**

Delete lines 224-259 (`lineUnits`, `entryGross`, `entryDiscount`, `entryNet`, `groupGross`, `groupDiscount`, `groupNet`). Replace with:
```js
const entryGross = (entry) => promoEntryGross(entry, items)
const entryDiscount = (entry) => promoEntryDiscount(entry, items, pricing.lineDiscounts)
const entryNet = (entry) => promoEntryNet(entry, items, pricing.lineBreakdown)
const groupGross = (group) => promoGroupGross(group, items)
const groupDiscount = (group) => promoGroupDiscount(group, items, pricing.lineDiscounts)
const groupNet = (group) => promoGroupNet(group, items, pricing.lineBreakdown)
```
Add `promoEntryGross, promoEntryDiscount, promoEntryNet, promoGroupGross, promoGroupDiscount, promoGroupNet` to Cart.jsx's existing `from '../../utils/promo'` import (currently `buildCartDisplayGroups, computePromoDiscounts`).

Before deleting, grep the file for any other reference to the local `lineUnits(` (not `promoEntryUnits`) to confirm nothing else in Cart.jsx calls it — if something does, keep a local `const lineUnits = (item) => ...` wrapper instead of deleting.

- [ ] **Step 3: Verify**

Pick one promo-group entry from a real cart scenario (e.g. a bundle line at 2 units out of a 5-unit line) and trace `entryGross`/`entryDiscount`/`entryNet` through both the old inline arrow functions and the new util calls — same numbers.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 6: Extract price-override bounds validation from POS.jsx

**Files:**
- Modify: `src/utils/validate.js`
- Modify: `src/pages/POS.jsx:292-298`

**Interfaces:**
- Produces: `isValidPriceOverride(value)` — exported from `src/utils/validate.js`.

Do NOT add this validation to `src/lib/api.js`'s `updateProductPrice` — the data layer must not hold business rules (see `docs/CODEMAP.md`'s layer rule); the validation belongs at the UI call site, which is exactly where it already runs today, just inline instead of via a named util.

- [ ] **Step 1: Add `isValidPriceOverride` to `src/utils/validate.js`**

```js
export const isValidPriceOverride = (value) => Number.isFinite(Number(value)) && Number(value) >= 0
```

- [ ] **Step 2: Use it in POS.jsx**

Replace lines 294-297:
```js
const next = Number(priceValue)
if (!Number.isFinite(next) || next < 0) {
  setPriceError('Enter a valid price.')
  return
}
```
with:
```js
const next = Number(priceValue)
if (!isValidPriceOverride(next)) {
  setPriceError('Enter a valid price.')
  return
}
```
Add `isValidPriceOverride` to POS.jsx's `utils/validate` import (check if one already exists in the file; add if not).

- [ ] **Step 3: Verify**

Trace `priceValue="-5"` → old: `next=-5`, `!Number.isFinite(-5) || -5<0` → true → error. New: `isValidPriceOverride(-5)` → false → `!false` → true → error. Trace `priceValue="45.50"` → both pass.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 7: Dedupe `netTotal` formula between api.js and TransactionDetailModal.jsx

**Files:**
- Modify: `src/utils/format.js`
- Modify: `src/lib/api.js:252`
- Modify: `src/components/transactions/TransactionDetailModal.jsx:22-25`

**Interfaces:**
- Produces: `netAfterRefund(total, refundedAmount)` — exported from `src/utils/format.js`.

- [ ] **Step 1: Add `netAfterRefund` to `src/utils/format.js`**

```js
/** Sale total minus what's been refunded off it, floored at 0. */
export function netAfterRefund(total, refundedAmount) {
  return Math.max(0, Number((Number(total || 0) - Number(refundedAmount || 0)).toFixed(2)))
}
```

- [ ] **Step 2: Use it in `src/lib/api.js`**

At line 252, replace:
```js
netTotal: Math.max(0, Number((total - refundedAmount).toFixed(2))),
```
with:
```js
netTotal: netAfterRefund(total, refundedAmount),
```
Add `netAfterRefund` to `api.js`'s import from `./utils/format` if one exists, otherwise add `import { netAfterRefund } from '../utils/format'` near the top (check `api.js`'s existing import block for the right relative path and whether a `utils/format` import already exists to extend instead).

- [ ] **Step 3: Use it in TransactionDetailModal.jsx**

Replace lines 22-25:
```js
const netTotal =
  detail?.netTotal != null && !refundSummary
    ? Number(detail.netTotal)
    : Math.max(0, Number((originalTotal - refundTotal).toFixed(2)))
```
with:
```js
const netTotal =
  detail?.netTotal != null && !refundSummary
    ? Number(detail.netTotal)
    : netAfterRefund(originalTotal, refundTotal)
```
Add `netAfterRefund` to the existing `import { money, qty } from '../../utils/format'` line (already present at the top of this file).

- [ ] **Step 4: Verify**

Trace `total=1000, refundedAmount=250` → old `Math.max(0, 750.00)=750`; new `netAfterRefund(1000,250)=750`. Trace `refundedAmount=1200` (over-refund edge case) → old `Math.max(0,-200)=0`; new same.

Run `npm run lint` and `npm run build`.

- [ ] **Step 5: Commit** — leave for user.

---

## Task 8: Consolidate product-draft field validation

**Files:**
- Modify: `src/utils/validate.js`
- Modify: `src/pages/Products.jsx:271-292`
- Modify: `src/components/catalog/ManagerNetworkCatalog.jsx:314-337`

**Interfaces:**
- Produces: `validateProductDraft(draft, options)` — exported from `src/utils/validate.js`. Validates only field-shape (name/sku required, barcode format, price/budget-price bounds, optional stock) — duplicate-detection stays separate in each caller (they check against different lists — branch `products` vs network `catalog` — with different fields, so unifying that part would change behavior).

- [ ] **Step 1: Add `validateProductDraft` to `src/utils/validate.js`**

```js
/**
 * Field-shape validation shared by the branch product form (Products.jsx) and the network
 * catalog form (ManagerNetworkCatalog.jsx). Does NOT check for duplicates — the two callers
 * check against different lists (branch products vs network catalog) and the caller is
 * responsible for that check itself.
 */
export const validateProductDraft = (
  { name, sku, barcode, price, budgetPrice, stock },
  { isRestaurant = false, requireStock = true } = {},
) => {
  const cleanName = sanitizeText(name)
  const cleanSku = sanitizeText(sku)
  const cleanBarcode = digitsOnly(barcode)
  if (!cleanName || !cleanSku) return 'Name and SKU are required.'
  if (!isRestaurant && !cleanBarcode) return 'Name, SKU, and barcode are required.'
  if (cleanBarcode && !/^\d+$/.test(cleanBarcode)) return 'Barcode must contain numbers only.'
  if (price === '' || Number(price) < 0) return 'Enter a valid price.'
  if (
    isRestaurant &&
    budgetPrice !== '' &&
    budgetPrice != null &&
    (Number.isNaN(Number(budgetPrice)) || Number(budgetPrice) < 0)
  ) {
    return 'Enter a valid budget price (or leave blank).'
  }
  if (requireStock && !isRestaurant && (stock === '' || Number.isNaN(Number(stock)))) {
    return 'Enter a valid stock amount.'
  }
  return null
}
```

- [ ] **Step 2: Use it in Products.jsx**

Replace lines 271-292 (`validateForm`):
```js
const validateForm = () => {
  const name = sanitizeText(form.name)
  const sku = sanitizeText(form.sku)
  const barcode = digitsOnly(form.barcode)
  if (!name || !sku) return 'Name and SKU are required.'
  if (!isRestaurant && !barcode) return 'Name, SKU, and barcode are required.'
  if (barcode && !/^\d+$/.test(barcode)) return 'Barcode must contain numbers only.'
  if (form.price === '' || Number(form.price) < 0) return 'Enter a valid price.'
  if (
    isRestaurant &&
    form.budgetPrice !== '' &&
    (Number.isNaN(Number(form.budgetPrice)) || Number(form.budgetPrice) < 0)
  ) {
    return 'Enter a valid budget price (or leave blank).'
  }
  if (!isRestaurant && (form.stock === '' || Number.isNaN(Number(form.stock)))) {
    return 'Enter a valid stock amount.'
  }
  const duplicate = findProductDuplicate(products, { name, sku, barcode }, selected)
  if (duplicate) return `Duplicate ${duplicateField(duplicate, { name, sku, barcode })} already exists.`
  return null
}
```
with:
```js
const validateForm = () => {
  const fieldError = validateProductDraft(form, { isRestaurant, requireStock: true })
  if (fieldError) return fieldError
  const name = sanitizeText(form.name)
  const sku = sanitizeText(form.sku)
  const barcode = digitsOnly(form.barcode)
  const duplicate = findProductDuplicate(products, { name, sku, barcode }, selected)
  if (duplicate) return `Duplicate ${duplicateField(duplicate, { name, sku, barcode })} already exists.`
  return null
}
```
Add `validateProductDraft` to the existing `from '../utils/validate'` import block (line 40-47).

- [ ] **Step 3: Use it in ManagerNetworkCatalog.jsx**

Replace lines 318-337 (the field-check block inside `saveNew`, everything from `if (!name || !sku)` through the budget-price check — NOT the SKU-duplicate check that follows at lines 338-342, leave that alone):
```js
if (!name || !sku) {
  setFormError('Name and SKU are required.')
  return
}
if (!isRestaurant && !barcode) {
  setFormError('Name, SKU, and barcode are required for retail goods.')
  return
}
if (form.price === '' || Number(form.price) < 0) {
  setFormError('Enter a valid price.')
  return
}
if (
  isRestaurant &&
  form.budgetPrice !== '' &&
  (Number.isNaN(Number(form.budgetPrice)) || Number(form.budgetPrice) < 0)
) {
  setFormError('Enter a valid budget price (or leave blank).')
  return
}
```
with:
```js
const fieldError = validateProductDraft(form, { isRestaurant, requireStock: false })
if (fieldError) {
  setFormError(fieldError)
  return
}
```
**Careful:** the original messages differ slightly between the two files ("Name, SKU, and barcode are required." vs "...required for retail goods.") — `validateProductDraft` standardizes on Products.jsx's wording. Confirm with the user this message-text change is acceptable, or keep `setFormError` calls with the original text by having `validateProductDraft` return a message key instead of full text if exact wording must be preserved. Default to accepting the standardized wording since it's cosmetic (this is the one intentional textual change in this task — call it out in the task's completion note).

Add `validateProductDraft` to ManagerNetworkCatalog.jsx's existing `from '../../utils/validate'` import (line 55).

- [ ] **Step 4: Verify**

Trace an empty-name draft through both files' old and new validation — same rejection point (just possibly different wording per the note above). Trace a fully valid restaurant-mode draft (no barcode, no stock field) through ManagerNetworkCatalog's new path — must pass (requireStock:false matters here).

Run `npm run lint` and `npm run build`.

- [ ] **Step 5: Commit** — leave for user.

---

## Task 9: Fix Products.jsx menu-kind→category mapping to reuse `categoryForMenuKind`

**Files:**
- Modify: `src/pages/Products.jsx:855-873`

**Interfaces:**
- Consumes: `categoryForMenuKind` from `src/utils/ulam.js` (already exists, already correctly used by `ManagerNetworkCatalog.jsx`).

- [ ] **Step 1: Replace the inline ternary chain**

Replace lines 855-873:
```jsx
onChange={(e) => {
  const kind = e.target.value
  setForm((prev) => ({
    ...prev,
    menuKind: kind,
    category:
      kind === 'meat'
        ? 'Meat'
        : kind === 'veggie'
          ? 'Veggie'
          : kind === 'pancit'
            ? 'Pancit'
            : kind === 'drink'
              ? 'Drink'
              : kind === 'rice'
                ? 'Rice'
                : 'Extra',
  }))
}}
```
with:
```jsx
onChange={(e) => {
  const kind = e.target.value
  setForm((prev) => ({
    ...prev,
    menuKind: kind,
    category: categoryForMenuKind(kind, prev.category),
  }))
}}
```
Add `categoryForMenuKind` to Products.jsx's imports — check if `src/utils/ulam.js` is already imported in this file; if not, add `import { categoryForMenuKind } from '../utils/ulam'`.

- [ ] **Step 2: Verify**

Trace `kind='drink'` through the old ternary chain (→ `'Drink'`) and through `categoryForMenuKind('drink', prev.category)` (map lookup → `'Drink'`) — same result for all six kinds (meat/veggie/pancit/drink/rice/extra + unrecognized → fallback).

Run `npm run lint` and `npm run build`.

- [ ] **Step 3: Commit** — leave for user.

---

## Task 10: Fix stock-tone divergence in SupervisorCatalogAdopt.jsx (bug fix, not pure refactor)

**Files:**
- Modify: `src/components/catalog/SupervisorCatalogAdopt.jsx:130-147`

**Interfaces:**
- Consumes: `stockTone` from `src/utils/format.js` (canonical: `low` at `stock <= lowStockAt ?? 5`, `fair` at `stock <= lowAt*2`, else `good`).

**This one intentionally changes behavior** — the current code references a `product.mediumStockAt` field that doesn't exist anywhere in the schema (always `undefined`, so the "fair" threshold is silently hardcoded to `stock <= 30` for every product), and defaults `lowStockAt` to `10` instead of the canonical `5` used everywhere else (`format.js`, `Products.jsx`). This makes the same product classify differently on this screen vs. everywhere else. Fixing it converges the classification — call this out to the user as a behavior change, not a no-op refactor.

- [ ] **Step 1: Replace the inline tone calculation**

Find the block (around lines 136-141):
```js
? 'out'
: Number(product.stock) <= Number(product.lowStockAt || 10)
  ? 'low'
  : Number(product.stock) <= Number(product.mediumStockAt || 30)
    ? 'fair'
    : 'good'
```
(this sits inside a larger ternary starting a few lines above it — read the full surrounding block first with the exact line numbers before editing, since the `? 'out'` continues a condition from an earlier line).

Replace the whole `tone` computation with:
```js
const tone = Number(product.stock) <= 0 ? 'out' : stockTone(product)
```
placed as a standalone `const` above wherever the ternary currently sits, then use `tone` in place of the ternary expression at that point.

- [ ] **Step 2: Import `stockTone`**

Check whether `SupervisorCatalogAdopt.jsx` already imports from `../../utils/format`; if so add `stockTone` to that import, otherwise add `import { stockTone } from '../../utils/format'`.

- [ ] **Step 3: Verify**

Trace a product with `stock=8, lowStockAt=null` (no explicit threshold set): OLD → `lowStockAt||10 = 10`, `8<=10` → `'low'`. NEW → `stockTone` uses `lowAt ?? 5` → `5`, `8<=5` false, `8<=10` (fair, `5*2`) → `'fair'`. **This is the exact classification change being fixed** — document it in the task's completion note so it's visible in review, not silently absorbed.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 11: Dedupe Shrinkage category gate in Products.jsx

**Files:**
- Modify: `src/utils/validate.js`
- Modify: `src/pages/Products.jsx:350, 803`

**Interfaces:**
- Produces: `isShrinkageAllowed(category)` — exported from `src/utils/validate.js`.

- [ ] **Step 1: Add to `src/utils/validate.js`**

```js
/** Shrinkage is a meat-counter-only stock-adjustment reason. */
export const isShrinkageAllowed = (category) => category === 'Meat'
```

- [ ] **Step 2: Use it in Products.jsx**

At line 350, replace:
```js
if (action === 'Shrinkage' && form.category !== 'Meat') {
```
with:
```js
if (action === 'Shrinkage' && !isShrinkageAllowed(form.category)) {
```

At line 803, replace:
```jsx
{form.category === 'Meat' && <option>Shrinkage</option>}
```
with:
```jsx
{isShrinkageAllowed(form.category) && <option>Shrinkage</option>}
```
Add `isShrinkageAllowed` to Products.jsx's `utils/validate` import.

- [ ] **Step 3: Verify**

Trace `form.category='Meat'` and `form.category='Groceries'` through both call sites, old vs new — identical results.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 12: Extract stock-delta math from Products.jsx's `commitAdjust`

**Files:**
- Modify: `src/utils/format.js`
- Modify: `src/pages/Products.jsx:364-366`

**Interfaces:**
- Produces: `applyStockDelta(currentStock, signedAmount)` — exported from `src/utils/format.js`.

- [ ] **Step 1: Add to `src/utils/format.js`**

```js
/** New stock level after a signed restock/adjustment/shrinkage delta, rounded to 2 decimals. */
export function applyStockDelta(currentStock, signedAmount) {
  return Number((Number(currentStock || 0) + Number(signedAmount || 0)).toFixed(2))
}
```

- [ ] **Step 2: Use it in Products.jsx**

Replace line 366:
```js
const stock = Number((product.stock + signed).toFixed(2))
```
with:
```js
const stock = applyStockDelta(product.stock, signed)
```
Add `applyStockDelta` to Products.jsx's `utils/format` import (line ~36).

- [ ] **Step 3: Verify**

Trace `product.stock=12.5, signed=-3.25` → old `(12.5-3.25).toFixed(2)=9.25`; new `applyStockDelta(12.5,-3.25)=9.25`.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 13: Move `validatePromoDates` out of PromoEditorModal.jsx

**Files:**
- Modify: `src/utils/promo.js`
- Modify: `src/components/promos/PromoEditorModal.jsx:140-151`

**Interfaces:**
- Produces: `validatePromoDates(startsAt, endsAt, options)` — exported from `src/utils/promo.js`. Verbatim move, no logic change.

- [ ] **Step 1: Add to `src/utils/promo.js`** (verbatim)

```js
export function validatePromoDates(startsAt, endsAt, { allowPastStart = false } = {}) {
  if (!startsAt || !endsAt) return 'Enter a promo duration (Starts at + Ends at).'
  const startDate = new Date(startsAt)
  const endDate = new Date(endsAt)
  if (endDate <= startDate) return 'End date must be after start date.'
  if (!allowPastStart) {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (startDate < today) return 'Start date cannot be in the past.'
  }
  return null
}
```

- [ ] **Step 2: Use it in PromoEditorModal.jsx**

Delete the local `validatePromoDates` function (lines 140-151). Add `validatePromoDates` to the existing `import { expandPromoRuleRows } from '../../utils/promo'` line (now `import { expandPromoRuleRows, validatePromoDates } from '../../utils/promo'`). All existing call sites in this file keep working unchanged since the signature is identical.

- [ ] **Step 3: Verify**

Trace `startsAt='2026-08-01T00:00', endsAt='2026-07-01T00:00'` (end before start) through old and new — same error string.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 14: Extract promo rule-add validation from PromoEditorModal.jsx

**Files:**
- Modify: `src/utils/promo.js`
- Modify: `src/components/promos/PromoEditorModal.jsx:344-376`

**Interfaces:**
- Consumes: `validatePromoRuleDraft` needs `usedProductIdsByType` (a `Map<ruleType, Set<productId>>`, already computed in the component via `useMemo`) passed in as-is.
- Produces: `validatePromoRuleDraft(draft)` → `null` (valid) | `{ message: string }` | `{ duplicateIds: string[] }`, exported from `src/utils/promo.js`. Returns structured duplicate info instead of a formatted message because formatting product names requires `productList`, which only the component has loaded — keep that formatting in the component.

- [ ] **Step 1: Add to `src/utils/promo.js`**

```js
/**
 * Pure validation for adding one rule to a promo being authored. `usedProductIdsByType` is
 * the caller's Map<ruleType, Set<productId>> of products already used by an existing rule of
 * the same type on this promo. Returns null when valid; { message } for a plain error; or
 * { duplicateIds } when the block is a product-already-used-for-this-type conflict — the
 * caller resolves product names to build the final message (this function has no product list).
 */
export function validatePromoRuleDraft({
  ruleType,
  discountPct,
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
  if (discountPct < 0 || discountPct > 100) {
    return { message: 'Discount must be between 0 and 100.' }
  }
  if (ruleType === 'pair_pct' && productA && productB && productA === productB) {
    return { message: 'Pair rule needs two different products.' }
  }
  if (ruleType === 'bundle_pct') {
    if (!bundleName.trim()) return { message: 'Enter a bundle name before adding this rule.' }
    if (bundleSelected.length < 2) return { message: 'Select at least 2 products for a bundle.' }
  }
  const usedForType = usedProductIdsByType.get(ruleType) || new Set()
  const duplicateIds = selectedProductsForRule.filter((id) => usedForType.has(id))
  if (duplicateIds.length) return { duplicateIds }
  return null
}
```

- [ ] **Step 2: Use it in PromoEditorModal.jsx's `handleAddRule`**

Replace lines 344-376 (everything from `setRuleAttempted(true)` through the end of the duplicate-check block, stopping right before `setRuleError('')` / `setBusy(true)`):
```js
const handleAddRule = async () => {
  setRuleAttempted(true)
  if (!selectedProductsForRule.length) {
    setRuleError('Select at least one product for this rule.')
    return
  }
  if (discountPct < 0 || discountPct > 100) {
    setRuleError('Discount must be between 0 and 100.')
    return
  }
  if (ruleType === 'pair_pct' && productA && productB && productA === productB) {
    setRuleError('Pair rule needs two different products.')
    return
  }
  if (ruleType === 'bundle_pct') {
    if (!bundleName.trim()) {
      setRuleError('Enter a bundle name before adding this rule.')
      return
    }
    if (bundleSelected.length < 2) {
      setRuleError('Select at least 2 products for a bundle.')
      return
    }
  }

  const usedForType = usedProductIdsByType.get(ruleType) || new Set()
  const duplicates = selectedProductsForRule.filter((id) => usedForType.has(id))
  if (duplicates.length) {
    setRuleError(
      `${formatProductNames(duplicates)} already ${duplicates.length > 1 ? 'have' : 'has'} a ${RULE_TYPE_LABELS[ruleType] || 'matching'} rule on this promo. Remove the existing rule or pick other products. A different rule type is fine (e.g. also in a pair or bundle).`,
    )
    return
  }
```
with:
```js
const handleAddRule = async () => {
  setRuleAttempted(true)
  const result = validatePromoRuleDraft({
    ruleType,
    discountPct,
    productA,
    productB,
    bundleName,
    bundleSelected,
    selectedProductsForRule,
    usedProductIdsByType,
  })
  if (result?.message) {
    setRuleError(result.message)
    return
  }
  if (result?.duplicateIds) {
    setRuleError(
      `${formatProductNames(result.duplicateIds)} already ${result.duplicateIds.length > 1 ? 'have' : 'has'} a ${RULE_TYPE_LABELS[ruleType] || 'matching'} rule on this promo. Remove the existing rule or pick other products. A different rule type is fine (e.g. also in a pair or bundle).`,
    )
    return
  }
```
(the rest of `handleAddRule` — `setRuleError('')`, `setBusy(true)`, the rule-creation calls — stays unchanged).

Add `validatePromoRuleDraft` to the `utils/promo` import.

- [ ] **Step 3: Verify**

Trace a bundle-type draft with `bundleName=''` → old: caught by the bundle-name check, error set. New: `validatePromoRuleDraft` returns `{message: 'Enter a bundle name...'}`, same error set. Trace a duplicate-product case with 2 conflicting IDs → old and new produce the identical formatted message (same `formatProductNames`/pluralization logic, now fed by `result.duplicateIds` instead of local `duplicates`).

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 15: Hoist `isDuplicateCarry` to module scope in DayEnd.jsx

**Files:**
- Modify: `src/pages/DayEnd.jsx:482-489`

**Interfaces:**
- Produces: module-level `isDuplicateCarry(row, drawerShiftIds)` inside `DayEnd.jsx` (same file — this is NOT cross-file duplication, it's inline-in-component-body logic that should be a named function outside the component, matching this file's own existing convention for `shiftExpectedCash`, `countUnreviewedSelfRecorded`).

- [ ] **Step 1: Add the function at module scope**

Find `shiftExpectedCash` (around line 69) in `DayEnd.jsx` and add this function right after it, carrying over the full explanatory comment currently attached to `isDuplicateCarry` inline (the "A shift that carried its starting cash forward..." block, lines ~462-481):

```js
/**
 * A shift that carried its starting cash forward from another shift OPENED THE SAME
 * BUSINESS DAY is not new money — it is the same drawer contents someone recounted, and
 * those sales are already inside `cashSales` (day-wide, not shift-scoped). Summing its
 * startingCash again double-counted the whole prior shift's takings as a fresh float — most
 * visibly after a manager reopen, where the cashier re-confirms the same cash on hand and
 * that figure becomes the reopened shift's startingCash. A carry from a shift that closed on
 * an EARLIER business date is real: that cash never went through today's cashSales, so it
 * still belongs in today's float — those predecessors are simply absent from `drawerShiftIds`
 * (scoped to today) and nothing here excludes them.
 *
 * The exclusion only holds while startingCash still EQUALS the carried figure — that is the
 * signal that nothing but a recount happened. `carriedAmount` freezes what was carried at
 * shift-open; startingCash can still diverge from it afterward (the cashier adjusts the
 * pre-filled count before starting, or later declares a fresh 'opening_float' cash_movement
 * once the shift opened at ₱0). Either path means this shift's float is no longer "the same
 * drawer contents recounted" but a genuinely different declared amount, so it belongs in the
 * day's float same as any non-carried shift.
 */
function isDuplicateCarry(row, drawerShiftIds) {
  return (
    row.carriedFromShiftId &&
    drawerShiftIds.has(row.carriedFromShiftId) &&
    Math.abs(Number(row.startingCash || 0) - Number(row.carriedAmount || 0)) <= 0.004
  )
}
```

- [ ] **Step 2: Update the call site**

Find the block inside the component (originally around lines 462-489) and replace the inline comment + `const isDuplicateCarry = (row) => ...` definition with nothing (it's now module-level), then update the filter call:
```js
const shiftFloatTotal = drawerShifts
  .filter((row) => !isDuplicateCarry(row))
  .reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
```
becomes:
```js
const shiftFloatTotal = drawerShifts
  .filter((row) => !isDuplicateCarry(row, drawerShiftIds))
  .reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
```
(`drawerShiftIds` is already computed just above this in the component — confirm it's still in scope and defined before this line before editing).

- [ ] **Step 3: Verify**

Trace one carried-shift row and one non-carried row through the old inline arrow function and the new module-level function with the same `drawerShiftIds` set — identical boolean both times.

Run `npm run lint` and `npm run build`.

- [ ] **Step 4: Commit** — leave for user.

---

## Task 16: Dedupe gross-from-discounts formula between DayEnd.jsx and OwnShiftSoFar.jsx

**Files:**
- Modify: `src/utils/format.js`
- Modify: `src/pages/DayEnd.jsx:395`
- Modify: `src/components/dayend/OwnShiftSoFar.jsx:88-90`

**Interfaces:**
- Produces: `grossFromNetAndDiscounts(net, discounts)` — exported from `src/utils/format.js`.

- [ ] **Step 1: Add to `src/utils/format.js`**

```js
/** Pre-discount gross from a net figure and the discounts taken off it — the inverse of netting a discount in. */
export function grossFromNetAndDiscounts(net, discounts) {
  return Number((Number(net || 0) + Number(discounts || 0)).toFixed(2))
}
```

- [ ] **Step 2: Use it in DayEnd.jsx**

Replace line 395:
```js
const cashSalesGross = Number((cashSales + cashDiscounts).toFixed(2))
```
with:
```js
const cashSalesGross = grossFromNetAndDiscounts(cashSales, cashDiscounts)
```
Add `grossFromNetAndDiscounts` to DayEnd.jsx's `utils/format` import (check existing import first — this file likely already imports `today`/`dayEndForBusinessDate` etc. from `../utils/format`, confirm the relative path).

- [ ] **Step 3: Use it in OwnShiftSoFar.jsx**

Replace lines 88-90:
```js
const cashSalesGross = position
  ? Number((Number(position.cashSales || 0) + cashDiscounts).toFixed(2))
  : null
```
with:
```js
const cashSalesGross = position ? grossFromNetAndDiscounts(position.cashSales, cashDiscounts) : null
```
Add `grossFromNetAndDiscounts` to the existing `import { formatShiftDuration, formatShiftWhen, money } from '../../utils/format'` line (line 7).

- [ ] **Step 4: Verify**

Trace `cashSales=8500, cashDiscounts=340` through both old and new in each file — same `8840`.

Run `npm run lint` and `npm run build`.

- [ ] **Step 5: Commit** — leave for user.

---

## Task 17: Dedupe sales-performance aggregation between terminalReports.js and BranchDashboard.jsx

**Files:**
- Modify: `src/utils/terminalReports.js`
- Modify: `src/pages/manager/BranchDashboard.jsx:601-621`

**Interfaces:**
- Produces: `sumGrossAndDiscounts(transactions)` → `{ gross, discounts }`, `sumRefunds(transactions)` → `number`, `sumVoided(voidedTransactions)` → `number` — all exported from `src/utils/terminalReports.js`. Field-name tolerant (`total_amount ?? total`, `discount_amount ?? discountAmount`, `refunded_amount ?? refundedAmount`) so both the snake_case server rows `buildTerminalReportData` receives and the camelCase-mapped rows `BranchDashboard.jsx` receives work unchanged.

`BranchDashboard.jsx`'s existing comment above this block already says "Same reductions terminalReports.js uses... reused rather than re-derived so this row and a printed reading for the same day can never quietly disagree" — this task makes that comment true; today the code re-derives instead of reusing.

- [ ] **Step 1: Add the three functions to `src/utils/terminalReports.js`**

Add them above `buildTerminalReportData` (which starts at line 116):

```js
export function sumGrossAndDiscounts(transactions = []) {
  const gross = transactions.reduce(
    (s, t) => s + Number(t.total_amount ?? t.total ?? 0) + Number(t.discount_amount ?? t.discountAmount ?? 0),
    0,
  )
  const discounts = transactions.reduce(
    (s, t) => s + Number(t.discount_amount ?? t.discountAmount ?? 0),
    0,
  )
  return { gross, discounts }
}

export function sumRefunds(transactions = []) {
  return transactions.reduce((s, t) => s + Number(t.refunded_amount ?? t.refundedAmount ?? 0), 0)
}

export function sumVoided(voidedTransactions = []) {
  return voidedTransactions.reduce((s, t) => s + Number(t.total_amount ?? t.total ?? 0), 0)
}
```

- [ ] **Step 2: Use them inside `buildTerminalReportData` itself**

Read lines 139-159 in full first (the exact current code — offsets may have shifted slightly from the audit). Replace the `grossSales`/`totalDisc` reduces with:
```js
const { gross: grossSales, discounts: totalDisc } = sumGrossAndDiscounts(completed)
```
Replace the `refund` reduce with:
```js
const refund = sumRefunds(completed)
```
Replace the `voidAmt` reduce with:
```js
const voidAmt = sumVoided(voided)
```
Leave `dailySales`, `vat`, and `taxable` exactly as they are — they're not part of this dedup (different formulas, not shared with BranchDashboard.jsx).

- [ ] **Step 3: Use them in BranchDashboard.jsx**

Replace lines 601-621 (`todaySalesPerformanceItems`):
```js
const todaySalesPerformanceItems = [
  {
    label: 'Gross sales',
    value: money(todayTx.reduce((sum, t) => sum + Number(t.total || 0) + Number(t.discountAmount || 0), 0)),
  },
  {
    label: 'Discounts',
    value: money(todayTx.reduce((sum, t) => sum + Number(t.discountAmount || 0), 0)),
    tone: 'danger',
  },
  {
    label: 'Refunds',
    value: money(todayTx.reduce((sum, t) => sum + Number(t.refundedAmount || 0), 0)),
    tone: 'danger',
  },
  {
    label: 'Voided sales',
    value: money(todayVoided.reduce((sum, t) => sum + Number(t.total || 0), 0)),
    tone: 'danger',
  },
]
```
with:
```js
const { gross: todayGross, discounts: todayDiscounts } = sumGrossAndDiscounts(todayTx)
const todaySalesPerformanceItems = [
  { label: 'Gross sales', value: money(todayGross) },
  { label: 'Discounts', value: money(todayDiscounts), tone: 'danger' },
  { label: 'Refunds', value: money(sumRefunds(todayTx)), tone: 'danger' },
  { label: 'Voided sales', value: money(sumVoided(todayVoided)), tone: 'danger' },
]
```
Add `import { sumGrossAndDiscounts, sumRefunds, sumVoided } from '../../utils/terminalReports'` to `BranchDashboard.jsx` (check it doesn't already import from `terminalReports.js` under a different name first — if it does, extend that import instead of adding a new line).

- [ ] **Step 4: Verify**

Trace 3 sample transactions (2 paid with different discount amounts, 1 voided) through the OLD inline reduces in both files and the NEW shared functions — identical gross/discounts/refunds/voided totals in both call sites.

Run `npm run lint` and `npm run build`.

- [ ] **Step 5: Commit** — leave for user.

---

## Task 18: Dedupe shift-duration calculation between Staff.jsx and BranchDashboard.jsx

**Files:**
- Modify: `src/utils/format.js`
- Modify: `src/pages/manager/Staff.jsx:182-194`
- Modify: `src/pages/manager/BranchDashboard.jsx:137-142`

**Interfaces:**
- Produces: `shiftDurationMs(row, options)` — exported from `src/utils/format.js`. `options.openEndsAt` defaults to `Date.now()` (an open shift counts up to now).

- [ ] **Step 1: Add to `src/utils/format.js`**

```js
/** Milliseconds a shift row covers — an open shift (no clockOut) counts up to `openEndsAt` (default: now). Returns 0 for a missing/invalid clockIn or a clockOut before clockIn. */
export function shiftDurationMs(row, { openEndsAt = Date.now() } = {}) {
  const start = row.clockIn ? new Date(row.clockIn).getTime() : NaN
  if (Number.isNaN(start)) return 0
  const end = row.clockOut ? new Date(row.clockOut).getTime() : openEndsAt
  return end > start ? end - start : 0
}
```

- [ ] **Step 2: Use it in Staff.jsx**

Replace lines 182-194 (`totalHoursLabel`):
```js
function totalHoursLabel(shifts = []) {
  let ms = 0
  for (const row of shifts) {
    const start = row.clockIn ? new Date(row.clockIn).getTime() : NaN
    if (Number.isNaN(start)) continue
    // An open shift counts up to now, otherwise today's hours read as zero all day.
    const end = row.clockOut ? new Date(row.clockOut).getTime() : Date.now()
    if (end > start) ms += end - start
  }
  if (ms <= 0) return '—'
  const mins = Math.round(ms / 60000)
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}
```
with:
```js
function totalHoursLabel(shifts = []) {
  const ms = shifts.reduce((sum, row) => sum + shiftDurationMs(row), 0)
  if (ms <= 0) return '—'
  const mins = Math.round(ms / 60000)
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}
```
Add `shiftDurationMs` to Staff.jsx's `utils/format` import (find the existing import line first).

- [ ] **Step 3: Use it in BranchDashboard.jsx's `rollUpStaffHours`**

Replace lines 137-142:
```js
const start = row.clockIn ? new Date(row.clockIn).getTime() : NaN
const end = row.clockOut ? new Date(row.clockOut).getTime() : NaN
// An open shift counts up to now — otherwise today's hours read as zero all day.
const stop = Number.isNaN(end) ? Date.now() : end
const duration = !Number.isNaN(start) && stop > start ? stop - start : 0
entry.totalMs += duration
```
with:
```js
entry.totalMs += shiftDurationMs(row)
```
Add `shiftDurationMs` to BranchDashboard.jsx's `utils/format` import (check the existing import for this file first).

Leave the rest of `rollUpStaffHours` (the `todayMs`/`openNow`/`lastIn`/`lastOut` bookkeeping) exactly as-is — only the duration sub-calculation is shared.

- [ ] **Step 4: Verify**

Trace an open shift (`clockIn` set, `clockOut` null) and a closed shift through both files' old and new code — same millisecond duration both times (open-shift-counts-to-now behavior preserved in both).

Run `npm run lint` and `npm run build`.

- [ ] **Step 5: Commit** — leave for user.

---

## Final Step: Update CODEMAP.md if any task deviated

If any task above required a different approach than written (e.g. an import path didn't match, a line range had shifted), note the actual change — no CODEMAP update should be needed since this plan doesn't change the layer rule itself, only enforces it, but double check `docs/CODEMAP.md`'s "Layer boundaries (enforced)" section (added in a prior task) still accurately describes the codebase after these 18 tasks.

- [ ] Run `npm run lint` once more from a clean state after all 18 tasks to confirm the total problem count hasn't grown from the 86 pre-existing baseline (documented in this session before this plan started).
- [ ] Run `npm run build` once more to confirm the production bundle still compiles.
