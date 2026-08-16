import { lineTotal } from './ulam'
import { newUuidClientId } from '../offline/queueTypes'

/** Helpers for active promo display on POS tiles and cart lines. */

export function isPromoDiscountType(type) {
  const t = String(type || '')
    .trim()
    .toLowerCase()
  return Boolean(t) && t !== 'pwd' && t !== 'senior'
}

export function discountSourceLabel(type) {
  if (!type) return null
  if (String(type).toLowerCase() === 'pwd') return 'PWD'
  if (String(type).toLowerCase() === 'senior') return 'Senior'
  return String(type)
}

/** POS tile highlight / strike price — item % only; set-based promos use quick-add or plain tiles. */
export function isItemPercentPromo(info) {
  return normalizeRuleType(info?.ruleType) === 'item_pct'
}

/**
 * Build a productId -> best-offer map from a flat list of rules pulled from
 * one or more live promo events. Each rule should carry its own `eventName`
 * (attach it when flattening events together) so ties resolve per-product.
 * When several rules/events target the same product, the highest % wins —
 * offers never stack on the same product.
 */
export function buildPromoByProductId(rules = [], fallbackEventName = '') {
  const map = new Map()
  for (const rule of rules || []) {
    const pct = Number(rule.discountPct || 0)
    for (const p of rule.products || []) {
      const productId = p.productId
      if (!productId) continue
      const existing = map.get(productId)
      if (!existing || pct > Number(existing.discountPct || 0)) {
        map.set(productId, {
          ruleType: rule.ruleType,
          discountPct: pct,
          buyQty: Number(rule.buyQty ?? 1),
          getQty: Number(rule.getQty ?? 1),
          eventName: rule.eventName || fallbackEventName || '',
          bundleName: rule.ruleType === 'bundle_pct' ? rule.bundleName || null : null,
          partners: (rule.products || [])
            .filter((p2) => p2.productId !== productId)
            .map((p2) => ({ productId: p2.productId, productName: p2.productName })),
        })
      }
    }
  }
  return map
}

/**
 * Named bundles ready for a POS quick-add button — one entry per `bundle_pct` rule that
 * was given a name (unnamed bundles are still valid promo rules, they just don't get a
 * button; nothing else here needs a name to work). Each rule already represents one
 * complete bundle (a manager picks its full product set in one rule), so this is a
 * straight filter + reshape, not a cross-rule grouping.
 */
export function collectPromoBundles(rules = []) {
  return collectPromoQuickSets(rules).filter((set) => set.type === 'bundle')
}

/**
 * One-tap promo sets for POS — bundle (named), pair, and BOGO. Rendered as tiles in the
 * Promos grid, not as category chips.
 */
export function collectPromoQuickSets(rules = []) {
  const sets = []
  for (const rule of rules || []) {
    const ruleType = normalizeRuleType(rule.ruleType || rule.rule_type)
    const discountPct = Number(rule.discountPct ?? rule.discount_pct ?? 0)
    const products = (rule.products || [])
      .map((p) => ({
        productId: p.productId || p.product_id,
        productName: p.productName || null,
      }))
      .filter((p) => p.productId)

    if (ruleType === 'bundle_pct' && rule.bundleName && products.length >= 2) {
      const names = products.map((p) => p.productName).filter(Boolean)
      sets.push({
        ruleId: rule.id,
        type: 'bundle',
        name: rule.bundleName,
        discountPct,
        products,
        sublabel: names.join(' · '),
        badge: 'Bundle',
      })
      continue
    }

    if (ruleType === 'pair_pct' && products.length >= 2) {
      const [a, b] = products
      const labelA = a.productName || 'Item A'
      const labelB = b.productName || 'Item B'
      sets.push({
        ruleId: rule.id,
        type: 'pair',
        name: `${labelA} + ${labelB}`,
        discountPct,
        products,
        sublabel: `Pair · ${discountPct}% off`,
        badge: 'Pair',
      })
      continue
    }

    if (ruleType === 'bogo_pct' && products.length >= 1) {
      const buyQty = Number(rule.buyQty ?? rule.buy_qty ?? 1)
      const getQty = Number(rule.getQty ?? rule.get_qty ?? 1)
      const pname = products[0].productName || 'Item'
      sets.push({
        ruleId: rule.id,
        type: 'bogo',
        name: buyQty === 1 && getQty === 1 ? `B1T1 · ${pname}` : `Buy ${buyQty} Get ${getQty} · ${pname}`,
        discountPct,
        buyQty,
        getQty,
        products: [products[0]],
        sublabel:
          buyQty === 1 && getQty === 1
            ? 'Buy 1 take 1'
            : `${buyQty} paid + ${getQty} discounted`,
        badge: buyQty === 1 && getQty === 1 ? 'B1T1' : 'BOGO',
      })
    }
  }
  return sets
}

