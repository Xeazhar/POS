import { supabase } from '../supabase'
import { appError } from '../../utils/errors'
import { normalizeBranchType, isRestaurantBranchType, RESTAURANT_FEATURES_ENABLED } from '../../utils/features'
import { localDateKey, today } from '../../utils/format'
import { normalizeMenuKind } from '../../utils/ulam'
import {
  fetchAllRows,
  mapProduct,
  mapDayEndRow,
  mapTransaction,
  withApprover,
  withCashierName,
  staffNameById,
  fetchStaffIdentities,
  writeProductRow,
  mapPricing,
  toDbPricing,
  resolveCategoryIds,
} from './shared.js'
import { mapMovement } from './inventory.js'
import { mapBranchFiscalHeader } from './branches.js'

const BOOTSTRAP_PRODUCT_COLS =
  'id, branch_id, name, sku, barcode, category_id, menu_kind, pricing_mode, price, unit_cost, budget_price, low_stock_threshold, available_today, discount_eligible, product_no, created_at, categories(name)'
export const BOOTSTRAP_TX_COLS =
  'id, invoice_number, status, total_amount, refunded_amount, amount_tendered, change_given, created_at, staff_id, branch_id, shift_id, void_reason, voided_at, voided_by, void_approved_by, client_id, order_type, ulam_combo, payment_method, payment_reference, vat_amount, vatable_sales, vat_exempt_sales, zero_rated_sales, sc_pwd_discount, vat_rate_applied, discount_amount, discount_type, discount_id_note, transaction_items(id)'
const BOOTSTRAP_MOVE_COLS =
  'id, created_at, product_id, movement_type, quantity_in, quantity_out, quantity_on_hand_after, old_price, new_price, detail, branch_id, products(name)'
export const BOOTSTRAP_DAY_END_COLS =
  'id, business_date, recorded_cash, cash_on_hand, variance, expected_cash, note, status, closed_at, submitted_at, approved_at, reopened_at, reopen_reason, day_report, staff_id, branch_id, staff!staff_id(full_name), requested_at, requested_by, request_manager, reopen_requested_at, reopen_requested_by, reopen_request_reason, handoff_confirmed_by, handoff_confirmed_at, confirmer:staff!handoff_confirmed_by(full_name)'

/**
 * POS cold-path: catalog + stock + categories only.
 * Login/POS should wait on this; recent txs/movements/day-ends load separately.
 */
export async function bootstrapPosCatalog(branchId) {
  const [productsRes, inventoryRes, catsRes, branchRes] = await Promise.all([
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
    supabase.from('categories').select('id, name').order('name'),
    supabase
      .from('branches')
      .select(
        'id, day_open_hour, invoice_prefix, invoice_next, name, address, business_name, tin, branch_tin_code, bir_permit_no, machine_identification_no, serial_number',
      )
      .eq('id', branchId)
      .maybeSingle(),
  ])
  for (const res of [productsRes, inventoryRes, catsRes, branchRes]) {
    if (res.error) throw res.error
  }
  const stockMap = Object.fromEntries(
    (inventoryRes.data || []).map((row) => [
      row.product_id,
      { stock: Number(row.quantity_on_hand), updatedAt: row.updated_at },
    ]),
  )
  return {
    products: (productsRes.data || []).map((row) =>
      mapProduct(row, stockMap[row.id]?.stock ?? 0, {
        updatedAt: stockMap[row.id]?.updatedAt,
        lastMovementAt: null,
      }),
    ),
    categories: catsRes.data || [],
    dayOpenHour: Number(branchRes.data?.day_open_hour ?? 7),
    invoicePrefix: branchRes.data?.invoice_prefix || 'SI',
    invoiceNext: Number(branchRes.data?.invoice_next ?? 1),
    fiscalHeader: branchRes.data ? mapBranchFiscalHeader(branchRes.data) : null,
  }
}

/**
 * Recent activity for a branch (txs / movements / day ends).
 * Used by dashboards, sync, and inventory history — not required to paint POS tiles.
 */
