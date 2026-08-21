import { allowDemoMode, supabase } from '../supabase'
import { mapDayReport } from '../../utils/dayEndReport'
import { localDateKey, netAfterRefund, today } from '../../utils/format'
import { normalizeMenuKind } from '../../utils/ulam'

export const hasSupabase = Boolean(supabase)
export { allowDemoMode }

export const mapPricing = (mode) => (mode === 'per_kg' || mode === 'kg' ? 'kg' : 'pc')
export const toDbPricing = (mode) => (mode === 'kg' ? 'per_kg' : 'per_unit')

export function mapDayEndRow(row) {
  if (!row) return null
  const fmtTime = (value) =>
    value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return {
    id: row.id,
    date: row.business_date,
    recordedCash: Number(row.recorded_cash),
    cashOnHand: Number(row.cash_on_hand),
    variance: Number(row.variance),
    expectedCash: Number(row.expected_cash ?? 0),
    note: row.note || '',
    status: row.status || 'closed',
    cashier: row.staff?.full_name || '',
    closedAt: fmtTime(row.closed_at),
    submittedAt: fmtTime(row.submitted_at),
    approvedAt: fmtTime(row.approved_at),
    reopenedAt: row.reopened_at ? fmtTime(row.reopened_at) : null,
    reopenReason: row.reopen_reason || '',
    dayReport: mapDayReport(row.day_report),
    branchId: row.branch_id || null,
    requestedAt: row.requested_at || null,
    requestedBy: row.requested_by || null,
    requestManager: row.request_manager === true,
    rejectedAt: row.rejected_at || null,
    rejectedBy: row.rejected_by || null,
    rejectReason: row.reject_reason || '',
    reopenRequestedAt: row.reopen_requested_at || null,
    reopenRequestedBy: row.reopen_requested_by || null,
    reopenRequestReason: row.reopen_request_reason || '',
    // Supervisor→manager cash handoff (migrate_day_end_cash_handoff.sql) — non-blocking,
    // no deadline, so these stay null on plenty of legitimately-closed days.
    handoffConfirmedBy: row.handoff_confirmed_by || null,
    handoffConfirmedByName: row.confirmer?.full_name || '',
    handoffConfirmedAt: row.handoff_confirmed_at || null,
  }
}

export function isMissingColumnError(error, column) {
  const msg = String(error?.message || error || '')
  return msg.includes(column) && (msg.includes('schema cache') || msg.includes('does not exist') || msg.includes('Could not find'))
}

/**
 * Read every row of a query, not just the first page.
 *
 * PostgREST caps a response at `db-max-rows` (1000 on Supabase by default) and returns the
 * truncated set WITHOUT an error. A branch past that many products silently lost its tail:
 * those products never reached useProductStore, so POS couldn't price them, and Cart's
 * eligibility lookup (`productById.get(item.id)`) missed them and fell back to the stale
 * flag frozen on the cart line — which is why a product could read "Discountable: Yes" in
 * the catalog and still refuse PWD/Senior at the counter.
 *
 * `build(from, to)` must return a fresh query each call — a PostgREST builder is not reusable.
 */
export const PAGE_ROWS = 1000

export async function fetchAllRows(build) {
  const out = []
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await build(from, from + PAGE_ROWS - 1)
    if (error) return { data: null, error }
    const rows = data || []
    out.push(...rows)
    if (rows.length < PAGE_ROWS) break
  }
  return { data: out, error: null }
}

/**
 * Converts a "YYYY-MM-DD" business/calendar date key into the UTC instant boundaries of
 * that LOCAL day, for filtering a `timestamptz` column.
 *
 * `created_at` is timestamptz, and the Supabase DB session runs in UTC — a bare
 * `${date}T00:00:00` filter is read as UTC midnight, not Manila midnight, shifting the
 * whole window 8 hours: early-morning local sales/events fall out of "today" and the
 * window's tail bleeds into the next local day instead. `new Date(...)` parses the
 * timezone-less string as LOCAL time (the terminal runs in PH time, same assumption
 * `businessDate()` makes) and `.toISOString()` converts that instant to the correct UTC
 * value, so the filter means what the caller intended.
 */
export function localDayBoundsIso(startKey, endKey = startKey) {
  return {
    startIso: startKey ? new Date(`${startKey}T00:00:00`).toISOString() : null,
    endIso: endKey ? new Date(`${endKey}T23:59:59.999`).toISOString() : null,
  }
}