/** For item_% promos, the per-unit sale price. Other rule types need cart context. */
export function promoUnitPrice(listPrice, info) {
  if (!info || info.ruleType !== 'item_pct') return null
  const pct = Number(info.discountPct || 0)
  if (!(pct > 0)) return null
  const price = Number(listPrice || 0)
  if (!(price > 0)) return null
  return Number((price * (1 - pct / 100)).toFixed(2))
}

export function promoDisplayName(info) {
  return info?.bundleName || info?.eventName || ''
}

export function promoBadgeLabel(info) {
  if (!info) return null
  if (info.ruleType === 'item_pct') return `${info.discountPct}% OFF`
  if (info.ruleType === 'bogo_pct') return `Buy ${info.buyQty} Get ${info.getQty}`
  if (info.ruleType === 'pair_pct') return `Pair ${info.discountPct}%`
  if (info.ruleType === 'bundle_pct') return `Bundle ${info.discountPct}%`
  return 'PROMO'
}

/** Which product(s) this pair/bundle discount needs alongside it — short label + full title. */
export function promoPartnerLabel(info) {
  if (!info?.partners?.length) return null
  if (info.ruleType === 'pair_pct') {
    const name = info.partners[0]?.productName
    return name ? { text: `w/ ${name}`, title: name } : null
  }
  if (info.ruleType === 'bundle_pct') {
    const names = info.partners.map((p) => p.productName).filter(Boolean)
    if (!names.length) return null
    return { text: `+${names.length} item${names.length > 1 ? 's' : ''}`, title: names.join(', ') }
  }
  return null
}

function lineQtyForPromo(item, { allowKg = false } = {}) {
  if (item.pricingMode === 'kg') {
    return allowKg ? Number(item.weight || 0) : 0
  }
  return Number(item.quantity || 0)
}

/** Cart row unit count — must stay aligned with lineTotal() so priced lines always render. */
function lineDisplayUnits(item) {
  if (item.pricingMode === 'kg') return Number(item.weight || 0)
  return Number(item.quantity || 1)
}

function normalizeRuleType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

function isSetBasedRuleType(ruleType) {
  return ruleType === 'pair_pct' || ruleType === 'bundle_pct' || ruleType === 'bogo_pct'
}

function buildIndexMaps(items) {
  const indicesByProductId = {}
  const indicesBySku = {}
  items.forEach((item, idx) => {
    if (!indicesByProductId[item.id]) indicesByProductId[item.id] = []
    indicesByProductId[item.id].push(idx)
    const sku = String(item.sku || '')
      .trim()
      .toLowerCase()
    if (sku) {
      if (!indicesBySku[sku]) indicesBySku[sku] = []
      indicesBySku[sku].push(idx)
    }
  })

  const indicesForProduct = (productId, skuHint = '') => {
    if (productId && indicesByProductId[productId]?.length) return indicesByProductId[productId]
    const sku = String(skuHint || '')
      .trim()
      .toLowerCase()
    if (sku && indicesBySku[sku]?.length) return indicesBySku[sku]
    return []
  }

  return { indicesForProduct }
}

function createLineAllocator(items) {
  const unitsUsed = items.map(() => 0)
  const { indicesForProduct } = buildIndexMaps(items)

  const takeUnits = (productId, skuHint, unitsToTake, { allowKg = false, skipIndices = null } = {}) => {
    const taken = []
    let remaining = unitsToTake
    for (const idx of indicesForProduct(productId, skuHint)) {
      if (remaining <= 0) break
      if (skipIndices?.has(idx)) continue
      const q = lineQtyForPromo(items[idx], { allowKg })
      const available = q - unitsUsed[idx]
      if (available <= 0) continue
      const take = Math.min(available, remaining)
      unitsUsed[idx] += take
      taken.push({ lineIndex: idx, units: take })
      remaining -= take
    }
    return taken
  }

  return { takeUnits, unitsUsed, indicesForProduct }
}

