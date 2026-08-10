/** Build sold / restock snapshot for day-end close + next-day alerts. */

import { rowBusinessDate } from './format'

function lineQty(line) {
  if (!line) return 0
  if (line.pricingMode === 'kg') return Number(line.weight || 0)
  return Number(line.quantity || 0)
}

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
  if (patch.name) prev.name = patch.name
  if (patch.sku) prev.sku = patch.sku
  if (patch.pricingMode) prev.pricingMode = patch.pricingMode
  map.set(key, prev)
}

/**
 * @param {{
 *   date: string,
 *   transactions?: object[],
 *   movements?: object[],
 *   products?: object[],
 *   isRestaurant?: boolean,
 *   dayOpenHour?: number,
 * }} args
 *
 * `date` is a BUSINESS date, so rows are matched with `rowBusinessDate(row, dayOpenHour)`
 * rather than their calendar `date` field — see that helper for why the two differ and why
 * comparing them directly loses money either side of midnight.
 */
export function buildDayEndReport({
  date,
  transactions = [],
  movements = [],
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

  const soldMap = new Map()
  const productById = Object.fromEntries((products || []).map((p) => [p.id, p]))

  paid.forEach((txn) => {
    ;(txn.itemsList || []).forEach((line) => {
      const product = productById[line.id]
      const qty = lineQty(line)
      if (!qty) return
      const unit = Number(line.price ?? line.unitPrice ?? product?.price ?? 0)
      bumpSold(soldMap, line.id || line.name, {
        productId: line.id || null,
        name: product?.name || line.name || 'Item',
        sku: product?.sku || line.sku || '',
        pricingMode: line.pricingMode || product?.pricingMode || 'pc',
        qty,
        revenue: unit * qty,
      })
    })
  })

  // Retail: sale movements fill gaps when synced txs lack itemsList
  if (!isRestaurant) {
    ;(movements || []).forEach((move) => {
      if (!inDay(move)) return
      if (move.movementType !== 'sale' && move.type !== 'Sale') return
      const qty = Math.abs(Number(move.quantityChange || 0))
      if (!qty || !move.productId) return
      const product = productById[move.productId]
      const existing = soldMap.get(move.productId)
      // Prefer movement totals when we have no cart lines yet
      if (!existing) {
        bumpSold(soldMap, move.productId, {
          productId: move.productId,
          name: product?.name || move.product || 'Product',
          sku: product?.sku || '',
          pricingMode: product?.pricingMode || 'pc',
          qty,
          revenue: Number(product?.price || 0) * qty,
        })
        return
      }
      if (existing.qty + 0.001 < qty) {
        const add = qty - existing.qty
        bumpSold(soldMap, move.productId, {
          productId: move.productId,
          name: product?.name || existing.name,
          sku: product?.sku || existing.sku,
          pricingMode: product?.pricingMode || existing.pricingMode,
          qty: add,
          revenue: Number(product?.price || 0) * add,
        })
      }
    })
  }

  const sold = [...soldMap.values()].sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)

  let restock = []
  if (!isRestaurant) {
    restock = (products || [])
      .map((product) => {
        const soldQty = soldMap.get(product.id)?.qty || 0
        const onHand = Number(product.stock ?? 0)
        const lowStockAt = Number(product.lowStockAt ?? 5)
        const needsRestock = onHand <= lowStockAt || (soldQty > 0 && onHand <= lowStockAt * 1.5)
        if (!needsRestock) return null
        const suggestedQty = Number(
          Math.max(lowStockAt * 2 - onHand, soldQty > 0 ? soldQty : 0, 0).toFixed(2),
        )
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

/** Normalize day_report from DB or local entry. */
export function mapDayReport(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    businessDate: raw.businessDate || raw.business_date || null,
    orderCount: Number(raw.orderCount ?? raw.order_count ?? 0),
    revenue: Number(raw.revenue ?? 0),
    sold: Array.isArray(raw.sold) ? raw.sold : [],
    restock: Array.isArray(raw.restock) ? raw.restock : [],
    generatedAt: raw.generatedAt || raw.generated_at || null,
  }
}
