import { supabase } from '../supabase'
import { normalizeMenuKind } from '../../utils/ulam'
import { writeProductRow, toDbPricing, resolveCategoryIds } from './shared.js'
import { recordPriceChange } from './catalog.js'

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
    .select('*, staff!staff_id(full_name), branches(name), requester:staff!revert_requested_by(full_name)')
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
  // created_count/updated_count start at 0, not the preview's guess — the preview only
  // knows what it INTENDS to do before a single row is written. Filling them in from the
  // preview here used to mean a batch that failed on row 1 still sat in Recent Imports
  // claiming full success, because this insert happens before the loop below runs at all.
  // See the `finally` block: the real counts get written once we know what actually
  // happened, whether the loop finishes clean or throws partway through.
  const { data: batch, error: batchError } = await supabase
    .from('import_batches')
    .insert({
      branch_id: branchId,
      staff_id: staffId,
      filename,
      file_hash: fileHash,
      row_count: preview.rowCount,
      created_count: 0,
      updated_count: 0,
      skipped_count: preview.skippedCount,
      status: 'committed',
    })
    .select('*')
    .single()
  if (batchError) throw batchError

  const itemRows = []
  const total = preview.lines.length || 1
  let actualCreated = 0
  let actualUpdated = 0

  // Resolve every category the file references in one query, before the loop.
  const categoryIds = await resolveCategoryIds((preview.lines || []).map((l) => l.values?.category))

  try {
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
      let action = line.action
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

      if (action === 'create') {
        let product
        try {
          product = await writeProductRow('insert', {
            branch_id: branchId,
            is_active: true,
            ...productPayload,
          })
        } catch (err) {
          // The preview classifies create-vs-update against the caller's local product
          // list, which only ever holds ACTIVE rows (every fetch filters is_active=true —
          // see setProductActive). A SKU that was deactivated ("Not selling") still
          // physically holds the UNIQUE(branch_id, sku) slot, so this insert collides
          // even though the preview called it a "create". Reimporting the SKU is the
          // user asking for it back — reactivate and update the existing row instead of
          // failing the entire batch over one already-existing SKU.
          if (err?.code !== '23505') throw err
          const { data: existing } = await supabase
            .from('products')
            .select('id')
            .eq('branch_id', branchId)
            .eq('sku', values.sku)
            .maybeSingle()
          if (!existing) throw err
          product = await writeProductRow(
            'update',
            { ...productPayload, is_active: true },
            { id: existing.id },
          )
          action = 'update'
        }
        productId = product.id
        if (action === 'create' && !restaurant) {
          await supabase.from('branch_inventory').upsert({
            branch_id: branchId,
            product_id: productId,
            quantity_on_hand: 0,
          })
        }
      } else if (action !== 'restock') {
        await writeProductRow('update', { ...productPayload, is_active: true }, { id: productId })
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
      // action === 'restock' (branch Inventory import matching an existing product): only
      // the on-hand quantity changes, via record_stock_movement below. Name/SKU/barcode/
      // category/price/pricingMode/discountEligible on the sheet are ignored so a restock
      // file can never silently overwrite product identity or pricing — that's Catalog
      // import's or Products.jsx's job, not a plain restock.

      if (action === 'create') actualCreated += 1
      else actualUpdated += 1

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
        action,
        quantity_added: restaurant ? 0 : line.quantityAdded,
        name: values.name,
        sku: values.sku,
        barcode: barcode || '',
      })
      onProgress?.(index + 1, total, values.name)
    }
  } finally {
    // Runs whether the loop finished clean or threw partway through, so Recent Imports
    // and Undo always reflect rows actually written — never the pre-loop guess.
    if (itemRows.length) {
      await supabase.from('import_batch_items').insert(itemRows)
    }
    await supabase
      .from('import_batches')
      .update({ created_count: actualCreated, updated_count: actualUpdated })
      .eq('id', batch.id)
  }

  return { ...batch, created_count: actualCreated, updated_count: actualUpdated }
}

export async function revertInventoryImport(batchId, staffId) {
  const { data, error } = await supabase.rpc('revert_import_batch', {
    p_batch_id: batchId,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/** Supervisor flags a committed import for a manager to revert — see requestImportRevert. */
export async function requestImportRevert(batchId, staffId) {
  const { data, error } = await supabase.rpc('request_import_revert', {
    p_batch_id: batchId,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}

/** Manager clears a revert request without reverting — batch goes back to 'committed'. */
export async function dismissImportRevertRequest(batchId, staffId) {
  const { data, error } = await supabase.rpc('dismiss_import_revert_request', {
    p_batch_id: batchId,
    p_staff_id: staffId,
  })
  if (error) throw error
  return data
}