function promoSetDisplayName(rule, ruleType) {
  if (rule.bundleName) return rule.bundleName
  if (ruleType === 'pair_pct') {
    const names = (rule.products || []).map((p) => p.productName).filter(Boolean)
    if (names.length >= 2) return `Pair · ${names[0]} + ${names[1]}`
    return `Pair ${Number(rule.discountPct ?? rule.discount_pct ?? 0)}%`
  }
  if (ruleType === 'bogo_pct') {
    const p = rule.products?.[0]
    const buyQty = Number(rule.buyQty ?? rule.buy_qty ?? 1)
    const getQty = Number(rule.getQty ?? rule.get_qty ?? 1)
    return `Buy ${buyQty} Get ${getQty}${p?.productName ? ` · ${p.productName}` : ''}`
  }
  return rule.eventName || 'Promo set'
}

function formatGroupEntryLabel(item, units) {
  if (item.pricingMode === 'kg') return `${item.name} · ${units.toFixed(2)} kg`
  const n = Number(units)
  return `${item.name} · ${n} ${n === 1 ? 'pc' : 'pcs'}`
}

/**
 * Allocate complete promo sets (pair / bundle / BOGO) from cart lines FIFO.
 * Returns display groups with per-line unit counts — extra qty stays ungrouped.
 */
export function allocatePromoSets(items = [], promoRules = [], { skipIndices = null } = {}) {
  if (!items.length || !promoRules?.length) return []

  const allocator = createLineAllocator(items)
  const sets = []

  for (const rule of promoRules) {
    const ruleType = normalizeRuleType(rule.ruleType || rule.rule_type)
    if (!isSetBasedRuleType(ruleType)) continue

    const products = rule.products || []
    if (!products.length) continue

    if (ruleType === 'pair_pct') {
      const [a, b] = products
      const idA = a?.productId || a?.product_id
      const idB = b?.productId || b?.product_id
      if (!idA || !idB) continue
      while (true) {
        const takenA = allocator.takeUnits(idA, a?.sku, 1, { skipIndices })
        if (!takenA.length) break
        const takenB = allocator.takeUnits(idB, b?.sku, 1, { skipIndices })
        if (!takenB.length) {
          for (const entry of takenA) allocator.unitsUsed[entry.lineIndex] -= entry.units
          break
        }
        const entries = [...takenA, ...takenB]
        sets.push({
          id: newUuidClientId(),
          ruleType,
          name: promoSetDisplayName(rule, ruleType),
          entries,
        })
      }
    } else if (ruleType === 'bundle_pct' && products.length >= 2) {
      while (true) {
        const round = []
        for (const p of products) {
          const taken = allocator.takeUnits(p.productId || p.product_id, p.sku, 1, { skipIndices })
          if (!taken.length) {
            for (const entry of round) allocator.unitsUsed[entry.lineIndex] -= entry.units
            round.length = 0
            break
          }
          round.push(...taken)
        }
        if (!round.length) break
        sets.push({
          id: newUuidClientId(),
          ruleType,
          name: promoSetDisplayName(rule, ruleType),
          entries: round,
        })
      }
    } else if (ruleType === 'bogo_pct') {
      const p = products[0]
      const productId = p?.productId || p?.product_id
      const buyQty = Number(rule.buyQty ?? rule.buy_qty ?? 1)
      const getQty = Number(rule.getQty ?? rule.get_qty ?? 1)
      const group = buyQty + getQty
      if (!group) continue
      while (true) {
        const taken = allocator.takeUnits(productId, p?.sku, group, { skipIndices })
        if (!taken.length) break
        sets.push({
          id: newUuidClientId(),
          ruleType,
          name: promoSetDisplayName(rule, ruleType),
          entries: taken,
        })
      }
    }
  }

  return sets
}

/**
 * Cart display groups: explicit promoGroupId rows first, then auto-detected sets,
 * then remaining qty as normal lines (including partial leftovers from a split line).
 */
