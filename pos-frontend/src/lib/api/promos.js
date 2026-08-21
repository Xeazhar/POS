import { supabase } from '../supabase'
import { aggregatePromoSalesOffers } from '../../utils/promo'
import { fetchAllRows, localDayBoundsIso, isMissingColumnError, staffNameById } from './shared.js'
import { fetchBranchProducts } from './catalog.js'
import { fetchBranches } from './branches.js'

export async function expireEndedPromos() {
  try {
    await supabase.rpc('expire_ended_promos')
  } catch {
    /* ignore — display truth still hides ended promos */
  }
}

/**
 * Has this promo's scheduled end time passed?
 *
 * The client must never depend on the DB sweep having run to decide whether a promo is
 * over: an ended promo has to read as ended immediately from the timestamp alone.
 */
export function promoHasEnded(event) {
  const endsAt = event?.ends_at ?? event?.endsAt
  if (!endsAt) return false
  const end = new Date(endsAt)
  return !Number.isNaN(end.getTime()) && end < new Date()
}

/**
 * Display status for a promo row. Exactly three outcomes matter to a manager:
 *
 *   active   selling right now
 *   stopped  a manager ended it EARLY — a decision
 *   expired  it reached its own end date — a schedule running out
 */
export function promoEffectiveStatus(event) {
  const status = event?.status || 'inactive'
  if ((status === 'active' || status === 'stop_pending') && promoHasEnded(event)) return 'expired'
  if (
    status === 'stopped' &&
    !(event?.stopped_by ?? event?.stoppedBy) &&
    String(event?.stop_reason ?? event?.stopReason ?? '') === 'Promo ended'
  ) {
    return 'expired'
  }
  return status
}

/** Badge label + tone for a promo status. One place, so no screen invents its own words. */
export function promoStatusBadge(event) {
  const status = promoEffectiveStatus(event)
  switch (status) {
    case 'active':
      return { status, label: 'Active', tone: 'success', hint: 'Selling now' }
    case 'stop_pending':
      return { status, label: 'Stop pending', tone: 'warn', hint: 'Stop requested, awaiting approval — still selling' }
    case 'stopped':
      return { status, label: 'Stopped', tone: 'danger', hint: 'Ended early by a manager' }
    case 'expired':
      return { status, label: 'Expired', tone: 'neutral', hint: 'Ran to its end date' }
    case 'pending':
      return { status, label: 'Pending', tone: 'warn', hint: 'Awaiting manager approval' }
    case 'rejected':
      return { status, label: 'Rejected', tone: 'danger', hint: 'Not approved' }
    case 'draft':
      return { status, label: 'Draft', tone: 'neutral', hint: 'Not submitted yet' }
    default:
      return { status, label: status || '—', tone: 'neutral', hint: '' }
  }
}

/**
 * Promo (Manager-hosted discounts)
 *
 * Live promo events are selected by:
 * - promo_events.branch_id = given branchId
 * - promo_events.status in (active, stop_pending) — several can be live at once
 *
 * Returns: [{ event, rules }] where rules includes ordered product ids.
 * When more than one event is live, POS applies the best discount per line
 * across all of them (see utils/promo.js computePromoDiscounts).
 */
export async function fetchActivePromoEventsWithRules(branchId, { respectDuration = true } = {}) {
  // Display truth (promoHasEnded) hides ended rows — no write-on-read expire here.
  const { data: events, error: eventError } = await supabase
    .from('promo_events')
    .select('id,name,status,starts_at,ends_at,stop_reason')
    .eq('branch_id', branchId)
    .in('status', ['active', 'stop_pending'])
    .order('created_at', { ascending: false })
    .limit(20)

  if (eventError) throw eventError

  let liveEvents = (events || []).filter(
    (e) => (e.status === 'active' || e.status === 'stop_pending') && !promoHasEnded(e),
  )

  if (!liveEvents.length) return []
  const loaded = await Promise.all(liveEvents.map((event) => loadPromoRulesForEvent(event, respectDuration)))
  return loaded.filter(Boolean)
}

/** Back-compat: first live promo event only. Prefer fetchActivePromoEventsWithRules. */
export async function fetchActivePromoEventWithRules(branchId, opts = {}) {
  const events = await fetchActivePromoEventsWithRules(branchId, opts)
  return events[0] || null
}