export async function bootstrapBranchActivity(branchId) {
  const dayEndsCutoff = localDateKey(new Date(Date.now() - 90 * 86400000))
  const [txRes, moveRes, dayRes] = await Promise.all([
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
  ])
  for (const res of [txRes, moveRes, dayRes]) {
    if (res.error) throw res.error
  }

  const staffNames = await staffNameById((txRes.data || []).map((row) => row.staff_id))
  const approverIdentities = await fetchStaffIdentities(
    (txRes.data || []).map((row) => row.void_approved_by),
  ).catch(() => ({}))

  const lastMoveMap = {}
  ;(moveRes.data || []).forEach((row) => {
    if (!lastMoveMap[row.product_id]) lastMoveMap[row.product_id] = localDateKey(row.created_at)
  })

  return {
    transactions: (txRes.data || []).map((row) =>
      mapTransaction(withApprover(withCashierName(row, staffNames), approverIdentities)),
    ),
    movements: (moveRes.data || []).map(mapMovement),
    dayEnds: (dayRes.data || []).map((row) => mapDayEndRow(row)),
    lastMoveMap,
  }
}

/** Full branch snapshot = catalog + activity (offline sync / pages that need both). */
export async function bootstrapBranchData(branchId) {
  const [catalog, activity] = await Promise.all([
    bootstrapPosCatalog(branchId),
    bootstrapBranchActivity(branchId),
  ])
  const products = (catalog.products || []).map((p) => ({
    ...p,
    lastMovementAt: activity.lastMoveMap?.[p.id] || p.lastMovementAt || null,
  }))
  return {
    products,
    categories: catalog.categories,
    dayOpenHour: catalog.dayOpenHour,
    invoicePrefix: catalog.invoicePrefix,
    invoiceNext: catalog.invoiceNext,
    fiscalHeader: catalog.fiscalHeader,
    transactions: activity.transactions,
    movements: activity.movements,
    dayEnds: activity.dayEnds,
  }
}

/**
 * Loads branch inventory data without exposing transaction or day-end records.
 * @param {string} branchId - The branch identifier.
 * @returns {Promise<Object>} Inventory products, categories, opening hour, and stock movements.
 */
export async function bootstrapBranchInventory(branchId) {
  const [catalog, activity] = await Promise.all([
    bootstrapPosCatalog(branchId),
    bootstrapBranchActivity(branchId),
  ])
  const products = (catalog.products || []).map((p) => ({
    ...p,
    lastMovementAt: activity.lastMoveMap?.[p.id] || p.lastMovementAt || null,
  }))
  return {
    products,
    categories: catalog.categories,
    dayOpenHour: catalog.dayOpenHour,
    movements: activity.movements,
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
      branch_type: normalizeBranchType(
        values.branchType === 'restaurant' || values.menuKind ? 'restaurant' : 'retail',
      ),
    })
    .select('*, categories(name)')
    .single()
  if (error) throw error
  return data
}