export function buildCartDisplayGroups(items = [], promoRules = []) {
  if (!items.length) return []

  const groups = []
  const claimedUnits = items.map(() => 0)

  const byGroupId = new Map()
  items.forEach((item, idx) => {
    if (!item.promoGroupId) return
    if (!byGroupId.has(item.promoGroupId)) {
      byGroupId.set(item.promoGroupId, {
        kind: 'promo',
        id: item.promoGroupId,
        type: item.promoGroupType || 'bundle',
        name: item.promoGroupName || 'Promo bundle',
        entries: [],
      })
    }
    const units = lineDisplayUnits(item)
    byGroupId.get(item.promoGroupId).entries.push({ lineIndex: idx, units })
    claimedUnits[idx] += units
  })
  groups.push(...byGroupId.values())

  const skipIndices = new Set(
    items.map((item, idx) => (item.promoGroupId ? idx : null)).filter((idx) => idx != null),
  )
  for (const set of allocatePromoSets(items, promoRules, { skipIndices })) {
    for (const entry of set.entries) claimedUnits[entry.lineIndex] += entry.units
    groups.push({
      kind: 'promo',
      id: set.id,
      type: set.ruleType,
      name: set.name,
      entries: set.entries,
    })
  }

  items.forEach((item, idx) => {
    const total = lineDisplayUnits(item)
    const remaining = total - claimedUnits[idx]
    if (remaining > 0.0001) {
      groups.push({
        kind: 'line',
        id: `line-${idx}`,
        entries: [{ lineIndex: idx, units: remaining }],
      })
    }
  })

  return groups.map((group) => ({
    ...group,
    sublabel: group.entries
      .map((entry) => formatGroupEntryLabel(items[entry.lineIndex], entry.units))
      .join(', '),
  }))
}

/**
 * Auto-apply active promo rules to cart lines.
 *
 * Set-based rules (pair / bundle / BOGO) run first and consume units FIFO.
 * item_% only discounts units not already consumed by a set rule — so an extra
 * water beside a bundle does not inherit the bundle discount.
 */
export function computePromoDiscounts(items = [], promoRules = []) {
  if (!promoRules?.length || !items?.length) return null

  const lineDiscounts = items.map(() => 0)
  const linePromoNames = items.map(() => null)
  const lineBundleNames = items.map(() => null)
  const unitsUsedPerLine = items.map(() => 0)

  const { indicesForProduct } = buildIndexMaps(items)

  const allocateUnitsForProduct = (
    target,
    productId,
    skuHint,
    unitsToDiscount,
    discountAmountPerUnitFn,
    allowKg,
  ) => {
    const indices = indicesForProduct(productId, skuHint)
    let remaining = unitsToDiscount
    for (const idx of indices) {
      if (remaining <= 0) break
      const q = lineQtyForPromo(items[idx], { allowKg })
      const available = q - unitsUsedPerLine[idx]
      if (available <= 0) continue
      const take = Math.min(available, remaining)
      target[idx] = Number((target[idx] + discountAmountPerUnitFn(idx, take)).toFixed(2))
      unitsUsedPerLine[idx] += take
      remaining -= take
    }
  }

  const appliedEventNames = new Set()
  const setRules = []
  const itemRules = []
  for (const rule of promoRules) {
    const ruleType = normalizeRuleType(rule.ruleType || rule.rule_type)
    if (isSetBasedRuleType(ruleType)) setRules.push(rule)
    else if (ruleType === 'item_pct') itemRules.push(rule)
  }

  const applyRule = (rule) => {
    const ruleType = normalizeRuleType(rule.ruleType || rule.rule_type)
    const pct = Number(rule.discountPct ?? rule.discount_pct ?? 0) / 100
    if (pct <= 0) return

    const products = rule.products || []
    if (!products.length) return

    const ruleDiscounts = items.map(() => 0)

    if (ruleType === 'item_pct') {
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
    }

    for (let i = 0; i < ruleDiscounts.length; i += 1) {
      if (ruleDiscounts[i] > lineDiscounts[i]) {
        lineDiscounts[i] = ruleDiscounts[i]
        linePromoNames[i] = rule.eventName || null
        lineBundleNames[i] = rule.bundleName || null
      }
    }
  }

  for (const rule of setRules) applyRule(rule)
  for (const rule of itemRules) applyRule(rule)

  for (let i = 0; i < lineDiscounts.length; i += 1) {
    const maxDiscount = lineTotal(items[i])
    lineDiscounts[i] = Math.min(lineDiscounts[i], maxDiscount)
    if (lineDiscounts[i] <= 0) {
      linePromoNames[i] = null
      lineBundleNames[i] = null
    }
    if (linePromoNames[i]) appliedEventNames.add(linePromoNames[i])
  }

  const promoDiscountAmount = Number(lineDiscounts.reduce((sum, v) => sum + v, 0).toFixed(2))
  return promoDiscountAmount > 0
    ? {
        lineDiscounts,
        promoDiscountAmount,
        linePromoNames,
        lineBundleNames,
        appliedEventNames: [...appliedEventNames],
      }
    : null
}

