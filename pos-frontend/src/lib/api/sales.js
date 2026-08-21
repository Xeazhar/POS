import { supabase } from '../supabase'
import { isRestaurantBranchType } from '../../utils/features'
import { localDateKey } from '../../utils/format'
import {
  hasSupabase,
  isMissingColumnError,
  mapTransaction,
  withCashierName,
  withApprover,
  staffNameById,
  fetchStaffIdentities,
} from './shared.js'
import { BOOTSTRAP_TX_COLS } from './catalog.js'

function isDuplicateClientIdError(error) {
  const msg = String(error?.message || error || '')
  return error?.code === '23505' && msg.includes('uq_transactions_branch_client')
}

export async function loadTransactionByClientId(branchId, clientId) {
  const { data, error } = await supabase
    .from('transactions')
    .select(BOOTSTRAP_TX_COLS)
    .eq('branch_id', branchId)
    .eq('client_id', clientId)
    .maybeSingle()
  if (error) throw error
  return data
}

/**
 * Business date of the earliest sale on record, for the Reports "All records" range.
 *
 * Needed because some reports (BIR Sales Summary) walk the range one day at a time. Using
 * an arbitrary floor like 2000-01-01 for "all" would spin ~9,500 iterations, each firing a
 * query — enough to hang the tab and hammer the API. Anchoring to real data keeps "all"
 * proportional to how long the branch has actually been trading.
 *
 * Returns null when the branch has no sales yet.
 */
export async function fetchEarliestTransactionDate(branchId = null) {
  let q = supabase
    .from('transactions')
    .select('created_at')
    .order('created_at', { ascending: true })
    .limit(1)
  if (branchId) q = q.eq('branch_id', branchId)
  const { data, error } = await q.maybeSingle()
  if (error) throw error
  return data?.created_at ? localDateKey(data.created_at) : null
}

/** The RPC itself is absent — i.e. migrate_complete_sale_rpc.sql is not applied yet. */
function isMissingFunctionError(error, name) {
  const raw = String(error?.message || error || '')
  return new RegExp(`Could not find the function.*${name}|function public\\.${name}.*does not exist`, 'i').test(raw)
}

/**
 * Postgres deadlock_detected. complete_sale()'s branch-counter UPDATE can occasionally
 * deadlock against another concurrent sale on the same branch (see migrate_complete_sale_rpc.sql)
 * — Postgres always rolls the victim back cleanly (no partial state, atomicity guarantees
 * that), so a blind retry is safe.
 */
function isDeadlockError(error) {
  return error?.code === '40P01'
}

