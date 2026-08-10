import { allowDemoMode, supabase } from './supabase'
import { mapDayReport } from '../utils/dayEndReport'
import { appError } from '../utils/errors'
import { localDateKey, rowBusinessDate, today } from '../utils/format'
import { pinAuthEmail } from '../utils/roles'
import { normalizeMenuKind } from '../utils/ulam'
import { clearUnlockSecret, loadUnlockSecret, saveUnlockSecret } from '../offline/session'
import { createVerifier, isVerifierExpired, verifyAgainst } from '../utils/unlockVerifier'
import { APP_VERSION } from '../utils/version'

export const hasSupabase = Boolean(supabase)
export { allowDemoMode }

const mapPricing = (mode) => (mode === 'per_kg' || mode === 'kg' ? 'kg' : 'pc')
const toDbPricing = (mode) => (mode === 'kg' ? 'per_kg' : 'per_unit')

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
  }
}

function isMissingColumnError(error, column) {
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
const PAGE_ROWS = 1000

async function fetchAllRows(build) {
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

async function writeProductRow(mode, payload, { id } = {}) {
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
async function staffNameById(ids) {
  const identities = await fetchStaffIdentities(ids)
  return Object.fromEntries(Object.entries(identities).map(([id, who]) => [id, who.name]))
}

function withCashierName(row, names) {
  if (!row) return row
  const name = names?.[row.staff_id]
  if (!name) return row
  return { ...row, staff: { full_name: name } }
}

/**
 * Attach the approver's name/role to a row that carries an approver id. Applied after the
 * fact rather than joined, for the multi-FK reason above.
 */
function withApprover(row, identities, field = 'void_approved_by') {
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
    orNumber: row.or_number || null,
    time: Number.isNaN(created.getTime())
      ? '—'
      : created.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    cashier: row.staff?.full_name || 'Staff',
    total,
    refundedAmount,
    netTotal: Math.max(0, Number((total - refundedAmount).toFixed(2))),
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
  const build = (from, to) => {
    let q = supabase
      .from('stock_movements')
      .select(cols)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .range(from, to)
    if (start) q = q.gte('created_at', `${start}T00:00:00`)
    if (end) q = q.lte('created_at', `${end}T23:59:59.999`)
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
  const orNumbers = await resolveMovementReferences(rows)
  return rows.map((row) =>
    mapMovement({
      ...row,
      staff_name: who[row.staff_id]?.name || null,
      product: row.products?.name || '',
      reference: readableReference(row, orNumbers),
    }),
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `stock_movements.reference` holds whatever caused the movement, and for a sale that is the
 * transaction's internal id — a UUID nobody can look a receipt up with, printed in a column
 * staff read. Trade it for the OR number, which is the one identifier that appears on the
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
      .select('id, or_number')
      .in('id', ids.slice(i, i + 200))
    if (error) return map // a missing OR is cosmetic; never fail the whole history for it
    for (const t of data || []) if (t.or_number) map[t.id] = t.or_number
  }
  return map
}

/** Human-readable reference, or nothing. A bare id is noise, not information. */
function readableReference(row, orNumbers) {
  const raw = String(row.reference || '')
  if (!raw) return ''
  // or_number already carries its own prefix (e.g. "OR-00000001", or a branch's own
  // or_prefix) — prepending "OR " here duplicated it as "OR OR-00000001".
  if (orNumbers[raw]) return orNumbers[raw]
  // Import batch ids and unresolvable sale ids both land here — say nothing rather than
  // print a key the reader cannot act on.
  return UUID_RE.test(raw) ? '' : raw
}

export async function fetchSessionStaff() {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth?.user) return null
  const selectFull =
    'id, full_name, role, branch_id, is_active, login_code, permissions, branches(id, name, address, is_active, day_open_hour, branch_type, device_settings, vat_rate)'
  const selectBase =
    'id, full_name, role, branch_id, is_active, branches(id, name, address, is_active, day_open_hour, branch_type)'
  let { data, error } = await supabase
    .from('staff')
    .select(selectFull)
    .eq('auth_user_id', auth.user.id)
    .eq('is_active', true)
    .maybeSingle()
  if (error && /login_code|permissions|vat_rate|device_settings|schema cache|column/i.test(String(error.message || ''))) {
    ;({ data, error } = await supabase
      .from('staff')
      .select(selectBase)
      .eq('auth_user_id', auth.user.id)
      .eq('is_active', true)
      .maybeSingle())
  }
  if (error) throw error
  if (!data) return null
  return {
    id: data.id,
    authUserId: auth.user.id,
    email: auth.user.email,
    name: data.full_name,
    role: data.role,
    branchId: data.branch_id,
    branchName: data.branches?.name || 'Branch',
    branchAddress: data.branches?.address || '',
    branchType: data.branches?.branch_type === 'restaurant' ? 'restaurant' : 'retail',
    dayOpenHour: Number(data.branches?.day_open_hour ?? 7),
    deviceSettings: data.branches?.device_settings || null,
    vatRate: Number(data.branches?.vat_rate ?? 0.12),
    loginCode: data.login_code || null,
    permissions: Array.isArray(data.permissions) ? data.permissions : null,
  }
}

export async function signIn(email, password, { captchaToken } = {}) {
  const { error } = await supabase.auth.signInWithPassword({
    email,
    password,
    options: captchaToken ? { captchaToken } : undefined,
  })
  if (error) throw error
  return fetchSessionStaff()
}

/** Cashier/supervisor PIN login via staff code + PIN. */
export async function signInWithPin(loginCode, pin, { captchaToken } = {}) {
  const code = String(loginCode || '').replace(/\D/g, '')
  // Complex PINs: keep letters/symbols (do not strip to digits).
  const pinVal = String(pin || '').trim()
  if (!captchaToken) {
    throw new Error('Complete the security check before signing in.')
  }
  const { data, error } = await supabase.rpc('resolve_pin_login', {
    p_login_code: code,
    p_pin: pinVal,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row?.auth_email) throw new Error('Invalid staff code or PIN')
  // RPC no longer returns Auth password — sign in with the till PIN after server validated it.
  return signIn(row.auth_email, pinVal, { captchaToken })
}

export async function verifySupervisorPin(branchId, loginCode, pin) {
  const { data, error } = await supabase.rpc('verify_supervisor_pin', {
    p_branch_id: branchId,
    p_login_code: String(loginCode || '').replace(/\D/g, ''),
    p_pin: String(pin || '').trim(),
  })
  if (error) throw error
  // Hardened RPC returns table rows; older builds returned a bare uuid string.
  if (typeof data === 'string') return { staff_id: data, full_name: null }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    staff_id: row.staff_id || row.id || null,
    full_name: row.full_name || row.name || null,
  }
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function claimStaffSession(staffId, sessionId) {
  const { error } = await supabase.rpc('claim_staff_session', {
    p_staff_id: staffId,
    p_session_id: sessionId,
  })
  if (error) throw error
  return true
}

export async function heartbeatStaffSession(staffId, sessionId) {
  const { error } = await supabase.rpc('heartbeat_staff_session', {
    p_staff_id: staffId,
    p_session_id: sessionId,
  })
  if (error) throw error
  return true
}

export async function releaseStaffSession(staffId, sessionId) {
  if (!staffId || !sessionId) return true
  const { error } = await supabase.rpc('release_staff_session', {
    p_staff_id: staffId,
    p_session_id: sessionId,
  })
  if (error) console.warn('release_staff_session:', error.message)
  return true
}

const MANAGER_UNLOCK_SESSION_KEY = 'cale-manager-unlock-v1'

/**
 * Remember a password verifier for lock-screen unlock.
 *
 * Session stays signed in — this only compares locally, so the lock screen keeps working
 * with no network (blackout, ISP outage). The stored value is a PBKDF2 verifier, never the
 * password and never a fast hash — see src/utils/unlockVerifier.js for the threat model.
 */
export async function setManagerUnlockSecret(staffId, password) {
  if (!staffId || password == null || password === '') return
  const record = await createVerifier(staffId, password)
  try {
    sessionStorage.setItem(MANAGER_UNLOCK_SESSION_KEY, JSON.stringify(record))
  } catch {
    /* ignore */
  }
  try {
    await saveUnlockSecret(staffId, record)
  } catch {
    /* ignore */
  }
}

export async function clearManagerUnlockSecret() {
  try {
    sessionStorage.removeItem(MANAGER_UNLOCK_SESSION_KEY)
  } catch {
    /* ignore */
  }
  try {
    await clearUnlockSecret()
  } catch {
    /* ignore */
  }
}

/** Load the verifier record (v2 PBKDF2, or a legacy v1 digest pending upgrade). */
async function readUnlockRecord(staffId) {
  try {
    const raw = sessionStorage.getItem(MANAGER_UNLOCK_SESSION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.staffId === staffId && (parsed.hash || parsed.digest)) return parsed
    }
  } catch {
    /* ignore */
  }
  try {
    const row = await loadUnlockSecret(staffId)
    if (row?.hash || row?.digest) {
      try {
        sessionStorage.setItem(MANAGER_UNLOCK_SESSION_KEY, JSON.stringify({ staffId, ...row }))
      } catch {
        /* ignore */
      }
      return { staffId, ...row }
    }
  } catch {
    /* ignore */
  }
  return null
}

/**
 * Lock-screen unlock for managers — verified entirely on-device so it works with no
 * network. Comparison is constant-time PBKDF2; see src/utils/unlockVerifier.js.
 */
export async function verifyAccountPassword(_email, password, { staffId = null } = {}) {
  const pwd = String(password || '')
  if (!pwd) throw new Error('Enter your password')
  if (!staffId) throw new Error('No staff session to unlock')

  const record = await readUnlockRecord(staffId)
  if (!record) {
    throw new Error('Unlock not available for this session. Sign out and sign in again.')
  }
  // A verifier that has sat on a device for a month must be refreshed by a real sign-in —
  // bounds how long a walked-off terminal keeps something worth attacking.
  if (isVerifierExpired(record)) {
    await clearManagerUnlockSecret()
    throw new Error('Unlock expired for security. Sign out and sign in with your password.')
  }

  const { ok, needsUpgrade } = await verifyAgainst(record, staffId, pwd)
  if (!ok) throw new Error('Incorrect password')

  // Correct password + weak/outdated stored form: rewrite it now, while we legitimately
  // hold the plaintext. This is what retires the old unsalted SHA-256 records without
  // locking out a terminal that is offline at upgrade time.
  if (needsUpgrade) {
    try {
      await setManagerUnlockSecret(staffId, pwd)
    } catch {
      /* non-fatal — unlock already succeeded */
    }
  }
  return true
}

export async function verifyOwnPin(staffId, pin) {
  const { error } = await supabase.rpc('verify_own_pin', {
    p_staff_id: staffId,
    p_pin: String(pin || '').trim(),
  })
  if (error) throw error
  return true
}

/** Persist device session id across reloads of the same browser tab. */
export function getOrCreateDeviceSessionId() {
  const key = 'cale-pos-device-session'
  try {
    let id = sessionStorage.getItem(key)
    if (!id) {
      id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`
      sessionStorage.setItem(key, id)
    }
    return id
  } catch {
    return `sess_${Date.now()}`
  }
}

export function clearDeviceSessionId() {
  try {
    sessionStorage.removeItem('cale-pos-device-session')
  } catch {
    /* ignore */
  }
}

const BOOTSTRAP_PRODUCT_COLS =
  'id, branch_id, name, sku, barcode, category_id, menu_kind, pricing_mode, price, unit_cost, budget_price, low_stock_threshold, available_today, discount_eligible, product_no, created_at, categories(name)'
const BOOTSTRAP_TX_COLS =
  'id, or_number, status, total_amount, refunded_amount, amount_tendered, change_given, created_at, staff_id, branch_id, shift_id, void_reason, voided_at, voided_by, void_approved_by, client_id, order_type, ulam_combo, payment_method, payment_reference, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, vat_rate_applied, discount_amount, discount_type, discount_id_note, transaction_items(id)'
// Pre migrate_vat_breakdown.sql fallback (see bootstrapBranchData / fetchTerminalReportSource).
const BOOTSTRAP_TX_COLS_LEGACY =
  'id, or_number, status, total_amount, refunded_amount, amount_tendered, change_given, created_at, staff_id, branch_id, void_reason, voided_at, voided_by, void_approved_by, client_id, order_type, ulam_combo, payment_method, payment_reference, vat_amount, vatable_sales, discount_amount, discount_type, discount_id_note, transaction_items(id)'
const BOOTSTRAP_MOVE_COLS =
  'id, created_at, product_id, movement_type, quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price, detail, branch_id, products(name)'
const BOOTSTRAP_DAY_END_COLS =
  'id, business_date, recorded_cash, cash_on_hand, variance, expected_cash, note, status, closed_at, submitted_at, approved_at, reopened_at, reopen_reason, day_report, staff_id, branch_id, staff!staff_id(full_name), requested_at, requested_by, request_manager, reopen_requested_at, reopen_requested_by, reopen_request_reason'
const BOOTSTRAP_DAY_END_COLS_LEGACY =
  'id, business_date, recorded_cash, cash_on_hand, variance, note, status, closed_at, staff_id, branch_id, staff!staff_id(full_name)'

export async function bootstrapBranchData(branchId) {
  // Everything that reads the store's dayEnds (DayEnd.jsx's today lookup, Dashboard's
  // previous-day restock report) only ever needs recent days — unlike transactions/
  // stock_movements above, this query had no bound at all, so it grew unbounded for the
  // life of the branch. 90 days is generous headroom over "today"/"yesterday"; historical
  // reporting goes through Reports.jsx's own date-ranged queries, not this snapshot.
  const dayEndsCutoff = localDateKey(new Date(Date.now() - 90 * 86400000))
  const [productsRes, inventoryRes, txRes, moveRes, dayResInitial, catsRes, branchRes] = await Promise.all([
    // Paged: a branch with >1000 products would otherwise be silently truncated.
    fetchAllRows((from, to) =>
      supabase
        .from('products')
        .select(BOOTSTRAP_PRODUCT_COLS)
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .order('name')
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from('branch_inventory')
        .select('product_id, quantity_on_hand, updated_at')
        .eq('branch_id', branchId)
        .order('product_id')
        .range(from, to),
    ),
    supabase
      .from('transactions')
      .select(BOOTSTRAP_TX_COLS)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('stock_movements')
      .select(BOOTSTRAP_MOVE_COLS)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('day_ends')
      .select(BOOTSTRAP_DAY_END_COLS)
      .eq('branch_id', branchId)
      .gte('business_date', dayEndsCutoff)
      .order('business_date', { ascending: false }),
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('branches').select('id, day_open_hour').eq('id', branchId).maybeSingle(),
  ])

  let dayRes = dayResInitial
  if (
    dayRes.error &&
    /expected_cash|submitted_at|approved_at|reopened_at|reopen_reason|reopen_requested|day_report|schema cache|column/i.test(
      String(dayRes.error.message || ''),
    )
  ) {
    dayRes = await supabase
      .from('day_ends')
      .select(BOOTSTRAP_DAY_END_COLS_LEGACY)
      .eq('branch_id', branchId)
      .gte('business_date', dayEndsCutoff)
      .order('business_date', { ascending: false })
  }

  let tx = txRes
  if (
    tx.error &&
    /vat_exempt_sales|zero_rated_sales|sc_pwd_discount|vat_rate_applied|schema cache|column/i.test(
      String(tx.error.message || ''),
    )
  ) {
    // Frontend can deploy ahead of migrate_vat_breakdown.sql being run — degrade instead of
    // failing the whole bootstrap (POS/inventory/etc. don't depend on these columns existing).
    tx = await supabase
      .from('transactions')
      .select(BOOTSTRAP_TX_COLS_LEGACY)
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(200)
  }

  for (const res of [productsRes, inventoryRes, tx, moveRes, dayRes, catsRes, branchRes]) {
    if (res.error) throw res.error
  }

  const staffNames = await staffNameById((tx.data || []).map((row) => row.staff_id))
  // Approvers are resolved alongside cashiers so a voided/refunded receipt can name who
  // signed it off in the list itself, not only after opening the detail modal.
  const approverIdentities = await fetchStaffIdentities(
    (tx.data || []).map((row) => row.void_approved_by),
  ).catch(() => ({}))

  const stockMap = Object.fromEntries(
    (inventoryRes.data || []).map((row) => [
      row.product_id,
      {
        stock: Number(row.quantity_on_hand),
        updatedAt: row.updated_at,
      },
    ]),
  )
  const lastMoveMap = {}
  ;(moveRes.data || []).forEach((row) => {
    if (!lastMoveMap[row.product_id]) lastMoveMap[row.product_id] = localDateKey(row.created_at)
  })

  return {
    products: (productsRes.data || []).map((row) =>
      mapProduct(row, stockMap[row.id]?.stock ?? 0, {
        updatedAt: stockMap[row.id]?.updatedAt,
        lastMovementAt: lastMoveMap[row.id] || null,
      }),
    ),
    transactions: (tx.data || []).map((row) =>
      mapTransaction(withApprover(withCashierName(row, staffNames), approverIdentities)),
    ),
    movements: (moveRes.data || []).map(mapMovement),
    dayEnds: (dayRes.data || []).map((row) => mapDayEndRow(row)),
    categories: catsRes.data || [],
    dayOpenHour: Number(branchRes.data?.day_open_hour ?? 7),
  }
}

/**
 * Lightweight products-only refetch for live updates (see src/offline/realtime.js) —
 * a manager's price/stock edit should reach an open POS screen without re-pulling
 * transactions/movements/day-ends too. Same query shape as bootstrapBranchData's
 * products+stock join, just narrower.
 */
export async function fetchBranchProducts(branchId) {
  const [productsRes, inventoryRes] = await Promise.all([
    // Paged — see fetchAllRows. Truncation here is what made products vanish from POS.
    fetchAllRows((from, to) =>
      supabase
        .from('products')
        .select(BOOTSTRAP_PRODUCT_COLS)
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .order('name')
        .range(from, to),
    ),
    fetchAllRows((from, to) =>
      supabase
        .from('branch_inventory')
        .select('product_id, quantity_on_hand, updated_at')
        .eq('branch_id', branchId)
        .order('product_id')
        .range(from, to),
    ),
  ])
  if (productsRes.error) throw productsRes.error
  if (inventoryRes.error) throw inventoryRes.error
  const stockMap = Object.fromEntries(
    (inventoryRes.data || []).map((row) => [
      row.product_id,
      { stock: Number(row.quantity_on_hand), updatedAt: row.updated_at },
    ]),
  )
  return (productsRes.data || []).map((row) =>
    mapProduct(row, stockMap[row.id]?.stock ?? 0, { updatedAt: stockMap[row.id]?.updatedAt }),
  )
}

export async function fetchCatalogProducts({ branchType = null } = {}) {
  // Paged for the same reason as the branch products query — a network catalog past 1000
  // items was being cut off, so items simply weren't listed on Manager → Data.
  const { data, error } = await fetchAllRows((from, to) => {
    let q = supabase
      .from('catalog_products')
      .select('*, categories(name)')
      .eq('is_active', true)
      .order('name')
      .range(from, to)
    if (branchType === 'retail' || branchType === 'restaurant') {
      q = q.eq('branch_type', branchType)
    }
    return q
  })
  if (error) {
    // Fallback if branch_type column missing
    if (String(error.message || '').includes('branch_type')) {
      const fallback = await fetchAllRows((from, to) =>
        supabase
          .from('catalog_products')
          .select('*, categories(name)')
          .eq('is_active', true)
          .order('name')
          .range(from, to),
      )
      if (fallback.error) throw error
      let rows = fallback.data || []
      if (branchType === 'restaurant') {
        rows = rows.filter((r) => r.menu_kind != null)
      } else if (branchType === 'retail') {
        rows = rows.filter((r) => r.menu_kind == null)
      }
      return rows.map(mapCatalogRow)
    }
    throw error
  }
  return (data || []).map(mapCatalogRow)
}

function mapCatalogRow(row) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode || '',
    category: row.categories?.name || '',
    categoryId: row.category_id,
    pricingMode: mapPricing(row.pricing_mode),
    price: Number(row.price),
    budgetPrice: row.budget_price != null ? Number(row.budget_price) : null,
    menuKind: row.menu_kind || null,
    discountEligible: row.discount_eligible === true,
    lowStockAt: Number(row.low_stock_threshold ?? 10),
    branchType: row.branch_type || (row.menu_kind ? 'restaurant' : 'retail'),
  }
}

/**
 * @param {object} values
 * @param {Map<string,string>} [categoryIds] pre-resolved name→id map. Import passes one so
 *   the per-row category lookup below is skipped entirely; without it each call costs its
 *   own round trip (and a second one when the category has to be created).
 */
export async function createCatalogProduct(values, categoryIds = null) {
  let categoryId = values.category ? categoryIds?.get(String(values.category).trim()) : null
  if (!categoryId) {
    const { data: cat } = await supabase.from('categories').select('id').eq('name', values.category).maybeSingle()
    categoryId = cat?.id
    if (!categoryId && values.category) {
      const { data: created } = await supabase.from('categories').insert({ name: values.category }).select('id').single()
      categoryId = created?.id
    }
  }
  const { data, error } = await supabase
    .from('catalog_products')
    .insert({
      name: values.name,
      sku: values.sku,
      barcode: values.barcode || null,
      category_id: categoryId || null,
      pricing_mode: toDbPricing(values.pricingMode || 'pc'),
      price: Number(values.price),
      budget_price:
        values.budgetPrice != null && values.budgetPrice !== '' ? Number(values.budgetPrice) : null,
      menu_kind: values.menuKind || null,
      discount_eligible: values.discountEligible === true,
      low_stock_threshold: values.lowStockAt || 10,
      is_active: true,
      branch_type: values.branchType === 'restaurant' || values.menuKind ? 'restaurant' : 'retail',
    })
    .select('*, categories(name)')
    .single()
  if (error) throw error
  return data
}

/** Bulk-create network catalog rows (manager import). Skips are already filtered client-side. */
export async function commitCatalogImport({
  preview,
  branchType = 'retail',
  onProgress,
}) {
  const lines = preview?.lines || []
  const total = lines.length || 1
  let created = 0

  // Validate the WHOLE file before writing anything. There is no transaction around this
  // loop, so a bad row discovered at #400 would otherwise leave 399 rows committed with no
  // way to undo them (unlike inventory import, catalog import has no batch/revert record).
  // Failing before the first write turns a half-done import into a no-op.
  lines.forEach((line, i) => {
    const values = line.values || {}
    const price = Number(values.price)
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(
        `Catalog import rejected before any changes: invalid price on row ${i + 1} (${values.sku || values.name || 'item'}).`,
      )
    }
    if (!String(values.name || '').trim() || !String(values.sku || '').trim()) {
      throw new Error(`Catalog import rejected before any changes: missing name/SKU on row ${i + 1}.`)
    }
  })

  // Resolve categories once, then PASS THE MAP DOWN. The result used to be discarded
  // while createCatalogProduct still did its own per-row lookup, so the call saved nothing
  // and cost one extra query — and because resolveCategoryIds creates missing categories
  // (defaulting a blank to 'Groceries'), it left behind category rows no product ever
  // referenced. Only non-blank categories are resolved now.
  const categoryIds = await resolveCategoryIds(
    lines.map((l) => l.values?.category).filter((name) => String(name || '').trim()),
  )

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const values = line.values || {}
    await createCatalogProduct(
      {
        ...values,
        branchType: preview?.restaurant || branchType === 'restaurant' ? 'restaurant' : 'retail',
        menuKind: values.menuKind || null,
        discountEligible: values.discountEligible === true,
        lowStockAt: values.lowStockAt || 10,
      },
      categoryIds,
    )
    created += 1
    onProgress?.(i + 1, total)
  }
  return { created }
}

export async function updateCatalogProduct(id, values) {
  const payload = {
    name: values.name,
    sku: values.sku,
    barcode: values.barcode || null,
    pricing_mode: toDbPricing(values.pricingMode || 'pc'),
    price: Number(values.price),
    budget_price:
      values.budgetPrice != null && values.budgetPrice !== '' ? Number(values.budgetPrice) : null,
    menu_kind: values.menuKind || null,
    discount_eligible: values.discountEligible === true,
    updated_at: new Date().toISOString(),
  }
  if (values.category) {
    const { data: cat } = await supabase.from('categories').select('id').eq('name', values.category).maybeSingle()
    payload.category_id = cat?.id || null
  }
  const { data, error } = await supabase
    .from('catalog_products')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single()
  if (error) throw error
  return data
}

/**
 * Push a network-catalog "Discountable" edit out to every branch that already adopted this
 * item (matched via products.catalog_product_id). Without this, toggling Discountable in the
 * network catalog only set the default for *future* adoptions — an already-adopted product's
 * live discount_eligible never changed, so PWD/Senior kept not applying on POS. Scoped to just
 * this one field (not price) so it doesn't silently override branch-specific pricing.
 */
export async function cascadeDiscountEligibleToBranches(catalogProductId, discountEligible, sku = null) {
  const next = discountEligible === true

  // Pass 1: rows properly linked to this catalog item.
  const { error } = await supabase
    .from('products')
    .update({ discount_eligible: next })
    .eq('catalog_product_id', catalogProductId)
  if (error) throw error

  // Pass 2: rows that were never linked. `catalog_product_id` is only ever set by
  // createProduct's best-effort mirror — which silently no-ops for supervisors (writing
  // catalog_products needs is_manager()) — and is never set at all by the bulk importer.
  // So a large share of real branch products sit with a NULL link, and pass 1 alone
  // misses every one of them: the manager flips Discountable, sees it save, and POS
  // never changes. Match those by SKU instead, then backfill the link so each row only
  // ever needs this fallback once.
  const trimmedSku = String(sku || '').trim()
  if (!trimmedSku) return

  const { data: orphans, error: orphanError } = await supabase
    .from('products')
    .select('id')
    .is('catalog_product_id', null)
    .ilike('sku', trimmedSku) // ilike without wildcards = case-insensitive equality
  if (orphanError || !orphans?.length) return

  const ids = orphans.map((row) => row.id)
  await supabase
    .from('products')
    .update({ discount_eligible: next, catalog_product_id: catalogProductId })
    .in('id', ids)
}

/**
 * Push every catalog item's Discountable flag down to the branch products linked to it.
 *
 * The per-item cascade only runs when someone saves that item. Anything toggled before the
 * cascade existed — or while a branch row had no catalog link — stays out of sync, showing
 * "Yes" in the catalog while POS refuses the discount. This reconciles the lot in one go,
 * which is the same thing migrate_sync_discount_eligible.sql does, exposed as a button so
 * it does not need a SQL console.
 *
 * Only writes rows that actually differ, and only touches discount_eligible.
 */
export async function resyncDiscountEligibleToBranches() {
  const { data: catalogRows, error: catErr } = await fetchAllRows((from, to) =>
    supabase.from('catalog_products').select('id, sku, discount_eligible').range(from, to),
  )
  if (catErr) throw catErr

  const { data: productRows, error: prodErr } = await fetchAllRows((from, to) =>
    supabase.from('products').select('id, sku, catalog_product_id, discount_eligible').range(from, to),
  )
  if (prodErr) throw prodErr

  const byId = new Map((catalogRows || []).map((c) => [c.id, c]))

  // SKU is deliberately NOT used as a fallback here.
  //
  // discount_eligible decides whether a PWD/Senior VAT exemption applies, so flipping it
  // changes what a customer is charged. Matching on SKU would reach products a branch
  // created locally and never adopted from the catalog — a branch could have marked its
  // own item not discountable on purpose, and a coincidental SKU collision with an
  // unrelated catalog entry would silently overturn that from a single button press with
  // no confirmation. Two catalog rows sharing a normalised SKU made it worse: building a
  // Map from them means the last one silently wins, so which value gets applied depends on
  // row order.
  //
  // migrate_sync_discount_eligible.sql joins on catalog_product_id only and states that
  // unlinked rows cannot be reconciled. This now agrees with it. Unlinked products are
  // counted and reported so the gap is visible rather than papered over —
  // migrate_backfill_catalog_links.sql is the fix for those.
  const toEnable = []
  const toDisable = []
  let unlinked = 0
  for (const p of productRows || []) {
    if (!p.catalog_product_id) {
      unlinked += 1
      continue
    }
    const match = byId.get(p.catalog_product_id)
    if (!match) continue
    const want = match.discount_eligible === true
    if ((p.discount_eligible === true) === want) continue
    ;(want ? toEnable : toDisable).push(p.id)
  }

  // Two bulk updates rather than one per row — this can span thousands of products.
  for (const [ids, value] of [
    [toEnable, true],
    [toDisable, false],
  ]) {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      if (!chunk.length) continue
      const { error } = await supabase
        .from('products')
        .update({ discount_eligible: value })
        .in('id', chunk)
      if (error) throw error
    }
  }

  return { enabled: toEnable.length, disabled: toDisable.length, unlinked }
}

/**
 * Push a network-catalog identity/price edit (name, sku, barcode, category, price,
 * budget_price) out to every branch that already adopted this item — same reach pattern as
 * cascadeDiscountEligibleToBranches (linked rows via catalog_product_id, plus an orphan pass
 * matched by the item's SKU **before** this edit, since an unlinked branch row still carries
 * the old SKU). A price change is also logged via recordPriceChange per affected branch row
 * so the Price Change Register and Price Listing report see it, matching what editing price
 * on a branch's own Inventory page already does.
 */
export async function cascadeCatalogFieldsToBranches(catalogProductId, fields, { matchSku, staffId } = {}) {
  const updateFields = {}
  if (fields.name !== undefined) updateFields.name = fields.name
  if (fields.sku !== undefined) updateFields.sku = fields.sku
  if (fields.barcode !== undefined) updateFields.barcode = fields.barcode
  if (fields.price !== undefined) updateFields.price = fields.price
  if (fields.budgetPrice !== undefined) updateFields.budget_price = fields.budgetPrice
  if (fields.category) {
    const { data: cat } = await supabase.from('categories').select('id').eq('name', fields.category).maybeSingle()
    if (cat?.id) updateFields.category_id = cat.id
  }
  if (!Object.keys(updateFields).length) return

  const logPriceChanges = async (rows) => {
    if (fields.price === undefined) return
    for (const row of rows) {
      const oldPrice = row.price != null ? Number(row.price) : null
      if (oldPrice == null || oldPrice === Number(fields.price)) continue
      await recordPriceChange({
        branchId: row.branch_id,
        productId: row.id,
        staffId,
        oldPrice,
        newPrice: Number(fields.price),
        detail: fields.name || 'Price update (network catalog)',
      })
    }
  }

  // Pass 1: rows properly linked to this catalog item.
  const { data: linked, error: linkedError } = await supabase
    .from('products')
    .select('id, branch_id, price')
    .eq('catalog_product_id', catalogProductId)
  if (linkedError) throw linkedError
  if (linked?.length) {
    const { error } = await supabase
      .from('products')
      .update(updateFields)
      .eq('catalog_product_id', catalogProductId)
    if (error) throw error
    await logPriceChanges(linked)
  }

  // Pass 2: rows never linked (see cascadeDiscountEligibleToBranches for why this happens).
  const trimmedSku = String(matchSku || '').trim()
  if (!trimmedSku) return
  const { data: orphans, error: orphanError } = await supabase
    .from('products')
    .select('id, branch_id, price')
    .is('catalog_product_id', null)
    .ilike('sku', trimmedSku)
  if (orphanError || !orphans?.length) return
  const ids = orphans.map((row) => row.id)
  const { error } = await supabase
    .from('products')
    .update({ ...updateFields, catalog_product_id: catalogProductId })
    .in('id', ids)
  if (error) throw error
  await logPriceChanges(orphans)
}

/** Supervisor: add catalog items to this branch's sellable products + inventory. */
export async function adoptCatalogProducts({ branchId, catalogIds, staffId }) {
  const { data, error } = await supabase.rpc('adopt_catalog_products', {
    p_branch_id: branchId,
    p_catalog_ids: catalogIds,
    p_staff_id: staffId || null,
  })
  if (error) throw error
  return Number(data || 0)
}

export async function createProduct({ branchId, staffId, values, branchType = 'retail' }) {
  const isRestaurant = branchType === 'restaurant'
  const { data: cat } = await supabase.from('categories').select('id').eq('name', values.category).maybeSingle()
  let categoryId = cat?.id
  if (!categoryId) {
    const { data: created } = await supabase.from('categories').insert({ name: values.category }).select('id').single()
    categoryId = created?.id
  }
  const product = await writeProductRow('insert', {
    branch_id: branchId,
    name: values.name,
    sku: values.sku,
    barcode: values.barcode || null,
    category_id: categoryId || null,
    pricing_mode: toDbPricing(values.pricingMode || 'pc'),
    price: values.price,
    ...(isRestaurant
      ? {
          budget_price:
            values.budgetPrice != null && values.budgetPrice !== ''
              ? Number(values.budgetPrice)
              : null,
          menu_kind: normalizeMenuKind(values.menuKind, values.category),
          available_today: values.availableToday !== false,
        }
      : {}),
    low_stock_threshold: values.lowStockAt || 5,
    unit_cost: values.unitCost != null && values.unitCost !== '' ? Number(values.unitCost) : 0,
    discount_eligible: values.discountEligible === true,
  })

  // Mirror into network catalog (managers creating products)
  try {
    const { data: existingCat } = await supabase
      .from('catalog_products')
      .select('id')
      .eq('sku', values.sku)
      .maybeSingle()
    let catalogId = existingCat?.id
    if (!catalogId) {
      const { data: createdCat } = await supabase
        .from('catalog_products')
        .insert({
          name: values.name,
          sku: values.sku,
          barcode: values.barcode || null,
          category_id: categoryId || null,
          pricing_mode: toDbPricing(values.pricingMode || 'pc'),
          price: values.price,
          budget_price:
            values.budgetPrice != null && values.budgetPrice !== ''
              ? Number(values.budgetPrice)
              : null,
          menu_kind: isRestaurant ? normalizeMenuKind(values.menuKind, values.category) : null,
          discount_eligible: values.discountEligible === true,
          low_stock_threshold: values.lowStockAt || 5,
        })
        .select('id')
        .single()
      catalogId = createdCat?.id
    }
    if (catalogId) {
      await supabase.from('products').update({ catalog_product_id: catalogId }).eq('id', product.id)
    }
  } catch (err) {
    console.warn('catalog_products sync skipped:', err?.message || err)
  }

  if (!isRestaurant) {
    await supabase.from('branch_inventory').upsert({
      branch_id: branchId,
      product_id: product.id,
      quantity_on_hand: values.stock ?? 0,
    })
    await supabase.rpc('record_stock_movement', {
      p_branch_id: branchId,
      p_product_id: product.id,
      p_staff_id: staffId,
      p_movement_type: 'restock',
      p_quantity_in: values.stock ?? 0,
      p_quantity_out: 0,
      p_reference: 'initial',
      p_detail: 'New product',
    })
  }

  return mapProduct(product, isRestaurant ? 0 : values.stock, {
    branchId,
    updatedAt: today(),
    lastMovementAt: isRestaurant ? null : today(),
  })
}

export async function updateProductRow(id, values, { branchId, staffId, previousPrice } = {}) {
  let categoryId = values.categoryId || null
  if (values.category) {
    const { data: cat } = await supabase.from('categories').select('id').eq('name', values.category).maybeSingle()
    categoryId = cat?.id || categoryId
  }

  let oldPrice = previousPrice
  if (oldPrice == null) {
    const { data: current } = await supabase.from('products').select('price').eq('id', id).maybeSingle()
    oldPrice = current?.price != null ? Number(current.price) : null
  }

  const data = await writeProductRow(
    'update',
    {
      name: values.name,
      sku: values.sku,
      barcode: values.barcode,
      category_id: categoryId,
      pricing_mode: toDbPricing(values.pricingMode),
      price: values.price,
      budget_price:
        values.budgetPrice != null && values.budgetPrice !== ''
          ? Number(values.budgetPrice)
          : null,
      menu_kind: normalizeMenuKind(values.menuKind, values.category),
      low_stock_threshold: values.lowStockAt || 5,
      // Only touch discount_eligible when the caller explicitly set it — a partial
      // update (e.g. a stock-only adjustment) must not silently clear this flag.
      ...(values.discountEligible !== undefined ? { discount_eligible: values.discountEligible === true } : {}),
    },
    { id },
  )

  if (
    branchId &&
    oldPrice != null &&
    values.price != null &&
    Number(oldPrice) !== Number(values.price)
  ) {
    await recordPriceChange({
      branchId,
      productId: id,
      staffId,
      oldPrice: Number(oldPrice),
      newPrice: Number(values.price),
      detail: values.name || 'Price update',
    })
  }

  return data
}

/** Toggle whether a restaurant menu item is offered today. */
export async function setMenuAvailableToday(productId, availableToday) {
  const { data, error } = await supabase
    .from('products')
    .update({ available_today: Boolean(availableToday) })
    .eq('id', productId)
    .select('*, categories(name)')
    .single()
  if (error) throw error
  return data
}

export async function updateProductPrice(id, price, { branchId, staffId, previousPrice, productName } = {}) {
  let oldPrice = previousPrice
  if (oldPrice == null) {
    const { data: current } = await supabase.from('products').select('price, name').eq('id', id).maybeSingle()
    oldPrice = current?.price != null ? Number(current.price) : null
    productName = productName || current?.name
  }

  const { data, error } = await supabase
    .from('products')
    .update({ price: Number(price) })
    .eq('id', id)
    .select('*, categories(name)')
    .single()
  if (error) throw error

  if (branchId && oldPrice != null && Number(oldPrice) !== Number(price)) {
    await recordPriceChange({
      branchId,
      productId: id,
      staffId,
      oldPrice: Number(oldPrice),
      newPrice: Number(price),
      detail: productName || data?.name || 'Price update',
    })
  }

  return data
}

export async function recordPriceChange({ branchId, productId, staffId, oldPrice, newPrice, detail }) {
  if (Number(oldPrice) === Number(newPrice)) return null
  const { data, error } = await supabase.rpc('record_price_change', {
    p_branch_id: branchId,
    p_product_id: productId,
    p_staff_id: staffId || null,
    p_old_price: Number(oldPrice),
    p_new_price: Number(newPrice),
    p_detail: detail || 'Price update',
  })
  if (error) throw error
  if (!data) return null
  return mapMovement({ ...data, products: { name: detail } })
}

export async function fetchPriceHistory(productId, branchId) {
  let query = supabase
    .from('stock_movements')
    .select(
      'id, created_at, product_id, movement_type, quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price, detail, branch_id',
    )
    .eq('product_id', productId)
    .eq('movement_type', 'price_change')
    .order('created_at', { ascending: false })
    .limit(50)
  if (branchId) query = query.eq('branch_id', branchId)
  const { data, error } = await query
  if (error) {
    if (/movement_type|schema cache/i.test(String(error.message || ''))) return []
    throw error
  }
  return (data || []).map((row) => mapMovement(row))
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

function isDuplicateClientIdError(error) {
  const msg = String(error?.message || error || '')
  return error?.code === '23505' && msg.includes('uq_transactions_branch_client')
}

export async function loadTransactionByClientId(branchId, clientId) {
  let { data, error } = await supabase
    .from('transactions')
    .select(BOOTSTRAP_TX_COLS)
    .eq('branch_id', branchId)
    .eq('client_id', clientId)
    .maybeSingle()
  if (
    error &&
    /vat_exempt_sales|zero_rated_sales|sc_pwd_discount|vat_rate_applied|schema cache|column/i.test(
      String(error.message || ''),
    )
  ) {
    ;({ data, error } = await supabase
      .from('transactions')
      .select(BOOTSTRAP_TX_COLS_LEGACY)
      .eq('branch_id', branchId)
      .eq('client_id', clientId)
      .maybeSingle())
  }
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
}) {
  // Run till check + OR allocate (+ branch type if unknown) together
  const tillPromise = supabase.rpc('assert_till_open', { p_branch_id: branchId })
  const orPromise = supabase.rpc('allocate_or_number', { p_branch_id: branchId })
  const branchPromise =
    branchType != null
      ? Promise.resolve({ data: { branch_type: branchType } })
      : supabase.from('branches').select('branch_type').eq('id', branchId).maybeSingle()

  const [{ error: tillError }, orRes, branchRes] = await Promise.all([
    tillPromise,
    orPromise,
    branchPromise,
  ])
  if (tillError) throw tillError

  const isRestaurant =
    branchType === 'restaurant' || branchRes?.data?.branch_type === 'restaurant'

  let orNumber = null
  if (!orRes.error) orNumber = orRes.data
  else if (!String(orRes.error.message || '').includes('Could not find the function')) {
    throw orRes.error
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
  if (orNumber) insertRow.or_number = orNumber
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
        isMissingColumnError(itemsError, 'vat_category'))
    ) {
      const strippedLines = lines.map((row) => {
        const rest = { ...row }
        delete rest.price_tier
        delete rest.promo_name
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
      or_number: txn.or_number,
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
      '*, transaction_items(id, quantity, unit_price, line_total, discount_eligible, discount_amount, products(id, name, sku, pricing_mode))',
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
  if (staffId) {
    // p_approved_by: migrate_void_sale_approved_by.sql. On an environment where that hasn't
    // been applied yet, the old 3-arg signature doesn't match this call and PostgREST returns
    // "Could not find the function" — falls through to the manual path below, which already
    // records the approver correctly.
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
    if (!String(error.message || '').includes('Could not find the function')) throw error
  }

  const { data: existing } = await supabase
    .from('transactions')
    .select('id, branch_id, or_number, total_amount')
    .eq('id', id)
    .maybeSingle()

  const updatePayload = {
    status: 'voided',
    void_reason: reason,
    voided_at: new Date().toISOString(),
    voided_by: staffId,
  }
  if (approvedBy) updatePayload.void_approved_by = approvedBy

  let { error } = await supabase.from('transactions').update(updatePayload).eq('id', id)
  if (error && isMissingColumnError(error, 'void_approved_by')) {
    delete updatePayload.void_approved_by
    ;({ error } = await supabase.from('transactions').update(updatePayload).eq('id', id))
  }
  // Same idempotency case as the RPC branch above, reached here only on a pre-void_sale_secure
  // database — guard_transaction_updates() (migrate_bir_pos_compliance.sql) rejects the update
  // with "voided transactions are locked" once it already landed.
  if (error && isAlreadyVoidedError(error)) {
    const { data: current } = await supabase.from('transactions').select('*').eq('id', id).maybeSingle()
    return current
  }
  if (error) throw error

  if (existing?.branch_id) {
    await supabase.from('sale_events').insert({
      branch_id: existing.branch_id,
      transaction_id: id,
      staff_id: staffId,
      event_type: 'void',
      or_number: existing.or_number,
      reason,
      amount: existing.total_amount,
      payload: { approved_by: approvedBy },
    })
  }
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
    .select('id, transaction_id, branch_id, mode, reason, items, status, requested_by, requested_at, transactions(or_number, total_amount), staff:requested_by(full_name)')
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
    orNumber: row.transactions?.or_number || null,
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

export async function submitDayEnd({ branchId, staffId, entry }) {
  const { data, error } = await supabase.rpc('submit_day_end', {
    p_branch_id: branchId,
    p_staff_id: staffId,
    p_business_date: entry.date,
    p_recorded_cash: entry.recordedCash,
    p_cash_on_hand: entry.cashOnHand,
    p_variance: entry.variance,
    p_expected_cash: entry.expectedCash ?? 0,
    p_note: entry.note || null,
    p_day_report: entry.dayReport ?? null,
    p_day_end_id: entry.id || null,
  })
  if (error) throw error
  return data
}

export async function approveDayEnd({ id, staffId }) {
  const { data, error } = await supabase.rpc('approve_day_end', {
    p_day_end_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/** @deprecated use submitDayEnd — kept for offline queue compatibility */
export async function closeDayEnd(payload) {
  return submitDayEnd(payload)
}

export async function reopenDayEnd({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('reopen_day_end', {
    p_day_end_id: id,
    p_staff_id: staffId,
    p_reason: reason,
  })
  if (error) throw error
  return data
}

/**
 * A cashier (or anyone on the branch) blocked by a closed business day asks a manager to
 * reopen it — reopening itself stays manager-only (`reopenDayEnd`), this just gives the
 * person stuck at the till a way to ask instead of being stuck with no recourse but signing
 * out. Surfaces to managers via `fetchPendingApprovals`.
 */
export async function requestDayReopen({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('request_day_reopen', {
    p_day_end_id: id,
    p_staff_id: staffId,
    p_reason: reason || null,
  })
  if (error) throw error
  return data
}

/** Supervisor/manager declines a cashier's "Request day end" made by mistake. */
export async function rejectDayEndRequest({ id, staffId, reason }) {
  const { data, error } = await supabase.rpc('reject_day_end_request', {
    p_day_end_id: id,
    p_staff_id: staffId,
    p_reason: reason || null,
  })
  if (error) throw error
  return data
}

/**
 * A cashier flags the business day for closing — no cash figures yet. Whoever answers it
 * (a supervisor, or a manager if `requestManager` was set) counts the drawer on the normal
 * Close Day screen, which overwrites this with real numbers and closes as usual.
 */
export async function requestDayEnd({ branchId, staffId, businessDate, requestManager = false }) {
  const { data, error } = await supabase.rpc('request_day_end', {
    p_branch_id: branchId,
    p_staff_id: staffId,
    p_business_date: businessDate,
    p_request_manager: requestManager,
  })
  if (error) throw error
  return data
}

const BRANCH_LIST_COLS =
  'id, name, address, is_active, sort_order, day_open_hour, branch_type, device_settings, vat_rate, tin, branch_tin_code, business_name, bir_permit_no, machine_identification_no, serial_number, or_prefix'
const BRANCH_LIST_COLS_LEGACY =
  'id, name, address, is_active, sort_order, day_open_hour, branch_type, device_settings, vat_rate'

/**
 * A business has ONE TIN; a branch has a BIR branch code appended to it (head office
 * 00000, then 00001, …) — see migrate_company_tin.sql. Composed here, in one place, so
 * the invoice, the X/Z reading and the settings screen can never print three versions
 * of the same number.
 *
 * Falls back to the branch's own legacy `tin` when the company TIN has not been set,
 * which is what every environment looks like until that migration is run.
 */
export function composeTin(companyTin, branchCode, legacyBranchTin = null) {
  const main = String(companyTin || '').trim()
  if (!main) return legacyBranchTin || ''
  const code = String(branchCode || '').trim()
  return code ? `${main}-${code}` : main
}

let companyProfileCache = null

/** The single company-level fiscal identity row. Cached — it changes about never. */
export async function fetchCompanyProfile({ force = false } = {}) {
  if (!supabase) return null
  if (companyProfileCache && !force) return companyProfileCache
  const { data, error } = await supabase
    .from('company_profile')
    .select('id, business_name, tin, address')
    .limit(1)
    .maybeSingle()
  if (error) {
    // Table not created yet (migration not applied) — degrade to branch-level TIN rather
    // than failing every screen that prints a receipt.
    if (/company_profile|schema cache|does not exist/i.test(String(error.message || ''))) {
      companyProfileCache = { business_name: null, tin: null, address: null, missing: true }
      return companyProfileCache
    }
    throw error
  }
  companyProfileCache = data || { business_name: null, tin: null, address: null }
  return companyProfileCache
}

export async function saveCompanyProfile({ businessName, tin, address }) {
  const { data, error } = await supabase
    .from('company_profile')
    .upsert(
      {
        id: true,
        business_name: businessName ?? null,
        tin: tin ?? null,
        address: address ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
    .select('id, business_name, tin, address')
    .single()
  if (error) throw error
  companyProfileCache = data
  branchHeaderCache.clear()
  return data
}

export async function fetchBranches() {
  let { data, error } = await supabase
    .from('branches')
    .select(BRANCH_LIST_COLS)
    .order('sort_order')
    .order('name')
  if (error && /branch_tin_code|tin|business_name|schema cache|column/i.test(String(error.message || ''))) {
    ;({ data, error } = await supabase
      .from('branches')
      .select(BRANCH_LIST_COLS_LEGACY)
      .order('sort_order')
      .order('name'))
  }
  if (error) {
    // Older schemas may lack sort_order / device_settings / vat_rate — fall back broadly.
    const fallback = await supabase.from('branches').select('*').order('name')
    if (fallback.error) throw error
    data = fallback.data || []
  }
  // Every consumer (receipt, X/Z reading, settings form) reads `full_tin` and gets the
  // same composed value — no caller has to know about the two-level structure.
  const company = await fetchCompanyProfile().catch(() => null)
  return (data || []).map((row) => ({
    ...row,
    company_tin: company?.tin || null,
    company_business_name: company?.business_name || null,
    full_tin: composeTin(company?.tin, row.branch_tin_code, row.tin),
  }))
}

const branchHeaderCache = new Map()

/**
 * Branch identity block for printing (business name, address, composed TIN, permit, MIN,
 * serial). Cached per branch id because it is read on every receipt print and changes
 * about never — and because the POS used to print `TIN: —` on every sale by handing
 * buildReceipt a stub `{ name }` object rather than the real branch row.
 */
export async function fetchBranchFiscalHeader(branchId) {
  if (!branchId || !supabase) return null
  if (branchHeaderCache.has(branchId)) return branchHeaderCache.get(branchId)
  const branches = await fetchBranches().catch(() => [])
  for (const row of branches) branchHeaderCache.set(row.id, row)
  return branchHeaderCache.get(branchId) || null
}

export async function reorderBranches(orderedIds = []) {
  branchHeaderCache.clear()
  await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from('branches').update({ sort_order: index + 1 }).eq('id', id),
    ),
  )
}

/** Seconds without heartbeat before a branch is considered offline. */
export const BRANCH_ONLINE_WINDOW_SEC = 120

export function isBranchOnline(presence, now = Date.now()) {
  if (!presence?.last_seen_at) return false
  const last = new Date(presence.last_seen_at).getTime()
  if (Number.isNaN(last)) return false
  return now - last <= BRANCH_ONLINE_WINDOW_SEC * 1000
}

export async function heartbeatBranch({ branchId, staffId }) {
  if (!supabase || !branchId) return null
  const { data, error } = await supabase.rpc('heartbeat_branch', {
    p_branch_id: branchId,
    p_staff_id: staffId || null,
    p_app_version: APP_VERSION,
    p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 180) : null,
  })
  if (error) {
    // Table/RPC may not be migrated yet — don't break the POS
    console.warn('heartbeat_branch', error.message)
    return null
  }
  return data
}

const DEVICE_KEY_MAP = {
  'barcode-scanner': 'barcode_scanner',
  'receipt-printer': 'receipt_printer',
  'cash-drawer': 'cash_drawer',
  barcode_scanner: 'barcode_scanner',
  receipt_printer: 'receipt_printer',
  cash_drawer: 'cash_drawer',
}

const DEVICE_LABELS = {
  barcode_scanner: 'Barcode Scanner',
  receipt_printer: 'Receipt Printer',
  cash_drawer: 'Cash Drawer',
}

export async function fetchBranchDeviceSettings(branchId) {
  if (!supabase || !branchId) return null
  const { data, error } = await supabase
    .from('branches')
    .select('device_settings')
    .eq('id', branchId)
    .maybeSingle()
  if (error) {
    if (!/device_settings|schema cache|column/i.test(String(error.message || ''))) {
      console.warn('fetchBranchDeviceSettings', error.message)
    }
    return null
  }
  return data?.device_settings ?? null
}

export async function reportBranchDevices(branchId, devices) {
  if (!supabase || !branchId || !devices?.length) return
  const rows = devices.map((device) => {
    const key = DEVICE_KEY_MAP[device.id] || DEVICE_KEY_MAP[device.device_key] || device.id
    return {
      branch_id: branchId,
      device_key: key,
      state: device.state === 'connected' ? 'connected' : device.state || 'disconnected',
      detail: device.detail || (device.state === 'connected' ? 'Connected' : 'Not Connected'),
      updated_at: new Date().toISOString(),
    }
  })
  const { error } = await supabase.from('branch_devices').upsert(rows, { onConflict: 'branch_id,device_key' })
  if (error) console.warn('reportBranchDevices', error.message)
}

export async function fetchBranchTelemetry(branchIds = []) {
  if (!supabase) return { presence: {}, devices: {} }
  const ids = branchIds.filter(Boolean)
  if (!ids.length) return { presence: {}, devices: {} }

  const [presenceRes, devicesRes] = await Promise.all([
    supabase
      .from('branch_presence')
      .select('branch_id, staff_id, last_seen_at, is_online, updated_at')
      .in('branch_id', ids),
    supabase
      .from('branch_devices')
      .select('branch_id, device_key, state, detail, updated_at')
      .in('branch_id', ids),
  ])

  if (presenceRes.error) console.warn('branch_presence', presenceRes.error.message)
  if (devicesRes.error) console.warn('branch_devices', devicesRes.error.message)

  const presence = Object.fromEntries((presenceRes.data || []).map((row) => [row.branch_id, row]))
  const devices = {}
  for (const row of devicesRes.data || []) {
    if (!devices[row.branch_id]) devices[row.branch_id] = []
    devices[row.branch_id].push({
      key: row.device_key,
      label: DEVICE_LABELS[row.device_key] || row.device_key,
      state: row.state,
      detail: row.detail || '',
      updatedAt: row.updated_at,
    })
  }
  // Ensure all three slots exist for UI
  for (const id of ids) {
    const list = devices[id] || []
    const byKey = Object.fromEntries(list.map((d) => [d.key, d]))
    devices[id] = ['barcode_scanner', 'receipt_printer', 'cash_drawer'].map(
      (key) =>
        byKey[key] || {
          key,
          label: DEVICE_LABELS[key],
          state: 'disconnected',
          detail: 'Not Connected',
          updatedAt: null,
        },
    )
  }

  return { presence, devices }
}

export function deviceSummary(deviceList = []) {
  const connected = deviceList.filter((d) => d.state === 'connected').length
  return { connected, total: deviceList.length || 3 }
}

export async function fetchRoles() {
  const { data, error } = await supabase.from('roles').select('name, label, sort_order').order('sort_order')
  if (error) throw error
  return data || []
}

export async function saveBranch(payload) {
  // Settings just changed — the next receipt must not print the old header.
  branchHeaderCache.clear()
  const fields = {
    name: payload.name,
    address: payload.address,
    is_active: payload.is_active,
  }
  if (payload.branch_type != null) {
    fields.branch_type = payload.branch_type === 'restaurant' ? 'restaurant' : 'retail'
  }
  // Optional fiscal / settings fields — only write when provided (Branch settings)
  if ('business_name' in payload || 'businessName' in payload) {
    fields.business_name = payload.business_name ?? payload.businessName ?? null
  }
  if ('tin' in payload) fields.tin = payload.tin ?? null
  if ('branch_tin_code' in payload || 'branchTinCode' in payload) {
    fields.branch_tin_code = payload.branch_tin_code ?? payload.branchTinCode ?? null
  }
  if ('bir_permit_no' in payload || 'birPermitNo' in payload) {
    fields.bir_permit_no = payload.bir_permit_no ?? payload.birPermitNo ?? null
  }
  if ('machine_identification_no' in payload || 'machineId' in payload) {
    fields.machine_identification_no =
      payload.machine_identification_no ?? payload.machineId ?? null
  }
  if ('serial_number' in payload || 'serialNumber' in payload) {
    fields.serial_number = payload.serial_number ?? payload.serialNumber ?? null
  }
  if ('or_prefix' in payload || 'orPrefix' in payload) {
    fields.or_prefix = payload.or_prefix ?? payload.orPrefix
  }
  if (payload.day_open_hour != null) {
    fields.day_open_hour = Math.min(23, Math.max(0, Number(payload.day_open_hour)))
  }
  if (payload.vat_rate != null || payload.vatRate != null) {
    fields.vat_rate = Number(payload.vat_rate ?? payload.vatRate)
  }
  if (payload.sort_order != null || payload.sortOrder != null) {
    fields.sort_order = Number(payload.sort_order ?? payload.sortOrder)
  }
  if ('device_settings' in payload || 'deviceSettings' in payload) {
    const raw = payload.device_settings ?? payload.deviceSettings
    fields.device_settings = {
      barcode_scanner: raw?.barcode_scanner === true,
      receipt_printer: raw?.receipt_printer === true,
      cash_drawer: raw?.cash_drawer === true,
    }
  }
  Object.keys(fields).forEach((key) => {
    if (fields[key] === undefined) delete fields[key]
  })
  if (payload.id) {
    let { data, error } = await supabase
      .from('branches')
      .update(fields)
      .eq('id', payload.id)
      .select('*')
      .single()
    if (
      error &&
      (isMissingColumnError(error, 'vat_rate') ||
        isMissingColumnError(error, 'sort_order') ||
        isMissingColumnError(error, 'branch_tin_code'))
    ) {
      const fallback = { ...fields }
      delete fallback.vat_rate
      delete fallback.sort_order
      // Frontend can ship ahead of migrate_company_tin.sql.
      delete fallback.branch_tin_code
      ;({ data, error } = await supabase.from('branches').update(fallback).eq('id', payload.id).select('*').single())
    }
    if (
      error &&
      fields.device_settings &&
      /device_settings|schema cache|column|Could not find/i.test(String(error.message || ''))
    ) {
      // Do NOT soft-succeed — toggle must actually persist
      const missing = new Error(
        'Device settings DB column missing — run migrate_device_settings.sql in Supabase.',
      )
      missing.code = 'DEV01'
      missing.supportCode = 'DEV01'
      throw missing
    }
    if (error) {
      const wrapped = new Error(error.message || 'Could not save device on/off setting.')
      wrapped.code = fields.device_settings ? 'DEV02' : 'GEN01'
      wrapped.supportCode = wrapped.code
      throw wrapped
    }
    if (fields.device_settings && data && data.device_settings == null) {
      const missing = new Error(
        'Device settings DB column missing — run migrate_device_settings.sql in Supabase.',
      )
      missing.code = 'DEV01'
      missing.supportCode = 'DEV01'
      throw missing
    }
    return data
  }
  const { data, error } = await supabase
    .from('branches')
    .insert({
      ...fields,
      is_active: payload.is_active ?? true,
      branch_type: fields.branch_type || 'retail',
      or_prefix: fields.or_prefix || 'OR',
    })
    .select('*')
    .single()
  if (error) throw error
  return data
}

/**
 * Staff roster for the Staff page.
 *
 * Managers read the `staff` table directly (RLS allows it). Supervisors CANNOT — the
 * `read staff` policy is `auth_user_id = auth.uid() or is_manager()`, so a direct read
 * returns them exactly one row, which is why their Staff page looked empty. They go
 * through `branch_staff_roster()`, a definer function that returns their branch's people
 * WITHOUT login_pin / auth_secret (see migrate_branch_staff_roster.sql — widening the
 * table policy instead would expose every cashier's PIN).
 */
export async function fetchStaffRoster({ branchId = null, isManager = false } = {}) {
  if (isManager) return fetchAllStaff()
  const { data, error } = await supabase.rpc('branch_staff_roster', {
    p_branch_id: branchId || null,
  })
  if (error) {
    if (/branch_staff_roster|Could not find the function/i.test(String(error.message || ''))) {
      // Migration not applied yet — fall back to the direct read. RLS will trim it to the
      // caller's own row, which is the old (wrong but harmless) behaviour, not a crash.
      return fetchAllStaff()
    }
    throw error
  }
  return (data || []).map((row) => ({
    id: row.id,
    branch_id: row.branch_id,
    full_name: row.full_name,
    role: row.role,
    login_code: row.login_code,
    is_active: row.is_active,
    permissions: row.permissions,
    created_at: row.created_at,
    branches: { name: row.branch_name },
    roles: null,
  }))
}

export async function fetchAllStaff() {
  const selectFull =
    'id, branch_id, full_name, role, login_code, is_active, permissions, created_at, branches(name), roles(label)'
  const { data, error } = await supabase.from('staff').select(selectFull).order('full_name')
  if (error) {
    // Older DBs may lack permissions / roles join
    if (/permissions|roles|login_code|schema cache|column/i.test(String(error.message || ''))) {
      const fallback = await supabase
        .from('staff')
        .select('id, branch_id, full_name, role, is_active, created_at, branches(name)')
        .order('full_name')
      if (fallback.error) throw error
      return fallback.data || []
    }
    throw error
  }
  // Never return login_pin in list payloads — reveal only via revealStaffPin.
  return data || []
}

/**
 * Sessions currently held, for a master to inspect before ejecting anyone.
 *
 * `isStale` marks rows past the 15-minute heartbeat window `claim_staff_session()` uses:
 * those are no longer blocking a login, so a master can tell a genuinely live till apart
 * from a leftover row before kicking someone off mid-sale.
 */
export async function fetchActiveSessions() {
  const { data, error } = await supabase.rpc('admin_active_sessions')
  if (error) {
    if (/admin_active_sessions|Could not find the function/i.test(String(error.message || ''))) {
      throw appError('SESS01', 'Run migrate_admin_session_release.sql in Supabase.')
    }
    throw error
  }
  return (data || []).map((row) => ({
    staffId: row.staff_id,
    name: row.full_name || 'Staff',
    role: row.role || null,
    branchId: row.branch_id || null,
    branchName: row.branch_name || '—',
    heartbeatAt: row.session_heartbeat_at || null,
    isStale: row.is_stale === true,
  }))
}

/**
 * Clear a stuck "already signed in on another device" lock.
 *
 * A session is normally cleared by release_staff_session() on sign-out, which a crashed
 * tab, a dead battery or a power cut never gets to call — leaving the account locked out
 * of itself for up to 15 minutes with no device to sign out from. Master only, and the
 * database logs who forced whom off.
 */
export async function forceReleaseStaffSession(staffId) {
  const { error } = await supabase.rpc('admin_release_staff_session', { p_staff_id: staffId })
  if (error) {
    if (/SESSION_NOT_ALLOWED/i.test(String(error.message || ''))) {
      throw appError('SESS02')
    }
    if (/Could not find the function/i.test(String(error.message || ''))) {
      throw appError('SESS01', 'Run migrate_admin_session_release.sql in Supabase.')
    }
    throw error
  }
  return true
}

/** Same, for everyone (optionally one branch). Never releases the master doing it. */
export async function releaseAllStaffSessions(branchId = null) {
  const { data, error } = await supabase.rpc('admin_release_all_sessions', {
    p_branch_id: branchId,
  })
  if (error) {
    if (/SESSION_NOT_ALLOWED/i.test(String(error.message || ''))) {
      throw appError('SESS02')
    }
    if (/Could not find the function/i.test(String(error.message || ''))) {
      throw appError('SESS01', 'Run migrate_admin_session_release.sql in Supabase.')
    }
    throw error
  }
  return Number(data || 0)
}

export async function createStaffAccount({
  email,
  password,
  fullName,
  role,
  branchId,
  loginCode = null,
  loginPin = null,
  permissions = null,
  captchaToken = null,
}) {
  const { data: sessionData } = await supabase.auth.getSession()
  const managerSession = sessionData.session
  const pinRole = role === 'cashier' || role === 'supervisor'
  const authEmail = pinRole && loginCode ? pinAuthEmail(loginCode, branchId) : email
  // Till PIN is also the Auth password (never returned to clients after login resolve).
  const authPassword = pinRole ? String(loginPin || '') : password
  if (pinRole && !authPassword) throw new Error('PIN is required for cashier/supervisor accounts.')

  // Supabase captcha protection applies to signUp exactly as it does to signIn. Without a
  // token the project rejects the call with "captcha protection: request disallowed" —
  // which is why creating a staff login failed while logging in worked.
  const { data, error } = await supabase.auth.signUp({
    email: authEmail,
    password: authPassword,
    options: {
      data: { full_name: fullName, role, branch_id: branchId },
      ...(captchaToken ? { captchaToken } : {}),
    },
  })
  if (error) {
    if (/captcha/i.test(String(error.message || ''))) {
      throw appError(
        'AUTH06',
        'Complete the security check on the staff form before saving, then try again.',
      )
    }
    throw error
  }
  // The `staff` row id, distinct from data.user.id (the AUTH user id). The caller needs
  // this one for the audit trail — an audit row keyed to the auth user cannot be joined
  // back to the staff record support is actually looking at.
  let staffId = null
  if (data.user) {
    const staffPayload = {
      branch_id: branchId,
      full_name: fullName,
      role,
      is_active: true,
      login_code: pinRole ? String(loginCode || '').replace(/\D/g, '') : null,
      login_pin: pinRole ? String(loginPin || '') : null,
      auth_secret: pinRole ? String(loginPin || '') : null,
      permissions: Array.isArray(permissions) ? permissions : null,
    }
    const { data: existing } = await supabase
      .from('staff')
      .select('id')
      .eq('auth_user_id', data.user.id)
      .maybeSingle()
    if (existing?.id) {
      staffId = existing.id
      let { error: updateError } = await supabase.from('staff').update(staffPayload).eq('id', existing.id)
      if (updateError && (isMissingColumnError(updateError, 'login_code') || isMissingColumnError(updateError, 'permissions') || isMissingColumnError(updateError, 'auth_secret'))) {
        const fallback = { branch_id: branchId, full_name: fullName, role, is_active: true }
        ;({ error: updateError } = await supabase.from('staff').update(fallback).eq('id', existing.id))
      }
      if (updateError) {
        const uniqueErr = staffCodeUniqueError(updateError)
        if (uniqueErr) throw uniqueErr
        throw updateError
      }
    } else {
      let { data: inserted, error: insertError } = await supabase
        .from('staff')
        .insert({ auth_user_id: data.user.id, ...staffPayload })
        .select('id')
        .maybeSingle()
      if (insertError && (isMissingColumnError(insertError, 'login_code') || isMissingColumnError(insertError, 'permissions') || isMissingColumnError(insertError, 'auth_secret'))) {
        ;({ data: inserted, error: insertError } = await supabase
          .from('staff')
          .insert({
            auth_user_id: data.user.id,
            branch_id: branchId,
            full_name: fullName,
            role,
            is_active: true,
          })
          .select('id')
          .maybeSingle())
      }
      if (insertError) {
        const uniqueErr = staffCodeUniqueError(insertError)
        if (uniqueErr) throw uniqueErr
        if (insertError.code !== '23505') throw insertError
      }
      staffId = inserted?.id || null
      if (!staffId) {
        // 23505 means a trigger (handle_new_user) already created the row — read it back
        // so the caller still gets an id to audit against.
        const { data: found } = await supabase
          .from('staff')
          .select('id')
          .eq('auth_user_id', data.user.id)
          .maybeSingle()
        staffId = found?.id || null
      }
    }
  }
  if (managerSession) await supabase.auth.setSession(managerSession)
  return { ...data.user, staffId }
}

function staffCodeUniqueError(error) {
  if (!error) return null
  if (error.code === '23505' && /login_code|staff_login_code/i.test(String(error.message || error.details || ''))) {
    return new Error('That staff code is already in use. Choose a different unique code.')
  }
  if (error.code === '23505' && /staff_branch_login_code|login_code/i.test(String(error.message || error.details || ''))) {
    return new Error('That staff code is already in use. Choose a different unique code.')
  }
  return null
}

export async function updateStaffRow(id, changes) {
  const payload = { ...changes }
  if ('loginCode' in payload) {
    payload.login_code = payload.loginCode
    delete payload.loginCode
  }
  if ('loginPin' in payload) {
    payload.login_pin = payload.loginPin
    // Keep Auth secret aligned so next PIN login can sign in with the till PIN.
    payload.auth_secret = payload.loginPin
    delete payload.loginPin
  }
  let { data, error } = await supabase.from('staff').update(payload).eq('id', id).select('*, branches(name)').single()
  if (error && (isMissingColumnError(error, 'login_code') || isMissingColumnError(error, 'login_pin') || isMissingColumnError(error, 'permissions'))) {
    const fallback = { ...payload }
    delete fallback.login_code
    delete fallback.login_pin
    delete fallback.permissions
    ;({ data, error } = await supabase.from('staff').update(fallback).eq('id', id).select('*, branches(name)').single())
  }
  const uniqueErr = staffCodeUniqueError(error)
  if (uniqueErr) throw uniqueErr
  if (error) throw error
  return data
}

export async function revealStaffPin(staffId) {
  const { data, error } = await supabase
    .from('staff')
    .select('id, full_name, login_code, login_pin, role')
    .eq('id', staffId)
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Staff not found')
  await logAuditEvent({
    branchId: null,
    staffId: null,
    eventType: 'pin_viewed',
    detail: `PIN viewed for ${data.full_name}`,
    meta: { targetStaffId: staffId },
  }).catch(() => {})
  return { loginCode: data.login_code, loginPin: data.login_pin, name: data.full_name, role: data.role }
}

/**
 * Shape every shift row is read as. Written once because five call sites used to each
 * pick their own subset and drift.
 */
export function mapShiftRow(row) {
  if (!row) return null
  return {
    id: row.id,
    serverId: row.id,
    clientId: row.client_id || null,
    branchId: row.branch_id,
    branchName: row.branches?.name || '',
    staffId: row.staff_id,
    staffName: row.staff?.full_name || '',
    staffRole: row.staff?.role || '',
    drawerId: row.drawer_id || 'main',
    drawerLabel: row.drawer_label || '',
    holdsDrawer: row.holds_drawer !== false,
    businessDate: row.business_date || null,
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    shiftPeriod: row.shift_period === 'am' || row.shift_period === 'pm' ? row.shift_period : null,
    startingCash: row.starting_cash == null ? null : Number(row.starting_cash),
    carriedFromShiftId: row.carried_from_shift_id || null,
    carriedAmount: row.carried_amount == null ? null : Number(row.carried_amount),
    endingCash: row.ending_cash == null ? null : Number(row.ending_cash),
    expectedCash: row.expected_cash == null ? null : Number(row.expected_cash),
    variance: row.variance == null ? null : Number(row.variance),
    cashSales: Number(row.cash_sales || 0),
    cashRefunds: Number(row.cash_refunds || 0),
    cashPaidOut: Number(row.cash_paid_out || 0),
    cashPickups: Number(row.cash_pickups || 0),
    closeNote: row.close_note || '',
    closedBy: row.closed_by || null,
    closedWithoutSupervisor: row.closed_without_supervisor === true,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    open: !row.clock_out,
    status: row.clock_out ? 'closed' : 'open',
  }
}

const SHIFT_COLS =
  'id, branch_id, staff_id, drawer_id, drawer_label, holds_drawer, business_date, clock_in, clock_out, shift_period, starting_cash, carried_from_shift_id, carried_amount, ending_cash, expected_cash, variance, cash_sales, cash_refunds, cash_paid_out, cash_pickups, close_note, closed_by, client_id, closed_without_supervisor, reviewed_by, reviewed_at'
// shift_period (migrate_staff_shift_period.sql) and closed_without_supervisor/reviewed_by/
// reviewed_at (migrate_shift_close_no_supervisor_flag.sql) are each optional, independent of
// the core cash-accountability schema. Selecting any of them alongside the cash columns means
// one missing optional column fails the whole select, and the fallback ladder would then drop
// to a column set with no starting_cash / ending_cash at all — which reads as "the float was
// never recorded" rather than as a schema gap. This tier keeps every cash figure and gives up
// only the optional columns, together, rather than trying to isolate which one is missing.
const SHIFT_COLS_CORE = SHIFT_COLS.replace(
  ', shift_period',
  '',
).replace(', closed_without_supervisor, reviewed_by, reviewed_at', '')
const SHIFT_COLS_LEGACY = 'id, branch_id, staff_id, clock_in, clock_out, shift_period'
const SHIFT_COLS_MINIMAL = 'id, branch_id, staff_id, clock_in, clock_out'

/** One of the optional staff_shifts columns is absent — a migration hasn't been applied yet. */
function isMissingOptionalShiftColumn(error) {
  return /shift_period|closed_without_supervisor|reviewed_by|reviewed_at/i.test(
    String(error?.message || error || ''),
  )
}

/** True when the database predates migrate_shift_cash_accountability.sql. */
function isMissingShiftCashSchema(error) {
  return /drawer_id|starting_cash|business_date|open_staff_shift|close_staff_shift|shift_cash_summary|adjust_shift_cash|schema cache|does not exist|Could not find/i.test(
    String(error?.message || error || ''),
  )
}

/** The RPC itself is absent — i.e. migrate_shift_cash_accountability.sql is not applied. */
function isMissingShiftRpc(error, name) {
  const raw = String(error?.message || error || '')
  return new RegExp(`Could not find the function.*${name}|function public\\.${name}.*does not exist`, 'i').test(raw)
}

/** Turn a Postgres exception raised by the shift RPCs into a support-coded error. */
function shiftRpcError(error) {
  const raw = String(error?.message || error || '')
  if (/SHIFT_DRAWER_BUSY/.test(raw)) return appError('SHIFT02', raw)
  if (/SHIFT_CLOSED/.test(raw)) return appError('SHIFT04', raw)
  if (/SHIFT_NOT_ALLOWED/.test(raw)) return appError('SHIFT05', raw)
  if (/SHIFT_FLOAT_REQUIRED|SHIFT_COUNT_REQUIRED|SHIFT_REASON_REQUIRED|SHIFT_BAD_AMOUNT|SHIFT_BAD_FIELD/.test(raw)) {
    return appError('SHIFT03', raw)
  }
  return error
}

/**
 * Start a shift and record its change fund in one server call.
 *
 * Idempotent on `clientId`, and it resumes rather than duplicates when the same cashier
 * is already open on the drawer — both matter because this call is replayed from the
 * offline outbox, where "ran twice" is normal, not exceptional.
 */
export async function openShift({
  branchId,
  staffId,
  drawerId,
  drawerLabel = null,
  startingCash,
  shiftPeriod = null,
  clientId = null,
  carriedFromShiftId = null,
  carriedAmount = null,
  businessDate = null,
  holdsDrawer = true,
}) {
  const { data, error } = await supabase.rpc('open_staff_shift', {
    p_branch_id: branchId,
    p_staff_id: staffId,
    p_drawer_id: drawerId || 'main',
    p_starting_cash: holdsDrawer ? Number(startingCash || 0) : null,
    p_shift_period: shiftPeriod === 'am' || shiftPeriod === 'pm' ? shiftPeriod : null,
    p_client_id: clientId,
    p_carried_from: carriedFromShiftId,
    p_carried_amount: carriedAmount == null ? null : Number(carriedAmount),
    p_business_date: businessDate,
    p_drawer_label: drawerLabel,
    p_holds_drawer: holdsDrawer !== false,
  })
  if (error) {
    // Database without migrate_shift_cash_accountability.sql. Fall back to the old
    // clock-in + change-fund-entry pair rather than refusing to open a shift, which would
    // stop the branch selling entirely until someone runs a migration.
    if (isMissingShiftRpc(error, 'open_staff_shift')) {
      const legacy = await clockIn({ branchId, staffId, shiftPeriod, businessDate })
      if (holdsDrawer !== false && Number(startingCash || 0) > 0 && legacy?.id) {
        await recordChangeFund({
          branchId,
          staffId,
          shiftId: legacy.id,
          amount: Number(startingCash),
          note: 'Opening float',
          confirmedBy: staffId,
          businessDate,
        }).catch(() => {})
      }
      return mapShiftRow({
        ...legacy,
        drawer_id: drawerId || 'main',
        drawer_label: drawerLabel,
        holds_drawer: holdsDrawer !== false,
        starting_cash: holdsDrawer !== false ? Number(startingCash || 0) : null,
        business_date: businessDate,
        client_id: clientId,
      })
    }
    throw shiftRpcError(error)
  }
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

/**
 * End a shift. `endingCash` is optional now — ending a shift no longer counts the drawer
 * (Day End does that once per business day); when omitted the shift closes with no
 * ending/expected/variance figures rather than a fabricated ₱0.00 count. When a count IS
 * given, expected cash and variance are still computed server-side from rows attributed to
 * the shift — never sent from here.
 */
export async function closeShift({ shiftId, endingCash = null, note = '', closedBy = null }) {
  const { data, error } = await supabase.rpc('close_staff_shift', {
    p_shift_id: shiftId,
    p_ending_cash: endingCash == null ? null : Number(endingCash),
    p_note: note || null,
    p_closed_by: closedBy,
  })
  if (error) {
    // Pre-migration: end the shift the old way. No expected/variance is computed, because
    // nothing attributed sales to the shift — a fabricated variance would be worse. The
    // counted cash itself is still written; see clockOut.
    if (isMissingShiftRpc(error, 'close_staff_shift')) {
      return mapShiftRow(await clockOut(shiftId, { endingCash, note, closedBy }))
    }
    throw shiftRpcError(error)
  }
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

/**
 * Manager sign-off on a shift that was closed under its own cashier's count because no
 * supervisor/manager could witness it (see ShiftCashOut's "no supervisor available" path).
 * Requires migrate_shift_close_no_supervisor_flag.sql — absent on older databases, in which
 * case there is nothing to acknowledge, so this is a no-op rather than an error.
 */
export async function acknowledgeShiftReview(shiftId, staffId) {
  const { data, error } = await supabase.rpc('acknowledge_shift_review', {
    p_shift_id: shiftId,
    p_staff_id: staffId,
  })
  if (error) {
    if (isMissingShiftRpc(error, 'acknowledge_shift_review')) return null
    throw shiftRpcError(error)
  }
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

/** Live cash position of an open shift — what the cash-out screen counts against. */
export async function fetchShiftCashSummary(shiftId) {
  const { data, error } = await supabase.rpc('shift_cash_summary', { p_shift_id: shiftId })
  if (error) {
    if (isMissingShiftCashSchema(error)) return null
    throw error
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    startingCash: Number(row.starting_cash || 0),
    cashSales: Number(row.cash_sales || 0),
    cashRefunds: Number(row.cash_refunds || 0),
    cashPaidOut: Number(row.cash_paid_out || 0),
    cashPickups: Number(row.cash_pickups || 0),
    expectedCash: Number(row.expected_cash || 0),
    saleCount: Number(row.sale_count || 0),
  }
}

/**
 * Whoever currently holds this drawer, if anyone.
 *
 * Goes through drawer_holder() rather than reading staff_shifts, because RLS deliberately
 * hides other cashiers' shifts from a cashier — and this is the one thing about them a
 * cashier legitimately needs before counting cash into the same till. The function returns
 * a name and a start time only, no cash figures.
 */
export async function fetchOpenShiftOnDrawer({ branchId, drawerId }) {
  const { data, error } = await supabase.rpc('drawer_holder', {
    p_branch_id: branchId,
    p_drawer_id: drawerId || 'main',
  })
  if (error) {
    if (isMissingShiftCashSchema(error)) return null
    throw error
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    id: row.shift_id,
    serverId: row.shift_id,
    branchId,
    drawerId: drawerId || 'main',
    staffId: row.staff_id,
    staffName: row.staff_name || 'Another cashier',
    clockIn: row.clock_in,
    isMine: row.is_mine === true,
    holdsDrawer: true,
    open: true,
    status: 'open',
    // Deliberately absent: this view carries no cash figures.
    startingCash: null,
  }
}

/** Every open shift at a branch — the supervisor's "who is on the tills" view. */
export async function fetchOpenShiftsForBranch(branchId) {
  const run = (cols) =>
    supabase
      .from('staff_shifts')
      .select(`${cols}, staff:staff_id(id, full_name, role)`)
      .eq('branch_id', branchId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })

  let { data, error } = await run(SHIFT_COLS)
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_CORE))
  }
  if (error) {
    if (isMissingShiftCashSchema(error)) return []
    throw error
  }
  return (data || []).map(mapShiftRow)
}

/** Last shift to cash out on this drawer — its ending count pre-fills a handoff. */
export async function fetchLastClosedShiftOnDrawer({ branchId, drawerId }) {
  const { data, error } = await supabase.rpc('drawer_last_count', {
    p_branch_id: branchId,
    p_drawer_id: drawerId || 'main',
  })
  if (error) {
    if (isMissingShiftCashSchema(error)) return null
    throw error
  }
  const row = Array.isArray(data) ? data[0] : data
  if (!row) return null
  return {
    id: row.shift_id,
    serverId: row.shift_id,
    branchId,
    drawerId: drawerId || 'main',
    staffName: row.staff_name || '',
    clockOut: row.clock_out,
    endingCash: row.ending_cash == null ? null : Number(row.ending_cash),
    holdsDrawer: true,
    open: false,
    status: 'closed',
  }
}

/** Supervisor/manager correction to a closed shift's count. Always logged, never silent. */
export async function adjustShiftCash({ shiftId, field, newValue, reason, approvedBy = null }) {
  const { data, error } = await supabase.rpc('adjust_shift_cash', {
    p_shift_id: shiftId,
    p_field: field,
    p_new_value: Number(newValue),
    p_reason: reason,
    p_approved_by: approvedBy,
  })
  if (error) throw shiftRpcError(error)
  return mapShiftRow(Array.isArray(data) ? data[0] : data)
}

export async function fetchShiftAdjustments(shiftIds = []) {
  const ids = (shiftIds || []).filter(Boolean)
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('shift_adjustments')
    .select('id, shift_id, field, old_value, new_value, reason, adjusted_by, approved_by, created_at, staff:adjusted_by(full_name)')
    .in('shift_id', ids)
    .order('created_at', { ascending: false })
  if (error) {
    if (isMissingShiftCashSchema(error)) return []
    throw error
  }
  return (data || []).map((row) => ({
    id: row.id,
    shiftId: row.shift_id,
    field: row.field,
    oldValue: row.old_value == null ? null : Number(row.old_value),
    newValue: Number(row.new_value || 0),
    reason: row.reason || '',
    adjustedBy: row.adjusted_by || null,
    adjustedByName: row.staff?.full_name || '',
    approvedBy: row.approved_by || null,
    createdAt: row.created_at,
  }))
}

export async function clockIn({ branchId, staffId, shiftPeriod = null, businessDate = null }) {
  const period = shiftPeriod === 'am' || shiftPeriod === 'pm' ? shiftPeriod : null
  const payload = {
    branch_id: branchId,
    staff_id: staffId,
    clock_in: new Date().toISOString(),
  }
  if (period) payload.shift_period = period
  // Stamp the business date the till computed. Without it the row is invisible to every
  // business-date range query (see fetchStaffShifts), so a shift opened through this
  // legacy path would never appear in Day end's "Change fund by shift".
  if (businessDate) payload.business_date = businessDate
  const { data, error } = await supabase.from('staff_shifts').insert(payload).select('*').single()
  if (error) {
    // Older DBs without shift_period / business_date — retry with the minimum column set
    if (
      (period || businessDate) &&
      (isMissingColumnError(error, 'shift_period') ||
        isMissingColumnError(error, 'business_date') ||
        /shift_period|business_date/i.test(String(error.message || '')))
    ) {
      const fallback = await supabase
        .from('staff_shifts')
        .insert({
          branch_id: branchId,
          staff_id: staffId,
          clock_in: new Date().toISOString(),
        })
        .select('*')
        .single()
      if (fallback.error) throw fallback.error
      return fallback.data
    }
    throw error
  }
  return data
}

/**
 * End a shift by writing clock_out directly — the pre-RPC path.
 *
 * The counted drawer has to be written here too. Clocking out and dropping `ending_cash`
 * closes the shift with no count on it, which every reader then shows as "Pending handoff"
 * forever: a closed shift cannot be edited afterwards, so the cashier's figure is gone for
 * good. Expected/variance are still left null — nothing attributed sales to the shift on
 * this schema, and a fabricated variance would be worse than an absent one.
 */
export async function clockOut(shiftId, { endingCash = null, note = '', closedBy = null } = {}) {
  const clockOutAt = new Date().toISOString()
  const patch = { clock_out: clockOutAt }
  if (endingCash != null) patch.ending_cash = Number(endingCash)
  if (note) patch.close_note = note
  if (closedBy) patch.closed_by = closedBy

  const run = (values) =>
    supabase.from('staff_shifts').update(values).eq('id', shiftId).select('*').single()

  let { data, error } = await run(patch)
  // Truly old schema: staff_shifts is just a clock-in/clock-out log with nowhere to put a
  // count. Ending the shift still has to work — the drawer figure is recorded on paper.
  if (
    error &&
    (isMissingColumnError(error, 'ending_cash') ||
      isMissingColumnError(error, 'close_note') ||
      isMissingColumnError(error, 'closed_by'))
  ) {
    ;({ data, error } = await run({ clock_out: clockOutAt }))
  }
  if (error) throw error
  return data
}

/**
 * The staff member's own open shift, if any.
 *
 * `drawerId` narrows it to one physical till: same cashier on a DIFFERENT terminal is not
 * the same cash context, so that must not resume — see Shell's shift gate.
 */
export async function fetchOpenShift(staffId, { drawerId = null } = {}) {
  const run = async (cols) => {
    let query = supabase
      .from('staff_shifts')
      .select(cols)
      .eq('staff_id', staffId)
      .is('clock_out', null)
    // Only narrow by drawer on column sets that actually have the column — the older tiers
    // predate per-drawer shifts, and filtering on it there fails the query outright.
    if (drawerId && cols.includes('drawer_id')) query = query.eq('drawer_id', drawerId)
    return query.order('clock_in', { ascending: false }).limit(1).maybeSingle()
  }

  // shift_period first: it is only a label, and treating its absence as a missing cash schema
  // would resume the shift with no starting_cash — the cashier's change fund would read as
  // never counted. See SHIFT_COLS_CORE.
  let { data, error } = await run(SHIFT_COLS)
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_CORE))
  }
  if (error && isMissingShiftCashSchema(error)) {
    ;({ data, error } = await run(SHIFT_COLS_LEGACY))
  }
  if (error) {
    if (isMissingOptionalShiftColumn(error) || /schema cache|column/i.test(String(error.message || ''))) {
      const fallback = await run(SHIFT_COLS_MINIMAL)
      if (fallback.error) {
        if (isMissingColumnError(fallback.error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(fallback.error.message || ''))) {
          return null
        }
        throw fallback.error
      }
      return mapShiftRow(fallback.data)
    }
    if (isMissingColumnError(error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(error.message || ''))) {
      return null
    }
    throw error
  }
  return mapShiftRow(data)
}

/**
 * Shift log for supervisors (one branch) or managers (all / filtered).
 *
 * Ranges match on `business_date`, not on `clock_in`. Filtering by the clock-in instant
 * dropped shifts out of Day end's "Change fund by shift" for two independent reasons:
 *
 *  - A business day runs from the branch's open hour to the next open hour, so a shift
 *    started at 05:00 belongs to the PREVIOUS business date. Bucketing it by the calendar
 *    day of its clock-in files it under a day the supervisor is not looking at.
 *  - `clock_in` is timestamptz and a bare `2026-08-09T00:00:00` is read in the database
 *    session's zone — UTC on Supabase, not Manila. That shifted the whole window eight
 *    hours, so the opening hours of every trading day fell outside it.
 *
 * Together those made a drawer's own float and closing count look unrecorded. `business_date`
 * is a plain date written from the same value the till computed, so neither applies. Rows
 * predating that column fall back to clock_in rather than disappearing.
 */
export async function fetchStaffShifts({ branchId = null, start = null, end = null, limit = 300 } = {}) {
  const JOINS = 'staff:staff_id(id, full_name, role), branches:branch_id(id, name)'
  const clockInTerms = [
    start ? `clock_in.gte.${start}T00:00:00` : null,
    end ? `clock_in.lte.${end}T23:59:59` : null,
  ].filter(Boolean)
  const businessDateTerms = [
    start ? `business_date.gte.${start}` : null,
    end ? `business_date.lte.${end}` : null,
  ].filter(Boolean)

  const run = async (cols) => {
    let query = supabase
      .from('staff_shifts')
      .select(`${cols}, created_at, ${JOINS}`)
      .order('clock_in', { ascending: false })
      .limit(limit)
    if (branchId) query = query.eq('branch_id', branchId)
    if (clockInTerms.length) {
      if (cols === SHIFT_COLS || cols === SHIFT_COLS_CORE) {
        query = query.or(
          `and(${businessDateTerms.join(',')}),and(business_date.is.null,${clockInTerms.join(',')})`,
        )
      } else {
        // Legacy schema has no business_date to match on.
        if (start) query = query.gte('clock_in', `${start}T00:00:00`)
        if (end) query = query.lte('clock_in', `${end}T23:59:59.999`)
      }
    }
    return query
  }

  // Newest schema first, then progressively older ones. A branch mid-migration still gets
  // a usable shift log instead of an empty page. The optional columns are checked before the
  // cash schema because isMissingShiftCashSchema matches "does not exist" generically: without
  // this ordering a missing optional column would be read as a missing cash schema and every
  // float and closing count would silently drop out of the result.
  let { data, error } = await run(SHIFT_COLS)
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_CORE))
  }
  if (error && isMissingShiftCashSchema(error)) {
    ;({ data, error } = await run(SHIFT_COLS_LEGACY))
  }
  if (error && isMissingOptionalShiftColumn(error)) {
    ;({ data, error } = await run(SHIFT_COLS_MINIMAL))
  }
  if (error) {
    if (isMissingColumnError(error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(error.message || ''))) {
      return []
    }
    throw error
  }
  // `staff:staff_id(...)` above is a PostgREST embed, filtered by `staff`'s own RLS (self
  // row or manager only) — a supervisor reading their branch's shift log got every OTHER
  // cashier's name silently blanked by that join. Re-resolve through
  // resolve_staff_identities(), which grants a supervisor their own branch, and prefer it
  // over whatever the embed did manage to return.
  const who = await fetchStaffIdentities((data || []).map((row) => row.staff_id)).catch(() => ({}))
  return (data || []).map((row) => {
    const identity = who[row.staff_id]
    const mapped = mapShiftRow(identity ? { ...row, staff: { full_name: identity.name, role: identity.role } } : row)
    return {
      ...mapped,
      branchName: row.branches?.name || '—',
      staffName: identity?.name || row.staff?.full_name || 'Staff',
    }
  })
}

/** Cash drawer ledger (change fund · pickups · petty paid-outs). Renamed from petty_cash. */
export const CASH_DRAWER_TABLE = 'cash_drawer_entries'
const CASH_DRAWER_LEGACY_TABLE = 'petty_cash'
const CASH_DRAWER_COLS =
  'id, branch_id, staff_id, amount, reason, business_date, created_at, kind, status, receipt_ref, shift_id, requested_by, approved_by, approved_at, confirmed_by, confirmed_at, reject_reason'

function isMissingCashDrawerTable(error) {
  return /cash_drawer_entries|petty_cash|Could not find the table|relation .* does not exist|schema cache/i.test(
    String(error?.message || error || ''),
  )
}

/** Prefer cash_drawer_entries; fall back to legacy petty_cash until migration is applied. */
async function withCashDrawerTable(run) {
  const primary = await run(CASH_DRAWER_TABLE)
  if (primary?.error && isMissingCashDrawerTable(primary.error)) {
    return run(CASH_DRAWER_LEGACY_TABLE)
  }
  return primary
}

export async function addPettyCash({
  branchId,
  staffId,
  amount,
  reason,
  businessDate,
  kind = 'paid_out',
  status = 'approved',
  receiptRef = null,
  shiftId = null,
  requestedBy = null,
  approvedBy = null,
  confirmedBy = null,
}) {
  const resolvedKind =
    kind ||
    (/^\[CHANGE FUND\]/i.test(reason || '')
      ? 'change_fund'
      : /^\[PICKUP\]/i.test(reason || '')
        ? 'pickup'
        : 'paid_out')
  const payload = {
    branch_id: branchId,
    staff_id: staffId,
    amount: Number(amount),
    reason: reason || '',
    business_date: businessDate,
    kind: resolvedKind,
    status,
    receipt_ref: receiptRef || null,
    shift_id: shiftId || null,
    requested_by: requestedBy || staffId || null,
    approved_by: approvedBy || (status === 'approved' || status === 'recorded' ? staffId : null),
    approved_at:
      status === 'approved' || status === 'recorded' ? new Date().toISOString() : null,
    confirmed_by: confirmedBy || null,
    confirmed_at: confirmedBy ? new Date().toISOString() : null,
  }
  let { data, error } = await withCashDrawerTable((table) =>
    supabase.from(table).insert(payload).select('*').single(),
  )
  if (error && /kind|status|receipt_ref|shift_id|schema cache|column/i.test(String(error.message || ''))) {
    // Older schema without workflow columns
    ;({ data, error } = await withCashDrawerTable((table) =>
      supabase
        .from(table)
        .insert({
          branch_id: branchId,
          staff_id: staffId,
          amount: Number(amount),
          reason: reason || '',
          business_date: businessDate,
        })
        .select('*')
        .single(),
    ))
  }
  if (error) throw error
  return mapPettyCashRow(data)
}

function mapPettyCashRow(row) {
  if (!row) return null
  const reason = String(row.reason || '')
  const kind =
    row.kind ||
    (/^\[CHANGE FUND\]/i.test(reason)
      ? 'change_fund'
      : /^\[PICKUP\]/i.test(reason)
        ? 'pickup'
        : 'paid_out')
  // A paid-out with no status predates the workflow columns, so the cash was already handed
  // over — 'fulfilled', matching rowStatus() in DayEnd.jsx. Defaulting to 'approved' would
  // park a years-old disbursement in the "awaiting hand-over" queue and add its cash back
  // into the expected drawer.
  const status =
    row.status ||
    (kind === 'paid_out' ? 'fulfilled' : 'recorded')
  return {
    id: row.id,
    branchId: row.branch_id,
    staffId: row.staff_id,
    amount: Number(row.amount || 0),
    reason,
    kind,
    status,
    receiptRef: row.receipt_ref || '',
    shiftId: row.shift_id || null,
    requestedBy: row.requested_by || row.staff_id || null,
    approvedBy: row.approved_by || null,
    approvedAt: row.approved_at || null,
    confirmedBy: row.confirmed_by || null,
    confirmedAt: row.confirmed_at || null,
    rejectReason: row.reject_reason || '',
    businessDate: row.business_date,
    createdAt: row.created_at,
  }
}

/** Opening float at clock-in — cashier enters amount (no separate supervisor PIN step). */
export async function recordChangeFund({
  branchId,
  staffId,
  shiftId,
  amount,
  note,
  confirmedBy,
  businessDate,
}) {
  return addPettyCash({
    branchId,
    staffId,
    amount,
    reason: `[CHANGE FUND] ${note || 'Opening float'}`.trim(),
    businessDate,
    kind: 'change_fund',
    status: 'recorded',
    shiftId,
    requestedBy: staffId,
    confirmedBy,
  })
}

/** Staff requests petty cash (paid-out) — awaits supervisor/manager approval. */
export async function requestPettyCash({
  branchId,
  staffId,
  amount,
  reason,
  receiptRef,
  businessDate,
  shiftId = null,
  autoApprove = false,
}) {
  const why = String(reason || '').trim()
  if (!why) throw new Error('A reason is required for petty cash requests.')
  return addPettyCash({
    branchId,
    staffId,
    amount,
    reason: why,
    receiptRef: String(receiptRef || '').trim() || null,
    businessDate,
    kind: 'paid_out',
    // A supervisor-or-above requesting their own branch's petty cash already holds
    // approval authority — the immediate next step would just be them clicking Approve
    // on their own row, same as submit_day_end collapsing self-approval. `autoApprove`
    // is the caller's `canApprove` (see PettyCashPanel), the same gate the manual
    // Approve button already uses, so this adds no new trust beyond what that button had.
    status: autoApprove ? 'approved' : 'pending',
    requestedBy: staffId,
    approvedBy: autoApprove ? staffId : null,
    shiftId,
  })
}

export async function approvePettyCash({ id, approvedBy }) {
  const { data, error } = await withCashDrawerTable((table) =>
    supabase
      .from(table)
      .update({
        status: 'approved',
        approved_by: approvedBy,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .single(),
  )
  if (error) throw error
  return mapPettyCashRow(data)
}

/**
 * Mark an approved petty-cash request as physically handed over.
 *
 * `.eq('status', 'approved')` is the control, not a filter: it means a row can only ever
 * reach 'fulfilled' from 'approved', so cash cannot be disbursed against a request nobody
 * signed off. The same rule is enforced in the database by
 * cash_drawer_entries_fulfil_needs_approval (migrate_petty_cash_fulfilment.sql) — the UI
 * is not the boundary here.
 *
 * Whoever is on site does this, including the cashier who raised the request. That is
 * deliberate: the approval already happened, and requiring the approver to be present to
 * hand over the money is exactly the deadlock this split exists to remove.
 */
export async function fulfillPettyCash({ id, confirmedBy }) {
  const { data, error } = await withCashDrawerTable((table) =>
    supabase
      .from(table)
      .update({
        status: 'fulfilled',
        confirmed_by: confirmedBy,
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'approved')
      .select('*')
      .single(),
  )
  if (error) {
    if (/fulfil_needs_approval|violates check constraint/i.test(String(error.message || ''))) {
      throw appError('PETTY03', 'This request has no recorded approval.')
    }
    // No row came back = it was not in 'approved' state (already fulfilled, or rejected).
    if (/multiple \(or no\) rows|0 rows/i.test(String(error.message || ''))) {
      throw appError('PETTY03', 'Only an approved request can be marked as handed over.')
    }
    throw error
  }
  return mapPettyCashRow(data)
}

export async function rejectPettyCash({ id, approvedBy, reason = '' }) {
  const { data, error } = await withCashDrawerTable((table) =>
    supabase
      .from(table)
      .update({
        status: 'rejected',
        approved_by: approvedBy,
        approved_at: new Date().toISOString(),
        reject_reason: reason || null,
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('*')
      .single(),
  )
  if (error) throw error
  return mapPettyCashRow(data)
}

/** Resolve requester / approver / fulfiller names (and the approver's role) onto rows. */
async function withPettyCashActors(rows) {
  if (!rows.length) return rows
  const who = await fetchStaffIdentities([
    ...rows.map((row) => row.staffId),
    ...rows.map((row) => row.requestedBy),
    ...rows.map((row) => row.approvedBy),
    ...rows.map((row) => row.confirmedBy),
  ]).catch(() => ({}))
  return rows.map((row) => ({
    ...row,
    staffName: who[row.staffId]?.name || null,
    requestedByName: row.requestedBy ? who[row.requestedBy]?.name || null : null,
    approvedByName: row.approvedBy ? who[row.approvedBy]?.name || null : null,
    approvedByRole: row.approvedBy ? who[row.approvedBy]?.role || null : null,
    confirmedByName: row.confirmedBy ? who[row.confirmedBy]?.name || null : null,
  }))
}

export async function fetchPettyCash(branchId, businessDate) {
  const { data, error } = await withCashDrawerTable((table) =>
    supabase
      .from(table)
      .select(CASH_DRAWER_COLS)
      .eq('branch_id', branchId)
      .eq('business_date', businessDate)
      .order('created_at', { ascending: false }),
  )
  if (error) {
    if (isMissingCashDrawerTable(error)) return []
    // Older schemas without kind/status columns
    if (/kind|status|receipt_ref|schema cache|column/i.test(String(error.message || ''))) {
      const fallback = await withCashDrawerTable((table) =>
        supabase
          .from(table)
          .select('id, branch_id, staff_id, amount, reason, business_date, created_at')
          .eq('branch_id', branchId)
          .eq('business_date', businessDate)
          .order('created_at', { ascending: false }),
      )
      if (fallback.error) {
        if (isMissingCashDrawerTable(fallback.error)) return []
        throw fallback.error
      }
      return (fallback.data || []).map(mapPettyCashRow)
    }
    throw error
  }
  // Names/roles for the three actors, so the day-end panel can say who asked, who
  // approved and who handed the cash over without a second round trip per row.
  return withPettyCashActors((data || []).map(mapPettyCashRow))
}

export async function fetchPettyCashTimeline(branchId, { startDate, endDate } = {}) {
  const runQuery = (cols) =>
    withCashDrawerTable((table) => {
      let query = supabase
        .from(table)
        .select(cols)
        .eq('branch_id', branchId)
        .order('created_at', { ascending: false })
      if (startDate) query = query.gte('business_date', startDate)
      if (endDate) query = query.lte('business_date', endDate)
      return query
    })

  let { data, error } = await runQuery(CASH_DRAWER_COLS)
  if (error && /kind|status|receipt_ref|schema cache|column/i.test(String(error.message || ''))) {
    ;({ data, error } = await runQuery('id, branch_id, staff_id, amount, reason, business_date, created_at'))
  }
  if (error) {
    if (isMissingCashDrawerTable(error)) return []
    throw error
  }

  const rows = (data || []).map(mapPettyCashRow)
  const who = await fetchStaffIdentities([
    ...rows.map((row) => row.staffId),
    ...rows.map((row) => row.requestedBy),
    ...rows.map((row) => row.approvedBy),
    ...rows.map((row) => row.confirmedBy),
  ])
  return rows.map((row) => ({
    ...row,
    staffName: who[row.staffId]?.name || 'Staff',
    requestedByName: row.requestedBy ? who[row.requestedBy]?.name || 'Staff' : null,
    approvedByName: row.approvedBy ? who[row.approvedBy]?.name || 'Staff' : null,
    approvedByRole: row.approvedBy ? who[row.approvedBy]?.role || null : null,
    confirmedByName: row.confirmedBy ? who[row.confirmedBy]?.name || 'Staff' : null,
    confirmedByRole: row.confirmedBy ? who[row.confirmedBy]?.role || null : null,
  }))
}

/**
 * Today's payment/cash-drawer impact for one branch — sales by tender (net of same-tender
 * refunds, same as `recorded`/`netTotal` on `SupervisorDayEnd`), cash actually handed back,
 * and the resulting expected-cash figure. `expectedCash` is the EXACT formula
 * `SupervisorDayEnd` (`DayEnd.jsx`) uses for its own "Expected" line, reused here rather than
 * re-derived, so a dashboard tile can never quietly disagree with the real Day End screen.
 *
 * `cardSales`/`ewalletSales` are informational only — deliberately excluded from
 * `expectedCash`, since a card/e-wallet payment never touches the physical drawer.
 *
 * Always scoped to one business day (`date`) — an expected-cash figure is a once-per-day
 * drawer count, not something that means anything summed over a week.
 */
export async function fetchBranchCashImpact(branchId, date, openHour = 7) {
  const empty = {
    cashSales: 0,
    cardSales: 0,
    ewalletSales: 0,
    cashRefunds: 0,
    changeFund: 0,
    pickup: 0,
    paidOut: 0,
    expectedCash: 0,
  }
  if (!branchId || !date || !supabase) return empty

  // A generous calendar-day buffer around the business date, narrowed precisely afterward
  // with rowBusinessDate — never compare a business date to a calendar date directly (see
  // the same rule in DayEnd.jsx / BranchDashboard.jsx).
  const windowStart = new Date(`${date}T00:00:00`)
  windowStart.setDate(windowStart.getDate() - 1)
  const windowEnd = new Date(`${date}T00:00:00`)
  windowEnd.setDate(windowEnd.getDate() + 2)

  const [txRes, pettyRows, shiftRows] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from('transactions')
        .select('total_amount, refunded_amount, status, payment_method, created_at')
        .eq('branch_id', branchId)
        .gte('created_at', windowStart.toISOString())
        .lt('created_at', windowEnd.toISOString())
        .order('created_at', { ascending: true })
        .range(from, to),
    ),
    fetchPettyCashTimeline(branchId, { startDate: date, endDate: date }).catch(() => []),
    fetchStaffShifts({ branchId, start: date, end: date }).catch(() => []),
  ])
  if (txRes.error) throw txRes.error

  const todayRows = (txRes.data || [])
    .map((row) => ({
      total: Number(row.total_amount || 0),
      refundedAmount: Number(row.refunded_amount || 0),
      status: row.status === 'voided' ? 'Voided' : 'Paid',
      paymentMethod: ['card', 'ewallet'].includes(String(row.payment_method || '').toLowerCase())
        ? String(row.payment_method).toLowerCase()
        : 'cash',
      createdAt: row.created_at,
    }))
    .filter((row) => rowBusinessDate(row, openHour) === date)

  const cashToday = todayRows.filter((row) => row.paymentMethod === 'cash')
  // Net of refunds — a voided sale was never counted in here (filtered to status === 'Paid'),
  // so its total never inflates this figure; only a real refund on a completed sale does.
  const netByMethod = (method) =>
    todayRows
      .filter((row) => row.status === 'Paid' && row.paymentMethod === method)
      .reduce((sum, row) => sum + Math.max(0, row.total - row.refundedAmount), 0)
  const cashSales = netByMethod('cash')
  const cardSales = netByMethod('card')
  const ewalletSales = netByMethod('ewallet')
  // Cash actually handed back on a refund only — the figure the physical drawer count is
  // reconciled against. A card/e-wallet refund never leaves this drawer, so it is not
  // summed in here.
  const cashRefunds = cashToday.reduce((sum, row) => sum + row.refundedAmount, 0)

  const drawerShifts = (shiftRows || []).filter((row) => row.holdsDrawer !== false)
  const shiftFloatTotal = drawerShifts.reduce((sum, row) => sum + Number(row.startingCash || 0), 0)
  // The float moved from cash_drawer_entries (`change_fund` rows) to staff_shifts.starting_cash
  // mid-project — both sources are summed, same as DayEnd.jsx, so a pre-migration business
  // day still counts its float correctly.
  const legacyFloatTotal = (pettyRows || [])
    .filter((row) => row.kind === 'change_fund')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  const changeFund = shiftFloatTotal + legacyFloatTotal
  const pickup = (pettyRows || [])
    .filter((row) => row.kind === 'pickup')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)
  // Only cash that has actually left the drawer — an approved-but-unfulfilled paid-out is
  // still sitting in the till (same rule DayEnd.jsx applies).
  const paidOut = (pettyRows || [])
    .filter((row) => row.kind === 'paid_out' && row.status === 'fulfilled')
    .reduce((sum, row) => sum + Number(row.amount || 0), 0)

  return {
    cashSales: Number(cashSales.toFixed(2)),
    cardSales: Number(cardSales.toFixed(2)),
    ewalletSales: Number(ewalletSales.toFixed(2)),
    cashRefunds: Number(cashRefunds.toFixed(2)),
    changeFund: Number(changeFund.toFixed(2)),
    pickup: Number(pickup.toFixed(2)),
    paidOut: Number(paidOut.toFixed(2)),
    expectedCash: Number((changeFund + cashSales - paidOut - pickup).toFixed(2)),
  }
}

export async function branchSummary(branchId, { days = 1 } = {}) {
  // LOCAL midnight, not toISOString(). In UTC+8 `toISOString().slice(0,10)` on a
  // day=1 window resolves to the previous local calendar day for any time before 08:00,
  // so the "Today" figure quietly included part of yesterday.
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (Math.max(1, days) - 1))
  const startIso = start.toISOString()

  const { data: branch } = await supabase
    .from('branches')
    .select('branch_type')
    .eq('id', branchId)
    .maybeSingle()
  const isRestaurant = branch?.branch_type === 'restaurant'

  // Paged. This feeds the headline Revenue/Orders KPI on the manager Overview, so a
  // truncation here understates the biggest number on the dashboard while the chart
  // directly beneath it — which is paged — shows the full figure.
  const { data: txs, error: txErr } = await fetchAllRows((from, to) =>
    supabase
      .from('transactions')
      .select('total_amount, discount_amount, refunded_amount, status')
      .eq('branch_id', branchId)
      .gte('created_at', startIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (txErr) throw txErr
  const paid = (txs || []).filter((t) => t.status === 'completed')
  const voided = (txs || []).filter((t) => t.status === 'voided')
  // Same reductions terminalReports.js uses for the X/Z reading — Gross/Net/Discounts/
  // Refunds/Voided must read the same everywhere or the dashboard and the printed reading
  // will disagree over the same sales.
  const grossSales = paid.reduce(
    (sum, t) => sum + Number(t.total_amount || 0) + Number(t.discount_amount || 0),
    0,
  )
  const netSales = paid.reduce(
    (sum, t) => sum + Number(t.total_amount || 0) - Number(t.refunded_amount || 0),
    0,
  )
  const discounts = paid.reduce((sum, t) => sum + Number(t.discount_amount || 0), 0)
  const refunds = paid.reduce((sum, t) => sum + Number(t.refunded_amount || 0), 0)
  const voidedSales = voided.reduce((sum, t) => sum + Number(t.total_amount || 0), 0)

  let lowStock = 0
  let menuOn = 0
  let menuOff = 0
  if (isRestaurant) {
    const { data: products } = await fetchAllRows((from, to) =>
      supabase
        .from('products')
        .select('available_today, is_active, id')
        .eq('branch_id', branchId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to),
    )
    ;(products || []).forEach((p) => {
      if (p.available_today !== false) menuOn += 1
      else menuOff += 1
    })
  } else {
    const { data: inv } = await fetchAllRows((from, to) =>
      supabase
        .from('branch_inventory')
        .select('quantity_on_hand, product_id, products(low_stock_threshold)')
        .eq('branch_id', branchId)
        .order('product_id', { ascending: true })
        .range(from, to),
    )
    lowStock = (inv || []).filter(
      (row) => Number(row.quantity_on_hand) <= Number(row.products?.low_stock_threshold ?? 5),
    ).length
  }

  return {
    revenue: paid.reduce((sum, t) => sum + Number(t.total_amount), 0),
    orders: paid.length,
    lowStock,
    menuOn,
    menuOff,
    branchType: isRestaurant ? 'restaurant' : 'retail',
    grossSales: Number(grossSales.toFixed(2)),
    netSales: Number(netSales.toFixed(2)),
    discounts: Number(discounts.toFixed(2)),
    refunds: Number(refunds.toFixed(2)),
    voidedSales: Number(voidedSales.toFixed(2)),
  }
}

/** period: 'day' | 'week' | 'month' | 'year' */
/**
 * Revenue and order count for the current period AND the one immediately before it,
 * so the dashboard can show "up 12% on last week" rather than a bare number.
 *
 * One query, not two: it reads the whole span from the start of the PREVIOUS window to
 * now and splits it client-side on the boundary. Two round trips would be no more
 * accurate and twice as slow on a page that already fans out per branch.
 *
 * The comparison window always matches the selected period — day vs. yesterday, week vs.
 * the week before, year vs. last year — because comparing a week against a month is not
 * a trend, it is a mistake with an arrow drawn on it.
 *
 * Branch scoping is left entirely to RLS, exactly as fetchNetworkDashboard does: a
 * manager's policy already limits them to branches they may see, so no client-side
 * filter is added that could disagree with it.
 */
export async function fetchPeriodComparison(period = 'week') {
  const days = period === 'day' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365
  const currentStart = new Date()
  currentStart.setHours(0, 0, 0, 0)
  currentStart.setDate(currentStart.getDate() - (days - 1))
  const previousStart = new Date(currentStart)
  previousStart.setDate(previousStart.getDate() - days)

  const { data, error } = await fetchAllRows((from, to) =>
    supabase
      .from('transactions')
      .select('total_amount, created_at')
      .eq('status', 'completed')
      .gte('created_at', previousStart.toISOString())
      .order('created_at', { ascending: true })
      .range(from, to),
  )
  if (error) throw error

  const boundary = currentStart.getTime()
  const current = { revenue: 0, orders: 0 }
  const previous = { revenue: 0, orders: 0 }
  ;(data || []).forEach((row) => {
    const when = new Date(row.created_at).getTime()
    const bucket = when >= boundary ? current : previous
    bucket.revenue += Number(row.total_amount) || 0
    bucket.orders += 1
  })

  return {
    period,
    days,
    current,
    previous,
    // `true` only when the previous window genuinely had activity. A brand-new shop has
    // no prior period, and 0 → anything is not a percentage — it is a first week. The UI
    // uses this to show "New" instead of a meaningless +∞.
    hasPrevious: previous.orders > 0,
  }
}

export async function fetchNetworkDashboard(periodOrDays = 'week') {
  const period =
    typeof periodOrDays === 'number'
      ? periodOrDays <= 1
        ? 'day'
        : periodOrDays <= 7
          ? 'week'
          : periodOrDays <= 31
            ? 'month'
            : 'year'
      : periodOrDays
  const days = period === 'day' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : 365
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const startIso = start.toISOString()
  // Paged. Unpaged this stopped at PostgREST's 1000-row cap with no error, which on the
  // Year view means the whole dashboard — revenue, branch split, payment mix — silently
  // under-reports by however much got cut off, while still looking like a real figure.
  const txQuery = (cols) => (from, to) =>
    supabase
      .from('transactions')
      .select(cols)
      .eq('status', 'completed')
      .gte('created_at', startIso)
      .order('created_at', { ascending: true })
      .range(from, to)

  let { data: txs, error: txError } = await fetchAllRows(
    txQuery('total_amount, status, created_at, branch_id, payment_method, branches(name)'),
  )
  if (txError && /payment_method|schema cache/i.test(String(txError.message || ''))) {
    ;({ data: txs, error: txError } = await fetchAllRows(
      txQuery('total_amount, status, created_at, branch_id, branches(name)'),
    ))
  }
  if (txError) throw txError
  txs = txs || []

  const localKey = (value) => {
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const byBucket = {}
  const byBranch = {}
  const byPay = { cash: 0, card: 0, ewallet: 0 }
  if (period === 'year') {
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      byBucket[key] = 0
    }
  } else if (period === 'day') {
    const now = new Date()
    for (let hour = 0; hour <= now.getHours(); hour += 1) {
      byBucket[String(hour).padStart(2, '0')] = 0
    }
  } else {
    for (let i = 0; i < days; i += 1) {
      const d = new Date(start)
      d.setDate(start.getDate() + i)
      byBucket[localKey(d)] = 0
    }
  }

  // Network-wide top products / top categories (by revenue) for the same window.
  const byProductNet = {}
  const byCategoryNet = {}
  try {
    const itemsRes = await supabase
      .from('transaction_items')
      .select(
        'quantity, line_total, product_id, products(name, categories(name)), transactions!inner(created_at, status)',
      )
      .gte('transactions.created_at', startIso)
      .eq('transactions.status', 'completed')
    if (itemsRes.error) throw itemsRes.error
    for (const row of itemsRes.data || []) {
      const revenue = Number(row.line_total || 0)
      const name = row.products?.name || 'Product'
      const category = row.products?.categories?.name || 'Other'
      const key = row.product_id || name
      if (!byProductNet[key]) byProductNet[key] = { id: key, name, category, revenue: 0, qty: 0 }
      byProductNet[key].revenue += revenue
      byProductNet[key].qty += Number(row.quantity || 0)
      byCategoryNet[category] = (byCategoryNet[category] || 0) + revenue
    }
  } catch {
    // Product/category breakdown is a nice-to-have on this dashboard — a schema
    // hiccup here shouldn't take down the revenue/branch/payment charts above.
  }

  const todayKey = localKey(new Date())
  // Order COUNT per bucket, alongside revenue. The line chart's tooltip needs it: ₱8,400
  // means something quite different from 4 orders than from 90, and revenue alone cannot
  // distinguish "a quiet day" from "a few big baskets".
  const ordersByBucket = {}
  Object.keys(byBucket).forEach((key) => {
    ordersByBucket[key] = 0
  })
  txs.forEach((row) => {
    const when = new Date(row.created_at)
    const dayKey = localKey(when)
    let bucketKey = dayKey
    if (period === 'year') bucketKey = dayKey.slice(0, 7)
    else if (period === 'day') {
      if (dayKey !== todayKey) return
      bucketKey = String(when.getHours()).padStart(2, '0')
    }
    const amount = Number(row.total_amount) || 0
    if (byBucket[bucketKey] != null) {
      byBucket[bucketKey] += amount
      ordersByBucket[bucketKey] += 1
    }
    const name = row.branches?.name || 'Branch'
    byBranch[name] = (byBranch[name] || 0) + amount
    const method = String(row.payment_method || 'cash').toLowerCase()
    if (method === 'card') byPay.card += amount
    else if (method === 'ewallet' || method === 'e-wallet' || method === 'gcash' || method === 'maya') {
      byPay.ewallet += amount
    } else byPay.cash += amount
  })

  return {
    period,
    days,
    linePoints: Object.entries(byBucket).map(([label, total]) => {
      const orders = ordersByBucket[label] || 0
      if (period === 'day') {
        const hour = Number(label)
        const suffix = hour < 12 ? 'AM' : 'PM'
        const display = hour % 12 === 0 ? 12 : hour % 12
        return { label: `${label}:00`, short: `${display} ${suffix}`, total, orders, full: `${display}:00 ${suffix}` }
      }
      const asDate =
        period === 'year'
          ? new Date(`${label}-01T00:00:00`)
          : new Date(`${label}T00:00:00`)
      return {
        label,
        short:
          period === 'year'
            ? asDate.toLocaleDateString([], { month: 'short', year: '2-digit' })
            : asDate.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        // Spelled out for the tooltip — "Mar 4" is fine on a crowded axis but ambiguous
        // when someone is reading an exact figure off a hover.
        full:
          period === 'year'
            ? asDate.toLocaleDateString([], { month: 'long', year: 'numeric' })
            : asDate.toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' }),
        total,
        orders,
      }
    }),
    branchBars: Object.entries(byBranch).map(([category, value]) => ({ category, value })),
    paymentMix: [
      { id: 'cash', label: 'Cash', value: byPay.cash },
      { id: 'card', label: 'Card', value: byPay.card },
      { id: 'ewallet', label: 'E-wallet', value: byPay.ewallet },
    ],
    topProducts: Object.values(byProductNet)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
      .map((p) => ({ category: p.name, value: Number(p.revenue.toFixed(2)) })),
    topCategories: Object.entries(byCategoryNet)
      .map(([category, value]) => ({ category, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value),
  }
}

/**
 * Raw (unaggregated) sold line items in a date range — the source for a branch's Top
 * Products/Categories (Dashboard.jsx) and DayEnd's sales report (dayEndReport.js).
 * Deliberately NOT `stock_movements`: that log survives a debug transaction reset (by
 * design — see debug_reset_all_transactions.sql) and would keep counting deleted test
 * sales as "today's sales" forever. Deliberately NOT priced from the product's current
 * price either — `line_total` is what was actually charged, immune to a later price edit.
 * Mirrors fetchNetworkDashboard's `itemsRes` query above, minus the branch_id column
 * (callers already have their own branch's `products` list loaded to resolve
 * name/category/pricingMode, same as the code that used to read stock_movements did).
 * Callers bucket these rows themselves — by calendar day (Dashboard) or business day via
 * rowBusinessDate (DayEnd) — same fetch-a-buffered-window-then-narrow-client-side split
 * fetchBranchCashImpact already uses.
 */
export async function fetchSoldLineItems({ branchId, startIso, endIso, includeVoided = false }) {
  const build = (from, to) => {
    let q = supabase
      .from('transaction_items')
      .select('quantity, line_total, product_id, transactions!inner(created_at, status, branch_id)')
      .gte('transactions.created_at', startIso)
      .lt('transactions.created_at', endIso)
      .range(from, to)
    if (!includeVoided) q = q.eq('transactions.status', 'completed')
    if (branchId) q = q.eq('transactions.branch_id', branchId)
    return q
  }
  // Paged — see fetchNetworkDashboard's 1000-row PostgREST cap comment above.
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return (data || []).map((row) => ({
    productId: row.product_id,
    quantity: Number(row.quantity || 0),
    revenue: Number(row.line_total || 0),
    createdAt: row.transactions?.created_at || null,
  }))
}

/**
 * Sale lines in range, the source for every line-level report.
 *
 * Paged via fetchAllRows because PostgREST caps a response at db-max-rows (1000) and
 * returns the truncated page with NO error. Unpaged, a report over any busy month would
 * quietly stop partway and still print a total — the worst possible failure for a document
 * someone files. Always page anything that can exceed 1000 rows.
 */
export async function fetchReportSalesDetail({ start, end, branchId, includeVoided = false }) {
  // BOTH column sets have to vary in the fallback. An earlier version held the product
  // columns constant, so the retry re-sent the identical `unit_cost` selection that had
  // just failed — meaning the fallback for a missing unit_cost could never actually
  // recover, and every line-level report hard-failed on schemas where it used to work.
  const PRODUCT_FULL = 'products(id, product_no, name, sku, unit_cost, category_id, categories(name))'
  const PRODUCT_MIN = 'products(id, product_no, name, sku, category_id, categories(name))'
  const TXN_FULL =
    'id, or_number, created_at, status, void_reason, voided_at, branch_id, staff_id, amount_tendered, total_amount, order_type, ulam_combo, payment_method, payment_reference'
  const TXN_MIN =
    'id, or_number, created_at, status, void_reason, voided_at, branch_id, staff_id, amount_tendered, total_amount, order_type, ulam_combo'

  const build = (productCols, txnCols) => (from, to) => {
    let q = supabase
      .from('transaction_items')
      .select(`*, ${productCols}, transactions!inner(${txnCols})`)
      .gte('transactions.created_at', `${start}T00:00:00`)
      .lte('transactions.created_at', `${end}T23:59:59`)
      .order('id', { ascending: true })
      .range(from, to)
    if (!includeVoided) q = q.eq('transactions.status', 'completed')
    if (branchId) q = q.eq('transactions.branch_id', branchId)
    return q
  }

  let { data, error } = await fetchAllRows(build(PRODUCT_FULL, TXN_FULL))
  if (error && /payment_method|payment_reference|unit_cost|schema cache|column/i.test(String(error.message || ''))) {
    // Older schemas without payment and/or cost columns — drop both optional sets.
    ;({ data, error } = await fetchAllRows(build(PRODUCT_MIN, TXN_MIN)))
  }
  if (error) throw error
  const rows = data || []
  const staffNames = await staffNameById(rows.map((row) => row.transactions?.staff_id))
  return rows.map((row) => ({
    ...row,
    transactions: withCashierName(row.transactions, staffNames),
  }))
}

export async function logAuditEvent({ branchId, staffId, eventType, detail, meta = {} }) {
  if (!supabase) return null
  const { data, error } = await supabase.rpc('log_audit_event', {
    p_branch_id: branchId || null,
    p_staff_id: staffId || null,
    p_event_type: eventType,
    p_detail: detail || null,
    p_meta: meta,
  })
  if (error) {
    // Soft-fail if migration not applied yet
    if (String(error.message || '').includes('Could not find the function')) return null
    console.warn('audit log failed', error.message)
    return null
  }
  return data
}

/**
 * Record a supervisor/manager sign-off for an action that has no row of its own to carry
 * an `approved_by` column — a cart line removed before the sale exists, a shelf price
 * overridden at the counter. Without this, those approvals left no trace of WHO allowed
 * them, only that the action happened.
 *
 * Actions that already persist an approver (`transactions.void_approved_by`,
 * `sale_refund_lines.approved_by`, `cash_drawer_entries.approved_by`,
 * `shift_adjustments.approved_by`) do NOT go through here — a second record would just
 * be a second thing to keep in sync.
 */
export async function logApprovalEvent({
  branchId,
  requestedBy,
  approvedBy,
  approverName = null,
  approverRole = null,
  action,
  detail = null,
  meta = {},
}) {
  return logAuditEvent({
    branchId,
    staffId: requestedBy || approvedBy || null,
    eventType: `approval:${action}`,
    detail,
    meta: {
      ...meta,
      action,
      requested_by: requestedBy || null,
      approved_by: approvedBy || null,
      approver_name: approverName,
      approver_role: approverRole,
    },
  })
}

/**
 * Audit trail in range. `limit: null` reads everything.
 *
 * The old hard cap of 500 silently truncated the Login & Audit Trail report — an audit
 * document that quietly drops the oldest events in its own date range is worse than no
 * document, because it reads as complete. Report callers pass null; incidental callers
 * that only want a recent slice still pass a limit.
 */
export async function fetchAuditEvents({ start, end, branchId, limit = 500 } = {}) {
  const build = (from, to) => {
    let query = supabase
      .from('audit_events')
      .select('*, staff(full_name), branches(name)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (start) query = query.gte('created_at', `${start}T00:00:00`)
    if (end) query = query.lte('created_at', `${end}T23:59:59`)
    if (branchId) query = query.eq('branch_id', branchId)
    return query
  }
  if (limit == null) {
    const { data, error } = await fetchAllRows(build)
    if (error) throw error
    return data || []
  }
  const { data, error } = await build(0, limit - 1)
  if (error) throw error
  return data || []
}

/** Void / refund events. `limit: null` reads everything — see fetchAuditEvents. */
export async function fetchSaleEvents({ start, end, branchId, eventType, limit = 500 } = {}) {
  const build = (from, to) => {
    let query = supabase
      .from('sale_events')
      .select('*, branches(name)')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (start) query = query.gte('created_at', `${start}T00:00:00`)
    if (end) query = query.lte('created_at', `${end}T23:59:59`)
    if (branchId) query = query.eq('branch_id', branchId)
    if (eventType) query = query.eq('event_type', eventType)
    return query
  }
  let rows
  if (limit == null) {
    const { data, error } = await fetchAllRows(build)
    if (error) throw error
    rows = data || []
  } else {
    const { data, error } = await build(0, limit - 1)
    if (error) throw error
    rows = data || []
  }
  // Resolved separately rather than via a `staff(full_name)` embed — the embed is filtered
  // by `staff`'s own RLS (self row or manager only), so a supervisor viewing a cashier's
  // void/refund got a silently blank "performed by". `fetchStaffIdentities` goes through
  // resolve_staff_identities(), which grants a supervisor their own branch. voidSale also
  // stashes the approver id in payload.approved_by, resolved the same way.
  const who = await fetchStaffIdentities([
    ...rows.map((row) => row.staff_id),
    ...rows.map((row) => row.payload?.approved_by),
  ]).catch(() => ({}))
  return rows.map((row) => {
    const performer = who[row.staff_id]
    const approver = who[row.payload?.approved_by]
    return {
      ...row,
      staff: performer ? { full_name: performer.name } : row.staff,
      ...(approver ? { approver_name: approver.name, approver_role: approver.role } : null),
    }
  })
}

/**
 * Daily Z/X style reading from transactions (operational; not BIR-accredited).
 *
 * The VAT aggregates below are what makes this filable rather than merely informative.
 * BIR's daily sales breakdown is not one "sales" number — a return needs VATable sales,
 * output VAT, VAT-exempt sales and zero-rated sales stated separately, because each line
 * is taxed differently. Summing them back into a single total loses the distinction and
 * there is no way to recover it afterwards.
 *
 * Every figure is read from the columns frozen at time of sale (migrate_vat_breakdown.sql),
 * never recomputed here: a VAT rate change or a promo edit must not retroactively alter a
 * reading that has already been filed.
 */
export async function fetchDailyReading({ date, branchId }) {
  const VAT_COLS =
    'id, or_number, status, total_amount, void_reason, created_at, staff_id, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, discount_amount'
  // Paged: a busy branch can clear 1000 sales in a day, and PostgREST would truncate to
  // exactly that with no error — producing a day's total that is short by an unknown
  // amount and looks entirely plausible.
  const build = (cols) => (from, to) => {
    let q = supabase
      .from('transactions')
      .select(cols)
      .gte('created_at', `${date}T00:00:00`)
      .lte('created_at', `${date}T23:59:59`)
      .order('created_at', { ascending: true })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    return q
  }
  let { data, error } = await fetchAllRows(build(VAT_COLS))
  if (error && /vat_|sc_pwd_discount|discount_amount|schema cache|column/i.test(String(error.message || ''))) {
    // Pre-migrate_vat_breakdown database: still produce the operational figures rather
    // than failing the whole report. The VAT columns simply read as zero.
    ;({ data, error } = await fetchAllRows(
      build('id, or_number, status, total_amount, void_reason, created_at, staff_id'),
    ))
  }
  if (error) throw error
  const rows = data || []
  const staffNames = await staffNameById(rows.map((r) => r.staff_id))
  const completed = rows.filter((r) => r.status === 'completed')
  const voided = rows.filter((r) => r.status === 'voided')
  const sum = (list, key) => list.reduce((acc, r) => acc + Number(r[key] || 0), 0)
  const salesTotal = sum(completed, 'total_amount')
  const voidTotal = sum(voided, 'total_amount')
  const orNumbers = rows.map((r) => r.or_number).filter(Boolean)
  return {
    date,
    branchId: branchId || null,
    transactionCount: completed.length,
    voidCount: voided.length,
    salesTotal,
    voidTotal,
    netSales: salesTotal,
    // BIR breakdown — all four must be reported separately, never merged.
    vatableSales: sum(completed, 'vatable_sales'),
    vatAmount: sum(completed, 'vat_amount'),
    vatExemptSales: sum(completed, 'vat_exempt_sales'),
    zeroRatedSales: sum(completed, 'zero_rated_sales'),
    scPwdDiscount: sum(completed, 'sc_pwd_discount'),
    discountTotal: sum(completed, 'discount_amount'),
    // "Gross sales" for BIR is the pre-discount figure: what was rung up before any
    // deduction. total_amount is already net of discounts, so add them back.
    grossSales: salesTotal + sum(completed, 'discount_amount'),
    orFrom: orNumbers[0] || null,
    orTo: orNumbers[orNumbers.length - 1] || null,
    rows: rows.map((r) => ({
      or_number: r.or_number,
      status: r.status,
      total: Number(r.total_amount),
      cashier: staffNames[r.staff_id] || null,
      time: r.created_at,
      void_reason: r.void_reason,
    })),
  }
}

/**
 * Transactions in range with the fiscal columns, paged past PostgREST's 1000-row cap.
 * Shared source for the SC/PWD, Discount, Tender and Electronic Journal reports so they
 * can never disagree with each other about what a day contained.
 */
async function fetchFiscalTransactions({ start, end, branchId, includeVoided = true }) {
  const FULL =
    'id, or_number, status, total_amount, amount_tendered, change_given, created_at, staff_id, branch_id, payment_method, payment_reference, discount_amount, discount_type, discount_id_note, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, vat_rate_applied, void_reason, refunded_amount'
  // `created_at` is timestamptz — a bare `2026-08-09T00:00:00` is read in the database
  // session's zone (UTC on Supabase), not Manila, shifting the whole window 8 hours and
  // filing early-morning sales under the wrong day (see fetchStaffShifts above for the
  // same class of bug). Building a local Date and converting to ISO fixes the instant.
  const dayStart = new Date(`${start}T00:00:00`).toISOString()
  const dayEnd = new Date(`${end}T23:59:59.999`).toISOString()
  const build = (cols) => (from, to) => {
    let q = supabase
      .from('transactions')
      .select(cols)
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd)
      // created_at is NOT unique — several sales can share a timestamp, and a bulk write
      // inside one transaction gives them an identical now(). Ordering on it alone leaves
      // ties in arbitrary order, so a row straddling a 1000-row page boundary can appear
      // twice or vanish. `id` breaks the tie deterministically. An Electronic Journal that
      // duplicates or drops an OR number is worthless as evidence.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    if (!includeVoided) q = q.eq('status', 'completed')
    return q
  }
  let { data, error } = await fetchAllRows(build(FULL))
  if (error && /vat_|sc_pwd|discount_|payment_|refunded_amount|schema cache|column/i.test(String(error.message || ''))) {
    // The reduced set KEEPS payment_method. Dropping it made fetchTenderSummary bucket
    // every sale as cash — so a manager reconciling the drawer would be handed a "cash"
    // figure that silently included every card and e-wallet sale, with nothing on screen
    // saying the data was degraded. A wrong number presented confidently is worse than a
    // failed query. Only the genuinely newer VAT/discount columns are dropped here.
    ;({ data, error } = await fetchAllRows(
      build(
        'id, or_number, status, total_amount, amount_tendered, created_at, staff_id, branch_id, void_reason, payment_method',
      ),
    ))
  }
  if (error && /payment_method/i.test(String(error.message || ''))) {
    // Only if payment_method itself is what is missing does the tender split become
    // impossible. Flagged on every row so the report can say so rather than imply cash.
    const bare = await fetchAllRows(
      build('id, or_number, status, total_amount, amount_tendered, created_at, staff_id, branch_id, void_reason'),
    )
    if (bare.error) throw bare.error
    data = (bare.data || []).map((r) => ({ ...r, payment_method: null, paymentMethodUnavailable: true }))
    error = null
  }
  if (error) throw error
  const rows = data || []
  const staffNames = await staffNameById(rows.map((r) => r.staff_id))
  return rows.map((r) => ({ ...r, cashier: staffNames[r.staff_id] || null }))
}

/**
 * Per-day BIR breakdown across a whole range, from ONE ranged query bucketed client-side.
 *
 * Replaces a per-day loop. Sequentially that was 365 round trips for a year; run through
 * Promise.all instead it became 365 *concurrent* paged fetches, which the browser queues
 * six at a time against Supabase and which rate-limiting will start refusing — and since
 * one rejection fails the whole batch, a manager got an error instead of a report. The
 * "All records" preset makes that range unbounded, so neither shape was survivable.
 *
 * Every figure still comes from the columns frozen at time of sale; only the fetch shape
 * changed.
 */
export async function fetchBirDailyBreakdown({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: true })

  const byDay = new Map()
  const dayOf = (iso) => String(iso || '').slice(0, 10)
  // Seed every calendar day in range so days with no trading still appear as a zero row —
  // a gap in a filed summary looks like a missing record rather than a closed day.
  const cursor = new Date(`${start}T12:00:00`)
  const last = new Date(`${end}T12:00:00`)
  while (cursor <= last) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(
      cursor.getDate(),
    ).padStart(2, '0')}`
    byDay.set(key, {
      date: key,
      orNumbers: [],
      transactionCount: 0,
      voidCount: 0,
      salesTotal: 0,
      voidTotal: 0,
      discountTotal: 0,
      vatableSales: 0,
      vatAmount: 0,
      vatExemptSales: 0,
      zeroRatedSales: 0,
      scPwdDiscount: 0,
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  rows.forEach((r) => {
    const day = byDay.get(dayOf(r.created_at))
    if (!day) return
    if (r.or_number) day.orNumbers.push(r.or_number)
    if (r.status === 'voided') {
      day.voidCount += 1
      day.voidTotal += Number(r.total_amount || 0)
      return
    }
    day.transactionCount += 1
    day.salesTotal += Number(r.total_amount || 0)
    day.discountTotal += Number(r.discount_amount || 0)
    day.vatableSales += Number(r.vatable_sales || 0)
    day.vatAmount += Number(r.vat_amount || 0)
    day.vatExemptSales += Number(r.vat_exempt_sales || 0)
    day.zeroRatedSales += Number(r.zero_rated_sales || 0)
    day.scPwdDiscount += Number(r.sc_pwd_discount || 0)
  })

  return [...byDay.values()].map((day) => ({
    ...day,
    netSales: day.salesTotal,
    // BIR "gross sales" is the pre-discount figure; total_amount is already net of them.
    grossSales: day.salesTotal + day.discountTotal,
    orFrom: day.orNumbers[0] || null,
    orTo: day.orNumbers[day.orNumbers.length - 1] || null,
  }))
}

/**
 * Senior Citizen / PWD discount register (RA 9994 / RA 10754).
 *
 * This is a statutory record, not a convenience: the 20% discount is claimable by the
 * business as a deduction from gross income, and BIR will only allow it against a register
 * showing, per sale, the customer's ID number, the VAT-exempt amount, and the discount
 * given. A total alone is not substantiation.
 *
 * Rows with no ID number recorded are still listed — deliberately. Hiding them would make
 * the register look clean while the exposure (a discount that cannot be substantiated on
 * audit) stays exactly the same. Seeing them is the point.
 */
export async function fetchScPwdReport({ start, end, branchId }) {
  // Completed sales only. A voided sale never happened, so listing it in the register
  // invites someone summing the discount column to claim a deduction for a sale that was
  // cancelled — and it would also be counted in the "no ID number recorded" warning,
  // making the register look worse than it is. Voids belong in the Electronic Journal and
  // the Void / Refund Log, both of which show them.
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: false })
  const register = rows
    .filter((r) => {
      const type = String(r.discount_type || '').toLowerCase()
      return Number(r.sc_pwd_discount || 0) > 0 || type.includes('pwd') || type.includes('senior')
    })
    .map((r) => ({
      date: String(r.created_at || '').slice(0, 10),
      or_number: r.or_number || r.id,
      discount_type: r.discount_type || '—',
      id_number: r.discount_id_note || '(NOT RECORDED)',
      gross_amount: Number(r.total_amount || 0) + Number(r.discount_amount || 0),
      vat_exempt_sales: Number(r.vat_exempt_sales || 0),
      sc_pwd_discount: Number(r.sc_pwd_discount || 0),
      net_amount: Number(r.total_amount || 0),
      cashier: r.cashier || '—',
    }))

  // The claimed total belongs on the document. Without it the deduction is worked out by
  // hand off a printout, which is exactly where a filing error gets introduced.
  if (register.length > 1) {
    const sum = (key) => Number(register.reduce((n, r) => n + Number(r[key] || 0), 0).toFixed(2))
    register.push({
      date: 'TOTAL',
      or_number: '',
      discount_type: `${register.length} sale(s)`,
      id_number: '',
      gross_amount: sum('gross_amount'),
      vat_exempt_sales: sum('vat_exempt_sales'),
      sc_pwd_discount: sum('sc_pwd_discount'),
      net_amount: sum('net_amount'),
      cashier: '',
    })
  }
  return register
}

/**
 * Every discount granted in range, of any kind — SC/PWD, promo, manual override.
 * Separate from the SC/PWD register because the audiences differ: this one answers
 * "where is margin leaking", the register answers "prove this deduction".
 */
export async function fetchDiscountReport({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: false })
  return rows
    .filter((r) => Number(r.discount_amount || 0) > 0 || Number(r.sc_pwd_discount || 0) > 0)
    .map((r) => {
      const scPwd = Number(r.sc_pwd_discount || 0)
      const total = Number(r.discount_amount || 0)
      const gross = Number(r.total_amount || 0) + total
      return {
        date: String(r.created_at || '').slice(0, 10),
        or_number: r.or_number || r.id,
        discount_type: r.discount_type || 'Unlabelled',
        gross_amount: gross,
        // Promo and SC/PWD are reported apart: only the SC/PWD half is a statutory
        // deduction, the promo half is an ordinary price reduction.
        promo_discount: Number(Math.max(0, total - scPwd).toFixed(2)),
        sc_pwd_discount: scPwd,
        total_discount: total,
        discount_pct: gross > 0 ? Number(((total / gross) * 100).toFixed(2)) : 0,
        net_amount: Number(r.total_amount || 0),
        cashier: r.cashier || '—',
      }
    })
}

/**
 * Tender / payment-method summary — the figure a day's cash count is reconciled against.
 * Voided sales are excluded; refunds are shown so the drawer maths still balances.
 */
export async function fetchTenderSummary({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: false })
  const byMethod = {}
  rows.forEach((r) => {
    // "unrecorded", not "cash", when the column is missing entirely — see
    // fetchFiscalTransactions. Defaulting to cash would produce a reconciliation figure
    // that looks authoritative and is wrong by the value of every card sale.
    const method = r.paymentMethodUnavailable
      ? 'unrecorded (database needs updating)'
      : String(r.payment_method || 'cash').toLowerCase()
    if (!byMethod[method]) {
      byMethod[method] = { payment_method: method, transactions: 0, gross_sales: 0, refunds: 0, net_sales: 0 }
    }
    const bucket = byMethod[method]
    bucket.transactions += 1
    bucket.gross_sales += Number(r.total_amount || 0)
    bucket.refunds += Number(r.refunded_amount || 0)
    bucket.net_sales += Number(r.total_amount || 0) - Number(r.refunded_amount || 0)
  })
  return Object.values(byMethod)
    .map((row) => ({
      ...row,
      gross_sales: Number(row.gross_sales.toFixed(2)),
      refunds: Number(row.refunds.toFixed(2)),
      net_sales: Number(row.net_sales.toFixed(2)),
    }))
    .sort((a, b) => b.net_sales - a.net_sales)
}

/**
 * Electronic Journal — the chronological, unabridged record of every transaction the
 * terminal issued, including voids. BIR requires a CRM/POS to keep an EJ and to be able
 * to produce it on demand; the summarised reports do not satisfy that on their own
 * because they cannot show a specific sale as it was rung.
 *
 * Voided sales are included and labelled rather than dropped — an EJ with the voids
 * removed is precisely the shape a tampered journal takes, so it would be worthless as
 * evidence that nothing was removed.
 */
export async function fetchElectronicJournal({ start, end, branchId }) {
  const rows = await fetchFiscalTransactions({ start, end, branchId, includeVoided: true })
  return rows.map((r) => ({
    datetime: r.created_at,
    or_number: r.or_number || r.id,
    status: r.status === 'voided' ? 'VOIDED' : 'COMPLETED',
    cashier: r.cashier || '—',
    payment_method: r.payment_method || 'cash',
    payment_reference: r.payment_reference || '',
    gross_amount: Number(r.total_amount || 0) + Number(r.discount_amount || 0),
    discount_amount: Number(r.discount_amount || 0),
    discount_type: r.discount_type || '',
    vatable_sales: Number(r.vatable_sales || 0),
    vat_amount: Number(r.vat_amount || 0),
    vat_exempt_sales: Number(r.vat_exempt_sales || 0),
    zero_rated_sales: Number(r.zero_rated_sales || 0),
    sc_pwd_discount: Number(r.sc_pwd_discount || 0),
    total_amount: Number(r.total_amount || 0),
    amount_tendered: Number(r.amount_tendered || 0),
    change_given: Number(r.change_given || 0),
    void_reason: r.void_reason || '',
  }))
}

/**
 * Gross margin by product — revenue less cost of goods sold.
 *
 * Cost is read from the product's CURRENT unit_cost, not a cost frozen at sale time,
 * because the schema has no per-line cost column. That makes this report reliable for
 * "which lines earn" and unreliable for restating a closed period after a supplier price
 * change. Stated here so nobody files it as audited COGS; it is a management report.
 */
export async function fetchGrossMarginReport({ start, end, branchId }) {
  const detail = await fetchReportSalesDetail({ start, end, branchId, includeVoided: false })
  const byProduct = {}
  detail.forEach((row) => {
    const product = row.products || {}
    const key = product.id || row.product_id
    if (!byProduct[key]) {
      byProduct[key] = {
        product: product.name || 'Unknown',
        sku: product.sku || '',
        category: product.categories?.name || '—',
        qty_sold: 0,
        revenue: 0,
        cost: 0,
      }
    }
    const qty = Number(row.quantity || 0)
    byProduct[key].qty_sold += qty
    byProduct[key].revenue += Number(row.line_total || 0)
    byProduct[key].cost += Number(product.unit_cost || 0) * qty
  })
  return Object.values(byProduct)
    .map((row) => {
      const revenue = Number(row.revenue.toFixed(2))
      const cost = Number(row.cost.toFixed(2))
      const margin = Number((revenue - cost).toFixed(2))
      return {
        ...row,
        qty_sold: Number(row.qty_sold.toFixed(2)),
        revenue,
        cost,
        margin,
        margin_pct: revenue > 0 ? Number(((margin / revenue) * 100).toFixed(1)) : 0,
      }
    })
    .sort((a, b) => b.margin - a.margin)
}

/**
 * Stock movement ledger — every in/out with the running balance it produced.
 * The inventory counterpart to the sales audit trail: it is what turns "the count is
 * wrong" into "the count went wrong here, by this person, on this date".
 */
export async function fetchStockMovementReport({ start, end, branchId, movementTypes = null }) {
  const build = (from, to) => {
    let q = supabase
      .from('stock_movements')
      .select('*, products(name, sku, categories(name)), staff(full_name), branches(name)')
      .gte('created_at', `${start}T00:00:00`)
      .lte('created_at', `${end}T23:59:59`)
      // `id` tiebreaker: a bulk import writes every row with the same now(), so ordering
      // on created_at alone leaves ties unordered and a row on a page boundary can be
      // duplicated or dropped. A ledger that loses a movement is not a ledger.
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to)
    if (branchId) q = q.eq('branch_id', branchId)
    // Filter server-side when the caller only wants certain kinds. Pulling every movement
    // across an all-records range and discarding 99% of it client-side is tens of
    // thousands of rows over the wire for a handful of results.
    if (movementTypes?.length) q = q.in('movement_type', movementTypes)
    return q
  }
  const { data, error } = await fetchAllRows(build)
  if (error) throw error
  return (data || []).map((row) => ({
    when: row.created_at,
    branch: row.branches?.name || '—',
    product: row.products?.name || '—',
    sku: row.products?.sku || '',
    category: row.products?.categories?.name || '—',
    movement: row.movement_type,
    qty_in: Number(row.quantity_in || 0),
    qty_out: Number(row.quantity_out || 0),
    balance_after: Number(row.quantity_on_hand_after || 0),
    old_price: row.old_price != null ? Number(row.old_price) : '',
    new_price: row.new_price != null ? Number(row.new_price) : '',
    detail: row.detail || '',
    staff: row.staff?.full_name || '—',
  }))
}

/**
 * Price change register — every price the branch has changed, and who changed it.
 * Kept distinct from the general stock ledger because this is the report that answers a
 * price-tampering question, and it should not require scrolling past thousands of sales.
 */
export async function fetchPriceChangeReport({ start, end, branchId }) {
  // Narrowed in the query, not after the fact. `update` is included because older rows
  // recorded a price edit under that type while still filling old_price/new_price; the
  // client-side check below keeps only the ones that actually carry a price change.
  const movements = await fetchStockMovementReport({
    start,
    end,
    branchId,
    movementTypes: ['price_change', 'update'],
  })
  return movements
    .filter((row) => row.movement === 'price_change' || (row.old_price !== '' && row.new_price !== ''))
    .map((row) => ({
      when: row.when,
      branch: row.branch,
      product: row.product,
      sku: row.sku,
      old_price: row.old_price,
      new_price: row.new_price,
      change:
        row.old_price !== '' && row.new_price !== ''
          ? Number((Number(row.new_price) - Number(row.old_price)).toFixed(2))
          : '',
      changed_by: row.staff,
      detail: row.detail,
    }))
}

/**
 * Source bundle for Terminal / Cashier / Department / PLU reports (one fetch).
 */
export async function fetchTerminalReportSource({ date, endDate, branchId, staffId = null }) {
  if (!supabase) throw new Error('Supabase not connected')
  const start = date
  const end = endDate || date

  let branch = null
  if (branchId) {
    const { data, error } = await supabase
      .from('branches')
      .select(
        'id, name, address, business_name, tin, serial_number, or_prefix, terminal_id, receipt_footer_official, receipt_footer_thanks, receipt_footer_contact, receipt_footer_tagline, contact_phone, vat_rate, branch_type',
      )
      .eq('id', branchId)
      .maybeSingle()
    if (error) {
      // Older schemas may lack receipt footer / fiscal columns
      const fallback = await supabase.from('branches').select('*').eq('id', branchId).maybeSingle()
      if (fallback.error) throw error
      branch = fallback.data
    } else {
      branch = data
    }
  }

  let txnQuery = supabase
    .from('transactions')
    .select(
      'id, or_number, status, total_amount, refunded_amount, amount_tendered, created_at, staff_id, branch_id, payment_method, payment_reference, discount_amount, discount_type, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, order_type, void_reason',
    )
    .gte('created_at', `${start}T00:00:00`)
    .lte('created_at', `${end}T23:59:59`)
    .order('created_at', { ascending: true })
  if (branchId) txnQuery = txnQuery.eq('branch_id', branchId)
  if (staffId) txnQuery = txnQuery.eq('staff_id', staffId)

  let { data: transactions, error: txnError } = await txnQuery
  if (
    txnError &&
    /refunded_amount|payment_method|discount_amount|vat_amount|vat_exempt_sales|schema cache|column/i.test(
      String(txnError.message || ''),
    )
  ) {
    let fb = supabase
      .from('transactions')
      .select('id, or_number, status, total_amount, created_at, staff_id, branch_id, void_reason')
      .gte('created_at', `${start}T00:00:00`)
      .lte('created_at', `${end}T23:59:59`)
      .order('created_at', { ascending: true })
    if (branchId) fb = fb.eq('branch_id', branchId)
    if (staffId) fb = fb.eq('staff_id', staffId)
    ;({ data: transactions, error: txnError } = await fb)
  }
  if (txnError) throw txnError

  const staffNames = await staffNameById((transactions || []).map((r) => r.staff_id))
  const txns = (transactions || []).map((row) => withCashierName(row, staffNames))

  let lineItems = []
  try {
    lineItems = await fetchReportSalesDetail({
      start,
      end,
      branchId: branchId || null,
      includeVoided: false,
    })
    if (staffId) {
      lineItems = lineItems.filter((row) => row.transactions?.staff_id === staffId)
    }
  } catch {
    lineItems = []
  }

  let pettyCash = []
  if (branchId) {
    try {
      const { data: pettyRows, error: pettyErr } = await withCashDrawerTable((table) =>
        supabase
          .from(table)
          .select(CASH_DRAWER_COLS)
          .eq('branch_id', branchId)
          .gte('business_date', start)
          .lte('business_date', end)
          .order('created_at', { ascending: false }),
      )
      if (pettyErr) {
        pettyCash = await fetchPettyCash(branchId, start).catch(() => [])
      } else {
        pettyCash = (pettyRows || []).map(mapPettyCashRow)
      }
    } catch {
      pettyCash = []
    }
  }

  let dayEnd = null
  if (branchId) {
    const { data } = await supabase
      .from('day_ends')
      .select(BOOTSTRAP_DAY_END_COLS)
      .eq('branch_id', branchId)
      .eq('business_date', start)
      .maybeSingle()
    dayEnd = data
  }

  // Lifetime completed sales before report start (OLD GRAND TOTAL)
  let oldGrandTotal = 0
  let grandQuery = supabase
    .from('transactions')
    .select('total_amount, refunded_amount')
    .eq('status', 'completed')
    .lt('created_at', `${start}T00:00:00`)
  if (branchId) grandQuery = grandQuery.eq('branch_id', branchId)
  const { data: prior, error: priorErr } = await grandQuery
  if (!priorErr && prior) {
    oldGrandTotal = prior.reduce(
      (s, r) => s + Number(r.total_amount || 0) - Number(r.refunded_amount || 0),
      0,
    )
  } else if (priorErr) {
    let q2 = supabase
      .from('transactions')
      .select('total_amount')
      .eq('status', 'completed')
      .lt('created_at', `${start}T00:00:00`)
    if (branchId) q2 = q2.eq('branch_id', branchId)
    const { data: prior2 } = await q2
    oldGrandTotal = (prior2 || []).reduce((s, r) => s + Number(r.total_amount || 0), 0)
  }

  const cashiers = Object.entries(staffNames).map(([id, name]) => ({ id, name }))

  return {
    branch,
    transactions: txns,
    lineItems,
    pettyCash,
    dayEnd,
    oldGrandTotal: Number(oldGrandTotal.toFixed(2)),
    cashiers,
    staffNames,
  }
}

/** Fiscal backup pack for a date range (JSON download from UI). */
export async function fetchFiscalBackup({ start, end, branchId }) {
  let txnQuery = supabase
    .from('transactions')
    .select('*, transaction_items(*, products(id, product_no, name, sku))')
    .gte('created_at', `${start}T00:00:00`)
    .lte('created_at', `${end}T23:59:59`)
    .order('created_at', { ascending: true })
  if (branchId) txnQuery = txnQuery.eq('branch_id', branchId)
  const { data: transactions, error: txnError } = await txnQuery
  if (txnError) throw txnError

  const staffNames = await staffNameById((transactions || []).map((row) => row.staff_id))
  const txnsWithStaff = (transactions || []).map((row) => withCashierName(row, staffNames))

  let dayQuery = supabase
    .from('day_ends')
    .select(BOOTSTRAP_DAY_END_COLS)
    .gte('business_date', start)
    .lte('business_date', end)
  if (branchId) dayQuery = dayQuery.eq('branch_id', branchId)
  const { data: dayEnds, error: dayError } = await dayQuery
  if (dayError) throw dayError

  const [events, audits] = await Promise.all([
    fetchSaleEvents({ start, end, branchId, limit: 5000 }).catch(() => []),
    fetchAuditEvents({ start, end, branchId, limit: 5000 }).catch(() => []),
  ])

  return {
    exportedAt: new Date().toISOString(),
    range: { start, end, branchId: branchId || null },
    transactions: txnsWithStaff,
    saleEvents: events,
    auditEvents: audits,
    dayEnds: dayEnds || [],
  }
}

/**
 * Every active product with its on-hand count. Source for both the Inventory report and
 * the Price Listing.
 *
 * Paged: a branch with more than 1000 active products was silently getting exactly 1000
 * back, so the Price Listing dropped items from a document printed for the shelf and the
 * Inventory report's valuation totals — and its negative-stock count — were computed over
 * a truncated set while presenting as complete.
 */
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

async function ensureCategoryId(categoryName) {
  const name = categoryName || 'Groceries'
  const { data: cat } = await supabase.from('categories').select('id').eq('name', name).maybeSingle()
  if (cat?.id) return cat.id
  const { data: created, error } = await supabase.from('categories').insert({ name }).select('id').single()
  if (error) throw error
  return created.id
}

/**
 * Resolve every category an import needs, once, before the row loop starts.
 *
 * ensureCategoryId costs 1-2 round trips and was being called per row. An import is
 * typically a few categories across hundreds of rows, so nearly all of those calls were
 * re-fetching something already known — roughly a quarter of the import's total requests
 * for no benefit. One query up front replaces all of them; only genuinely new categories
 * still cost an insert.
 */
/**
 * name → category id for a whole import, resolved in one query instead of per row.
 *
 * Keys are TRIMMED, and callers must look up with a trimmed name too — a sheet cell of
 * " Meat " would otherwise miss the map and fall back to a per-row query, silently
 * undoing the batching this exists for.
 *
 * Blank names collapse to 'Groceries', which is the inventory import's intended default.
 * Callers that should NOT create a category for a blank cell (catalog import) filter the
 * blanks out before calling.
 */
async function resolveCategoryIds(names = []) {
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

const DUPLICATE_IMPORT_HOURS = 24

export async function findRecentImportByHash(branchId, fileHash, withinHours = DUPLICATE_IMPORT_HOURS) {
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('import_batches')
    .select('*, staff!staff_id(full_name), branches(name)')
    .eq('branch_id', branchId)
    .eq('file_hash', fileHash)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function fetchImportBatches(branchId) {
  let query = supabase
    .from('import_batches')
    .select('*, staff!staff_id(full_name), branches(name)')
    .order('created_at', { ascending: false })
    .limit(50)
  if (branchId) query = query.eq('branch_id', branchId)
  const { data, error } = await query
  if (error) throw error
  return data || []
}

export async function fetchImportBatchItems(batchId) {
  const { data, error } = await supabase
    .from('import_batch_items')
    .select('*')
    .eq('batch_id', batchId)
    .order('name')
  if (error) throw error
  return data || []
}

export async function commitInventoryImport({
  branchId,
  staffId,
  filename,
  fileHash,
  preview,
  onProgress,
}) {
  const restaurant = Boolean(preview?.restaurant)
  const { data: batch, error: batchError } = await supabase
    .from('import_batches')
    .insert({
      branch_id: branchId,
      staff_id: staffId,
      filename,
      file_hash: fileHash,
      row_count: preview.rowCount,
      created_count: preview.createCount,
      updated_count: preview.updateCount,
      skipped_count: preview.skippedCount,
      status: 'committed',
    })
    .select('*')
    .single()
  if (batchError) throw batchError

  const itemRows = []
  const total = preview.lines.length || 1

  // Resolve every category the file references in one query, before the loop.
  const categoryIds = await resolveCategoryIds((preview.lines || []).map((l) => l.values?.category))

  for (let index = 0; index < preview.lines.length; index += 1) {
    const line = preview.lines[index]
    const values = line.values
    const price = Number(values?.price)
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Import rejected: invalid price on row ${index + 1} (${values?.sku || values?.name || 'item'}).`)
    }
    if (values?.stock != null && values.stock !== '') {
      const stock = Number(values.stock)
      if (!Number.isFinite(stock) || stock < 0) {
        throw new Error(`Import rejected: invalid stock on row ${index + 1} (${values?.sku || values?.name || 'item'}).`)
      }
    }
    if (!String(values?.name || '').trim() || !String(values?.sku || '').trim()) {
      throw new Error(`Import rejected: missing name/SKU on row ${index + 1}.`)
    }
    const categoryId = categoryIds.get(String(values.category || '').trim() || 'Groceries')
    let productId = line.existing?.id
    const barcode =
      values.barcode ||
      (restaurant ? `MENU-${values.sku}`.replace(/\W+/g, '').slice(0, 32) : values.barcode)

    const productPayload = {
      name: values.name,
      sku: values.sku,
      barcode: barcode || null,
      category_id: categoryId,
      pricing_mode: toDbPricing(restaurant ? 'pc' : values.pricingMode),
      price: values.price,
      low_stock_threshold: values.lowStockAt || 5,
      available_today: values.availableToday !== false,
      discount_eligible: values.discountEligible === true,
      ...(restaurant
        ? {
            budget_price: values.budgetPrice,
            menu_kind: normalizeMenuKind(values.menuKind, values.category),
          }
        : {}),
    }

    if (line.action === 'create') {
      const product = await writeProductRow('insert', {
        branch_id: branchId,
        ...productPayload,
      })
      productId = product.id
      if (!restaurant) {
        await supabase.from('branch_inventory').upsert({
          branch_id: branchId,
          product_id: productId,
          quantity_on_hand: 0,
        })
      }
    } else {
      await writeProductRow('update', productPayload, { id: productId })
      // Direct price edits elsewhere (Products.jsx, ManagerNetworkCatalog cascade) log
      // through recordPriceChange so the Price Change Register sees them — an import
      // that changes price must not be a silent exception to that.
      const oldPrice = line.existing?.price != null ? Number(line.existing.price) : null
      if (oldPrice != null && Number.isFinite(price) && oldPrice !== price) {
        await recordPriceChange({
          branchId,
          productId,
          staffId,
          oldPrice,
          newPrice: price,
          detail: values.name || 'Price update (import)',
        })
      }
    }

    if (!restaurant && line.quantityAdded > 0) {
      const { error: moveError } = await supabase.rpc('record_stock_movement', {
        p_branch_id: branchId,
        p_product_id: productId,
        p_staff_id: staffId,
        p_movement_type: 'restock',
        p_quantity_in: line.quantityAdded,
        p_quantity_out: 0,
        p_reference: batch.id,
        p_detail: `Import ${filename}`,
      })
      if (moveError) throw moveError
    }

    itemRows.push({
      batch_id: batch.id,
      product_id: productId,
      action: line.action,
      quantity_added: restaurant ? 0 : line.quantityAdded,
      name: values.name,
      sku: values.sku,
      barcode: barcode || '',
    })
    onProgress?.(index + 1, total, values.name)
  }

  if (itemRows.length) {
    const { error: itemsError } = await supabase.from('import_batch_items').insert(itemRows)
    if (itemsError) throw itemsError
  }

  return batch
}

export async function revertInventoryImport(batchId, staffId) {
  const { data, error } = await supabase.rpc('revert_import_batch', {
    p_batch_id: batchId,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/**
 * Best-effort sweep: flips any promo_events row past its ends_at from active/stop_pending
 * to status='expired' — see migrate_promo_expired_status.sql. Called at the top of the
 * promo read paths below instead of on a schedule, so it self-heals on every read without
 * needing pg_cron. Swallows errors so an un-migrated DB degrades to the old behaviour
 * (expired promos just stay hidden from POS via the respectDuration check) rather than
 * breaking the read.
 *
 * `expired` is deliberately not `stopped`: a promo that ran to its end date and one a
 * manager pulled early are different business events, and the old sweep recorded both as
 * `stopped`.
 */
async function expireEndedPromos() {
  try {
    // supabase-js resolves RPC errors onto { error } rather than rejecting — check both.
    const { error } = await supabase.rpc('expire_ended_promos')
    if (!error) return
    // Function not deployed yet. Fall back to a plain UPDATE: managers/supervisors have RLS
    // write access to their branch's promos, so the sweep still lands for exactly the people
    // who look at the Promos page. Cashiers get denied here and that's fine — promoHasEnded()
    // already hides ended promos for them.
    const payload = {
      status: 'expired',
      is_active: false,
      stopped_at: new Date().toISOString(),
    }
    const build = () =>
      supabase
        .from('promo_events')
        .update(payload)
        .in('status', ['active', 'stop_pending'])
        .not('ends_at', 'is', null)
        .lt('ends_at', new Date().toISOString())
    const { error: updateError } = await build()
    // Status check constraint not widened yet (migrate_promo_expired_status.sql unapplied):
    // fall back to the old value so the sweep still happens. promoEffectiveStatus() maps
    // that legacy shape back to `expired` for display.
    if (updateError && /status_check|violates check constraint/i.test(String(updateError.message || ''))) {
      await supabase
        .from('promo_events')
        .update({ ...payload, status: 'stopped', stop_reason: 'Promo ended' })
        .in('status', ['active', 'stop_pending'])
        .not('ends_at', 'is', null)
        .lt('ends_at', new Date().toISOString())
    }
  } catch {
    /* ignore — see comment above */
  }
}

/**
 * Has this promo's scheduled end time passed?
 *
 * The client must never depend on the DB sweep having run to decide whether a promo is
 * over: the sweep needs a migration applied, needs write permission, and in any case only
 * runs when someone happens to read. An ended promo has to read as ended *immediately*,
 * everywhere, from the timestamp alone — that's what "auto-expire" means to the user.
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
 *
 * `stopped` and `expired` must never collapse into each other: "we pulled that promo" and
 * "that promo finished" are different facts about the business. Derived here as well as
 * stored, so a tab open across the end time shows `expired` without waiting for the DB
 * sweep (see migrate_promo_expired_status.sql).
 */
export function promoEffectiveStatus(event) {
  const status = event?.status || (event?.is_active ? 'active' : 'inactive')
  if ((status === 'active' || status === 'stop_pending') && promoHasEnded(event)) return 'expired'
  // Pre-migration rows: the old sweep wrote 'stopped' with this exact reason and never set
  // stopped_by. Both conditions together, so a manager who typed that reason is still a
  // manual stop.
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
  await expireEndedPromos()
  // Live on POS: active or stop_pending (still selling until stop approved)
  let query = supabase
    .from('promo_events')
    .select('id,name,is_active,status,starts_at,ends_at,stop_reason')
    .eq('branch_id', branchId)

  const { data: events, error: eventError } = await query
    .or('status.in.(active,stop_pending),and(is_active.eq.true,status.is.null)')
    .order('created_at', { ascending: false })
    .limit(20)

  let liveEvents
  if (eventError) {
    // Fallback if status column missing
    const fallback = await supabase
      .from('promo_events')
      .select('id,name,is_active,starts_at,ends_at')
      .eq('branch_id', branchId)
      .eq('is_active', true)
    if (fallback.error) throw eventError
    liveEvents = fallback.data || []
  } else {
    liveEvents = (events || []).filter(
      (e) => e.status === 'active' || e.status === 'stop_pending' || (e.is_active && !e.status),
    )
  }

  // A promo past its end date is never live, whatever the stored status says and whatever
  // respectDuration asks for. respectDuration only governs the *not yet started* case (so a
  // manager can still build rules on a scheduled promo) — it was never meant to resurrect a
  // finished one, and treating it as such is why ended promos kept showing as Active here.
  liveEvents = liveEvents.filter((e) => !promoHasEnded(e))

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
      status: event.status || (event.is_active ? 'active' : 'stopped'),
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
  activateImmediately = false,
}) {
  const starts_iso = startsAt ? new Date(startsAt).toISOString() : null
  const ends_iso = endsAt ? new Date(endsAt).toISOString() : null
  const desc = description?.trim() || null

  // Dual-control: create as pending unless manager activates immediately after approve path.
  // New creates are always pending — never auto-activate.
  const payload = {
    branch_id: branchId,
    name,
    description: desc,
    is_active: false,
    status: 'pending',
    starts_at: starts_iso,
    ends_at: ends_iso,
    requested_by: staffId || null,
  }

  let { data, error } = await supabase.from('promo_events').insert(payload).select('id,name,status').single()
  if (error && isMissingColumnError(error, 'description')) {
    // migrate_promo_description.sql not applied yet — create without it rather than fail outright.
    const withoutDescription = { ...payload }
    delete withoutDescription.description
    ;({ data, error } = await supabase
      .from('promo_events')
      .insert(withoutDescription)
      .select('id,name,status')
      .single())
  }
  if (error && (isMissingColumnError(error, 'status') || isMissingColumnError(error, 'requested_by'))) {
    // Legacy: old schema (pre dual-control) activated immediately
    ;({ data, error } = await supabase
      .from('promo_events')
      .insert({
        branch_id: branchId,
        name,
        is_active: activateImmediately,
        starts_at: starts_iso,
        ends_at: ends_iso,
      })
      .select('id,name')
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

export async function rejectStopPromo({ id, staffId }) {
  const { data, error } = await supabase.rpc('reject_stop_promo', {
    p_promo_event_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

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
      orNumber: r.or_number || null,
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
 * Legacy path for DBs that haven't run migrate_promo_line_attribution.sql yet:
 * match by the whole transaction's discount_type. Misses/undercounts carts that
 * mixed lines from more than one concurrently-live promo (their discount_type is
 * a joined label like "A + B", not an exact match for either promo's name) —
 * see fetchPromoSalesStats below for the accurate per-line path.
 */
async function fetchPromoSalesStatsLegacy({ branchId, promoName, startsAt, endsAt }) {
  let txnQ = supabase
    .from('transactions')
    .select(
      'id, or_number, total_amount, discount_amount, discount_type, created_at, status, staff_id, refunded_amount',
    )
    .eq('branch_id', branchId)
    .eq('discount_type', promoName)
    .neq('status', 'voided')
    .order('created_at', { ascending: false })
    .limit(500)

  if (startsAt) txnQ = txnQ.gte('created_at', new Date(startsAt).toISOString())
  if (endsAt) txnQ = txnQ.lte('created_at', new Date(endsAt).toISOString())

  const { data: txns, error: txnErr } = await txnQ
  if (txnErr) {
    if (/discount_type|discount_amount|schema cache|column/i.test(String(txnErr.message || ''))) {
      return { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], receipts: [] }
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
    return { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], receipts: [] }
  }

  const { data: lines, error: lineErr } = await supabase
    .from('transaction_items')
    .select('quantity, unit_price, line_total, discount_amount, products(id, name, sku, pricing_mode)')
    .in('transaction_id', txnIds)
    .gt('discount_amount', 0)
  if (lineErr) {
    return { receiptCount, discountTotal, saleTotal, items: [], receipts }
  }

  return { receiptCount, discountTotal, saleTotal, items: aggregatePromoItems(lines || []), receipts }
}

/**
 * Promo performance: receipts + discounted line items sold under a promo name.
 *
 * Attribution is per-line (transaction_items.promo_name), not by matching the
 * whole transaction's discount_type — that stays accurate even when a single
 * cart mixed lines from two different concurrently-live promos, since each
 * line records exactly which promo discounted it.
 */
export async function fetchPromoSalesStats({
  branchId,
  promoName,
  startsAt = null,
  endsAt = null,
} = {}) {
  if (!branchId || !promoName) {
    return { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], receipts: [] }
  }

  // Cheap superset prefilter: any receipt with a discount on this branch/date range.
  let txnQ = supabase
    .from('transactions')
    .select('id, or_number, total_amount, discount_amount, created_at, status, staff_id, refunded_amount')
    .eq('branch_id', branchId)
    .gt('discount_amount', 0)
    .neq('status', 'voided')
    .order('created_at', { ascending: false })
    .limit(1000)

  if (startsAt) txnQ = txnQ.gte('created_at', new Date(startsAt).toISOString())
  if (endsAt) txnQ = txnQ.lte('created_at', new Date(endsAt).toISOString())

  const { data: candidateTxns, error: txnErr } = await txnQ
  if (txnErr) {
    if (/discount_amount|schema cache|column/i.test(String(txnErr.message || ''))) {
      return { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], receipts: [] }
    }
    throw txnErr
  }
  const candidates = candidateTxns || []
  if (!candidates.length) {
    return { receiptCount: 0, discountTotal: 0, saleTotal: 0, items: [], receipts: [] }
  }
  const candidateIds = candidates.map((r) => r.id)

  // Exact attribution: which of those receipts had a line this specific promo won.
  const { data: lines, error: lineErr } = await supabase
    .from('transaction_items')
    .select('transaction_id, quantity, unit_price, line_total, discount_amount, promo_name, products(id, name, sku, pricing_mode)')
    .in('transaction_id', candidateIds)
    .eq('promo_name', promoName)

  if (lineErr) {
    if (/promo_name|schema cache|column/i.test(String(lineErr.message || ''))) {
      return fetchPromoSalesStatsLegacy({ branchId, promoName, startsAt, endsAt })
    }
    throw lineErr
  }

  const matchedLines = lines || []
  const matchedTxnIds = new Set(matchedLines.map((l) => l.transaction_id))
  const matchedTxns = candidates.filter((t) => matchedTxnIds.has(t.id))

  const receiptCount = matchedTxns.length
  // This promo's own line discounts only — accurate even when the same receipt
  // also carries lines discounted by a different concurrently-live promo.
  const discountTotal = Number(matchedLines.reduce((sum, l) => sum + Number(l.discount_amount || 0), 0).toFixed(2))
  const saleTotal = Number(matchedTxns.reduce((sum, t) => sum + Number(t.total_amount || 0), 0).toFixed(2))
  const receipts = await buildPromoReceipts(matchedTxns)

  return { receiptCount, discountTotal, saleTotal, items: aggregatePromoItems(matchedLines), receipts }
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
  const { data, error } = await supabase.from('promo_rules').delete().eq('id', promoRuleId).select('id').maybeSingle()
  if (error) throw error
  return data
}

export async function fetchPromoEventsForBranch(branchId) {
  await expireEndedPromos()
  const { data, error } = await supabase
    .from('promo_events')
    .select(
      'id,name,description,is_active,status,starts_at,ends_at,created_at,stop_reason,reject_reason,requested_by,approved_by,stop_requested_by',
    )
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })

  if (error && isMissingColumnError(error, 'reject_reason')) {
    // migrate_promo_reject_reason.sql not applied yet on this environment.
    const retry = await supabase
      .from('promo_events')
      .select(
        'id,name,description,is_active,status,starts_at,ends_at,created_at,stop_reason,requested_by,approved_by,stop_requested_by',
      )
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
    if (!retry.error) return retry.data || []
  }

  if (error && isMissingColumnError(error, 'description')) {
    const retry = await supabase
      .from('promo_events')
      .select(
        'id,name,is_active,status,starts_at,ends_at,created_at,stop_reason,requested_by,approved_by,stop_requested_by',
      )
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
    if (!retry.error) return retry.data || []
  } else if (!error) {
    return data || []
  }

  const fallback = await supabase
    .from('promo_events')
    .select('id,name,is_active,starts_at,ends_at,created_at')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })
  if (fallback.error) throw error
  return fallback.data || []
}

/** Manager overview: live promos on every branch (no branch filter). */
export async function fetchActivePromosAcrossBranches() {
  await expireEndedPromos()
  const branchRows = await fetchBranches().catch(() => [])
  const branchNameById = Object.fromEntries((branchRows || []).map((b) => [b.id, b.name]))

  const mapRow = (row) => ({
    id: row.id,
    name: row.name,
    status: row.status || (row.is_active ? 'active' : 'inactive'),
    is_active: Boolean(row.is_active),
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    created_at: row.created_at,
    branch_id: row.branch_id,
    branchName: branchNameById[row.branch_id] || row.branches?.name || 'Branch',
    stop_reason: row.stop_reason || null,
  })

  const isLive = (row) => {
    // Ended by the clock = not live, regardless of stored status (see promoHasEnded).
    if (promoHasEnded(row)) return false
    const status = String(row.status || '').toLowerCase()
    if (status === 'active' || status === 'stop_pending') return true
    // Legacy rows before dual-control status column
    if (!status && row.is_active) return true
    if (row.is_active && status === 'active') return true
    return false
  }

  // Simple filter first (avoids brittle nested .or() PostgREST syntax)
  let { data, error } = await supabase
    .from('promo_events')
    .select('id,name,is_active,status,starts_at,ends_at,created_at,branch_id,stop_reason')
    .in('status', ['active', 'stop_pending'])
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    // Column missing or filter unsupported — pull a wider set and filter in JS
    const wide = await supabase
      .from('promo_events')
      .select('id,name,is_active,status,starts_at,ends_at,created_at,branch_id,stop_reason')
      .order('created_at', { ascending: false })
      .limit(500)

    if (wide.error) {
      const legacy = await supabase
        .from('promo_events')
        .select('id,name,is_active,starts_at,ends_at,created_at,branch_id')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(500)
      if (legacy.error) throw error
      return (legacy.data || []).map(mapRow)
    }

    data = (wide.data || []).filter(isLive)
  } else {
    // Also pick up legacy is_active rows that may not have status=active
    const { data: legacyActive } = await supabase
      .from('promo_events')
      .select('id,name,is_active,status,starts_at,ends_at,created_at,branch_id,stop_reason')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(500)

    const byId = new Map()
    for (const row of data || []) byId.set(row.id, row)
    for (const row of legacyActive || []) {
      if (isLive(row) && !byId.has(row.id)) byId.set(row.id, row)
    }
    data = [...byId.values()]
  }

  return (data || [])
    .filter(isLive)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map(mapRow)
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

/**
 * Pending approval inbox for Shell notifications.
 * Managers: submitted/requested day-ends + promo pending/stop + petty cash pending.
 * Supervisors: submitted/requested (non-manager-flagged) day-ends + petty cash pending on
 * their branch.
 */
export async function fetchPendingApprovals({ role, branchId } = {}) {
  if (!hasSupabase) return []
  const manager = role === 'manager' || role === 'admin' || role === 'master'
  const supervisor = role === 'supervisor'
  if (!manager && !supervisor) return []

  const items = []

  // Day-end awaiting approve/close
  let dayQ = supabase
    .from('day_ends')
    .select('id, business_date, status, submitted_at, branch_id, branches(name)')
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false })
    .limit(30)
  if (!manager && branchId) dayQ = dayQ.eq('branch_id', branchId)
  const { data: dayRows, error: dayErr } = await dayQ
  if (!dayErr) {
    for (const row of dayRows || []) {
      const branchName = row.branches?.name || 'Branch'
      items.push({
        id: `day-${row.id}`,
        kind: 'day_end_submitted',
        title: 'Day end awaiting approval',
        detail: `${branchName} · ${row.business_date || 'today'}`,
        href: manager ? `/manager/branches/${row.branch_id}` : '/day-end',
        createdAt: row.submitted_at || null,
        priority: 1,
      })
    }
  }

  // Day-end requested by a cashier — no cash figures yet, just a flag that someone needs to
  // count the drawer. A supervisor only sees a request that was NOT specifically flagged
  // for a manager; a manager sees every request (the universal fallback). Always routes to
  // /day-end (not the branch dashboard) — that's the screen with the actual counting form.
  let requestQ = supabase
    .from('day_ends')
    .select('id, business_date, status, requested_at, request_manager, branch_id, branches(name)')
    .eq('status', 'requested')
    .order('requested_at', { ascending: false })
    .limit(30)
  if (!manager) {
    requestQ = requestQ.eq('request_manager', false)
    if (branchId) requestQ = requestQ.eq('branch_id', branchId)
  }
  const { data: requestRows, error: requestErr } = await requestQ
  if (!requestErr) {
    for (const row of requestRows || []) {
      const branchName = row.branches?.name || 'Branch'
      items.push({
        id: `day-req-${row.id}`,
        kind: 'day_end_requested',
        title: row.request_manager ? 'Day end requested (manager)' : 'Day end requested',
        detail: `${branchName} · ${row.business_date || 'today'}`,
        href: '/day-end',
        createdAt: row.requested_at || null,
        priority: 1,
      })
    }
  }

  // A closed day, reopen requested — manager-only, since reopen_day_end() itself is
  // manager-only (a supervisor being stuck by their own closing is not something they can
  // self-service; they need the same escalation a cashier does).
  if (manager) {
    let reopenQ = supabase
      .from('day_ends')
      .select('id, business_date, status, reopen_requested_at, reopen_request_reason, branch_id, branches(name)')
      .eq('status', 'closed')
      .not('reopen_requested_at', 'is', null)
      .order('reopen_requested_at', { ascending: false })
      .limit(30)
    const { data: reopenRows, error: reopenErr } = await reopenQ
    if (!reopenErr) {
      for (const row of reopenRows || []) {
        const branchName = row.branches?.name || 'Branch'
        items.push({
          id: `day-reopen-${row.id}`,
          kind: 'day_end_reopen_requested',
          title: 'Day reopen requested',
          detail: `${branchName} · ${row.business_date || 'today'}${row.reopen_request_reason ? ` · ${row.reopen_request_reason}` : ''}`,
          href: `/manager/branches/${row.branch_id}`,
          createdAt: row.reopen_requested_at || null,
          priority: 1,
        })
      }
    }
  }

  // Petty cash requests awaiting approve
  const { data: pettyRows, error: pettyErr } = await withCashDrawerTable((table) => {
    let q = supabase
      .from(table)
      .select('id, amount, reason, created_at, branch_id, branches(name)')
      .eq('status', 'pending')
      .eq('kind', 'paid_out')
      .order('created_at', { ascending: false })
      .limit(40)
    if (!manager && branchId) q = q.eq('branch_id', branchId)
    return q
  })
  if (!pettyErr) {
    for (const row of pettyRows || []) {
      const branchName = row.branches?.name || 'Branch'
      items.push({
        id: `petty-${row.id}`,
        kind: 'petty_pending',
        title: 'Petty cash request',
        detail: `${branchName} · ₱${Number(row.amount || 0).toFixed(2)} · ${row.reason || 'No reason'}`,
        href: manager ? `/manager/branches/${row.branch_id}` : '/day-end',
        createdAt: row.created_at || null,
        priority: 2,
      })
    }
  }

  // Shifts closed under the cashier's own count because no supervisor/manager was reachable
  // (see ShiftCashOut's "no supervisor available" path) — needs someone to acknowledge it.
  // Silently skipped on a database that predates migrate_shift_close_no_supervisor_flag.sql.
  let shiftQ = supabase
    .from('staff_shifts')
    .select('id, staff_id, branch_id, ending_cash, variance, clock_out, staff:staff_id(full_name), branches(name)')
    .eq('closed_without_supervisor', true)
    .is('reviewed_at', null)
    .order('clock_out', { ascending: false })
    .limit(30)
  if (!manager && branchId) shiftQ = shiftQ.eq('branch_id', branchId)
  const { data: shiftRows, error: shiftErr } = await shiftQ
  if (!shiftErr) {
    for (const row of shiftRows || []) {
      const branchName = row.branches?.name || 'Branch'
      items.push({
        id: `shift-${row.id}`,
        kind: 'shift_needs_review',
        title: 'Shift closed without supervisor',
        detail: `${row.staff?.full_name || 'Cashier'} · ${branchName} · ending ₱${Number(row.ending_cash || 0).toFixed(2)}${
          row.variance ? ` · variance ₱${Number(row.variance).toFixed(2)}` : ''
        }`,
        href: '/manager/staff',
        createdAt: row.clock_out || null,
        priority: 2,
      })
    }
  }

  // Promo dual-control — managers only
  if (manager) {
    const { data: promoRows, error: promoErr } = await supabase
      .from('promo_events')
      .select('id, name, status, created_at, updated_at, branch_id, branches(name)')
      .in('status', ['pending', 'stop_pending'])
      .order('created_at', { ascending: false })
      .limit(40)
    if (!promoErr) {
      for (const row of promoRows || []) {
        const branchName = row.branches?.name || 'Branch'
        const stop = row.status === 'stop_pending'
        items.push({
          id: `promo-${row.id}-${row.status}`,
          kind: stop ? 'promo_stop_pending' : 'promo_pending',
          title: stop ? 'Promo stop requested' : 'Promo awaiting approval',
          detail: `${row.name || 'Promo'} · ${branchName}`,
          href: '/manager/promos',
          createdAt: row.updated_at || row.created_at || null,
          priority: stop ? 3 : 4,
        })
      }
    }
  }

  // Refund requests with no supervisor on site — managers only (is_manager()
  // is what the approve/reject RPCs actually check; a present supervisor
  // never needs this path, they approve in person instead).
  if (manager) {
    const { data: refundRows, error: refundErr } = await supabase
      .from('refund_requests')
      .select('id, mode, reason, requested_at, branch_id, branches(name), transactions(or_number)')
      .eq('status', 'pending')
      .order('requested_at', { ascending: false })
      .limit(40)
    if (!refundErr) {
      for (const row of refundRows || []) {
        const branchName = row.branches?.name || 'Branch'
        items.push({
          id: `refund-${row.id}`,
          kind: 'refund_pending',
          title: 'Refund awaiting approval',
          detail: `${branchName} · ${row.transactions?.or_number || 'sale'} · ${row.mode === 'full' ? 'Full refund' : 'Item refund'} · ${row.reason || ''}`,
          href: `/manager/branches/${row.branch_id}`,
          createdAt: row.requested_at || null,
          priority: 1,
        })
      }
    }
  }

  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  })
  return items
}