async function loadPromoRulesForEvent(event, respectDuration = true) {
  if (respectDuration) {
    const now = new Date()
    const startOk = !event.starts_at || new Date(event.starts_at) <= now
    const endOk = !event.ends_at || new Date(event.ends_at) >= now
    if (!startOk || !endOk) return null
  }

  let { data: rules, error: rulesError } = await supabase
    .from('promo_rules')
    .select('id,rule_type,discount_pct,buy_qty,get_qty,bundle_name')
    .eq('promo_event_id', event.id)

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
      discountPct: Number(r.discount_pct),
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

export async function fetchPromoRulesForEvent(promoEventId) {
  let { data: rules, error } = await supabase
    .from('promo_rules')
    .select('id,rule_type,discount_pct,buy_qty,get_qty,bundle_name')
    .eq('promo_event_id', promoEventId)
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
      discountPct: Number(r.discount_pct),
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

export async function createAndActivatePromoEvent({
  branchId,
  name,
  description = null,
  startsAt = null,
  endsAt = null,
  staffId = null,
  activateImmediately = false, // unused — dual-control always creates pending
}) {
  void activateImmediately
  const starts_iso = startsAt ? new Date(startsAt).toISOString() : null
  const ends_iso = endsAt ? new Date(endsAt).toISOString() : null
  const desc = description?.trim() || null

  // Dual-control: create as pending unless manager activates immediately after approve path.
  // New creates are always pending — never auto-activate.
  const payload = {
    branch_id: branchId,
    name,
    description: desc,
    status: 'pending',
    starts_at: starts_iso,
    ends_at: ends_iso,
    requested_by: staffId || null,
  }

  let { data, error } = await supabase.from('promo_events').insert(payload).select('id,name,status').single()
  if (error && isMissingColumnError(error, 'description')) {
    const withoutDescription = { ...payload }
    delete withoutDescription.description
    ;({ data, error } = await supabase
      .from('promo_events')
      .insert(withoutDescription)
      .select('id,name,status')
      .single())
  }
  if (error) throw error
  return { id: data.id, name: data.name, status: data.status || 'pending' }
}

export async function approvePromoEvent({ id, staffId }) {
  const { data, error } = await supabase.rpc('approve_promo_event', {
    p_promo_event_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

export async function rejectPromoEvent({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('reject_promo_event', {
    p_promo_event_id: id,
    p_staff_id: staffId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}

export async function requestStopPromo({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('request_stop_promo', {
    p_promo_event_id: id,
    p_staff_id: staffId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}

export async function approveStopPromo({ id, staffId }) {
  const { data, error } = await supabase.rpc('approve_stop_promo', {
    p_promo_event_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/**
 * Rejects a pending request to stop a promotion.
 * @param {string} id - The promotion event identifier.
 * @param {string} staffId - The staff member approving the rejection.
 * @returns {*} The result returned by the rejection operation.
 */
export async function rejectStopPromo({ id, staffId }) {
  const { data, error } = await supabase.rpc('reject_stop_promo', {
    p_promo_event_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/**
 * Fetches transaction lines attributed to a promotion within a date range.
 * @param {Object} params - Query parameters.
 * @param {string} params.branchId - Branch whose transactions to query.
 * @param {string} params.promoName - Promotion name assigned to the transaction lines.
 * @param {string} [params.startsAt] - Inclusive start of the query period.
 * @param {string} [params.endsAt] - Inclusive end of the query period.
 * @param {boolean} [params.minimal=false] - Whether to return only summary fields.
 * @returns {Promise<{lines: Array<Object>|null, legacy: boolean}>} The matching lines and whether legacy promotion reporting is required.
 * @throws {Error} If the query fails for a reason unrelated to unavailable promotion columns.
 */
async function fetchPromoAttributedLines({ branchId, promoName, startsAt, endsAt, minimal = false }) {
  const window = promoQueryWindow(startsAt, endsAt)
  const select = minimal
    ? 'transaction_id, discount_amount, transactions!inner(id, total_amount, created_at, status, branch_id)'
    : 'transaction_id, product_id, quantity, unit_price, line_total, discount_amount, promo_name, promo_group_id, transactions!inner(id, invoice_number, total_amount, discount_amount, created_at, status, staff_id, refunded_amount, branch_id)'

  const build = (from, to) => {
    let q = supabase
      .from('transaction_items')
      .select(select)
      .eq('promo_name', promoName)
      .eq('transactions.branch_id', branchId)
      .neq('transactions.status', 'voided')
      .gte('transactions.created_at', window.startsAt)
      .lte('transactions.created_at', window.endsAt)
      .order('transaction_id', { ascending: false })
      .range(from, to)
    return q
  }

  const { data, error } = await fetchAllRows(build)
  if (error) {
    if (/promo_name|promo_group_id|schema cache|column/i.test(String(error.message || ''))) {
      return { lines: null, legacy: true }
    }
    throw error
  }
  return { lines: data || [], legacy: false }
}

/**
 * Defines the bounded time window used for promotion history queries.
 * @param {string|Date} [startsAt] - The beginning of the query window.
 * @param {string|Date} [endsAt] - The end of the query window.
 * @returns {{startsAt: string, endsAt: string}} ISO 8601 timestamps for the query window, defaulting to the preceding 90 days when dates are omitted or invalid.
 */
function promoQueryWindow(startsAt, endsAt) {
  const end = endsAt ? new Date(endsAt) : new Date()
  const endMs = Number.isNaN(end.getTime()) ? Date.now() : end.getTime()
  let start = startsAt ? new Date(startsAt) : new Date(endMs - 90 * 86400000)
  const startMs = Number.isNaN(start.getTime()) ? endMs - 90 * 86400000 : start.getTime()
  const boundedStart = Math.min(startMs, endMs)
  return {
    startsAt: new Date(boundedStart).toISOString(),
    endsAt: new Date(endMs).toISOString(),
  }
}

const promoRulesByEventId = new Map()

/**
 * Loads and caches the rules associated with a promotion event.
 * @param {string} promoEventId - The promotion event identifier.
 * @returns {Promise<Array>} The promotion rules, or an empty array when no identifier is provided or the rules cannot be loaded.
 */
async function loadPromoRulesCached(promoEventId) {
  if (!promoEventId) return []
  if (promoRulesByEventId.has(promoEventId)) return promoRulesByEventId.get(promoEventId)
  const rules = await fetchPromoRulesForEvent(promoEventId).catch(() => [])
  promoRulesByEventId.set(promoEventId, rules)
  return rules
}

/**
 * Enriches promotional sales lines with their associated product details.
 * @param {Array<Object>} lines - Promotional sales lines containing product IDs.
 * @returns {Promise<Array<Object>>} The sales lines with product information attached when available.
 */
async function hydratePromoLineProducts(lines = []) {
  const ids = [...new Set(lines.map((l) => l.product_id).filter(Boolean))]
  if (!ids.length) return lines
  const { data, error } = await supabase
    .from('products')
    .select('id, name, sku, pricing_mode')
    .in('id', ids)
  if (error) return lines
  const byId = Object.fromEntries((data || []).map((p) => [p.id, p]))
  return lines.map((line) => ({
    ...line,
    products: byId[line.product_id] || line.products || null,
  }))
}

/**
 * Summarize sales attributed to a promotion.
 * @param {Array<Object>} matchedLines - Promotion-attributed transaction lines.
 * @param {Array<Object>} [rules=[]] - Promotion rules used to aggregate offers.
 * @param {Object} [options] - Summary options.
 * @param {number|null} [options.receiptLimit=null] - Maximum number of transactions included in `matchedTxns`.
 * @returns {Object} Aggregated receipt count, discount total, sale total, offers, items, and matching transactions.
 */
function promoStatsFromAttributedLines(matchedLines, rules = [], { receiptLimit = null } = {}) {
  const txnMap = new Map()
  for (const line of matchedLines) {
    const t = line.transactions
    if (t?.id && !txnMap.has(t.id)) txnMap.set(t.id, t)
  }
  const matchedTxns = [...txnMap.values()].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  )
  const receiptTxns =
    receiptLimit && matchedTxns.length > receiptLimit
      ? matchedTxns.slice(0, receiptLimit)
      : matchedTxns
  const discountTotal = Number(
    matchedLines.reduce((sum, l) => sum + Number(l.discount_amount || 0), 0).toFixed(2),
  )
  const saleTotal = Number(
    matchedTxns.reduce((sum, t) => sum + Number(t.total_amount || 0), 0).toFixed(2),
  )
  return {
    receiptCount: matchedTxns.length,
    discountTotal,
    saleTotal,
    offers: aggregatePromoSalesOffers(matchedLines, rules),
    items: aggregatePromoItems(matchedLines),
    matchedTxns: receiptTxns,
  }
}

/**
 * Aggregates promotional sales lines by product and ranks them by discount amount.
 * @param {Array<Object>} lines - Promotional sales lines to aggregate.
 * @returns {Array<Object>} Product summaries with quantity, gross sales, discount, and net sales totals.
 */
function aggregatePromoItems(lines = []) {
  const byProduct = {}
  for (const line of lines) {
    const productId = line.products?.id || line.product_id || 'unknown'
    if (!byProduct[productId]) {
      byProduct[productId] = {
        productId,
        name: line.products?.name || 'Product',
        sku: line.products?.sku || '',
        pricingMode: line.products?.pricing_mode === 'per_kg' ? 'kg' : 'pc',
        qty: 0,
        gross: 0,
        discount: 0,
        net: 0,
      }
    }
    const qty = Number(line.quantity || 0)
    const gross = Number(line.line_total || 0)
    const discount = Number(line.discount_amount || 0)
    byProduct[productId].qty += qty
    byProduct[productId].gross += gross
    byProduct[productId].discount += discount
    byProduct[productId].net += Math.max(0, gross - discount)
  }
  return Object.values(byProduct)
    .map((row) => ({
      ...row,
      qty: Number(row.qty.toFixed(3)),
      gross: Number(row.gross.toFixed(2)),
      discount: Number(row.discount.toFixed(2)),
      net: Number(row.net.toFixed(2)),
    }))
    .sort((a, b) => b.discount - a.discount)
}

async function buildPromoReceipts(rows) {
  const staffNames = await staffNameById(rows.map((r) => r.staff_id))
  return rows.map((r) => {
    const created = r.created_at ? new Date(r.created_at) : null
    return {
      id: r.id,
      invoiceNumber: r.invoice_number || null,
      total: Number(r.total_amount || 0),
      discountAmount: Number(r.discount_amount || 0),
      refundedAmount: Number(r.refunded_amount || 0),
      cashier: staffNames[r.staff_id] || 'Staff',
      createdAt: r.created_at || null,
      time:
        created && !Number.isNaN(created.getTime())
          ? created.toLocaleString([], {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '—',
    }
  })
}

/**
 * Aggregates promotion sales by matching transactions whose discount type equals the promotion name.
 *
 * @param {string} branchId - The branch whose promotion sales are queried.
 * @param {string} promoName - The promotion name stored as the transaction discount type.
 * @param {string} [startsAt] - Inclusive start of the reporting period.
 * @param {string} [endsAt] - Inclusive end of the reporting period.
 * @param {Array} [rules=[]] - Promotion rules used to aggregate matching offer data.
 * @returns {{receiptCount: number, discountTotal: number, saleTotal: number, items: Array, offers: Array, receipts: Array}} Aggregated receipt, discount, sale, item, offer, and receipt data.
 */
async function fetchPromoSalesStatsLegacy({ branchId, promoName, startsAt, endsAt, rules = [] }) {
  const window = promoQueryWindow(startsAt, endsAt)
  let txnQ = supabase
    .from('transactions')
    .select(
      'id, invoice_number, total_amount, discount_amount, discount_type, created_at, status, staff_id, refunded_amount',
    )
    .eq('branch_id', branchId)
    .eq('discount_type', promoName)
    .neq('status', 'voided')
    .gte('created_at', window.startsAt)
    .lte('created_at', window.endsAt)
    .order('created_at', { ascending: false })
    .limit(500)

  const { data: txns, error: txnErr } = await txnQ
  if (txnErr) {
    if (/discount_type|discount_amount|schema cache|column/i.test(String(txnErr.message || ''))) {
      return { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], offers: [], receipts: [] }
    }
    throw txnErr
  }

  const rows = txns || []
  const receiptCount = rows.length
  const discountTotal = Number(rows.reduce((sum, r) => sum + Number(r.discount_amount || 0), 0).toFixed(2))
  const saleTotal = Number(rows.reduce((sum, r) => sum + Number(r.total_amount || 0), 0).toFixed(2))
  const txnIds = rows.map((r) => r.id)
  const receipts = await buildPromoReceipts(rows)
  if (!txnIds.length) {
    return { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], offers: [], receipts: [] }
  }

  const { data: lines, error: lineErr } = await supabase
    .from('transaction_items')
    .select(
      'transaction_id, quantity, unit_price, line_total, discount_amount, promo_group_id, products(id, name, sku, pricing_mode)',
    )
    .in('transaction_id', txnIds)
    .gt('discount_amount', 0)
  if (lineErr) {
    return { receiptCount, discountTotal, saleTotal, items: [], offers: [], receipts }
  }

  const matchedLines = lines || []
  return {
    receiptCount,
    discountTotal,
    saleTotal,
    items: aggregatePromoItems(matchedLines),
    offers: aggregatePromoSalesOffers(matchedLines, rules),
    receipts,
  }
}

/**
 * Summarize sales totals attributed to a promotion within an optional date range.
 * @param {Object} params - Promotion and date-range filters.
 * @param {string} params.branchId - Branch identifier.
 * @param {string} params.promoName - Promotion name.
 * @param {string|null} [params.startsAt=null] - Inclusive start timestamp.
 * @param {string|null} [params.endsAt=null] - Inclusive end timestamp.
 * @returns {{receiptCount: number, discountTotal: number, saleTotal: number}} Aggregate receipt count, discount total, and sale total.
 */
export async function fetchPromoSalesStatsSummary({
  branchId,
  promoName,
  startsAt = null,
  endsAt = null,
} = {}) {
  const empty = { receiptCount: 0, discountTotal: 0, saleTotal: 0 }
  if (!branchId || !promoName) return empty

  const lineResult = await fetchPromoAttributedLines({
    branchId,
    promoName,
    startsAt,
    endsAt,
    minimal: true,
  })
  if (lineResult.legacy) {
    const full = await fetchPromoSalesStatsLegacy({ branchId, promoName, startsAt, endsAt, rules: [] })
    return {
      receiptCount: full.receiptCount,
      discountTotal: full.discountTotal,
      saleTotal: full.saleTotal,
    }
  }

  const matchedLines = lineResult.lines || []
  if (!matchedLines.length) return empty
  const stats = promoStatsFromAttributedLines(matchedLines, [])
  return {
    receiptCount: stats.receiptCount,
    discountTotal: stats.discountTotal,
    saleTotal: stats.saleTotal,
  }
}

/**
 * Aggregates sales performance for a promotion by its per-line attribution.
 * @param {Object} options - Promotion sales query options.
 * @param {string} options.branchId - Branch to query.
 * @param {string} options.promoName - Promotion name used for line attribution.
 * @param {string|null} [options.promoEventId=null] - Promotion event identifier used to resolve its rules.
 * @param {string|null} [options.startsAt=null] - Inclusive start of the sales period.
 * @param {string|null} [options.endsAt=null] - Inclusive end of the sales period.
 * @param {number} [options.receiptLimit=200] - Maximum number of receipt details to include.
 * @returns {Promise<Object>} Aggregated receipt count, discount total, sale total, item and offer summaries, receipt details, and whether the receipt list was truncated.
 */
export async function fetchPromoSalesStats({
  branchId,
  promoName,
  promoEventId = null,
  startsAt = null,
  endsAt = null,
  receiptLimit = 200,
} = {}) {
  const empty = { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], offers: [], receipts: [] }
  if (!branchId || !promoName) return empty

  const [rules, lineResult] = await Promise.all([
    loadPromoRulesCached(promoEventId),
    fetchPromoAttributedLines({ branchId, promoName, startsAt, endsAt, minimal: false }),
  ])

  if (lineResult.legacy) {
    return fetchPromoSalesStatsLegacy({ branchId, promoName, startsAt, endsAt, rules })
  }

  let matchedLines = lineResult.lines || []
  if (!matchedLines.length) return empty

  matchedLines = await hydratePromoLineProducts(matchedLines)
  const stats = promoStatsFromAttributedLines(matchedLines, rules, { receiptLimit })
  const receipts = await buildPromoReceipts(stats.matchedTxns)
  return {
    receiptCount: stats.receiptCount,
    discountTotal: stats.discountTotal,
    saleTotal: stats.saleTotal,
    items: stats.items,
    offers: stats.offers,
    receipts,
    receiptsTruncated: stats.receiptCount > receipts.length,
  }
}

/**
 * Retrieves the status of a promotion event.
 * @param {string} promoEventId - The promotion event identifier.
 * @return {string|null} The event status, or `null` if no matching event exists.
 */
async function fetchPromoEventStatus(promoEventId) {
  const { data, error } = await supabase.from('promo_events').select('status').eq('id', promoEventId).maybeSingle()
  if (error) throw error
  return data?.status || null
}

async function assertPromoEventPending(promoEventId) {
  const status = await fetchPromoEventStatus(promoEventId)
  if (!status) throw new Error('Promo event not found.')
  if (status !== 'pending') {
    throw new Error('Approved promos cannot be modified. Request an edit for manager reapproval.')
  }
}

async function assertPromoRuleMutable(promoRuleId) {
  const { data, error } = await supabase
    .from('promo_rules')
    .select('promo_event_id, promo_events(status)')
    .eq('id', promoRuleId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Promo rule not found.')
  const status = data.promo_events?.status
  if (status !== 'pending') {
    throw new Error('Approved promos cannot be modified. Request an edit for manager reapproval.')
  }
}

/** promo_event_id → Set of rule_type values. */
export async function fetchPromoRuleTypesForEvents(eventIds = []) {
  const ids = [...new Set((eventIds || []).filter(Boolean))]
  if (!ids.length) return {}
  const { data, error } = await supabase.from('promo_rules').select('promo_event_id, rule_type').in('promo_event_id', ids)
  if (error) throw error
  const map = {}
  for (const row of data || []) {
    if (!map[row.promo_event_id]) map[row.promo_event_id] = []
    map[row.promo_event_id].push(row.rule_type)
  }
  return map
}

export async function requestPromoEdit({ promoEventId, staffId }) {
  const { data, error } = await supabase.rpc('request_promo_edit', {
    p_promo_event_id: promoEventId,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

export async function createPromoWithRules({
  branchId,
  name,
  description = null,
  startsAt = null,
  endsAt = null,
  staffId = null,
  rules = [],
}) {
  if (!rules?.length) {
    throw new Error('Add at least one promo rule before submitting.')
  }
  const event = await createAndActivatePromoEvent({
    branchId,
    name,
    description,
    startsAt,
    endsAt,
    staffId,
  })
  for (const rule of rules) {
    await createPromoRule({
      promoEventId: event.id,
      ruleType: rule.ruleType,
      discountPct: rule.discountPct,
      productIds: rule.productIds,
      buyQty: rule.buyQty ?? 1,
      getQty: rule.getQty ?? 1,
      bundleName: rule.bundleName ?? null,
    })
  }
  return event
}

const PROMO_RULE_MIN_PRODUCTS = { pair_pct: 2, bundle_pct: 2, item_pct: 1, bogo_pct: 1 }

/**
 * Create the same promo (event + rules) on several branches at once.
 *
 * `products` table rows are per-branch — a product id picked while building the rules on
 * one (reference) branch doesn't exist on any other branch's row set. Each target branch's
 * catalog is matched by SKU instead, so `rules[].skus` (not productIds) is what this takes.
 * A branch missing a SKU just drops that product from its copy of the rule; if a rule falls
 * below its minimum product count on a branch (e.g. only one side of a pair matched), that
 * rule is skipped for that branch rather than failing the whole promo there.
 */
export async function createPromoAcrossBranches({
  branchIds,
  name,
  description = null,
  startsAt = null,
  endsAt = null,
  staffId = null,
  rules = [], // [{ ruleType, discountPct, buyQty, getQty, bundleName, skus: [...] }]
  onProgress = null, // ({ branchId, index, total }) => void — called before each branch starts
}) {
  const ids = [...new Set((branchIds || []).filter(Boolean))]
  if (!ids.length) throw new Error('Select at least one branch.')
  if (!rules?.length) throw new Error('Add at least one promo rule before submitting.')

  const results = []
  for (const branchId of ids) {
    onProgress?.({ branchId, index: results.length, total: ids.length })
    try {
      const branchProducts = await fetchBranchProducts(branchId)
      const bySku = new Map(
        branchProducts.map((p) => [String(p.sku || '').trim().toLowerCase(), p.id]),
      )

      const skippedSkus = new Set()
      const branchRules = []
      for (const rule of rules) {
        const productIds = (rule.skus || [])
          .map((sku) => bySku.get(String(sku || '').trim().toLowerCase()))
          .filter(Boolean)
        if (productIds.length < (rule.skus || []).length) {
          for (const sku of rule.skus || []) {
            if (!bySku.has(String(sku || '').trim().toLowerCase())) skippedSkus.add(sku)
          }
        }
        const minRequired = PROMO_RULE_MIN_PRODUCTS[rule.ruleType] ?? 1
        if (productIds.length < minRequired) continue
        branchRules.push({ ...rule, productIds })
      }

      if (!branchRules.length) {
        results.push({ branchId, status: 'skipped', reason: 'No matching products on this branch.' })
        continue
      }

      const event = await createPromoWithRules({
        branchId,
        name,
        description,
        startsAt,
        endsAt,
        staffId,
        rules: branchRules,
      })
      results.push({
        branchId,
        status: 'created',
        eventId: event.id,
        skippedSkus: [...skippedSkus],
        skippedRules: rules.length - branchRules.length,
      })
    } catch (e) {
      results.push({ branchId, status: 'error', error: e?.message || 'Failed to create promo.' })
    }
  }
  return results
}

/**
 * Clone an existing promo (any status) — name, dates, and rules — onto other branches, e.g.
 * a branch left out of the original multi-branch create, or one that only just adopted the
 * products. Reuses `createPromoAcrossBranches`'s per-branch SKU matching, so a target branch
 * missing a product just skips it the same way a fresh multi-branch create would.
 */
export async function copyPromoEventToBranches({ promoEventId, branchIds, staffId = null }) {
  let { data: source, error } = await supabase
    .from('promo_events')
    .select('name, description, starts_at, ends_at')
    .eq('id', promoEventId)
    .single()
  if (error && isMissingColumnError(error, 'description')) {
    ;({ data: source, error } = await supabase
      .from('promo_events')
      .select('name, starts_at, ends_at')
      .eq('id', promoEventId)
      .single())
  }
  if (error) throw error

  const rules = await fetchPromoRulesForEvent(promoEventId)
  if (!rules.length) throw new Error('This promo has no rules to copy.')

  return createPromoAcrossBranches({
    branchIds,
    name: source.name,
    description: source.description || null,
    startsAt: source.starts_at,
    endsAt: source.ends_at,
    staffId,
    rules: rules.map((r) => ({
      ruleType: r.ruleType,
      discountPct: r.discountPct,
      buyQty: r.buyQty,
      getQty: r.getQty,
      bundleName: r.bundleName,
      skus: (r.products || []).map((p) => p.sku).filter(Boolean),
    })),
  })
}

export async function createPromoRule({
  promoEventId,
  ruleType,
  discountPct,
  productIds,
  buyQty = 1,
  getQty = 1,
  bundleName = null,
}) {
  await assertPromoEventPending(promoEventId)
  const payload = {
    promo_event_id: promoEventId,
    rule_type: ruleType,
    discount_pct: discountPct,
    buy_qty: buyQty,
    get_qty: getQty,
    // Only bundle_pct rules ever carry a name — every other rule type passes null, which
    // is a no-op write, not worth a separate branch.
    ...(bundleName ? { bundle_name: bundleName } : {}),
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
  }

  return rule
}

/**
 * Partial update of a promo event's editable details (name and/or schedule).
 *
 * Each field is only written when the caller explicitly passes it — `undefined` means
 * "leave alone", `null` means "clear". Without that guard a rename-only call would null
 * out starts_at/ends_at and silently un-schedule a live promo. Same convention as
 * updateProductRow's discount_eligible guard; keep it if you add more optional fields.
 */
export async function updatePromoEventDetails({ promoEventId, name, description, startsAt, endsAt }) {
  await assertPromoEventPending(promoEventId)
  const toIso = (value) => (value ? new Date(value).toISOString() : null)

  const payload = {
    ...(typeof name === 'string' ? { name } : {}),
    ...(description !== undefined ? { description: description?.trim() || null } : {}),
    ...(startsAt !== undefined ? { starts_at: toIso(startsAt) } : {}),
    ...(endsAt !== undefined ? { ends_at: toIso(endsAt) } : {}),
    updated_at: new Date().toISOString(),
  }

  let { data, error } = await supabase.from('promo_events').update(payload).eq('id', promoEventId).select('id,name')
  if (error && isMissingColumnError(error, 'description')) {
    const withoutDescription = { ...payload }
    delete withoutDescription.description
    ;({ data, error } = await supabase
      .from('promo_events')
      .update(withoutDescription)
      .eq('id', promoEventId)
      .select('id,name'))
  }
  if (error) throw error
  return data
}

export async function deletePromoRule(promoRuleId) {
  await assertPromoRuleMutable(promoRuleId)
  const { data, error } = await supabase.from('promo_rules').delete().eq('id', promoRuleId).select('id').maybeSingle()
  if (error) throw error
  return data
}

export async function fetchPromoEventsForBranch(branchId) {
  await expireEndedPromos()
  const { data, error } = await supabase
    .from('promo_events')
    .select(
      'id,name,description,status,starts_at,ends_at,created_at,stop_reason,reject_reason,requested_by,approved_by,stop_requested_by,supersedes_event_id',
    )
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })

  if (error && isMissingColumnError(error, 'supersedes_event_id')) {
    const retry = await supabase
      .from('promo_events')
      .select(
        'id,name,description,status,starts_at,ends_at,created_at,stop_reason,reject_reason,requested_by,approved_by,stop_requested_by',
      )
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
    if (!retry.error) return retry.data || []
  }

  if (error && isMissingColumnError(error, 'reject_reason')) {
    const retry = await supabase
      .from('promo_events')
      .select(
        'id,name,description,status,starts_at,ends_at,created_at,stop_reason,requested_by,approved_by,stop_requested_by',
      )
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
    if (!retry.error) return retry.data || []
  }

  if (error && isMissingColumnError(error, 'description')) {
    const retry = await supabase
      .from('promo_events')
      .select(
        'id,name,status,starts_at,ends_at,created_at,stop_reason,requested_by,approved_by,stop_requested_by',
      )
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
    if (!retry.error) return retry.data || []
  }
  if (error) throw error
  return data || []
}

/** Manager overview: live promos on every branch (no branch filter). */
export async function fetchActivePromosAcrossBranches() {
  await expireEndedPromos()
  const branchRows = await fetchBranches().catch(() => [])
  const branchNameById = Object.fromEntries((branchRows || []).map((b) => [b.id, b.name]))

  const mapRow = (row) => ({
    id: row.id,
    name: row.name,
    status: row.status || 'inactive',
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    branch_id: row.branch_id,
    branchName: branchNameById[row.branch_id] || row.branches?.name || 'Branch',
    stop_reason: row.stop_reason || null,
  })

  const isLive = (row) => {
    if (promoHasEnded(row)) return false
    const status = String(row.status || '').toLowerCase()
    return status === 'active' || status === 'stop_pending'
  }

  const { data, error } = await supabase
    .from('promo_events')
    .select('id,name,status,starts_at,ends_at,created_at,branch_id,stop_reason')
    .in('status', ['active', 'stop_pending'])
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) throw error
  return (data || []).filter(isLive).map(mapRow)
}

/** Manager overview: full promo history (every status) on every branch, tagged with branch name. */
export async function fetchPromoEventsAcrossBranches() {
  const branchRows = await fetchBranches().catch(() => [])
  const rowsByBranch = await Promise.all(
    (branchRows || []).map(async (b) => {
      const rows = await fetchPromoEventsForBranch(b.id).catch(() => [])
      return rows.map((r) => ({ ...r, branch_id: b.id, branchName: b.name }))
    }),
  )
  return rowsByBranch
    .flat()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

export async function deletePromoEvent(promoEventId) {
  const { data, error } = await supabase.from('promo_events').delete().eq('id', promoEventId).select('id').maybeSingle()
  if (error) throw error
  return data
}