export async function writeProductRow(mode, payload, { id } = {}) {
  const attempt = async (row) => {
    if (mode === 'insert') {
      return supabase.from('products').insert(row).select('*, categories(name)').single()
    }
    return supabase.from('products').update(row).eq('id', id).select('*, categories(name)').single()
  }

  let { data, error } = await attempt(payload)
  if (error && (isMissingColumnError(error, 'budget_price') || isMissingColumnError(error, 'menu_kind') || isMissingColumnError(error, 'product_no'))) {
    const fallback = { ...payload }
    delete fallback.budget_price
    delete fallback.menu_kind
    delete fallback.product_no
    ;({ data, error } = await attempt(fallback))
  }
  if (error && isMissingColumnError(error, 'available_today')) {
    const fallback = { ...payload }
    delete fallback.budget_price
    delete fallback.menu_kind
    delete fallback.product_no
    delete fallback.available_today
    ;({ data, error } = await attempt(fallback))
  }
  // Drop ONLY the column the server actually complained about. These used to be removed
  // as a pair, so a schema missing `unit_cost` silently stripped `discount_eligible` from
  // every product write too — the save reported success and the discount flag never landed.
  if (error && isMissingColumnError(error, 'unit_cost')) {
    const fallback = { ...payload }
    delete fallback.unit_cost
    ;({ data, error } = await attempt(fallback))
  }
  if (error && isMissingColumnError(error, 'discount_eligible')) {
    const fallback = { ...payload }
    delete fallback.unit_cost
    delete fallback.discount_eligible
    ;({ data, error } = await attempt(fallback))
  }
  if (error) throw error
  return data
}

export function formatProductCode(productNo) {
  if (productNo == null || productNo === '') return ''
  const n = Number(productNo)
  if (!Number.isFinite(n) || n <= 0) return String(productNo)
  return String(Math.trunc(n)).padStart(4, '0')
}

export function mapProduct(row, stock = 0, meta = {}) {
  const category = row.categories?.name || row.category || 'Groceries'
  const menuKind = normalizeMenuKind(row.menu_kind, category)
  return {
    id: row.id,
    productNo: row.product_no != null ? Number(row.product_no) : null,
    productCode: formatProductCode(row.product_no),
    branchId: row.branch_id || meta.branchId || null,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode || '',
    category,
    categoryId: row.category_id,
    menuKind,
    pricingMode: mapPricing(row.pricing_mode),
    price: Number(row.price),
    unitCost: Number(row.unit_cost ?? 0),
    regularPrice: Number(row.price),
    budgetPrice: row.budget_price != null ? Number(row.budget_price) : null,
    stock: Number(stock),
    lowStockAt: Number(row.low_stock_threshold ?? 5),
    availableToday: row.available_today !== false,
    discountEligible: row.discount_eligible === true,
    createdAt: localDateKey(row.created_at) || meta.createdAt || today(),
    updatedAt: meta.updatedAt ? localDateKey(meta.updatedAt) : localDateKey(row.created_at) || today(),
    lastMovementAt: meta.lastMovementAt || null,
  }
}

/**
 * Resolve staff name AND role without embedding (avoids multi-FK PostgREST ambiguity:
 * `transactions` points at `staff` three times — staff_id, voided_by, void_approved_by —
 * so an embed has to be disambiguated at every call site).
 *
 * Role matters as much as the name for approvals: "approved by Ana" does not tell an
 * auditor whether Ana was allowed to approve it. Returns { id: { name, role } }.
 */
export async function fetchStaffIdentities(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  if (!unique.length || !supabase) return {}
  // `staff` RLS only ever grants a row's own account or a manager — a supervisor resolving
  // a same-branch cashier's name (Transactions cashier column, void/refund "performed by",
  // shift log) needs the narrow definer function instead, or the read comes back empty for
  // every id but their own. Falls back to the raw table read (old, self-only-for-a-
  // supervisor behaviour) if the migration adding it hasn't been applied yet.
  const { data, error } = await supabase.rpc('resolve_staff_identities', { p_ids: unique })
  if (!error) {
    return Object.fromEntries(
      (data || []).map((row) => [row.id, { name: row.full_name, role: row.role || null }]),
    )
  }
  if (!/resolve_staff_identities|Could not find the function/i.test(String(error.message || ''))) {
    throw error
  }
  const fallback = await supabase.from('staff').select('id, full_name, role').in('id', unique)
  if (fallback.error) throw fallback.error
  return Object.fromEntries(
    (fallback.data || []).map((row) => [row.id, { name: row.full_name, role: row.role || null }]),
  )
}

/** Name-only view of the above, for the many call sites that never needed the role. */
export async function staffNameById(ids) {
  const identities = await fetchStaffIdentities(ids)
  return Object.fromEntries(Object.entries(identities).map(([id, who]) => [id, who.name]))
}

export function withCashierName(row, names) {
  if (!row) return row
  const name = names?.[row.staff_id]
  if (!name) return row
  return { ...row, staff: { full_name: name } }
}

/**
 * Attach the approver's name/role to a row that carries an approver id. Applied after the
 * fact rather than joined, for the multi-FK reason above.
 */