export async function completeSale({
  branchId,
  staffId,
  items,
  total,
  tendered,
  clientId = null,
  orderType = 'dine_in',
  ulamCombo = null,
  branchType = null,
  paymentMethod = 'cash',
  paymentReference = null,
  vatAmount = 0,
  vatableSales = 0,
  vatExemptSales = 0,
  zeroRatedSales = 0,
  scPwdDiscount = 0,
  vatRateApplied = 0.12,
  discountAmount = 0,
  discountType = null,
  discountIdNote = null,
  shiftId = null,
  invoiceNumber: clientInvoiceNumber = null,
}) {
  if (clientId) {
    const existing = await loadTransactionByClientId(branchId, clientId).catch(() => null)
    // loadTransactionByClientId returns the raw BOOTSTRAP_TX_COLS row (snake_case) — every
    // other completeSale() return path is mapTransaction()-shaped (camelCase); callers that
    // persist the result straight to Dexie (syncEngine.js's COMPLETE_SALE case) need that
    // shape consistently, not just on the non-retry path.
    if (existing?.id) return mapTransaction(existing)
  }

  // Atomic path: complete_sale() does till check + invoice allocation + transaction + items +
  // stock movements + audit event in ONE server-side transaction (migrate_complete_sale_rpc.sql).
  // Either the whole sale lands or none of it does — no orphaned money-only transaction rows,
  // and one network round trip instead of four. Falls through to the legacy multi-step flow
  // below only when the RPC itself doesn't exist yet (database not yet migrated).
  try {
    const branchRes =
      branchType != null
        ? { data: { branch_type: branchType } }
        : await supabase.from('branches').select('branch_type').eq('id', branchId).maybeSingle()
    const isRestaurant =
      isRestaurantBranchType(branchType) || isRestaurantBranchType(branchRes?.data?.branch_type)

    const rpcLines = items.map((item) => {
      const unit = Number(item.unitPrice ?? item.price)
      const quantity = item.pricingMode === 'kg' ? item.weight : item.quantity
      const row = {
        product_id: item.id,
        quantity,
        unit_price: unit,
        line_total: unit * quantity,
        discount_eligible: item.discountEligible === true,
        discount_amount: Number(item.discountAmount ?? 0),
        promo_name: item.promoName || null,
        promo_group_id: item.promoGroupId || null,
        vat_category: item.vatCategory || 'vatable',
        detail: item.name || null,
      }
      if (isRestaurant) {
        row.price_tier = item.priceTier === 'budget' ? 'budget' : 'regular'
      }
      return row
    })

    const rpcParams = {
      p_branch_id: branchId,
      p_staff_id: staffId,
      p_items: rpcLines,
      p_total: total,
      p_tendered: tendered,
      p_client_id: clientId,
      p_client_invoice_number: clientInvoiceNumber,
      p_order_type: orderType,
      p_ulam_combo: ulamCombo,
      p_payment_method: paymentMethod,
      p_payment_reference: paymentReference,
      p_vat_amount: Number(vatAmount || 0),
      p_vatable_sales: Number(vatableSales || 0),
      p_vat_exempt_sales: Number(vatExemptSales || 0),
      p_zero_rated_sales: Number(zeroRatedSales || 0),
      p_sc_pwd_discount: Number(scPwdDiscount || 0),
      p_vat_rate_applied: Number(vatRateApplied || 0.12),
      p_discount_amount: Number(discountAmount || 0),
      p_discount_type: discountType || null,
      p_discount_id_note: discountIdNote || null,
      p_shift_id: shiftId || null,
    }

    // Up to one retry on a deadlock victim — safe (clean rollback, no partial state) and
    // expected occasionally under heavy concurrent same-branch checkout load. A short jittered
    // delay avoids immediately re-colliding with whichever transaction won the first round.
    let rpcTxn
    let rpcError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      ;({ data: rpcTxn, error: rpcError } = await supabase.rpc('complete_sale', rpcParams))
      if (!rpcError || !isDeadlockError(rpcError) || attempt === 1) break
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100))
    }
    if (rpcError) throw rpcError
    if (!rpcTxn) throw new Error('complete_sale returned no transaction')

    return mapTransaction(
      withCashierName(
        { ...rpcTxn, transaction_items: rpcLines.map((line) => ({ ...line, transaction_id: rpcTxn.id })) },
        { [staffId]: null },
      ),
    )
  } catch (err) {
    if (!isMissingFunctionError(err, 'complete_sale')) throw err
    // DB predates migrate_complete_sale_rpc.sql — fall back to the pre-atomic multi-step flow.
  }

  // ---- legacy multi-step path (pre migrate_complete_sale_rpc.sql) ----
  // Run till check + invoice reserve/allocate (+ branch type if unknown) together
  const tillPromise = supabase.rpc('assert_till_open', { p_branch_id: branchId })
  const invoicePromise = clientInvoiceNumber
    ? supabase.rpc('reserve_invoice_number', { p_branch_id: branchId, p_invoice_number: clientInvoiceNumber })
    : supabase.rpc('allocate_invoice_number', { p_branch_id: branchId })
  const branchPromise =
    branchType != null
      ? Promise.resolve({ data: { branch_type: branchType } })
      : supabase.from('branches').select('branch_type').eq('id', branchId).maybeSingle()

  const [{ error: tillError }, invoiceRes, branchRes] = await Promise.all([
    tillPromise,
    invoicePromise,
    branchPromise,
  ])
  if (tillError) throw tillError

  const isRestaurant =
    isRestaurantBranchType(branchType) || isRestaurantBranchType(branchRes?.data?.branch_type)

  let invoiceNumber = null
  if (!invoiceRes.error) invoiceNumber = invoiceRes.data
  else if (
    clientInvoiceNumber &&
    String(invoiceRes.error.message || '').includes('Could not find the function')
  ) {
    // DB without migrate_rename_or_to_invoice.sql — fall back to server-side allocate.
    const fallback = await supabase.rpc('allocate_invoice_number', { p_branch_id: branchId })
    if (!fallback.error) invoiceNumber = fallback.data
    else if (!String(fallback.error.message || '').includes('Could not find the function')) {
      throw fallback.error
    }
  } else if (!String(invoiceRes.error.message || '').includes('Could not find the function')) {
    throw invoiceRes.error
  }

  const insertRow = {
    branch_id: branchId,
    staff_id: staffId,
    total_amount: total,
    amount_tendered: tendered,
    change_given: Math.max(0, tendered - total),
    status: 'completed',
    payment_method: ['cash', 'card', 'ewallet'].includes(paymentMethod) ? paymentMethod : 'cash',
    payment_reference: paymentMethod === 'ewallet' ? String(paymentReference || '').trim() || null : null,
    vat_amount: Number(vatAmount || 0),
    vatable_sales: Number(vatableSales || 0),
    vat_exempt_sales: Number(vatExemptSales || 0),
    zero_rated_sales: Number(zeroRatedSales || 0),
    sc_pwd_discount: Number(scPwdDiscount || 0),
    vat_rate_applied: Number(vatRateApplied || 0.12),
    discount_amount: Number(discountAmount || 0),
    discount_type: discountType || null,
    discount_id_note: discountIdNote || null,
  }
  if (invoiceNumber) insertRow.invoice_number = invoiceNumber
  if (clientId) insertRow.client_id = clientId
  // Attributes the sale to the shift that rang it, so cash rolls up per shift as well as
  // per day. Omitted (not null) on older databases — see the shift_id fallback below.
  if (shiftId) insertRow.shift_id = shiftId
  if (isRestaurant) {
    insertRow.order_type = orderType === 'takeout' ? 'takeout' : 'dine_in'
    if (ulamCombo) insertRow.ulam_combo = ulamCombo
  }

  let { data: txn, error } = await supabase
    .from('transactions')
    .insert(insertRow)
    .select('*')
    .single()
  if (
    error &&
    (isMissingColumnError(error, 'order_type') ||
      isMissingColumnError(error, 'ulam_combo') ||
      isMissingColumnError(error, 'payment_method') ||
      isMissingColumnError(error, 'vat_amount') ||
      isMissingColumnError(error, 'vat_exempt_sales') ||
      isMissingColumnError(error, 'discount_amount'))
  ) {
    const fallback = { ...insertRow }
    delete fallback.order_type
    delete fallback.ulam_combo
    delete fallback.payment_method
    delete fallback.payment_reference
    delete fallback.vat_amount
    delete fallback.vatable_sales
    delete fallback.vat_exempt_sales
    delete fallback.zero_rated_sales
    delete fallback.sc_pwd_discount
    delete fallback.vat_rate_applied
    delete fallback.discount_amount
    delete fallback.discount_type
    delete fallback.discount_id_note
    delete fallback.shift_id
    ;({ data: txn, error } = await supabase.from('transactions').insert(fallback).select('*').single())
  }
  // Shift attribution is additive: a database without migrate_shift_cash_accountability.sql
  // must still be able to take money. Retry once without it rather than refuse the sale.
  if (error && insertRow.shift_id && isMissingColumnError(error, 'shift_id')) {
    const withoutShift = { ...insertRow }
    delete withoutShift.shift_id
    ;({ data: txn, error } = await supabase.from('transactions').insert(withoutShift).select('*').single())
  }
  if (error && clientId && isDuplicateClientIdError(error)) {
    txn = await loadTransactionByClientId(branchId, clientId)
    error = txn ? null : error
  }
  if (error) throw error

  const { count: existingLineCount, error: countError } = await supabase
    .from('transaction_items')
    .select('*', { count: 'exact', head: true })
    .eq('transaction_id', txn.id)
  if (countError) throw countError

  const lines = items.map((item) => {
    const unit = Number(item.unitPrice ?? item.price)
    const quantity = item.pricingMode === 'kg' ? item.weight : item.quantity
    const row = {
      transaction_id: txn.id,
      product_id: item.id,
      quantity,
      unit_price: unit,
      line_total: unit * quantity,
      discount_eligible: item.discountEligible === true,
      discount_amount: Number(item.discountAmount ?? 0),
      // Which promo event won this line — see migrate_promo_line_attribution.sql.
      promo_name: item.promoName || null,
      promo_group_id: item.promoGroupId || null,
      // 'vatable' | 'exempt' | 'zero_rated', frozen at sale time — see migrate_vat_breakdown.sql.
      vat_category: item.vatCategory || 'vatable',
    }
    if (isRestaurant) {
      row.price_tier = item.priceTier === 'budget' ? 'budget' : 'regular'
    }
    return row
  })

  if (!existingLineCount) {
    let { error: itemsError } = await supabase.from('transaction_items').insert(lines)
    if (
      itemsError &&
      (isMissingColumnError(itemsError, 'price_tier') ||
        isMissingColumnError(itemsError, 'promo_name') ||
        isMissingColumnError(itemsError, 'promo_group_id') ||
        isMissingColumnError(itemsError, 'vat_category'))
    ) {
      const strippedLines = lines.map((row) => {
        const rest = { ...row }
        delete rest.price_tier
        delete rest.promo_name
        delete rest.promo_group_id
        delete rest.vat_category
        return rest
      })
      ;({ error: itemsError } = await supabase.from('transaction_items').insert(strippedLines))
    }
    if (itemsError) throw itemsError

    // Restaurant / carinderia: no inventory deduction — menu sales only
    if (!isRestaurant) {
      await Promise.all(
        items.map((item) => {
          const sold = item.pricingMode === 'kg' ? item.weight : item.quantity
          return supabase
            .rpc('record_stock_movement', {
              p_branch_id: branchId,
              p_product_id: item.id,
              p_staff_id: staffId,
              p_movement_type: 'sale',
              p_quantity_in: 0,
              p_quantity_out: sold,
              p_reference: txn.id,
              p_detail: item.name,
            })
            .then(({ error: moveError }) => {
              if (moveError) throw moveError
            })
        }),
      )
    }
  }

  // Non-blocking audit trail
  void supabase
    .from('sale_events')
    .insert({
      branch_id: branchId,
      transaction_id: txn.id,
      staff_id: staffId,
      event_type: 'sale',
      invoice_number: txn.invoice_number,
      amount: total,
      payload: {
        client_id: clientId,
        order_type: insertRow.order_type || null,
        ulam_combo: ulamCombo,
      },
    })
    .then(({ error: eventError }) => {
      if (eventError) console.warn('sale_events insert skipped:', eventError.message)
    })

  return mapTransaction(withCashierName({ ...txn, transaction_items: lines }, { [staffId]: null }))
}

