/** Build sold / restock snapshot for day-end close + next-day alerts. */

import { rowBusinessDate } from './format'

function bumpSold(map, key, patch) {
  const prev = map.get(key) || {
    productId: patch.productId,
    name: patch.name,
    sku: patch.sku || '',
    pricingMode: patch.pricingMode || 'pc',
    qty: 0,
    revenue: 0,
  }
  prev.qty = Number((prev.qty + Number(patch.qty || 0)).toFixed(3))
  prev.revenue = Number((prev.revenue + Number(patch.revenue || 0)).toFixed(2))
  map.set(key, prev)
}

/**
 * @param {{
 *   date: string,
 *   transactions?: object[],
 *   soldItemRows?: object[],
 *   products?: object[],
 *   isRestaurant?: boolean,
 *   dayOpenHour?: number,
 * }} args
 *
 * `date` is a BUSINESS date, so `transactions` are matched with
 * `rowBusinessDate(row, dayOpenHour)` rather than their calendar `date` field — see that
 * helper for why the two differ and why comparing them directly loses money either side of
 * midnight. `soldItemRows` (from `fetchSoldLineItems`) is expected to already be narrowed to
 * this business day by the caller (DayEnd.jsx does the same buffer-then-`rowBusinessDate`
 * narrowing fetchBranchCashImpact uses) — this function does not re-filter it, so a caller
 * that passes an unscoped list will get an unscoped `sold` breakdown back.
 */
export function buildDayEndReport({
  date,
  transactions = [],
  soldItemRows = [],
  products = [],
  isRestaurant = false,
  dayOpenHour = undefined,
}) {
  const inDay = (row) => rowBusinessDate(row, dayOpenHour) === date
  const paid = (transactions || []).filter((txn) => txn.status === 'Paid' && inDay(txn))
  const orderCount = paid.length
  const revenue = Number(
    paid.reduce((sum, txn) => sum + Number(txn.netTotal ?? txn.total ?? 0), 0).toFixed(2),
  )
  const refunded = Number(
    paid.reduce((sum, txn) => sum + Number(txn.refundedAmount || 0), 0).toFixed(2),
  )

  // `revenue` on each row is line_total — what was actually charged, immune to a later
  // price edit — sourced from transaction_items directly (fetchSoldLineItems), not
  // stock_movements: that log survives a debug transaction reset and would keep counting
  // deleted test sales as if they sold today.
  const productById = Object.fromEntries((products || []).map((p) => [p.id, p]))
  const soldMap = new Map()
  ;(soldItemRows || []).forEach((row) => {
    if (!row.quantity || !row.productId) return
    const product = productById[row.productId]
    bumpSold(soldMap, row.productId, {
      productId: row.productId,
      name: product?.name || 'Product',
      sku: product?.sku || '',
      pricingMode: product?.pricingMode || 'pc',
      qty: row.quantity,
      revenue: row.revenue,
    })
  })

  const sold = [...soldMap.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)

  let restock = []
  if (!isRestaurant) {
    restock = (products || [])
      .map((product) => {
        const soldQty = soldMap.get(product.id)?.qty || 0
        const onHand = Number(product.stock ?? 0)
        const lowStockAt = Number(product.lowStockAt ?? 5)
        // Today's report flags restock only for items that actually sold today — a product
        // sitting low on stock without any sales today is carry-over inventory noise, not
        // something today's sales report should surface.
        const needsRestock = soldQty > 0 && onHand <= lowStockAt * 1.5
        if (!needsRestock) return null
        const suggestedQty = Number(Math.max(lowStockAt * 2 - onHand, soldQty, 0).toFixed(2))
        return {
          productId: product.id,
          name: product.name,
          sku: product.sku || '',
          pricingMode: product.pricingMode || 'pc',
          soldQty,
          onHand,
          lowStockAt,
          suggestedQty,
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.onHand - b.onHand || b.soldQty - a.soldQty)
  }

  return {
    businessDate: date,
    orderCount,
    revenue,
    refunded,
    sold,
    restock,
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Live "needs restock" list computed straight from current stock — no dependency on a
 * previous closed day-end existing, or on the item having sold that day.
 *
 * `previousDayRestockReport` below is a frozen snapshot from the last close, so it stays
 * blank until a branch has closed at least one full day, and even then only surfaces items
 * that both sold AND are low — real low stock that didn't move the day before never
 * showed up. Callers use this as the fallback so the dashboard card is never silently
 * empty for a brand-new branch (or any day one's close hasn't landed yet).
 */
export function liveRestockReport(products = []) {
  const restock = (products || [])
    .filter((product) => {
      const onHand = Number(product.stock ?? 0)
      const lowStockAt = Number(product.lowStockAt ?? 5)
      return onHand <= lowStockAt
    })
    .map((product) => {
      const onHand = Number(product.stock ?? 0)
      const lowStockAt = Number(product.lowStockAt ?? 5)
      return {
        productId: product.id,
        name: product.name,
        sku: product.sku || '',
        pricingMode: product.pricingMode || 'pc',
        onHand,
        lowStockAt,
        suggestedQty: Number(Math.max(lowStockAt * 2 - onHand, 0).toFixed(2)),
      }
    })
    .sort((a, b) => a.onHand - b.onHand)
  return { businessDate: null, orderCount: 0, revenue: 0, refunded: 0, sold: [], restock }
}

/** Latest closed day before today that has a restock list (next-morning alert). */
export function previousDayRestockReport(dayEnds = [], todayDate) {
  const rows = (dayEnds || [])
    .filter(
      (entry) =>
        entry.status === 'closed' &&
        entry.date &&
        entry.date < todayDate &&
        Array.isArray(entry.dayReport?.restock) &&
        entry.dayReport.restock.length > 0,
    )
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return rows[0] || null
}

/**
 * Normalize a day-end report from a database or local entry.
 * @param {Object} raw - The raw day-end report data.
 * @return {Object|null} The normalized report, or `null` for invalid input.
 */
export function mapDayReport(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    businessDate: raw.businessDate || raw.business_date || null,
    orderCount: Number(raw.orderCount ?? raw.order_count ?? 0),
    revenue: Number(raw.revenue ?? 0),
    sold: Array.isArray(raw.sold) ? raw.sold : [],
    restock: Array.isArray(raw.restock) ? raw.restock : [],
    refunded: Number(raw.refunded ?? 0),
    generatedAt: raw.generatedAt || raw.generated_at || null,
  }
}