const PROMO_RULE_TYPE_LABELS = {
  item_pct: 'Item %',
  pair_pct: 'Pair %',
  bundle_pct: 'Bundle %',
  bogo_pct: 'BOGO %',
}

/**
 * Retrieves the product identifier from a line item.
 * @param {Object} line - The line item containing product information.
 * @return {*} The product ID, or `null` when no ID is available.
 */
function lineProductId(line) {
  return line?.products?.id || line?.product_id || null
}

/**
 * Determines whether a line uses kilogram or piece pricing.
 * @param {Object} line - The line whose product pricing mode is evaluated.
 * @return {string} `kg` for kilogram pricing; `pc` for all other pricing modes.
 */
function linePricingMode(line) {
  return line?.products?.pricing_mode === 'per_kg' ? 'kg' : 'pc'
}

/**
 * Identifies the promotion associated with sold lines.
 * @param {Array<Object>} groupLines - Sold lines belonging to the same promotion group.
 * @param {Array<Object>} rules - Promotion rules used to classify the lines.
 * @returns {{label: string, badge: string, kind: string}} The promotion label, badge, and classification.
 */
function inferPromoOfferMeta(groupLines = [], rules = []) {
  const productIds = [...new Set(groupLines.map(lineProductId).filter(Boolean))]
  const names = [...new Set(groupLines.map((l) => l.products?.name).filter(Boolean))]

  for (const rule of rules || []) {
    const ruleType = normalizeRuleType(rule.ruleType || rule.rule_type)
    const ruleProductIds = (rule.products || [])
      .map((p) => p.productId || p.product_id)
      .filter(Boolean)

    if (ruleType === 'item_pct' && productIds.length === 1 && ruleProductIds.includes(productIds[0])) {
      return {
        label: names[0] || 'Product',
        badge: `Item ${Number(rule.discountPct || 0)}%`,
        kind: 'item_pct',
      }
    }

    if (
      ruleType === 'bundle_pct' &&
      rule.bundleName &&
      ruleProductIds.length >= 2 &&
      ruleProductIds.every((id) => productIds.includes(id))
    ) {
      return { label: rule.bundleName, badge: 'Bundle', kind: 'bundle' }
    }

    if (
      ruleType === 'pair_pct' &&
      ruleProductIds.length >= 2 &&
      productIds.length === 2 &&
      ruleProductIds.every((id) => productIds.includes(id))
    ) {
      const [a, b] = rule.products || []
      return {
        label: `${a?.productName || 'Item A'} + ${b?.productName || 'Item B'}`,
        badge: 'Pair',
        kind: 'pair',
      }
    }

    if (
      ruleType === 'bogo_pct' &&
      ruleProductIds.length >= 1 &&
      productIds.length === 1 &&
      productIds[0] === ruleProductIds[0]
    ) {
      const buyQty = Number(rule.buyQty ?? rule.buy_qty ?? 1)
      const getQty = Number(rule.getQty ?? rule.get_qty ?? 1)
      const pname = names[0] || 'Item'
      if (buyQty === 1 && getQty === 1) {
        return { label: pname, badge: 'Buy 1 take 1', kind: 'bogo' }
      }
      return { label: pname, badge: `Buy ${buyQty} Get ${getQty}`, kind: 'bogo' }
    }
  }

  if (productIds.length >= 2) {
    return { label: names.slice(0, 3).join(' + '), badge: 'Bundle', kind: 'bundle' }
  }
  return { label: names[0] || 'Promo item', badge: 'Promo', kind: 'item' }
}

/**
 * Aggregates quantities and monetary totals for transaction lines.
 * @param {Array<Object>} lines - The transaction lines to aggregate.
 * @returns {{qty: number, gross: number, discount: number, net: number, pricingMode: string}} The rounded quantity, gross amount, discount, net amount, and pricing mode.
 */
