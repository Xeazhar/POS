import { supabase } from '../supabase'
import { localDateKey } from '../../utils/format'
import { fetchAllRows, localDayBoundsIso, fetchStaffIdentities } from './shared.js'

export function mapMovement(row) {
  const change = Number(row.quantity_in || 0) - Number(row.quantity_out || 0)
  const typeRaw = String(row.movement_type || 'adjustment')
  const typeLabel =
    typeRaw === 'price_change'
      ? 'Price change'
      : typeRaw.replace(/^\w/, (c) => c.toUpperCase())
  return {
    id: row.id,
    date: localDateKey(row.created_at),
    createdAt: row.created_at || null,
    productId: row.product_id,
    product: row.products?.name || row.product || '',
    type: typeLabel,
    movementType: typeRaw,
    quantityChange: change,
    resultingStock: Number(row.quantity_on_hand_after),
    oldPrice: row.old_price != null ? Number(row.old_price) : null,
    newPrice: row.new_price != null ? Number(row.new_price) : null,
    detail: row.detail || '',
    reference: row.reference || '',
    branchId: row.branch_id,
    staffId: row.staff_id || null,
    staffName: row.staff_name || null,
  }
}

/** Movement types `stock_movements.movement_type` accepts, for filter dropdowns. */
export const MOVEMENT_TYPES = [
  { id: 'restock', label: 'Restock' },
  { id: 'sale', label: 'Sale' },
  { id: 'adjustment', label: 'Adjustment' },
  { id: 'shrinkage', label: 'Waste / shrinkage' },
  { id: 'price_change', label: 'Price change' },
  { id: 'update', label: 'Product update' },
]

/**
 * Stock movement log for the Inventory → Movement history tab.
 *
 * Separate from the movements `bootstrapBranchData` returns: that one is capped at the
 * most recent 500 rows across all products for the POS's own use. A history tab has to
 * answer questions about a date range, so it queries by range and pages rather than
 * filtering a fixed-size window that may not reach back far enough.
 */
export async function fetchStockMovements({
  branchId,
  start = null,
  end = null,
  productId = null,
  movementType = null,
} = {}) {
  if (!branchId) return []
  const cols =
    'id, created_at, product_id, staff_id, movement_type, reference, detail, quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price, branch_id, products(name, sku)'
  const { startIso, endIso } = localDayBoundsIso(start, end)
  const build = (from, to) => {
    let q = supabase
      .from('stock_movements')
      .select(cols)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .range(from, to)
    if (startIso) q = q.gte('created_at', startIso)
    if (endIso) q = q.lte('created_at', endIso)
    if (productId) q = q.eq('product_id', productId)
    if (movementType) q = q.eq('movement_type', movementType)
    return q
  }
  // Paged — a busy branch clears well over 1000 movements in a month and PostgREST would
  // silently truncate, which on an audit-facing log reads as "it didn't happen".
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  const rows = data || []
  const who = await fetchStaffIdentities(rows.map((r) => r.staff_id)).catch(() => ({}))
  const invoiceNumbers = await resolveMovementReferences(rows)
  return rows.map((row) =>
    mapMovement({
      ...row,
      staff_name: who[row.staff_id]?.name || null,
      product: row.products?.name || '',
      reference: readableReference(row, invoiceNumbers),
    }),
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `stock_movements.reference` holds whatever caused the movement, and for a sale that is the
 * transaction's internal id — a UUID nobody can look a receipt up with, printed in a column
 * staff read. Trade it for the invoice number, which is the one identifier that appears on the
 * receipt, in Transactions and in the BIR reports.
 */
async function resolveMovementReferences(rows) {
  const ids = [
    ...new Set(
      (rows || [])
        .filter((r) => r.movement_type === 'sale' && UUID_RE.test(String(r.reference || '')))
        .map((r) => r.reference),
    ),
  ]
  if (!ids.length) return {}
  const map = {}
  // Chunked: a month of movements can reference more transaction ids than a URL will carry.
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('transactions')
      .select('id, invoice_number')
      .in('id', ids.slice(i, i + 200))
    if (error) return map // a missing invoice number is cosmetic; never fail the whole history for it
    for (const t of data || []) if (t.invoice_number) map[t.id] = t.invoice_number
  }
  return map
}

/** Human-readable reference, or nothing. A bare id is noise, not information. */
function readableReference(row, invoiceNumbers) {
  const raw = String(row.reference || '')
  if (!raw) return ''
  // invoice_number already carries its own prefix (e.g. "SI-00000001", or a branch's own
  // invoice_prefix) — prepending "SI " here would duplicate it as "SI SI-00000001".
  if (invoiceNumbers[raw]) return invoiceNumbers[raw]
  // Import batch ids and unresolvable sale ids both land here — say nothing rather than
  // print a key the reader cannot act on.
  return UUID_RE.test(raw) ? '' : raw
}

export async function setInventoryStock({ branchId, productId, staffId, stock, previousStock, productName }) {
  const delta = Number((stock - previousStock).toFixed(2))
  if (delta === 0) return null
  const quantityIn = delta > 0 ? delta : 0
  const quantityOut = delta < 0 ? Math.abs(delta) : 0
  const { data, error } = await supabase.rpc('record_stock_movement', {
    p_branch_id: branchId,
    p_product_id: productId,
    p_staff_id: staffId,
    p_movement_type: 'adjustment',
    p_quantity_in: quantityIn,
    p_quantity_out: quantityOut,
    p_reference: 'edit',
    p_detail: productName,
  })
  if (error) throw error
  return mapMovement({ ...data, products: { name: productName } })
}

export async function adjustStock({ branchId, productId, staffId, action, amount, productName }) {
  const type = action.toLowerCase()
  const quantityIn = type === 'restock' ? amount : 0
  const quantityOut = type === 'restock' ? 0 : amount
  const { data, error } = await supabase.rpc('record_stock_movement', {
    p_branch_id: branchId,
    p_product_id: productId,
    p_staff_id: staffId,
    p_movement_type: type,
    p_quantity_in: quantityIn,
    p_quantity_out: quantityOut,
    p_reference: action,
    p_detail: productName,
  })
  if (error) throw error
  return mapMovement({ ...data, products: { name: productName } })
}

export async function fetchInventoryReport(branchId) {
  const { data, error } = await fetchAllRows((from, to) => {
    let query = supabase
      .from('products')
      .select('*, categories(name), branches(name), branch_inventory(quantity_on_hand, updated_at, branch_id)')
      .eq('is_active', true)
      .order('name')
      .order('id', { ascending: true })
      .range(from, to)
    if (branchId) query = query.eq('branch_id', branchId)
    return query
  })
  if (error) throw error
  return (data || []).map((row) => {
    const inv = Array.isArray(row.branch_inventory) ? row.branch_inventory[0] : row.branch_inventory
    return {
      branches: row.branches,
      products: row,
      quantity_on_hand: Number(inv?.quantity_on_hand || 0),
    }
  })
}