export async function fetchTransactionDetail(id) {
  const { data, error } = await supabase
    .from('transactions')
    .select(
      '*, transaction_items(id, quantity, unit_price, line_total, discount_eligible, discount_amount, promo_name, promo_group_id, products(id, name, sku, pricing_mode))',
    )
    .eq('id', id)
    .single()
  if (error) throw error
  const staffNames = await staffNameById([data.staff_id])
  const approverIdentities = await fetchStaffIdentities([
    data.void_approved_by,
    data.voided_by,
  ]).catch(() => ({}))
  const row = withApprover(withCashierName(data, staffNames), approverIdentities)
  const voidedByWho = approverIdentities[data.voided_by] || null
  return {
    ...mapTransaction({ ...row, transaction_items: row.transaction_items || [] }),
    voidedByName: voidedByWho?.name || null,
    voidedByRole: voidedByWho?.role || null,
    lines: (row.transaction_items || []).map((line) => ({
      id: line.id,
      name: line.products?.name || 'Product',
      sku: line.products?.sku || '',
      pricingMode: line.products?.pricing_mode === 'per_kg' ? 'kg' : 'pc',
      quantity: Number(line.quantity),
      unitPrice: Number(line.unit_price),
      lineTotal: Number(line.line_total),
      discountEligible: line.discount_eligible === true,
      discountAmount: Number(line.discount_amount ?? 0),
      promoName: line.promo_name || null,
      promoGroupId: line.promo_group_id || null,
      promoGroupName: null,
    })),
  }
}