function sumLineMoney(lines = []) {
  let gross = 0
  let discount = 0
  let net = 0
  let qty = 0
  let pricingMode = 'pc'
  for (const line of lines) {
    const q = Number(line.quantity || 0)
    const g = Number(line.line_total || 0)
    const d = Number(line.discount_amount || 0)
    gross += g
    discount += d
    net += Math.max(0, g - d)
    qty += q
    if (linePricingMode(line) === 'kg') pricingMode = 'kg'
  }
  return {
    qty: Number(qty.toFixed(3)),
    gross: Number(gross.toFixed(2)),
    discount: Number(discount.toFixed(2)),
    net: Number(net.toFixed(2)),
    pricingMode,
  }
}

/**
 * Aggregates sold lines into promo offer summaries for sales tracking.
 * @param {Array<Object>} lines - Sold transaction lines to aggregate.
 * @param {Array<Object>} rules - Promotion rules used to identify each offer.
 * @returns {Array<Object>} Offer summaries containing sets, quantities, pricing mode, gross amount, discount, and net amount, sorted by discount descending.
 */
export function aggregatePromoSalesOffers(lines = [], rules = []) {
  const setInstances = new Map()
  const singles = new Map()

  for (const line of lines) {
    const txnId = line.transaction_id
    const groupId = line.promo_group_id
    if (groupId && txnId) {
      const key = `${txnId}:${groupId}`
      if (!setInstances.has(key)) setInstances.set(key, [])
      setInstances.get(key).push(line)
      continue
    }

    const productId = lineProductId(line) || 'unknown'
    if (!singles.has(productId)) singles.set(productId, [])
    singles.get(productId).push(line)
  }

  const buckets = new Map()

  const addBucket = (meta, totals, { sets = 0, units = 0, pricingMode = 'pc' }) => {
    const bucketKey = `${meta.kind}:${meta.label}:${meta.badge}`
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        ...meta,
        sets: 0,
        qty: 0,
        pricingMode,
        gross: 0,
        discount: 0,
        net: 0,
      })
    }
    const row = buckets.get(bucketKey)
    row.sets += sets
    row.qty += units
    row.gross += totals.gross
    row.discount += totals.discount
    row.net += totals.net
    if (pricingMode === 'kg') row.pricingMode = 'kg'
  }

  for (const groupLines of setInstances.values()) {
    const meta = inferPromoOfferMeta(groupLines, rules)
    const totals = sumLineMoney(groupLines)
    addBucket(meta, totals, { sets: 1, units: 0, pricingMode: totals.pricingMode })
  }

  for (const groupLines of singles.values()) {
    const meta = inferPromoOfferMeta(groupLines, rules)
    const totals = sumLineMoney(groupLines)
    addBucket(meta, totals, { sets: 0, units: totals.qty, pricingMode: totals.pricingMode })
  }

  return [...buckets.values()]
    .map((row) => ({
      ...row,
      gross: Number(row.gross.toFixed(2)),
      discount: Number(row.discount.toFixed(2)),
      net: Number(row.net.toFixed(2)),
      qty: Number(row.qty.toFixed(3)),
      sets: row.sets,
    }))
    .sort((a, b) => b.discount - a.discount)
}

/**
 * Summarize the rule types associated with a promotion.
 * @param {string[]} ruleTypes - Rule type identifiers to summarize.
 * @return {string} An em dash for no types, the label for one type, or `Mixed` for multiple types.
 */
export function summarizePromoRuleTypes(ruleTypes = []) {
  const unique = [...new Set((ruleTypes || []).filter(Boolean))]
  if (!unique.length) return '—'
  if (unique.length === 1) return PROMO_RULE_TYPE_LABELS[unique[0]] || unique[0]
  return 'Mixed'
}

/**
 * Rules table rows for display. `item_pct` products are independent of each other (no
 * pairing/bundling), so each gets its own row — one row per product, same rule/discount
 * repeated. Pair/bundle/BOGO rules stay a single row: their products are one linked set,
 * not a list of separate discounts.
 */
export function expandPromoRuleRows(rules = []) {
  const rows = []
  for (const r of rules || []) {
    const products = r.products || []
    if (normalizeRuleType(r.ruleType || r.rule_type) === 'item_pct' && products.length > 1) {
      products.forEach((p, idx) => {
        rows.push({
          ...r,
          key: `${r.id || r.localId}-${idx}`,
          products: [p],
          isFirstOfGroup: idx === 0,
          groupSize: products.length,
        })
      })
    } else {
      rows.push({ ...r, key: r.id || r.localId, isFirstOfGroup: true, groupSize: products.length })
    }
  }
  return rows
}
