import { categoryForMenuKind, normalizeMenuKind } from './ulam'

/**
 * Guard a spreadsheet before it is parsed.
 *
 * xlsx parses entirely in the browser tab that the till runs in, so a large or malformed
 * file does not fail politely — it blocks the main thread and freezes the POS. Checking
 * the extension and the size first is cheap and turns a hang into a message.
 *
 * Size cap is deliberately generous: a 10MB sheet is roughly 100k catalogue rows, far past
 * anything a branch imports, while still small enough to parse without stalling.
 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024
const ALLOWED_IMPORT_EXT = ['.csv', '.xlsx', '.xls']

export function validateImportFile(file) {
  if (!file) return { ok: false, message: 'No file selected.' }

  const name = String(file.name || '').toLowerCase()
  if (!ALLOWED_IMPORT_EXT.some((ext) => name.endsWith(ext))) {
    return {
      ok: false,
      message: `Unsupported file type. Use ${ALLOWED_IMPORT_EXT.join(', ')}.`,
    }
  }
  if (file.size === 0) {
    return { ok: false, message: 'That file is empty.' }
  }
  if (file.size > MAX_IMPORT_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1)
    return {
      ok: false,
      message: `File is ${mb}MB — the limit is ${MAX_IMPORT_BYTES / 1024 / 1024}MB. Split it into smaller files.`,
    }
  }
  return { ok: true, message: '' }
}


export async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Lowercase / trim sheet headers so Name/SKU/etc. still match. */
export function normalizeSheetRows(rawRows) {
  return (rawRows || []).map((row) => {
    const next = {}
    Object.entries(row || {}).forEach(([key, value]) => {
      const k = String(key || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
      if (!k) return
      // map common aliases
      if (k === 'regularprice') next.price = value
      else if (k === 'pricingmode' || k === 'mode') next.pricingMode = value
      else if (k === 'menukind') next.menuKind = value
      else if (k === 'budgetprice') next.budgetPrice = value
      else if (k === 'lowstockat' || k === 'lowstock') next.lowStockAt = value
      else if (k === 'availabletoday') next.availableToday = value
      else if (
        k === 'discounteligible' ||
        k === 'discountable' ||
        k === 'discount' ||
        k === 'pwddiscount' ||
        k === 'seniordiscount'
      ) {
        next.discountEligible = value
      }
      else next[k] = value
    })
    return next
  })
}

/**
 * Reject files that don't include required columns.
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateImportHeaders(rawRows, { restaurant = false, mode = 'inventory' } = {}) {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return {
      ok: false,
      message: 'This file has no data rows. Check the import guide for the required format.',
    }
  }
  const sample = normalizeSheetRows([rawRows[0]])[0] || {}
  const keys = new Set(Object.keys(sample))
  const required =
    mode === 'catalog'
      ? restaurant
        ? ['name', 'sku', 'price', 'category', 'discountEligible']
        : ['name', 'sku', 'barcode', 'price', 'category', 'pricingMode', 'discountEligible']
      : restaurant
        ? ['name', 'sku', 'price', 'category', 'discountEligible']
        : ['name', 'sku', 'barcode', 'price', 'stock', 'category', 'pricingMode', 'discountEligible']

  const missing = required.filter((col) => !keys.has(col))
  if (missing.length) {
    const stockHint =
      mode === 'catalog'
        ? ' Network catalog does not use stock — set stock later on branch Inventory.'
        : ''
    return {
      ok: false,
      message: `This file does not follow the required format. Missing column(s): ${missing.join(
        ', ',
      )}.${stockHint} See the import guide.`,
    }
  }

  // Network catalog is a shared template with no on-hand quantity of its own — a stock
  // column here used to be silently accepted and discarded (buildCatalogImportPreview
  // forces it to 0), which let a branch-inventory file through looking like it worked.
  // Reject it outright instead so the mistake is caught before import, not after.
  if (mode === 'catalog' && keys.has('stock')) {
    return {
      ok: false,
      message:
        'This file has a stock column — network catalog import does not accept stock. Remove it, or use branch Inventory import to restock instead.',
    }
  }

  return { ok: true }
}

function parseBoolFlag(value, { defaultValue = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue
  const v = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'eligible'].includes(v)) return true
  if (['0', 'false', 'no', 'n'].includes(v)) return false
  return null
}

export function normalizeImportRow(raw, { restaurant = false } = {}) {
  const name = String(raw.name || '').trim().replace(/[<>]/g, '')
  const sku = String(raw.sku || '').trim().replace(/[<>]/g, '')
  const barcode = String(raw.barcode || '').replace(/\D/g, '')
  const categoryRaw = String(raw.category || '').trim()
  const menuKind = restaurant
    ? normalizeMenuKind(raw.menuKind || raw.menu_kind, categoryRaw || 'Meat')
    : null
  const category = restaurant
    ? categoryForMenuKind(menuKind, categoryRaw || 'Meat')
    : categoryRaw
  const modeRaw = String(raw.pricingMode || raw.pricing_mode || '')
    .trim()
    .toLowerCase()
  let pricingMode = null
  if (restaurant) {
    pricingMode = 'pc'
  } else if (modeRaw === 'kg' || modeRaw === 'per_kg') {
    pricingMode = 'kg'
  } else if (modeRaw === 'pc' || modeRaw === 'per_unit' || modeRaw === 'unit') {
    pricingMode = 'pc'
  }
  const price = Number(raw.price ?? raw.regular_price ?? raw.regularPrice ?? 0)
  const budgetRaw = raw.budgetPrice ?? raw.budget_price
  const budgetPrice =
    restaurant && budgetRaw !== undefined && budgetRaw !== null && String(budgetRaw).trim() !== ''
      ? Number(budgetRaw)
      : null
  const stock = restaurant ? 0 : Number(raw.stock || 0)
  const lowStockAt = Number(raw.lowStockAt || 5)
  const availableToday =
    raw.availableToday === false ||
    raw.available_today === false ||
    String(raw.availableToday || raw.available_today || 'true').toLowerCase() === 'false'
      ? false
      : true
  const discountEligible = parseBoolFlag(raw.discountEligible ?? raw.discountable ?? raw.discount, {
    defaultValue: false,
  })
  return {
    name,
    sku,
    barcode,
    category,
    menuKind,
    pricingMode,
    price,
    budgetPrice: budgetPrice != null && !Number.isNaN(budgetPrice) ? budgetPrice : null,
    stock,
    lowStockAt,
    availableToday,
    discountEligible,
  }
}

function validateRetailImportFields(values, { restaurant = false } = {}) {
  if (!values.category) {
    return 'Missing category'
  }
  if (!restaurant) {
    if (!values.pricingMode) {
      return 'pricingMode must be pc or kg'
    }
  }
  if (values.discountEligible == null) {
    return 'discountEligible must be true or false'
  }
  return null
}

export function buildImportPreview(rawRows, existingProducts, { restaurant = false } = {}) {
  const seen = new Set()
  const creates = []
  const updates = []
  const skipped = []

  rawRows.forEach((raw, index) => {
    const values = normalizeImportRow(raw, { restaurant })
    if (!values.name || !values.sku) {
      skipped.push({ index, reason: 'Missing name or SKU', values })
      return
    }
    if (!restaurant && !values.barcode) {
      skipped.push({ index, reason: 'Missing barcode', values })
      return
    }
    const fieldErr = validateRetailImportFields(values, { restaurant })
    if (fieldErr) {
      skipped.push({ index, reason: fieldErr, values })
      return
    }
    if (Number.isNaN(values.price) || values.price < 0) {
      skipped.push({ index, reason: 'Invalid price', values })
      return
    }
    if (
      restaurant &&
      values.budgetPrice != null &&
      (Number.isNaN(values.budgetPrice) || values.budgetPrice < 0)
    ) {
      skipped.push({ index, reason: 'Invalid budget price', values })
      return
    }
    if (!restaurant && Number.isNaN(values.stock)) {
      skipped.push({ index, reason: 'Invalid stock', values })
      return
    }

    const key = values.barcode
      ? `${values.sku.toLowerCase()}|${values.barcode}`
      : values.sku.toLowerCase()
    if (seen.has(key)) {
      skipped.push({ index, reason: 'Duplicate row in file', values })
      return
    }
    seen.add(key)

    const existing = existingProducts.find(
      (item) =>
        item.sku.toLowerCase() === values.sku.toLowerCase() ||
        (values.barcode && String(item.barcode) === values.barcode),
    )

    if (existing) {
      const nextStock = restaurant
        ? Number(existing.stock || 0)
        : Number((Number(existing.stock) + values.stock).toFixed(2))
      updates.push(
        attachImportChanges(
          {
            index,
            action: restaurant ? 'update' : 'restock',
            values,
            existing,
            quantityAdded: restaurant ? 0 : values.stock,
            currentStock: Number(existing.stock),
            nextStock,
          },
          {
            restaurant,
            restockOnly: !restaurant,
            stockDelta: restaurant
              ? null
              : { current: Number(existing.stock), next: nextStock, added: values.stock },
          },
        ),
      )
    } else {
      creates.push({
        index,
        action: 'create',
        values,
        quantityAdded: restaurant ? 0 : values.stock,
        currentStock: 0,
        nextStock: restaurant ? 0 : values.stock,
      })
    }
  })

  return {
    creates,
    updates,
    skipped,
    rowCount: rawRows.length,
    createCount: creates.length,
    updateCount: updates.length,
    skippedCount: skipped.length,
    lines: [...creates, ...updates],
  }
}

/**
 * Manager network-catalog import.
 * Creates new catalog rows; updates existing when SKU (or barcode) already matches —
 * so a manager can export/edit/re-import for bulk price or identity changes. Unchanged
 * rows and invalid/duplicate-in-file rows are skipped.
 */
export function buildCatalogImportPreview(rawRows, existingCatalog, { restaurant = false } = {}) {
  const seen = new Set()
  const creates = []
  const updates = []
  const skipped = []

  rawRows.forEach((raw, index) => {
    const values = normalizeImportRow(raw, { restaurant })
    // Network catalog never stores on-hand stock (branch Inventory does)
    values.stock = 0
    delete values.quantityAdded

    if (!values.name || !values.sku) {
      skipped.push({ index, reason: 'Missing name or SKU', values, action: 'skip' })
      return
    }
    if (!restaurant && !values.barcode) {
      skipped.push({ index, reason: 'Missing barcode', values, action: 'skip' })
      return
    }
    const fieldErr = validateRetailImportFields(values, { restaurant })
    if (fieldErr) {
      skipped.push({ index, reason: fieldErr, values, action: 'skip' })
      return
    }
    if (Number.isNaN(values.price) || values.price < 0) {
      skipped.push({ index, reason: 'Invalid price', values, action: 'skip' })
      return
    }
    if (
      restaurant &&
      values.budgetPrice != null &&
      (Number.isNaN(values.budgetPrice) || values.budgetPrice < 0)
    ) {
      skipped.push({ index, reason: 'Invalid budget price', values, action: 'skip' })
      return
    }

    const key = values.sku.toLowerCase()
    if (seen.has(key)) {
      skipped.push({ index, reason: 'Duplicate SKU in file', values, action: 'skip' })
      return
    }
    seen.add(key)

    const existing = existingCatalog.find(
      (item) =>
        String(item.sku || '').toLowerCase() === key ||
        (values.barcode && String(item.barcode || '') === values.barcode),
    )
    if (existing) {
      if (!catalogImportRowChanged(existing, values, { restaurant })) {
        skipped.push({
          index,
          reason: 'No changes',
          values,
          action: 'skip',
          existing,
        })
        return
      }
      updates.push(
        attachImportChanges(
          {
            index,
            action: 'update',
            values,
            existing,
          },
          { restaurant },
        ),
      )
      return
    }

    creates.push({
      index,
      action: 'create',
      values,
    })
  })

  return {
    creates,
    updates,
    skipped,
    rowCount: rawRows.length,
    createCount: creates.length,
    updateCount: updates.length,
    skippedCount: skipped.length,
    lines: [...creates, ...updates],
    restaurant,
  }
}

/** True when the import row differs from the live catalog item on any editable field. */
function catalogImportRowChanged(existing, values, { restaurant = false } = {}) {
  return describeImportFieldChanges(existing, values, { restaurant }).length > 0
}

/**
 * Human-readable field diffs for bulk-import preview (catalog + branch inventory).
 * Returns [{ field, label, from, to, format?, note? }] — UI formats money/qty.
 */
export function describeImportFieldChanges(
  existing,
  values,
  { restaurant = false, stockDelta = null, restockOnly = false } = {},
) {
  if (!existing || !values) return []
  const changes = []

  const push = (field, label, prev, next, { format = 'text' } = {}) => {
    if (format === 'bool') {
      const p = prev === true
      const n = next === true
      if (p === n) return
      changes.push({ field, label, from: p, to: n, format: 'bool' })
      return
    }
    const p = prev ?? ''
    const n = next ?? ''
    if (String(p).trim() === String(n).trim()) return
    if (typeof prev === 'number' && typeof next === 'number' && prev === next) return
    changes.push({ field, label, from: prev, to: next, format })
  }

  // Branch Inventory import only ever restocks quantity on an existing product — name,
  // barcode, price, category, etc. on the sheet are never written (see commitInventoryImport).
  // Showing those as pending "changes" here would be a preview that doesn't match what
  // commit actually does, so skip straight to the stock delta below.
  if (!restockOnly) {
    push('name', 'Name', existing.name, values.name)
    push('sku', 'SKU', existing.sku, values.sku)
    push('barcode', 'Barcode', existing.barcode || '', values.barcode || '')
    push('category', 'Category', existing.category, values.category)
    push('price', 'Price', Number(existing.price), Number(values.price), { format: 'money' })
    push('discountEligible', 'Discountable', existing.discountEligible === true, values.discountEligible === true, {
      format: 'bool',
    })

    if (!restaurant) {
      push('pricingMode', 'Pricing mode', existing.pricingMode || 'pc', values.pricingMode || 'pc')
    }
    if (restaurant) {
      const prevBudget = existing.budgetPrice == null ? null : Number(existing.budgetPrice)
      const nextBudget =
        values.budgetPrice == null || values.budgetPrice === '' ? null : Number(values.budgetPrice)
      if (prevBudget !== nextBudget) {
        changes.push({
          field: 'budgetPrice',
          label: 'Budget price',
          from: prevBudget,
          to: nextBudget,
          format: 'money',
        })
      }
      push('menuKind', 'Menu kind', existing.menuKind || '', values.menuKind || '')
    }
  }

  if (stockDelta && Number(stockDelta.added) > 0) {
    changes.push({
      field: 'stock',
      label: 'Stock',
      from: Number(stockDelta.current),
      to: Number(stockDelta.next),
      format: 'qty',
      note: `+${stockDelta.added} restock`,
    })
  }

  return changes
}

function attachImportChanges(line, { restaurant = false, stockDelta = null, restockOnly = false } = {}) {
  if (!line.existing) return line
  return {
    ...line,
    changes: describeImportFieldChanges(line.existing, line.values, { restaurant, stockDelta, restockOnly }),
  }
}
