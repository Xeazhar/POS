import { allowDemoMode, supabase } from './supabase'
import { mapDayReport } from '../utils/dayEndReport'
import { localDateKey, today } from '../utils/format'
import { normalizeMenuKind } from '../utils/ulam'

export const hasSupabase = Boolean(supabase)
export { allowDemoMode }

const mapPricing = (mode) => (mode === 'per_kg' || mode === 'kg' ? 'kg' : 'pc')
const toDbPricing = (mode) => (mode === 'kg' ? 'per_kg' : 'per_unit')

export function mapDayEndRow(row) {
  if (!row) return null
  return {
    id: row.id,
    date: row.business_date,
    recordedCash: Number(row.recorded_cash),
    cashOnHand: Number(row.cash_on_hand),
    variance: Number(row.variance),
    note: row.note || '',
    status: row.status || 'closed',
    cashier: row.staff?.full_name || '',
    closedAt: row.closed_at
      ? new Date(row.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '',
    reopenedAt: row.reopened_at
      ? new Date(row.reopened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : null,
    dayReport: mapDayReport(row.day_report),
    branchId: row.branch_id || null,
  }
}

function isMissingColumnError(error, column) {
  const msg = String(error?.message || error || '')
  return msg.includes(column) && (msg.includes('schema cache') || msg.includes('does not exist') || msg.includes('Could not find'))
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
    regularPrice: Number(row.price),
    budgetPrice: row.budget_price != null ? Number(row.budget_price) : null,
    stock: Number(stock),
    lowStockAt: Number(row.low_stock_threshold ?? 5),
    availableToday: row.available_today !== false,
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
  return {
    id: row.id,
    orNumber: row.or_number || null,
    time: Number.isNaN(created.getTime())
      ? '—'
      : created.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
    cashier: row.staff?.full_name || 'Staff',
    total: Number(row.total_amount),
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
  const selectWithDevices =
    'id, full_name, role, branch_id, is_active, branches(id, name, address, is_active, day_open_hour, branch_type, device_settings)'
  const selectBase =
    'id, full_name, role, branch_id, is_active, branches(id, name, address, is_active, day_open_hour, branch_type)'
  let { data, error } = await supabase
    .from('staff')
    .select(selectWithDevices)
    .eq('auth_user_id', auth.user.id)
    .eq('is_active', true)
    .maybeSingle()
  if (error && /device_settings|schema cache|column/i.test(String(error.message || ''))) {
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
  }
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return fetchSessionStaff()
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function bootstrapBranchData(branchId) {
  const [productsRes, inventoryRes, txRes, moveRes, dayRes, catsRes, branchRes] = await Promise.all([
    supabase
      .from('products')
      .select('*, categories(name)')
      .eq('branch_id', branchId)
      .eq('is_active', true)
      .order('name'),
    supabase.from('branch_inventory').select('*').eq('branch_id', branchId),
    supabase
      .from('transactions')
      .select('*, transaction_items(id)')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('stock_movements')
      .select('*, products(name)')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('day_ends')
      .select('*, staff!staff_id(full_name)')
      .eq('branch_id', branchId)
      .order('business_date', { ascending: false }),
    supabase.from('categories').select('*').order('name'),
    supabase.from('branches').select('id, day_open_hour').eq('id', branchId).maybeSingle(),
  ])

  for (const res of [productsRes, inventoryRes, txRes, moveRes, dayRes, catsRes, branchRes]) {
    if (res.error) throw res.error
  }

  const staffNames = await staffNameById((txRes.data || []).map((row) => row.staff_id))

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
    transactions: (txRes.data || []).map((row) => mapTransaction(withCashierName(row, staffNames))),
    movements: (moveRes.data || []).map(mapMovement),
    dayEnds: (dayRes.data || []).map((row) => mapDayEndRow(row)),
    categories: catsRes.data || [],
    dayOpenHour: Number(branchRes.data?.day_open_hour ?? 7),
  }
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
  })

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
    (isMissingColumnError(error, 'order_type') || isMissingColumnError(error, 'ulam_combo'))
  ) {
    const fallback = { ...insertRow }
    delete fallback.order_type
    delete fallback.ulam_combo
    ;({ data: txn, error } = await supabase.from('transactions').insert(fallback).select('*').single())
  }
  if (error) throw error

  const lines = items.map((item) => {
    const unit = Number(item.unitPrice ?? item.price)
    const quantity = item.pricingMode === 'kg' ? item.weight : item.quantity
    const row = {
      transaction_id: txn.id,
      product_id: item.id,
      quantity,
      unit_price: unit,
      line_total: unit * quantity,
    }
    if (isRestaurant) {
      row.price_tier = item.priceTier === 'budget' ? 'budget' : 'regular'
    }
    return row
  })
  let { error: itemsError } = await supabase.from('transaction_items').insert(lines)
  if (itemsError && isMissingColumnError(itemsError, 'price_tier')) {
    ;({ error: itemsError } = await supabase
      .from('transaction_items')
      .insert(lines.map(({ price_tier, ...rest }) => rest)))
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
      '*, transaction_items(id, quantity, unit_price, line_total, products(id, name, sku, pricing_mode))',
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
    })),
  }
}

