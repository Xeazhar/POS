import { lineTotal } from './ulam'

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

export function buildPromoByProductId(rules = [], eventName = '') {
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
          eventName: eventName || '',
        })
      }
    }
  }
  return map
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

export function promoBadgeLabel(info) {
  if (!info) return null
  if (info.ruleType === 'item_pct') return `${info.discountPct}% OFF`
  if (info.ruleType === 'bogo_pct') return `Buy ${info.buyQty} Get ${info.getQty}`
  if (info.ruleType === 'pair_pct') return `Pair ${info.discountPct}%`
  if (info.ruleType === 'bundle_pct') return `Bundle ${info.discountPct}%`
  return 'PROMO'
}

function lineQtyForPromo(item, { allowKg = false } = {}) {
  if (item.pricingMode === 'kg') {
    // item_% applies to weighed lines; pair/bundle/bogo stay piece-based
    return allowKg ? Number(item.weight || 0) : 0
  }
  return Number(item.quantity || 0)
}

function normalizeRuleType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
}

/**
 * Auto-apply active promo rules to cart lines.
 * Returns { lineDiscounts, promoDiscountAmount } or null.
 */
export function computePromoDiscounts(items = [], promoRules = []) {
  if (!promoRules?.length || !items?.length) return null

  const lineDiscounts = items.map(() => 0)

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

  const allocateUnitsForProduct = (productId, skuHint, unitsToDiscount, discountAmountPerUnitFn, allowKg) => {
    const indices = indicesForProduct(productId, skuHint)
    let remaining = unitsToDiscount
    for (const idx of indices) {
      if (remaining <= 0) break
      const q = lineQtyForPromo(items[idx], { allowKg })
      if (q <= 0) continue
      const take = Math.min(q, remaining)
      lineDiscounts[idx] = Number((lineDiscounts[idx] + discountAmountPerUnitFn(idx, take)).toFixed(2))
      remaining -= take
    }
  }

  for (const rule of promoRules) {
    const ruleType = normalizeRuleType(rule.ruleType || rule.rule_type)
    const pct = Number(rule.discountPct ?? rule.discount_pct ?? 0) / 100
    if (pct <= 0) continue

    const products = rule.products || []
    if (!products.length) continue

    if (ruleType === 'item_pct') {
      for (const p of products) {
        const productId = p.productId || p.product_id
        for (const idx of indicesForProduct(productId, p.sku)) {
          // Applies to piece and weighed lines
          lineDiscounts[idx] = Number((lineDiscounts[idx] + lineTotal(items[idx]) * pct).toFixed(2))
        }
      }
      continue
    }

    if (ruleType === 'pair_pct') {
      const [a, b] = products
      const idA = a?.productId || a?.product_id
      const idB = b?.productId || b?.product_id
      if (!idA || !idB) continue
      const idxsA = indicesForProduct(idA, a?.sku)
      const idxsB = indicesForProduct(idB, b?.sku)
      const totalA = idxsA.reduce((s, idx) => s + lineQtyForPromo(items[idx]), 0)
      const totalB = idxsB.reduce((s, idx) => s + lineQtyForPromo(items[idx]), 0)
      const pairs = Math.min(totalA, totalB)
      if (pairs <= 0) continue
      const perUnit = (idx, take) => Number(items[idx]?.price ?? 0) * take * pct
      allocateUnitsForProduct(idA, a?.sku, pairs, perUnit, false)
      allocateUnitsForProduct(idB, b?.sku, pairs, perUnit, false)
      continue
    }

    if (ruleType === 'bundle_pct') {
      if (products.length < 2) continue
      const totals = products.map((p) =>
        indicesForProduct(p.productId || p.product_id, p.sku).reduce(
          (s, idx) => s + lineQtyForPromo(items[idx]),
          0,
        ),
      )
      const bundles = Math.min(...totals)
      if (!(bundles > 0)) continue
      const perUnit = (idx, take) => Number(items[idx]?.price ?? 0) * take * pct
      for (const p of products) {
        allocateUnitsForProduct(p.productId || p.product_id, p.sku, bundles, perUnit, false)
      }
      continue
    }

    if (ruleType === 'bogo_pct') {
      const p = products[0]
      const productId = p?.productId || p?.product_id
      if (!productId && !p?.sku) continue
      const idxs = indicesForProduct(productId, p?.sku)
      const total = idxs.reduce((s, idx) => s + lineQtyForPromo(items[idx]), 0)
      if (total <= 0) continue
      const buyQty = Number(rule.buyQty ?? rule.buy_qty ?? 1)
      const getQty = Number(rule.getQty ?? rule.get_qty ?? 1)
      const group = buyQty + getQty
      if (group <= 0) continue
      const fullGroups = Math.floor(total / group)
      const remainder = total % group
      const freeUnits = fullGroups * getQty + Math.max(0, remainder - buyQty)
      if (freeUnits <= 0) continue
      const perUnit = (idx, take) => Number(items[idx]?.price ?? 0) * take * pct
      allocateUnitsForProduct(productId, p?.sku, freeUnits, perUnit, false)
    }
  }

  for (let i = 0; i < lineDiscounts.length; i += 1) {
    const maxDiscount = lineTotal(items[i])
    lineDiscounts[i] = Math.min(lineDiscounts[i], maxDiscount)
  }

  const promoDiscountAmount = Number(lineDiscounts.reduce((sum, v) => sum + v, 0).toFixed(2))
  return promoDiscountAmount > 0 ? { lineDiscounts, promoDiscountAmount } : null
}