/** Bulk create/update network catalog rows (manager import). Skips are already filtered client-side. */
export async function commitCatalogImport({
  preview,
  branchType = 'retail',
  staffId = null,
  onProgress,
}) {
  const lines = preview?.lines || []
  const total = lines.length || 1
  let created = 0
  let updated = 0
  const isRestaurant =
    RESTAURANT_FEATURES_ENABLED && (preview?.restaurant || isRestaurantBranchType(branchType))

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
    if (line.action === 'update' && !line.existing?.id) {
      throw new Error(
        `Catalog import rejected before any changes: update row ${i + 1} has no matching catalog id.`,
      )
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
    const payload = {
      ...values,
      branchType: isRestaurant ? 'restaurant' : 'retail',
      menuKind: values.menuKind || null,
      discountEligible: values.discountEligible === true,
      lowStockAt: values.lowStockAt || 10,
    }

    if (line.action === 'update') {
      const existing = line.existing
      // Full-record merge (same as the bulk editor): updateCatalogProduct replaces the row,
      // so a partial payload would blank omitted fields.
      await updateCatalogProduct(existing.id, {
        ...existing,
        name: String(values.name || '').trim(),
        sku: String(values.sku || '').trim(),
        barcode: values.barcode || null,
        category: values.category || existing.category,
        pricingMode: values.pricingMode || existing.pricingMode || 'pc',
        price: Number(values.price),
        budgetPrice:
          values.budgetPrice === '' || values.budgetPrice == null
            ? null
            : Number(values.budgetPrice),
        menuKind: values.menuKind || existing.menuKind || null,
        discountEligible: values.discountEligible === true,
      })
      // Same cascade as saveEditor — otherwise re-import would only fix catalog_products
      // and leave already-adopted branch shelves on the old price/name.
      if ((values.discountEligible === true) !== (existing.discountEligible === true)) {
        await cascadeDiscountEligibleToBranches(
          existing.id,
          values.discountEligible === true,
          existing.sku,
        )
      }
      const identityOrPriceChanged =
        String(values.name || '').trim() !== String(existing.name || '').trim() ||
        String(values.sku || '').trim() !== String(existing.sku || '').trim() ||
        String(values.barcode || '') !== String(existing.barcode || '') ||
        String(values.category || '') !== String(existing.category || '') ||
        Number(values.price) !== Number(existing.price) ||
        String(values.budgetPrice ?? '') !== String(existing.budgetPrice ?? '')
      if (identityOrPriceChanged) {
        await cascadeCatalogFieldsToBranches(
          existing.id,
          {
            name: String(values.name || '').trim(),
            sku: String(values.sku || '').trim(),
            barcode: values.barcode || null,
            category: values.category || existing.category,
            price: Number(values.price),
            budgetPrice:
              values.budgetPrice === '' || values.budgetPrice == null
                ? null
                : Number(values.budgetPrice),
          },
          { matchSku: existing.sku, staffId },
        )
      }
      updated += 1
    } else {
      await createCatalogProduct(payload, categoryIds)
      created += 1
    }
    onProgress?.(i + 1, total)
  }
  return { created, updated }
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
  const isRestaurant = isRestaurantBranchType(branchType)
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

/**
 * Hide (or restore) a product from POS/Inventory/low-stock without deleting it.
 *
 * `transaction_items.product_id` is `ON DELETE RESTRICT`, so a real DELETE already fails
 * for anything ever sold — this is the only working "remove" for a product with sales
 * history. Every product fetch already filters `is_active = true` (fetchBranchProducts,
 * bootstrapPosCatalog, bootstrapBranchData), so deactivating alone drops it from POS, the
 * dashboard, and the low-stock count — nothing else needs to change to stop it being
 * "logged and notified" as low stock.
 */
export async function setProductActive(productId, isActive) {
  const { data, error } = await supabase
    .from('products')
    .update({ is_active: Boolean(isActive) })
    .eq('id', productId)
    .select('*, categories(name)')
    .single()
  if (error) throw error
  return data
}

/**
 * Permanently remove a product row — for a product that should never have existed in this
 * branch (accidental import), not for one that just stopped selling (use setProductActive
 * for that; it's reversible, this isn't). `transaction_items`, `promo_rule_products`, and
 * `import_batch_items` all reference products with `ON DELETE RESTRICT`, so this fails with
 * Postgres 23503 the moment the product has any real history — callers should catch that and
 * point the user at archiving instead.
 */
export async function deleteProduct(productId) {
  const { error } = await supabase.from('products').delete().eq('id', productId)
  if (error) {
    if (error.code === '23503') throw appError('INV07', error.message)
    throw error
  }
}

/** Products hidden via setProductActive, for the "Not selling" view + reactivate. */
export async function fetchInactiveBranchProducts(branchId) {
  const [productsRes, inventoryRes] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from('products')
        .select(BOOTSTRAP_PRODUCT_COLS)
        .eq('branch_id', branchId)
        .eq('is_active', false)
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