export function withApprover(row, identities, field = 'void_approved_by') {
  if (!row) return row
  const who = identities?.[row[field]]
  if (!who) return row
  return { ...row, approver_name: who.name, approver_role: who.role }
}

export function mapTransaction(row) {
  const created = new Date(row.created_at)
  const createdAt = Number.isNaN(created.getTime()) ? row.created_at || null : created.toISOString()
  const total = Number(row.total_amount || 0)
  const refundedAmount = Number(row.refunded_amount || 0)
  return {
    id: row.id,
    invoiceNumber: row.invoice_number || null,
    time: Number.isNaN(created.getTime())
      ? '—'
      : created.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    cashier: row.staff?.full_name || 'Staff',
    total,
    refundedAmount,
    netTotal: netAfterRefund(total, refundedAmount),
    status: row.status === 'voided' ? 'Voided' : 'Paid',
    items: row.transaction_items?.length || row.item_count || 0,
    date: localDateKey(row.created_at),
    createdAt,
    branchId: row.branch_id,
    // Was never selected here at all, so every transaction lost its shift attribution the
    // moment it round-tripped through a server pull (bootstrapBranchData / putTransactions
    // both flow through this mapping). shiftClientId is deliberately NOT restored here — it
    // only ever existed as a same-session local-optimistic hint before the shift itself had
    // synced; once a row reaches the server, shiftId is the only attribution that means
    // anything, and BOOTSTRAP_TX_COLS now selects it.
    shiftId: row.shift_id || null,
    voidReason: row.void_reason,
    voidedAt: row.voided_at || null,
    voidedBy: row.voided_by || null,
    tendered: row.amount_tendered != null ? Number(row.amount_tendered) : null,
    change: row.change_given != null ? Number(row.change_given) : null,
    clientId: row.client_id || null,
    orderType: row.order_type || 'dine_in',
    ulamCombo: row.ulam_combo || null,
    paymentMethod: row.payment_method || 'cash',
    paymentReference: row.payment_reference || null,
    vatAmount: row.vat_amount != null ? Number(row.vat_amount) : 0,
    vatableSales: row.vatable_sales != null ? Number(row.vatable_sales) : 0,
    vatExemptSales: row.vat_exempt_sales != null ? Number(row.vat_exempt_sales) : 0,
    zeroRatedSales: row.zero_rated_sales != null ? Number(row.zero_rated_sales) : 0,
    scPwdDiscount: row.sc_pwd_discount != null ? Number(row.sc_pwd_discount) : 0,
    vatRateApplied: row.vat_rate_applied != null ? Number(row.vat_rate_applied) : null,
    discountAmount: row.discount_amount != null ? Number(row.discount_amount) : 0,
    discountType: row.discount_type || null,
    discountIdNote: row.discount_id_note || null,
    voidApprovedBy: row.void_approved_by || null,
    // Who signed off on the void/refund, and in what capacity. Populated by whichever
    // fetch resolved the ids (see withApprover); absent on offline/optimistic rows.
    voidApprovedByName: row.approver_name || null,
    voidApprovedByRole: row.approver_role || null,
  }
}

/** "Ana Cruz · Supervisor" — the one string every approval surface shows. */
export function approverLabel(name, role) {
  if (!name && !role) return null
  if (!role) return name
  const pretty = String(role).charAt(0).toUpperCase() + String(role).slice(1)
  return name ? `${name} · ${pretty}` : pretty
}

async function ensureCategoryId(categoryName) {
  const name = categoryName || 'Groceries'
  const { data: cat } = await supabase.from('categories').select('id').eq('name', name).maybeSingle()
  if (cat?.id) return cat.id
  const { data: created, error } = await supabase.from('categories').insert({ name }).select('id').single()
  if (error) throw error
  return created.id
}

/**
 * name → category id for a whole import, resolved in one query instead of per row.
 *
 * Keys are TRIMMED, and callers must look up with a trimmed name too — a sheet cell of
 * " Meat " would otherwise miss the map and fall back to a per-row query, silently
 * undoing the batching this exists for.
 *
 * Blank names collapse to 'Groceries', which is the inventory import's intended default.
 * Callers that should NOT create a category for a blank cell (catalog import) filter the
 * blanks out before calling. Shared by catalog import (createCatalogProduct path) and
 * inventory import — both need to resolve a batch of category names up front.
 */
export async function resolveCategoryIds(names = []) {
  const wanted = [...new Set(names.map((n) => String(n || '').trim() || 'Groceries'))]
  if (!wanted.length) return new Map()

  const { data, error } = await supabase.from('categories').select('id, name').in('name', wanted)
  if (error) throw error

  const map = new Map((data || []).map((row) => [row.name, row.id]))
  // Create only what is genuinely missing.
  for (const name of wanted) {
    if (map.has(name)) continue
    map.set(name, await ensureCategoryId(name))
  }
  return map
}
