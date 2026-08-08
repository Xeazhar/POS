import { allowDemoMode, supabase } from './supabase'
import { mapDayReport } from '../utils/dayEndReport'
import { localDateKey, today } from '../utils/format'
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

/** Resolve staff full names without embedding (avoids multi-FK PostgREST ambiguity). */
async function staffNameById(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))]
  if (!unique.length || !supabase) return {}
  const { data, error } = await supabase.from('staff').select('id, full_name').in('id', unique)
  if (error) throw error
  return Object.fromEntries((data || []).map((row) => [row.id, row.full_name]))
}

function withCashierName(row, names) {
  if (!row) return row
  const name = names?.[row.staff_id]
  if (!name) return row
  return { ...row, staff: { full_name: name } }
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
  }
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
    branchId: row.branch_id,
  }
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
  'id, or_number, status, total_amount, refunded_amount, amount_tendered, change_given, created_at, staff_id, branch_id, void_reason, voided_at, voided_by, void_approved_by, client_id, order_type, ulam_combo, payment_method, payment_reference, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, vat_rate_applied, discount_amount, discount_type, discount_id_note, transaction_items(id)'
// Pre migrate_vat_breakdown.sql fallback (see bootstrapBranchData / fetchTerminalReportSource).
const BOOTSTRAP_TX_COLS_LEGACY =
  'id, or_number, status, total_amount, refunded_amount, amount_tendered, change_given, created_at, staff_id, branch_id, void_reason, voided_at, voided_by, void_approved_by, client_id, order_type, ulam_combo, payment_method, payment_reference, vat_amount, vatable_sales, discount_amount, discount_type, discount_id_note, transaction_items(id)'
const BOOTSTRAP_MOVE_COLS =
  'id, created_at, product_id, movement_type, quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price, detail, branch_id, products(name)'
const BOOTSTRAP_DAY_END_COLS =
  'id, business_date, recorded_cash, cash_on_hand, variance, expected_cash, note, status, closed_at, submitted_at, approved_at, reopened_at, reopen_reason, day_report, staff_id, branch_id, staff!staff_id(full_name)'
const BOOTSTRAP_DAY_END_COLS_LEGACY =
  'id, business_date, recorded_cash, cash_on_hand, variance, note, status, closed_at, staff_id, branch_id, staff!staff_id(full_name)'

