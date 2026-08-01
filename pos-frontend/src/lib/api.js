import { supabase } from './supabase'
import { localDateKey, today } from '../utils/format'

export const hasSupabase = Boolean(supabase)

const mapPricing = (mode) => (mode === 'per_kg' || mode === 'kg' ? 'kg' : 'pc')
const toDbPricing = (mode) => (mode === 'kg' ? 'per_kg' : 'per_unit')

export function mapProduct(row, stock = 0, meta = {}) {
  return {
    id: row.id,
    branchId: row.branch_id || meta.branchId || null,
    name: row.name,
    sku: row.sku,
    barcode: row.barcode || '',
    category: row.categories?.name || row.category || 'Groceries',
    categoryId: row.category_id,
    pricingMode: mapPricing(row.pricing_mode),
    price: Number(row.price),
    stock: Number(stock),
    lowStockAt: Number(row.low_stock_threshold ?? 5),
    createdAt: localDateKey(row.created_at) || meta.createdAt || today(),
    updatedAt: meta.updatedAt ? localDateKey(meta.updatedAt) : localDateKey(row.created_at) || today(),
    lastMovementAt: meta.lastMovementAt || null,
  }
}

export function mapTransaction(row) {
  const created = new Date(row.created_at)
  const createdAt = Number.isNaN(created.getTime()) ? row.created_at || null : created.toISOString()
  return {
    id: row.id,
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
    tendered: row.amount_tendered != null ? Number(row.amount_tendered) : null,
    change: row.change_given != null ? Number(row.change_given) : null,
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
  const { data, error } = await supabase
    .from('staff')
    .select('id, full_name, role, branch_id, is_active, branches(id, name, address, is_active, day_open_hour)')
    .eq('auth_user_id', auth.user.id)
    .eq('is_active', true)
    .maybeSingle()
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
    dayOpenHour: Number(data.branches?.day_open_hour ?? 7),
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
      .select('*, staff(full_name), transaction_items(id)')
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
    transactions: (txRes.data || []).map(mapTransaction),
    movements: (moveRes.data || []).map(mapMovement),
    dayEnds: (dayRes.data || []).map((row) => ({
      id: row.id,
      date: row.business_date,
      recordedCash: Number(row.recorded_cash),
      cashOnHand: Number(row.cash_on_hand),
      variance: Number(row.variance),
      note: row.note || '',
      status: row.status || 'closed',
      cashier: row.staff?.full_name || '',
      closedAt: new Date(row.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      reopenedAt: row.reopened_at
        ? new Date(row.reopened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null,
    })),
    categories: catsRes.data || [],
    dayOpenHour: Number(branchRes.data?.day_open_hour ?? 7),
  }
}

export async function createProduct({ branchId, staffId, values }) {
  const { data: cat } = await supabase.from('categories').select('id').eq('name', values.category).maybeSingle()
  let categoryId = cat?.id
  if (!categoryId) {
    const { data: created } = await supabase.from('categories').insert({ name: values.category }).select('id').single()
    categoryId = created?.id
  }
  const { data: product, error } = await supabase
    .from('products')
    .insert({
      branch_id: branchId,
      name: values.name,
      sku: values.sku,
      barcode: values.barcode,
      category_id: categoryId || null,
      pricing_mode: toDbPricing(values.pricingMode),
      price: values.price,
      low_stock_threshold: values.lowStockAt || 5,
    })
    .select('*, categories(name)')
    .single()
  if (error) throw error
  await supabase.from('branch_inventory').upsert({
    branch_id: branchId,
    product_id: product.id,
    quantity_on_hand: values.stock,
  })
  await supabase.rpc('record_stock_movement', {
    p_branch_id: branchId,
    p_product_id: product.id,
    p_staff_id: staffId,
    p_movement_type: 'restock',
    p_quantity_in: values.stock,
    p_quantity_out: 0,
    p_reference: 'initial',
    p_detail: 'New product',
  })
  return mapProduct(product, values.stock, { branchId, updatedAt: today(), lastMovementAt: today() })
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

  const { data, error } = await supabase
    .from('products')
    .update({
      name: values.name,
      sku: values.sku,
      barcode: values.barcode,
      category_id: categoryId,
      pricing_mode: toDbPricing(values.pricingMode),
      price: values.price,
      low_stock_threshold: values.lowStockAt || 5,
    })
    .eq('id', id)
    .select('*, categories(name)')
    .single()
  if (error) throw error

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

export async function completeSale({ branchId, staffId, items, total, tendered }) {
  const { error: tillError } = await supabase.rpc('assert_till_open', { p_branch_id: branchId })
  if (tillError) throw tillError

  const { data: txn, error } = await supabase
    .from('transactions')
    .insert({
      branch_id: branchId,
      staff_id: staffId,
      total_amount: total,
      amount_tendered: tendered,
      change_given: Math.max(0, tendered - total),
      status: 'completed',
    })
    .select('*, staff(full_name)')
    .single()
  if (error) throw error

  const lines = items.map((item) => ({
    transaction_id: txn.id,
    product_id: item.id,
    quantity: item.pricingMode === 'kg' ? item.weight : item.quantity,
    unit_price: item.price,
    line_total: item.price * (item.pricingMode === 'kg' ? item.weight : item.quantity),
  }))
  const { error: itemsError } = await supabase.from('transaction_items').insert(lines)
  if (itemsError) throw itemsError

  for (const item of items) {
    const sold = item.pricingMode === 'kg' ? item.weight : item.quantity
    const { error: moveError } = await supabase.rpc('record_stock_movement', {
      p_branch_id: branchId,
      p_product_id: item.id,
      p_staff_id: staffId,
      p_movement_type: 'sale',
      p_quantity_in: 0,
      p_quantity_out: sold,
      p_reference: txn.id,
      p_detail: item.name,
    })
    if (moveError) throw moveError
  }

  return mapTransaction({ ...txn, transaction_items: lines })
}

export async function fetchTransactionDetail(id) {
  const { data, error } = await supabase
    .from('transactions')
    .select(
      '*, staff(full_name), transaction_items(id, quantity, unit_price, line_total, products(id, name, sku, pricing_mode))',
    )
    .eq('id', id)
    .single()
  if (error) throw error
  return {
    ...mapTransaction({ ...data, transaction_items: data.transaction_items || [] }),
    lines: (data.transaction_items || []).map((line) => ({
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

export async function voidSale(id, reason) {
  const { error } = await supabase
    .from('transactions')
    .update({ status: 'voided', void_reason: reason })
    .eq('id', id)
  if (error) throw error
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

  if (entry.id) {
    const { data, error } = await supabase
      .from('day_ends')
      .update(payload)
      .eq('id', entry.id)
      .select('*, staff!staff_id(full_name)')
      .single()
    if (error) throw error
    return data
  }

  const { data, error } = await supabase
    .from('day_ends')
    .insert(payload)
    .select('*, staff!staff_id(full_name)')
    .single()
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
  if (payload.day_open_hour != null) {
    fields.day_open_hour = Math.min(23, Math.max(0, Number(payload.day_open_hour)))
  }
  if (payload.id) {
    const { data, error } = await supabase
      .from('branches')
      .update(fields)
      .eq('id', payload.id)
      .select('*')
      .single()
    if (error) throw error
    return data
  }
  const { data, error } = await supabase
    .from('branches')
    .insert({ ...fields, is_active: payload.is_active ?? true })
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

export async function branchSummary(branchId) {
  const start = `${today()}T00:00:00`
  const { data: txs } = await supabase
    .from('transactions')
    .select('total_amount, status')
    .eq('branch_id', branchId)
    .gte('created_at', start)
  const paid = (txs || []).filter((t) => t.status === 'completed')
  const { data: inv } = await supabase
    .from('branch_inventory')
    .select('quantity_on_hand, product_id, products(low_stock_threshold)')
    .eq('branch_id', branchId)
  const low = (inv || []).filter(
    (row) => Number(row.quantity_on_hand) <= Number(row.products?.low_stock_threshold ?? 5),
  ).length
  return {
    revenue: paid.reduce((sum, t) => sum + Number(t.total_amount), 0),
    orders: paid.length,
    lowStock: low,
  }
}

export async function fetchNetworkDashboard(days = 7) {
  const start = new Date()
  start.setDate(start.getDate() - (days - 1))
  const startKey = start.toISOString().slice(0, 10)
  const { data: txs, error } = await supabase
    .from('transactions')
    .select('total_amount, status, created_at, branch_id, branches(name)')
    .eq('status', 'completed')
    .gte('created_at', `${startKey}T00:00:00`)
  if (error) throw error
  const byDate = {}
  const byBranch = {}
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    byDate[d.toISOString().slice(0, 10)] = 0
  }
  ;(txs || []).forEach((row) => {
    const key = row.created_at.slice(0, 10)
    if (byDate[key] != null) byDate[key] += Number(row.total_amount)
    const name = row.branches?.name || 'Branch'
    byBranch[name] = (byBranch[name] || 0) + Number(row.total_amount)
  })
  return {
    linePoints: Object.entries(byDate).map(([label, total]) => ({
      label,
      short: new Date(`${label}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' }),
      total,
    })),
    branchBars: Object.entries(byBranch).map(([category, value]) => ({ category, value })),
  }
}

export async function fetchReportSalesDetail({ start, end, branchId }) {
  let query = supabase
    .from('transaction_items')
    .select('*, products(name, sku, category_id, categories(name)), transactions!inner(id, created_at, status, branch_id, staff_id, staff(full_name), amount_tendered)')
    .gte('transactions.created_at', `${start}T00:00:00`)
    .lte('transactions.created_at', `${end}T23:59:59`)
    .eq('transactions.status', 'completed')
  if (branchId) query = query.eq('transactions.branch_id', branchId)
  const { data, error } = await query
  if (error) throw error
  return data || []
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
}) {
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

  for (const line of preview.lines) {
    const values = line.values
    const categoryId = await ensureCategoryId(values.category)
    let productId = line.existing?.id

    if (line.action === 'create') {
      const { data: product, error } = await supabase
        .from('products')
        .insert({
          branch_id: branchId,
          name: values.name,
          sku: values.sku,
          barcode: values.barcode,
          category_id: categoryId,
          pricing_mode: toDbPricing(values.pricingMode),
          price: values.price,
          low_stock_threshold: values.lowStockAt || 5,
        })
        .select('id')
        .single()
      if (error) throw error
      productId = product.id
      await supabase.from('branch_inventory').upsert({
        branch_id: branchId,
        product_id: productId,
        quantity_on_hand: 0,
      })
    } else {
      await supabase
        .from('products')
        .update({
          name: values.name,
          sku: values.sku,
          barcode: values.barcode,
          category_id: categoryId,
          pricing_mode: toDbPricing(values.pricingMode),
          price: values.price,
          low_stock_threshold: values.lowStockAt || 5,
        })
        .eq('id', productId)
    }

    if (line.quantityAdded > 0) {
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
      quantity_added: line.quantityAdded,
      name: values.name,
      sku: values.sku,
      barcode: values.barcode,
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