/**
 * "Transaction already voided" (void_sale_secure's own idempotency guard) means the
 * VOID has already been achieved, by an EARLIER attempt at this exact same op — not a
 * conflicting one. The offline queue retries a failed push until it succeeds; if the
 * first attempt's RPC actually committed server-side but the response never made it back
 * (connection dropped mid-round-trip, tab closed), the queue item stays un-DONE and
 * retries. That retry then correctly finds the sale already voided, throws, and — treated
 * as an ordinary failure — increments the attempt counter every cycle until it hits
 * MAX_SYNC_ATTEMPTS and gets quarantined ("Sync issue"), even though the desired end state
 * was reached on attempt one. Same shape as COMPLETE_SALE's duplicate-client-id handling
 * just above: recognize "this exact op already landed" and treat it as done, not failed.
 */
function isAlreadyVoidedError(error) {
  return /already voided|voided transactions are locked/i.test(String(error?.message || ''))
}

export async function voidSale(id, reason, staffId = null, approvedBy = null) {
  if (!staffId) {
    throw new Error('void_sale_secure requires staffId — direct transaction updates are not allowed')
  }
  const { data, error } = await supabase.rpc('void_sale_secure', {
    p_transaction_id: id,
    p_staff_id: staffId,
    p_reason: reason,
    p_approved_by: approvedBy,
  })
  if (!error) return data
  if (isAlreadyVoidedError(error)) {
    const { data: current } = await supabase.from('transactions').select('*').eq('id', id).maybeSingle()
    return current
  }
  throw error
}