export async function bootstrapBranchData(branchId) {
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
      .order('business_date', { ascending: false }),
    supabase.from('categories').select('id, name').order('name'),
    supabase.from('branches').select('id, day_open_hour').eq('id', branchId).maybeSingle(),
  ])

  let dayRes = dayResInitial
  if (
    dayRes.error &&
    /expected_cash|submitted_at|approved_at|reopened_at|reopen_reason|day_report|schema cache|column/i.test(
      String(dayRes.error.message || ''),
    )
  ) {
    dayRes = await supabase
      .from('day_ends')
      .select(BOOTSTRAP_DAY_END_COLS_LEGACY)
      .eq('branch_id', branchId)
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
    transactions: (tx.data || []).map((row) => mapTransaction(withCashierName(row, staffNames))),
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

export async function createCatalogProduct(values) {
  const { data: cat } = await supabase.from('categories').select('id').eq('name', values.category).maybeSingle()
  let categoryId = cat?.id
  if (!categoryId && values.category) {
    const { data: created } = await supabase.from('categories').insert({ name: values.category }).select('id').single()
    categoryId = created?.id
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
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const values = line.values || {}
    const price = Number(values.price)
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Catalog import rejected: invalid price on row ${i + 1} (${values.sku || values.name || 'item'}).`)
    }
    if (!String(values.name || '').trim() || !String(values.sku || '').trim()) {
      throw new Error(`Catalog import rejected: missing name/SKU on row ${i + 1}.`)
    }
    await createCatalogProduct({
      ...values,
      branchType: preview?.restaurant || branchType === 'restaurant' ? 'restaurant' : 'retail',
      menuKind: values.menuKind || null,
      discountEligible: values.discountEligible === true,
      lowStockAt: values.lowStockAt || 10,
    })
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

async function loadTransactionByClientId(branchId, clientId) {
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
    ;({ data: txn, error } = await supabase.from('transactions').insert(fallback).select('*').single())
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
  const row = withCashierName(data, staffNames)
  return {
    ...mapTransaction({ ...row, transaction_items: row.transaction_items || [] }),
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

export async function voidSale(id, reason, staffId = null, approvedBy = null) {
  if (staffId) {
    const { data, error } = await supabase.rpc('void_sale_secure', {
      p_transaction_id: id,
      p_staff_id: staffId,
      p_reason: reason,
    })
    if (!error) {
      if (approvedBy) {
        await supabase
          .from('transactions')
          .update({ void_approved_by: approvedBy })
          .eq('id', id)
          .then(({ error: e }) => {
            if (e && !isMissingColumnError(e, 'void_approved_by')) console.warn(e.message)
          })
      }
      return data
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
  const lines = (data || []).map((row) => ({
    ...row,
    productName: row.products?.name || null,
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

const BRANCH_LIST_COLS =
  'id, name, address, is_active, sort_order, day_open_hour, branch_type, device_settings, vat_rate'

export async function fetchBranches() {
  const { data, error } = await supabase.from('branches').select(BRANCH_LIST_COLS).order('sort_order').order('name')
  if (error) {
    // Older schemas may lack sort_order / device_settings / vat_rate — fall back broadly.
    const fallback = await supabase.from('branches').select('*').order('name')
    if (fallback.error) throw error
    return fallback.data || []
  }
  return data || []
}

export async function reorderBranches(orderedIds = []) {
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
    if (error && (isMissingColumnError(error, 'vat_rate') || isMissingColumnError(error, 'sort_order'))) {
      const fallback = { ...fields }
      delete fallback.vat_rate
      delete fallback.sort_order
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

export async function createStaffAccount({
  email,
  password,
  fullName,
  role,
  branchId,
  loginCode = null,
  loginPin = null,
  permissions = null,
}) {
  const { data: sessionData } = await supabase.auth.getSession()
  const managerSession = sessionData.session
  const pinRole = role === 'cashier' || role === 'supervisor'
  const authEmail = pinRole && loginCode ? pinAuthEmail(loginCode, branchId) : email
  // Till PIN is also the Auth password (never returned to clients after login resolve).
  const authPassword = pinRole ? String(loginPin || '') : password
  if (pinRole && !authPassword) throw new Error('PIN is required for cashier/supervisor accounts.')

  const { data, error } = await supabase.auth.signUp({
    email: authEmail,
    password: authPassword,
    options: { data: { full_name: fullName, role, branch_id: branchId } },
  })
  if (error) throw error
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
      let { error: insertError } = await supabase.from('staff').insert({
        auth_user_id: data.user.id,
        ...staffPayload,
      })
      if (insertError && (isMissingColumnError(insertError, 'login_code') || isMissingColumnError(insertError, 'permissions') || isMissingColumnError(insertError, 'auth_secret'))) {
        ;({ error: insertError } = await supabase.from('staff').insert({
          auth_user_id: data.user.id,
          branch_id: branchId,
          full_name: fullName,
          role,
          is_active: true,
        }))
      }
      if (insertError) {
        const uniqueErr = staffCodeUniqueError(insertError)
        if (uniqueErr) throw uniqueErr
        if (insertError.code !== '23505') throw insertError
      }
    }
  }
  if (managerSession) await supabase.auth.setSession(managerSession)
  return data.user
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

export async function clockIn({ branchId, staffId, shiftPeriod = null }) {
  const period = shiftPeriod === 'am' || shiftPeriod === 'pm' ? shiftPeriod : null
  const payload = {
    branch_id: branchId,
    staff_id: staffId,
    clock_in: new Date().toISOString(),
  }
  if (period) payload.shift_period = period
  const { data, error } = await supabase.from('staff_shifts').insert(payload).select('*').single()
  if (error) {
    // Older DBs without shift_period — retry without it
    if (period && (isMissingColumnError(error, 'shift_period') || /shift_period/i.test(String(error.message || '')))) {
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

export async function clockOut(shiftId) {
  const { data, error } = await supabase
    .from('staff_shifts')
    .update({ clock_out: new Date().toISOString() })
    .eq('id', shiftId)
    .select('*')
    .single()
  if (error) throw error
  return data
}

export async function fetchOpenShift(staffId) {
  const { data, error } = await supabase
    .from('staff_shifts')
    .select('id, branch_id, staff_id, clock_in, clock_out, shift_period')
    .eq('staff_id', staffId)
    .is('clock_out', null)
    .order('clock_in', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    if (isMissingColumnError(error, 'shift_period') || /shift_period|schema cache|column/i.test(String(error.message || ''))) {
      const fallback = await supabase
        .from('staff_shifts')
        .select('id, branch_id, staff_id, clock_in, clock_out')
        .eq('staff_id', staffId)
        .is('clock_out', null)
        .order('clock_in', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (fallback.error) {
        if (isMissingColumnError(fallback.error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(fallback.error.message || ''))) {
          return null
        }
        throw fallback.error
      }
      return fallback.data
    }
    if (isMissingColumnError(error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(error.message || ''))) {
      return null
    }
    throw error
  }
  return data
}

/** Shift log for supervisors (one branch) or managers (all / filtered). */
export async function fetchStaffShifts({ branchId = null, start = null, end = null, limit = 300 } = {}) {
  const run = async (includePeriod) => {
    let query = supabase
      .from('staff_shifts')
      .select(
        includePeriod
          ? 'id, branch_id, staff_id, clock_in, clock_out, shift_period, created_at, staff:staff_id(id, full_name, role), branches:branch_id(id, name)'
          : 'id, branch_id, staff_id, clock_in, clock_out, created_at, staff:staff_id(id, full_name, role), branches:branch_id(id, name)',
      )
      .order('clock_in', { ascending: false })
      .limit(limit)
    if (branchId) query = query.eq('branch_id', branchId)
    if (start) query = query.gte('clock_in', `${start}T00:00:00`)
    if (end) query = query.lte('clock_in', `${end}T23:59:59.999`)
    return query
  }

  let { data, error } = await run(true)
  if (error && /shift_period/i.test(String(error.message || ''))) {
    ;({ data, error } = await run(false))
  }
  if (error) {
    if (isMissingColumnError(error, 'staff_shifts') || /staff_shifts|schema cache/i.test(String(error.message || ''))) {
      return []
    }
    throw error
  }
  return (data || []).map((row) => ({
    id: row.id,
    branchId: row.branch_id,
    branchName: row.branches?.name || '—',
    staffId: row.staff_id,
    staffName: row.staff?.full_name || 'Staff',
    staffRole: row.staff?.role || '',
    clockIn: row.clock_in,
    clockOut: row.clock_out,
    shiftPeriod: row.shift_period === 'am' || row.shift_period === 'pm' ? row.shift_period : null,
    open: !row.clock_out,
  }))
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
  const status =
    row.status ||
    (kind === 'paid_out' ? 'approved' : 'recorded')
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
    status: 'pending',
    requestedBy: staffId,
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
  return (data || []).map(mapPettyCashRow)
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
  const staffNames = await staffNameById([
    ...rows.map((row) => row.staffId),
    ...rows.map((row) => row.approvedBy),
    ...rows.map((row) => row.confirmedBy),
  ])
  return rows.map((row) => ({
    ...row,
    staffName: staffNames[row.staffId] || 'Staff',
    approvedByName: row.approvedBy ? staffNames[row.approvedBy] || 'Staff' : null,
    confirmedByName: row.confirmedBy ? staffNames[row.confirmedBy] || 'Staff' : null,
  }))
}

export async function branchSummary(branchId, { days = 1 } = {}) {
  const start = new Date()
  start.setDate(start.getDate() - (Math.max(1, days) - 1))
  const startKey = start.toISOString().slice(0, 10)

  const { data: branch } = await supabase
    .from('branches')
    .select('branch_type')
    .eq('id', branchId)
    .maybeSingle()
  const isRestaurant = branch?.branch_type === 'restaurant'

  const { data: txs } = await supabase
    .from('transactions')
    .select('total_amount, status')
    .eq('branch_id', branchId)
    .gte('created_at', `${startKey}T00:00:00`)
  const paid = (txs || []).filter((t) => t.status === 'completed')

  let lowStock = 0
  let menuOn = 0
  let menuOff = 0
  if (isRestaurant) {
    const { data: products } = await supabase
      .from('products')
      .select('available_today, is_active')
      .eq('branch_id', branchId)
      .eq('is_active', true)
    ;(products || []).forEach((p) => {
      if (p.available_today !== false) menuOn += 1
      else menuOff += 1
    })
  } else {
    const { data: inv } = await supabase
      .from('branch_inventory')
      .select('quantity_on_hand, product_id, products(low_stock_threshold)')
      .eq('branch_id', branchId)
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
  }
}

/** period: 'day' | 'week' | 'month' | 'year' */
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
  const primary = await supabase
    .from('transactions')
    .select('total_amount, status, created_at, branch_id, payment_method, branches(name)')
    .eq('status', 'completed')
    .gte('created_at', startIso)

  let txs
  if (primary.error && /payment_method|schema cache/i.test(String(primary.error.message || ''))) {
    const fallback = await supabase
      .from('transactions')
      .select('total_amount, status, created_at, branch_id, branches(name)')
      .eq('status', 'completed')
      .gte('created_at', startIso)
    if (fallback.error) throw fallback.error
    txs = fallback.data || []
  } else if (primary.error) {
    throw primary.error
  } else {
    txs = primary.data || []
  }

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
    if (byBucket[bucketKey] != null) byBucket[bucketKey] += amount
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
      if (period === 'day') {
        const hour = Number(label)
        const suffix = hour < 12 ? 'AM' : 'PM'
        const display = hour % 12 === 0 ? 12 : hour % 12
        return { label: `${label}:00`, short: `${display} ${suffix}`, total }
      }
      return {
        label,
        short:
          period === 'year'
            ? new Date(`${label}-01T00:00:00`).toLocaleDateString([], { month: 'short', year: '2-digit' })
            : new Date(`${label}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }),
        total,
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
      .slice(0, 8)
      .map((p) => ({ category: p.name, value: Number(p.revenue.toFixed(2)) })),
    topCategories: Object.entries(byCategoryNet)
      .map(([category, value]) => ({ category, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value),
  }
}

export async function fetchReportSalesDetail({ start, end, branchId, includeVoided = false }) {
  let query = supabase
    .from('transaction_items')
    .select(
      '*, products(id, product_no, name, sku, category_id, categories(name)), transactions!inner(id, or_number, created_at, status, void_reason, voided_at, branch_id, staff_id, amount_tendered, total_amount, order_type, ulam_combo, payment_method, payment_reference)',
    )
    .gte('transactions.created_at', `${start}T00:00:00`)
    .lte('transactions.created_at', `${end}T23:59:59`)
  if (!includeVoided) query = query.eq('transactions.status', 'completed')
  if (branchId) query = query.eq('transactions.branch_id', branchId)
  const { data, error } = await query
  if (error) {
    // Soft-fail older schemas without payment columns
    if (/payment_method|payment_reference|schema cache/i.test(String(error.message || ''))) {
      const fallback = await supabase
        .from('transaction_items')
        .select(
          '*, products(id, product_no, name, sku, category_id, categories(name)), transactions!inner(id, or_number, created_at, status, void_reason, voided_at, branch_id, staff_id, amount_tendered, total_amount, order_type, ulam_combo)',
        )
        .gte('transactions.created_at', `${start}T00:00:00`)
        .lte('transactions.created_at', `${end}T23:59:59`)
      const fb = !includeVoided ? fallback.eq('transactions.status', 'completed') : fallback
      const scoped = branchId ? fb.eq('transactions.branch_id', branchId) : fb
      const { data: rows2, error: err2 } = await scoped
      if (err2) throw err2
      const staffNames2 = await staffNameById((rows2 || []).map((row) => row.transactions?.staff_id))
      return (rows2 || []).map((row) => ({
        ...row,
        transactions: withCashierName(row.transactions, staffNames2),
      }))
    }
    throw error
  }
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

export async function fetchAuditEvents({ start, end, branchId, limit = 500 } = {}) {
  let query = supabase
    .from('audit_events')
    .select('*, staff(full_name), branches(name)')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (start) query = query.gte('created_at', `${start}T00:00:00`)
  if (end) query = query.lte('created_at', `${end}T23:59:59`)
  if (branchId) query = query.eq('branch_id', branchId)
  const { data, error } = await query
  if (error) throw error
  return data || []
}

export async function fetchSaleEvents({ start, end, branchId, eventType, limit = 500 } = {}) {
  let query = supabase
    .from('sale_events')
    .select('*, staff(full_name), branches(name)')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (start) query = query.gte('created_at', `${start}T00:00:00`)
  if (end) query = query.lte('created_at', `${end}T23:59:59`)
  if (branchId) query = query.eq('branch_id', branchId)
  if (eventType) query = query.eq('event_type', eventType)
  const { data, error } = await query
  if (error) throw error
  return data || []
}

/** Daily Z/X style reading from transactions (operational; not BIR-accredited). */
export async function fetchDailyReading({ date, branchId }) {
  let query = supabase
    .from('transactions')
    .select('id, or_number, status, total_amount, void_reason, created_at, staff_id')
    .gte('created_at', `${date}T00:00:00`)
    .lte('created_at', `${date}T23:59:59`)
    .order('created_at', { ascending: true })
  if (branchId) query = query.eq('branch_id', branchId)
  const { data, error } = await query
  if (error) throw error
  const rows = data || []
  const staffNames = await staffNameById(rows.map((r) => r.staff_id))
  const completed = rows.filter((r) => r.status === 'completed')
  const voided = rows.filter((r) => r.status === 'voided')
  const salesTotal = completed.reduce((sum, r) => sum + Number(r.total_amount), 0)
  const voidTotal = voided.reduce((sum, r) => sum + Number(r.total_amount), 0)
  const orNumbers = rows.map((r) => r.or_number).filter(Boolean)
  return {
    date,
    branchId: branchId || null,
    transactionCount: completed.length,
    voidCount: voided.length,
    salesTotal,
    voidTotal,
    netSales: salesTotal,
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

export async function fetchInventoryReport(branchId) {
  let query = supabase
    .from('products')
    .select('*, categories(name), branches(name), branch_inventory(quantity_on_hand, updated_at, branch_id)')
    .eq('is_active', true)
    .order('name')
  if (branchId) query = query.eq('branch_id', branchId)
  const { data, error } = await query
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
    const categoryId = await ensureCategoryId(values.category)
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
 * to status='stopped' with stop_reason 'Promo ended' — see migrate_promo_auto_expire.sql.
 * Called at the top of the promo read paths below instead of on a schedule, so it self-heals
 * on every read without needing pg_cron. Swallows errors so an un-migrated DB (function
 * missing) degrades to the old behavior (expired promos just stay hidden from POS via the
 * respectDuration check) rather than breaking the read.
 */
async function expireEndedPromos() {
  try {
    // supabase-js resolves RPC errors onto { error } rather than rejecting — check both.
    const { error } = await supabase.rpc('expire_ended_promos')
    if (!error) return
    // Function not deployed yet (migrate_promo_auto_expire.sql unapplied). Fall back to a
    // plain UPDATE: managers/supervisors have RLS write access to their branch's promos, so
    // the sweep still lands for exactly the people who look at the Promos page. Cashiers get
    // denied here and that's fine — hasEnded() below already hides expired promos for them.
    await supabase
      .from('promo_events')
      .update({
        status: 'stopped',
        is_active: false,
        stopped_at: new Date().toISOString(),
        stop_reason: 'Promo ended',
      })
      .in('status', ['active', 'stop_pending'])
      .not('ends_at', 'is', null)
      .lt('ends_at', new Date().toISOString())
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

/** Display status for a promo row, treating a passed end date as stopped. */
export function promoEffectiveStatus(event) {
  const status = event?.status || (event?.is_active ? 'active' : 'inactive')
  if ((status === 'active' || status === 'stop_pending') && promoHasEnded(event)) return 'stopped'
  return status
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

  const { data: rules, error: rulesError } = await supabase
    .from('promo_rules')
    .select('id,rule_type,discount_pct,buy_qty,get_qty')
    .eq('promo_event_id', event.id)

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
  const { data: rules, error } = await supabase
    .from('promo_rules')
    .select('id,rule_type,discount_pct,buy_qty,get_qty')
    .eq('promo_event_id', promoEventId)
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
  startsAt = null,
  endsAt = null,
  staffId = null,
  activateImmediately = false,
}) {
  const starts_iso = startsAt ? new Date(startsAt).toISOString() : null
  const ends_iso = endsAt ? new Date(endsAt).toISOString() : null

  // Dual-control: create as pending unless manager activates immediately after approve path.
  // New creates are always pending — never auto-activate.
  const payload = {
    branch_id: branchId,
    name,
    is_active: false,
    status: 'pending',
    starts_at: starts_iso,
    ends_at: ends_iso,
    requested_by: staffId || null,
  }

  let { data, error } = await supabase.from('promo_events').insert(payload).select('id,name,status').single()
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

export async function rejectPromoEvent({ id, staffId }) {
  const { data, error } = await supabase.rpc('reject_promo_event', {
    p_promo_event_id: id,
    p_staff_id: staffId,
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

export async function createPromoRule({ promoEventId, ruleType, discountPct, productIds, buyQty = 1, getQty = 1 }) {
  const { data: rule, error: ruleError } = await supabase
    .from('promo_rules')
    .insert({
      promo_event_id: promoEventId,
      rule_type: ruleType,
      discount_pct: discountPct,
      buy_qty: buyQty,
      get_qty: getQty,
    })
    .select('id')
    .single()

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
export async function updatePromoEventDetails({ promoEventId, name, startsAt, endsAt }) {
  const toIso = (value) => (value ? new Date(value).toISOString() : null)

  const payload = {
    ...(typeof name === 'string' ? { name } : {}),
    ...(startsAt !== undefined ? { starts_at: toIso(startsAt) } : {}),
    ...(endsAt !== undefined ? { ends_at: toIso(endsAt) } : {}),
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase.from('promo_events').update(payload).eq('id', promoEventId).select('id,name')
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
      'id,name,is_active,status,starts_at,ends_at,created_at,stop_reason,requested_by,approved_by,stop_requested_by',
    )
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })

  if (error) {
    const fallback = await supabase
      .from('promo_events')
      .select('id,name,is_active,starts_at,ends_at,created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
    if (fallback.error) throw error
    return fallback.data || []
  }
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

export async function deletePromoEvent(promoEventId) {
  const { data, error } = await supabase.from('promo_events').delete().eq('id', promoEventId).select('id').maybeSingle()
  if (error) throw error
  return data
}

/**
 * Pending approval inbox for Shell notifications.
 * Managers: submitted day-ends + promo pending/stop + petty cash pending.
 * Supervisors: submitted day-ends + petty cash pending on their branch.
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

  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
  })
  return items
}