export async function voidSale(id, reason, staffId = null) {
  if (staffId) {
    const { data, error } = await supabase.rpc('void_sale_secure', {
      p_transaction_id: id,
      p_staff_id: staffId,
      p_reason: reason,
    })
    if (!error) return data
    if (!String(error.message || '').includes('Could not find the function')) throw error
  }

  const { data: existing } = await supabase
    .from('transactions')
    .select('id, branch_id, or_number, total_amount')
    .eq('id', id)
    .maybeSingle()

  const { error } = await supabase
    .from('transactions')
    .update({
      status: 'voided',
      void_reason: reason,
      voided_at: new Date().toISOString(),
      voided_by: staffId,
    })
    .eq('id', id)
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
      payload: {},
    })
  }
}

export async function closeDayEnd({ branchId, staffId, entry }) {
  const payload = {
    branch_id: branchId,
    staff_id: staffId,
    business_date: entry.date,
    recorded_cash: entry.recordedCash,
    cash_on_hand: entry.cashOnHand,
    variance: entry.variance,
    note: entry.note,
    status: 'closed',
    closed_at: new Date().toISOString(),
    reopened_at: null,
    reopened_by: null,
  }
  if (entry.dayReport != null) {
    payload.day_report = entry.dayReport
  }

  const run = async (body) => {
    if (entry.id) {
      return supabase
        .from('day_ends')
        .update(body)
        .eq('id', entry.id)
        .select('*, staff!staff_id(full_name)')
        .single()
    }
    return supabase.from('day_ends').insert(body).select('*, staff!staff_id(full_name)').single()
  }

  let { data, error } = await run(payload)
  if (error && payload.day_report && isMissingColumnError(error, 'day_report')) {
    const fallback = { ...payload }
    delete fallback.day_report
    ;({ data, error } = await run(fallback))
    if (!error) {
      console.warn('day_report column missing — run migrate_day_end_report.sql')
    }
  }
  if (error) throw error
  return data
}

export async function reopenDayEnd({ id, staffId }) {
  const { data, error } = await supabase.rpc('reopen_day_end', {
    p_day_end_id: id,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

export async function fetchBranches() {
  const { data, error } = await supabase.from('branches').select('*').order('name')
  if (error) throw error
  return data || []
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
    p_app_version: import.meta.env.VITE_APP_VERSION || 'web',
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
    supabase.from('branch_presence').select('*').in('branch_id', ids),
    supabase.from('branch_devices').select('*').in('branch_id', ids),
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
  const { data, error } = await supabase.from('roles').select('*').order('sort_order')
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
  const { data, error } = await supabase
    .from('staff')
    .select('*, branches(name), roles(label)')
    .order('full_name')
  if (error) throw error
  return data || []
}

export async function createStaffAccount({ email, password, fullName, role, branchId }) {
  const { data: sessionData } = await supabase.auth.getSession()
  const managerSession = sessionData.session
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, role, branch_id: branchId } },
  })
  if (error) throw error
  if (data.user) {
    // Trigger may already create the staff row — update it; insert only if missing
    const { data: existing } = await supabase
      .from('staff')
      .select('id')
      .eq('auth_user_id', data.user.id)
      .maybeSingle()
    if (existing?.id) {
      const { error: updateError } = await supabase
        .from('staff')
        .update({
          branch_id: branchId,
          full_name: fullName,
          role,
          is_active: true,
        })
        .eq('id', existing.id)
      if (updateError) throw updateError
    } else {
      const { error: insertError } = await supabase.from('staff').insert({
        auth_user_id: data.user.id,
        branch_id: branchId,
        full_name: fullName,
        role,
        is_active: true,
      })
      if (insertError && insertError.code !== '23505') throw insertError
    }
  }
  if (managerSession) await supabase.auth.setSession(managerSession)
  return data.user
}

export async function updateStaffRow(id, changes) {
  const { data, error } = await supabase.from('staff').update(changes).eq('id', id).select('*, branches(name)').single()
  if (error) throw error
  return data
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
  const { data: txs, error } = await supabase
    .from('transactions')
    .select('total_amount, status, created_at, branch_id, branches(name)')
    .eq('status', 'completed')
    .gte('created_at', startIso)
  if (error) throw error

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

  const todayKey = localKey(new Date())
  ;(txs || []).forEach((row) => {
    const when = new Date(row.created_at)
    const dayKey = localKey(when)
    let bucketKey = dayKey
    if (period === 'year') bucketKey = dayKey.slice(0, 7)
    else if (period === 'day') {
      if (dayKey !== todayKey) return
      bucketKey = String(when.getHours()).padStart(2, '0')
    }
    if (byBucket[bucketKey] != null) byBucket[bucketKey] += Number(row.total_amount)
    const name = row.branches?.name || 'Branch'
    byBranch[name] = (byBranch[name] || 0) + Number(row.total_amount)
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
  }
}

export async function fetchReportSalesDetail({ start, end, branchId, includeVoided = false }) {
  let query = supabase
    .from('transaction_items')
    .select(
      '*, products(id, product_no, name, sku, category_id, categories(name)), transactions!inner(id, or_number, created_at, status, void_reason, voided_at, branch_id, staff_id, amount_tendered, total_amount, order_type, ulam_combo)',
    )
    .gte('transactions.created_at', `${start}T00:00:00`)
    .lte('transactions.created_at', `${end}T23:59:59`)
  if (!includeVoided) query = query.eq('transactions.status', 'completed')
  if (branchId) query = query.eq('transactions.branch_id', branchId)
  const { data, error } = await query
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
    .select('*')
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
    onProgress?.({
      current: index + 1,
      total,
      label: values.name,
    })
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