/** Partial or multi-item refund. items: [{ item_id, quantity }] */
export async function refundSaleItems({
  transactionId,
  staffId,
  reason,
  items = [],
  approvedBy = null,
}) {
  const { data, error } = await supabase.rpc('refund_sale_items', {
    p_transaction_id: transactionId,
    p_staff_id: staffId,
    p_reason: reason || 'Item refund',
    p_items: items,
    p_approved_by: approvedBy,
  })
  if (error) throw error
  return data
}

/**
 * Remote manager approval for a refund/void when no supervisor is on site
 * (Transactions.jsx's "notify manager instead" checkbox) — mirrors promo
 * dual-control (approvePromoEvent/rejectPromoEvent above). The request sits
 * in `refund_requests` (not `transactions` — its guard trigger only allows
 * completed->voided or a refunded_amount increase) until a manager approves
 * or rejects it from wherever they are; approving executes the actual
 * void_sale_secure/refund_sale_items server-side.
 */
export async function requestRefundApproval({
  transactionId,
  staffId,
  branchId,
  mode,
  reason,
  items = null,
}) {
  const { data, error } = await supabase.rpc('request_refund_approval', {
    p_transaction_id: transactionId,
    p_staff_id: staffId,
    p_branch_id: branchId,
    p_mode: mode,
    p_reason: reason,
    p_items: mode === 'items' ? items : null,
  })
  if (error) throw error
  return data
}

export async function approveRefundRequest({ id, staffId }) {
  const { data, error } = await supabase.rpc('approve_refund_request', {
    p_request_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

export async function rejectRefundRequest({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('reject_refund_request', {
    p_request_id: id,
    p_staff_id: staffId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}

export async function cancelRefundRequest({ id, staffId }) {
  const { data, error } = await supabase.rpc('cancel_refund_request', {
    p_request_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/** Drop manager-refund alerts when a supervisor/manager voids or refunds on-site instead. */
export async function dismissPendingRefundRequestsForTransaction({ transactionId, staffId }) {
  if (!hasSupabase || !transactionId || !staffId) return
  const { data, error } = await supabase
    .from('refund_requests')
    .select('id')
    .eq('transaction_id', transactionId)
    .eq('status', 'pending')
  if (error) return
  for (const row of data || []) {
    try {
      await cancelRefundRequest({ id: row.id, staffId })
    } catch {
      /* already acted on remotely */
    }
  }
}

/** Status poll fallback for Transactions.jsx's waiting modal, alongside its realtime subscription. */
export async function fetchRefundRequestById(id) {
  const { data, error } = await supabase
    .from('refund_requests')
    .select('id, status, reject_reason')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  return data
}

/** Pending refund requests for a branch — BranchDashboard.jsx's review list. */
export async function fetchRefundRequests(branchId, { status = 'pending' } = {}) {
  let query = supabase
    .from('refund_requests')
    .select('id, transaction_id, branch_id, mode, reason, items, status, requested_by, requested_at, transactions(invoice_number, total_amount), staff:requested_by(full_name)')
    .eq('branch_id', branchId)
    .order('requested_at', { ascending: false })
  if (status) query = query.eq('status', status)
  const { data, error } = await query
  if (error) throw error
  return (data || []).map((row) => ({
    id: row.id,
    transactionId: row.transaction_id,
    branchId: row.branch_id,
    mode: row.mode,
    reason: row.reason,
    items: row.items,
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.staff?.full_name || null,
    requestedAt: row.requested_at,
    invoiceNumber: row.transactions?.invoice_number || null,
    totalAmount: row.transactions?.total_amount ?? null,
  }))
}

export async function fetchRefundSummary(transactionId) {
  const empty = { qtyByItem: {}, amountByItem: {}, totalAmount: 0, lines: [] }
  const { data, error } = await supabase
    .from('sale_refund_lines')
    .select(
      'id, transaction_item_id, product_id, quantity, amount, reason, created_at, staff_id, approved_by, products(name, sku)',
    )
    .eq('transaction_id', transactionId)
    .order('created_at', { ascending: false })
  if (error) {
    if (/sale_refund_lines|schema cache/i.test(String(error.message || ''))) return empty
    throw error
  }
  const qtyByItem = {}
  const amountByItem = {}
  let totalAmount = 0
  // Each refund line carries both the staff who rang it and the supervisor/manager who
  // approved it — the refund history has to name both, not just record that it happened.
  const who = await fetchStaffIdentities([
    ...(data || []).map((row) => row.staff_id),
    ...(data || []).map((row) => row.approved_by),
  ]).catch(() => ({}))
  const lines = (data || []).map((row) => ({
    ...row,
    productName: row.products?.name || null,
    staffName: who[row.staff_id]?.name || null,
    approvedByName: who[row.approved_by]?.name || null,
    approvedByRole: who[row.approved_by]?.role || null,
  }))
  lines.forEach((row) => {
    const id = row.transaction_item_id
    qtyByItem[id] = Number((qtyByItem[id] || 0) + Number(row.quantity || 0))
    amountByItem[id] = Number((amountByItem[id] || 0) + Number(row.amount || 0))
    totalAmount += Number(row.amount || 0)
  })
  return {
    qtyByItem,
    amountByItem,
    totalAmount: Number(totalAmount.toFixed(2)),
    lines,
  }
}

/** @deprecated prefer fetchRefundSummary */
export async function fetchRefundedQuantities(transactionId) {
  const summary = await fetchRefundSummary(transactionId)
  return summary.qtyByItem
}
