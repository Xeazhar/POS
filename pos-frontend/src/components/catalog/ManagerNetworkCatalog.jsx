import { useEffect, useMemo, useState } from 'react'
import {
  FiDownload,
  FiEdit2,
  FiMoreHorizontal,
  FiPlus,
  FiRefreshCw,
  FiSearch,
  FiUpload,
  FiX,
} from 'react-icons/fi'
import {
  ErrorBanner,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  Pager,
  PrimaryButton,
  SearchBox,
  SecondaryButton,
  SelectField,
  StatusOverlay,
  SkeletonRows,
  TableCard,
  tableHeadClass,
  tableRowClass,
} from '../ui'
import {
  cascadeCatalogFieldsToBranches,
  cascadeDiscountEligibleToBranches,
  resyncDiscountEligibleToBranches,
  commitCatalogImport,
  createCatalogProduct,
  fetchCatalogProducts,
  hasSupabase,
  updateCatalogProduct,
} from '../../lib/api'
import { isOnline, readCatalogCache, writeCatalogCache } from '../../offline'
import { RESTAURANT_FEATURES_ENABLED } from '../../utils/features'
import { withTimeout } from '../../utils/withTimeout'
import { useAuthStore } from '../../stores/posStore'
import {
  buildCatalogImportPreview,
  normalizeSheetRows,
  sha256Hex,
  validateImportFile,
  validateImportHeaders,
} from '../../utils/inventoryImport'
import { money } from '../../utils/format'
import { formatSupportError } from '../../utils/errors'
import ImportPreviewLines from '../shared/ImportPreviewLines'
import { categoryForMenuKind, hasBudgetTier, MENU_KINDS } from '../../utils/ulam'
import { decimalOnly, digitsOnly, sanitizeText } from '../../utils/validate'

import { readSpreadsheetBuffer, loadXlsx } from '../../lib/xlsxLoader'

const PAGE_SIZE = 12

const CATEGORY_CHOICES = {
  retail: ['Groceries', 'Bakery', 'Meat'],
  restaurant: ['Meat', 'Veggie', 'Pancit', 'Drink', 'Rice', 'Extra'],
}

const emptyForm = (branchType = 'retail') => ({
  name: '',
  sku: '',
  barcode: '',
  category: branchType === 'restaurant' ? 'Meat' : 'Groceries',
  menuKind: 'meat',
  pricingMode: 'pc',
  price: '',
  budgetPrice: '',
  discountEligible: false,
})

/**
 * Manage the shared network product catalog that branches can adopt.
 *
 * Supports adding, importing, exporting, filtering, editing, and synchronizing
 * retail and restaurant catalog items.
 */
export default function ManagerNetworkCatalog() {
  const user = useAuthStore((state) => state.user)
  const [branchType, setBranchType] = useState('retail')
  const [catalog, setCatalog] = useState([])
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [modeFilter, setModeFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(() => emptyForm('retail'))
  const [formError, setFormError] = useState('')

  // false = normal browsing (no checkboxes). Checkboxes only exist in bulk mode so the
  // table stays clean the rest of the time.
  const [bulkMode, setBulkMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState([])
  const [bulkProgress, setBulkProgress] = useState(null)
  // One editor for one row or many. `drafts` is keyed by catalog id and holds every
  // editable field, not just price — a per-field modal per field does not scale past two.
  const [editorIds, setEditorIds] = useState(null) // null = closed
  const [drafts, setDrafts] = useState({})
  const [rowMenuId, setRowMenuId] = useState(null)
  const [discountFilter, setDiscountFilter] = useState('all')
  const [resyncNote, setResyncNote] = useState('')
  const [barcodeFilter, setBarcodeFilter] = useState('all')

  const [preview, setPreview] = useState(null)
  const [importProgress, setImportProgress] = useState(null)
  const [loading, setLoading] = useState(true)

  const isRestaurant = RESTAURANT_FEATURES_ENABLED && branchType === 'restaurant'

  const reload = async () => {
    if (!hasSupabase) {
      setCatalog([])
      setLoading(false)
      return
    }
    if (!isOnline()) {
      setCatalog((await readCatalogCache(branchType)) || [])
      setLoading(false)
      return
    }
    try {
      const rows = await withTimeout(fetchCatalogProducts({ branchType }), 15000, 'Network catalog')
      setCatalog(rows)
      await writeCatalogCache(branchType, rows || [])
    } catch {
      setCatalog((await readCatalogCache(branchType)) || [])
    }
    setLoading(false)
  }

  useEffect(() => {
    setLoading(true)
    reload().catch((err) => {
      setError(err.message)
      setLoading(false)
    })
  }, [branchType])

  useEffect(() => {
    setPage(0)
    setCategoryFilter('All')
    setModeFilter('all')
    setDiscountFilter('all')
    setBarcodeFilter('all')
    setPreview(null)
  }, [branchType])

  useEffect(() => {
    setPage(0)
  }, [query, categoryFilter, modeFilter, discountFilter, barcodeFilter])

  const categories = useMemo(
    () => [...new Set(catalog.map((p) => p.category).filter(Boolean))].sort(),
    [catalog],
  )

  // Fixed choices for the given catalog type, plus any legacy category already in use
  // (e.g. from old imports) so an existing item never loses its current value.
  const categoryOptions = useMemo(
    () => [...new Set([...CATEGORY_CHOICES[isRestaurant ? 'restaurant' : 'retail'], ...categories])],
    [categories, isRestaurant],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return catalog.filter((row) => {
      if (q) {
        const hay = `${row.name} ${row.sku} ${row.barcode || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (categoryFilter !== 'All' && row.category !== categoryFilter) return false
      if (!isRestaurant && modeFilter !== 'all' && row.pricingMode !== modeFilter) return false
      if (discountFilter === 'yes' && row.discountEligible !== true) return false
      if (discountFilter === 'no' && row.discountEligible === true) return false
      if (barcodeFilter === 'missing' && String(row.barcode || '').trim()) return false
      if (barcodeFilter === 'has' && !String(row.barcode || '').trim()) return false
      return true
    })
  }, [catalog, query, categoryFilter, modeFilter, discountFilter, barcodeFilter, isRestaurant])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  const openAdd = () => {
    setFormError('')
    setForm(emptyForm(branchType))
    setShowAdd(true)
  }

  const setField = (key, value) => {
    let next = value
    if (key === 'barcode') next = digitsOnly(value)
    else if (key === 'price' || key === 'budgetPrice') next = decimalOnly(value)
    else if (key === 'name' || key === 'sku') next = value.replace(/[<>]/g, '')
    setForm((prev) => ({ ...prev, [key]: next }))
    setFormError('')
  }

  const onFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    setPreview(null)
    // Checked before the file is read — see InventoryImportPanel. xlsx parsing blocks the
    // main thread, so an oversized or mistyped file must be refused up front.
    const fileCheck = validateImportFile(file)
    if (!fileCheck.ok) {
      setError(fileCheck.message)
      return
    }
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      await sha256Hex(buf)
      const wb = await readSpreadsheetBuffer(buf)
      const XLSX = await loadXlsx()
      const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' })
      const format = validateImportHeaders(rawRows, { restaurant: isRestaurant, mode: 'catalog' })
      if (!format.ok) {
        setError(format.message)
        return
      }
      const rows = normalizeSheetRows(rawRows)
      const built = buildCatalogImportPreview(rows, catalog, { restaurant: isRestaurant })
      setPreview({ ...built, filename: file.name, restaurant: isRestaurant })
    } catch (err) {
      setError(formatSupportError(err, 'CAT05'))
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const commitImport = async () => {
    if (!preview?.lines?.length) {
      setError('Nothing to import — all rows were skipped or the file is empty.')
      return
    }
    setBusy(true)
    setError('')
    setImportProgress({ done: 0, total: preview.lines.length })
    try {
      await commitCatalogImport({
        preview,
        branchType,
        staffId: user?.id || null,
        onProgress: (done, total) => setImportProgress({ done, total }),
      })
      setPreview(null)
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'CAT06'))
    } finally {
      setBusy(false)
      setImportProgress(null)
    }
  }

  /** Download the live catalog as CSV so a manager can edit prices/fields and re-import. */
  const exportCatalog = async () => {
    if (!catalog.length) {
      setError('Nothing to export — this catalog type is empty.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const XLSX = await loadXlsx()
      const rows = isRestaurant
        ? catalog.map((row) => ({
            name: row.name,
            sku: row.sku,
            barcode: row.barcode || '',
            category: row.category || '',
            price: row.price,
            budgetPrice: row.budgetPrice ?? '',
            menuKind: row.menuKind || '',
            discountEligible: row.discountEligible === true,
          }))
        : catalog.map((row) => ({
            name: row.name,
            sku: row.sku,
            barcode: row.barcode || '',
            category: row.category || '',
            pricingMode: row.pricingMode || 'pc',
            price: row.price,
            discountEligible: row.discountEligible === true,
            lowStockAt: row.lowStockAt ?? 10,
          }))
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Catalog')
      XLSX.writeFile(
        book,
        `network-catalog-${isRestaurant ? 'restaurant' : 'retail'}.csv`,
      )
    } catch (err) {
      setError(formatSupportError(err, 'CAT05'))
    } finally {
      setBusy(false)
    }
  }

  const saveNew = async () => {
    const name = sanitizeText(form.name)
    const sku = sanitizeText(form.sku)
    const barcode = digitsOnly(form.barcode)
    if (!name || !sku) {
      setFormError('Name and SKU are required.')
      return
    }
    if (!isRestaurant && !barcode) {
      setFormError('Name, SKU, and barcode are required for retail goods.')
      return
    }
    if (form.price === '' || Number(form.price) < 0) {
      setFormError('Enter a valid price.')
      return
    }
    if (
      isRestaurant &&
      form.budgetPrice !== '' &&
      (Number.isNaN(Number(form.budgetPrice)) || Number(form.budgetPrice) < 0)
    ) {
      setFormError('Enter a valid budget price (or leave blank).')
      return
    }
    const skuKey = sku.toLowerCase()
    if (catalog.some((row) => String(row.sku || '').toLowerCase() === skuKey)) {
      setFormError('That SKU already exists in the network catalog.')
      return
    }

    const menuKind = isRestaurant ? form.menuKind : null
    setBusy(true)
    setFormError('')
    setError('')
    try {
      await createCatalogProduct({
        name,
        sku,
        barcode: barcode || null,
        category: isRestaurant ? categoryForMenuKind(menuKind, form.category) : form.category,
        menuKind,
        pricingMode: isRestaurant ? 'pc' : form.pricingMode,
        price: Number(form.price),
        budgetPrice:
          isRestaurant && hasBudgetTier(menuKind) && form.budgetPrice !== ''
            ? Number(form.budgetPrice)
            : null,
        discountEligible: form.discountEligible === true,
        branchType,
        lowStockAt: 10,
      })
      setShowAdd(false)
      setForm(emptyForm(branchType))
      await reload()
    } catch (err) {
      setFormError(formatSupportError(err, 'CAT02'))
    } finally {
      setBusy(false)
    }
  }

  /** Seed the editor with the rows' current values, so it opens showing today's data. */
  const openEditor = (ids) => {
    const rows = catalog.filter((row) => ids.includes(row.id))
    if (!rows.length) return
    const next = {}
    for (const row of rows) {
      next[row.id] = {
        name: row.name || '',
        sku: row.sku || '',
        barcode: row.barcode || '',
        category: row.category || '',
        price: String(row.price ?? ''),
        budgetPrice: row.budgetPrice != null ? String(row.budgetPrice) : '',
        discountEligible: row.discountEligible === true,
      }
    }
    setDrafts(next)
    setEditorIds(ids)
    setRowMenuId(null)
    setError('')
  }

  const setDraft = (id, key, value) => {
    let next = value
    if (key === 'barcode') next = digitsOnly(value)
    else if (key === 'price' || key === 'budgetPrice') next = decimalOnly(value)
    else if (typeof value === 'string') next = value.replace(/[<>]/g, '')
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [key]: next } }))
    setError('')
  }

  /** Apply one field's value to every row in the editor — the point of bulk editing. */
  const applyToAll = (key, value) => {
    setDrafts((prev) => {
      const next = {}
      for (const id of Object.keys(prev)) next[id] = { ...prev[id], [key]: value }
      return next
    })
  }

  /**
   * Save the editor.
   *
   * Sequential, not Promise.all: a Discountable change fans out to a second UPDATE per
   * item (the branch cascade), and a burst of those against Supabase is a good way to get
   * rate-limited halfway through and leave the catalog half-flipped. Progress is surfaced
   * so a long run doesn't look hung.
   *
   * Only rows that actually changed are written, so opening the editor and saving without
   * edits costs nothing. `updateCatalogProduct` replaces the whole row, so each call is
   * given the full record merged with the draft — a partial payload would blank the
   * fields it omitted.
   */
  const saveEditor = async () => {
    const ids = editorIds || []
    const changed = []
    for (const row of catalog) {
      if (!ids.includes(row.id)) continue
      const draft = drafts[row.id]
      if (!draft) continue
      if (!String(draft.name || '').trim()) {
        setError(`Name cannot be empty for ${row.name}.`)
        return
      }
      if (!String(draft.sku || '').trim()) {
        setError(`SKU cannot be empty for ${draft.name || row.name}.`)
        return
      }
      const price = Number(draft.price)
      if (draft.price === '' || !Number.isFinite(price) || price < 0) {
        setError(`Enter a valid price for ${draft.name || row.name}.`)
        return
      }
      const dirty =
        draft.name !== (row.name || '') ||
        draft.sku !== (row.sku || '') ||
        draft.barcode !== (row.barcode || '') ||
        draft.category !== (row.category || '') ||
        price !== Number(row.price) ||
        String(draft.budgetPrice) !== String(row.budgetPrice ?? '') ||
        draft.discountEligible !== (row.discountEligible === true)
      if (dirty) changed.push({ row, draft, price })
    }
    if (!changed.length) {
      setEditorIds(null)
      return
    }
    // Duplicate SKUs inside the catalog break adoption matching, so catch it before writing.
    const seen = new Map(
      catalog.filter((r) => !ids.includes(r.id)).map((r) => [String(r.sku || '').toLowerCase(), r.name]),
    )
    for (const { draft } of changed) {
      const key = String(draft.sku).toLowerCase()
      if (seen.has(key)) {
        setError(`SKU ${draft.sku} is already used by ${seen.get(key)}.`)
        return
      }
      seen.set(key, draft.name)
    }

    setBusy(true)
    setError('')
    try {
      for (let i = 0; i < changed.length; i += 1) {
        const { row, draft, price } = changed[i]
        setBulkProgress({ done: i, total: changed.length })
        await updateCatalogProduct(row.id, {
          ...row,
          name: draft.name.trim(),
          sku: draft.sku.trim(),
          barcode: draft.barcode || null,
          category: draft.category || row.category,
          price,
          budgetPrice: draft.budgetPrice === '' ? null : Number(draft.budgetPrice),
          discountEligible: draft.discountEligible === true,
        })
        // Every edit here also pushes to branches that already adopted the item — otherwise
        // this would only set the default for future adoptions, leaving an already-live
        // product's name/SKU/barcode/category/price stale everywhere (branch screens and
        // every report, which read products, never catalog_products). The old SKU (row.sku,
        // not the edited draft) is passed for the orphan-matching pass, since an unlinked
        // branch row still carries whatever SKU it had before this edit.
        if (draft.discountEligible !== (row.discountEligible === true)) {
          await cascadeDiscountEligibleToBranches(
            row.id,
            draft.discountEligible === true,
            row.sku,
          )
        }
        const identityOrPriceChanged =
          draft.name !== (row.name || '') ||
          draft.sku !== (row.sku || '') ||
          draft.barcode !== (row.barcode || '') ||
          draft.category !== (row.category || '') ||
          price !== Number(row.price) ||
          String(draft.budgetPrice) !== String(row.budgetPrice ?? '')
        if (identityOrPriceChanged) {
          await cascadeCatalogFieldsToBranches(
            row.id,
            {
              name: draft.name.trim(),
              sku: draft.sku.trim(),
              barcode: draft.barcode || null,
              category: draft.category || row.category,
              price,
              budgetPrice: draft.budgetPrice === '' ? null : Number(draft.budgetPrice),
            },
            { matchSku: row.sku, staffId: user?.id },
          )
        }
      }
      setEditorIds(null)
      setDrafts({})
      setSelectedIds([])
      setBulkMode(false)
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'CAT04'))
    } finally {
      setBulkProgress(null)
      setBusy(false)
    }
  }

  /**
   * Repair pass for items whose catalog flag never reached their branch rows (toggled
   * before the cascade existed, or while the row had no catalog link).
   */
  const resyncDiscountable = async () => {
    setBusy(true)
    setError('')
    try {
      const { enabled, disabled, unlinked } = await resyncDiscountEligibleToBranches()
      // Unlinked products are reported rather than guessed at. They are branch items with
      // no catalog link, so there is nothing to sync them against — saying so is honest,
      // where matching them by SKU would risk changing what a customer pays.
      const skipped = unlinked ? ` ${unlinked} branch item(s) are not linked to the catalog and were left alone.` : ''
      setResyncNote(
        enabled + disabled === 0
          ? `All linked branch products already match the catalog.${skipped}`
          : `Synced ${enabled + disabled} product(s) to branches (${enabled} on, ${disabled} off).${skipped}`,
      )
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'CAT07'))
    } finally {
      setBusy(false)
    }
  }

  const exitBulk = () => {
    setBulkMode(false)
    setSelectedIds([])
    setDrafts({})
    setEditorIds(null)
  }

  if (loading && !catalog.length) {
    return <PageSkeleton variant="table" />
  }

  return (
    <div>
      {importProgress && (
        <StatusOverlay
          title="Importing catalog"
          message={`${importProgress.done} / ${importProgress.total} items`}
        />
      )}

      <PageHeader eyebrow="MANAGER" title="Network catalog">
        <span className="text-xs text-brand-muted">
          Universal product list · branches adopt items from here
        </span>
      </PageHeader>

      <p className="mb-4 max-w-3xl text-xs text-brand-muted">
        Add retail / meat products to the shared catalog (manually or CSV import).
        To bulk-edit prices or fields, export the current catalog, edit the file, then import it
        back — matching SKUs update and cascade to adopted branches. Supervisors adopt new items
        onto their branch from Catalog.
      </p>

      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {RESTAURANT_FEATURES_ENABLED ? (
            <SelectField
              label="Catalog type"
              className="w-full min-w-0 sm:max-w-[220px]"
              value={branchType}
              onChange={(e) => setBranchType(e.target.value)}
            >
              <option value="retail">Retail goods</option>
              <option value="restaurant">Restaurant / potahe</option>
            </SelectField>
          ) : (
            <p className="text-xs font-bold text-brand-n700">Retail / meat catalog</p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton
              compact
              type="button"
              className="!h-8 !min-h-0 !gap-1 !px-2.5 !text-[11px]"
              disabled={busy}
              onClick={openAdd}
            >
              <FiPlus className="text-sm" /> Add item
            </PrimaryButton>
            <SecondaryButton
              compact
              type="button"
              className="!h-8 !min-h-0 !gap-1 !px-2.5 !text-[11px]"
              disabled={busy || !catalog.length}
              onClick={() => void exportCatalog()}
            >
              <FiDownload className="text-sm" /> Export
            </SecondaryButton>
            <label
              className={`inline-flex h-8 cursor-pointer items-center gap-1 rounded-[5px] border border-brand-border bg-brand-card px-2.5 text-[11px] font-bold text-brand-n800 ${
                busy ? 'pointer-events-none opacity-35' : ''
              }`}
            >
              <FiUpload className="text-sm" /> Import
              <input
                className="hidden"
                type="file"
                accept=".csv,.xlsx,.xls"
                disabled={busy}
                onChange={onFile}
              />
            </label>
          </div>
        </div>
        {error && <ErrorBanner className="mt-3 mb-0" error={error} onDismiss={() => setError('')} />}
      </TableCard>

      {preview && (
        <TableCard className="mb-4 max-h-none p-5">
          <h2 className="m-0 text-lg">Import preview</h2>
          <p className="mt-1 text-xs text-brand-muted">
            {preview.filename} · {preview.createCount} new · {preview.updateCount} update ·{' '}
            {preview.skippedCount} skipped — review updates below before confirming.
          </p>
          <ImportPreviewLines
            lines={preview.lines}
            creates={preview.creates}
            updates={preview.updates}
          />
          {(preview.skipped || []).length > 0 && (
            <div className="mt-4">
              <p className="m-0 mb-1 text-[11px] font-bold text-brand-warn">
                Skipped ({preview.skippedCount})
              </p>
              <div className="max-h-40 overflow-auto text-xs">
                {(preview.skipped || []).slice(0, 40).map((line, i) => (
                  <div
                    key={`s-${i}`}
                    className="border-t border-brand-softline py-1.5 text-brand-subtle first:border-t-0"
                  >
                    {line.values?.name || line.values?.sku || '—'} — {line.reason}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="mt-4 flex gap-2">
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={busy || !(preview.createCount + preview.updateCount)}
              onClick={commitImport}
            >
              {busy
                ? 'Importing…'
                : `Import ${preview.createCount} new, update ${preview.updateCount}`}
            </PrimaryButton>
          </div>
        </TableCard>
      )}

      

      <TableCard className="mb-4 max-h-none">
        <div className="flex flex-col gap-3 border-b border-brand-softline px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="m-0 text-base">
                {isRestaurant ? 'Restaurant catalog' : 'Retail catalog'}
              </h2>
              <p className="m-0 mt-1 text-[11px] text-brand-subtle">
                {filtered.length} shown · {catalog.length} total · this is the shared template new
                branches adopt from. Saving an edit here also pushes it to every branch that
                already adopted the item — use that branch's Catalog page instead if you only
                want to change one branch's copy.
              </p>
            </div>
           
          </div>
          {/* Bulk editing is opt-in: the checkbox column and the action bar only exist
              once it is switched on, so ordinary browsing stays uncluttered. One mode
              now, not one per field — the editor covers every field. */}
          {!bulkMode ? (
            <div className="flex flex-wrap items-center gap-2">
              <SecondaryButton compact type="button" onClick={() => setBulkMode(true)}>
                <FiEdit2 className="shrink-0" size={13} />
                Bulk edit
              </SecondaryButton>
              {/* Sync sits with the other catalog-wide tools instead of floating alone on
                  the far right, and says what it does rather than being a bare icon. */}
              <SecondaryButton
                compact
                type="button"
                disabled={busy}
                title="Push the catalog's Discountable setting down to branch products (price, name, SKU, etc. are not synced — edit those per-branch)"
                onClick={() => void resyncDiscountable()}
              >
                <FiRefreshCw className={`shrink-0 ${busy ? 'animate-spin' : ''}`} size={13} />
                {busy ? 'Syncing…' : 'Sync updates to branches'}
              </SecondaryButton>
              {resyncNote && (
                <span className="text-[11px] text-brand-subtle">{resyncNote}</span>
              )}
            </div>
          ) : (
            <div className="rounded-[8px] border border-brand-gold/50 bg-brand-gold/10 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  {/* The count is the thing that must be unmissable — a bulk action applied
                      to the wrong number of rows is the whole risk of this mode. */}
                  <span className="grid h-8 min-w-8 place-items-center rounded-[6px] bg-brand-dark px-2 text-sm font-bold text-brand-gold tabular-nums">
                    {selectedIds.length}
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-xs text-brand-ink">Bulk edit</strong>
                    <span className="block text-[10px] text-brand-n700">
                      {bulkProgress
                        ? `Saving ${bulkProgress.done + 1} of ${bulkProgress.total}…`
                        : selectedIds.length
                          ? `${selectedIds.length} selected`
                          : 'Tick the rows you want to change'}
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Select-all across the FILTERED set, not just the visible page — the
                      page checkbox already covers the page, and "all 240 matching" is the
                      thing someone actually wants after narrowing by category. */}
                  {selectedIds.length < filtered.length && (
                    <button
                      type="button"
                      className="border-0 bg-transparent text-[11px] font-bold text-brand-ink underline underline-offset-2 disabled:opacity-40"
                      disabled={busy}
                      onClick={() => setSelectedIds(filtered.map((r) => r.id))}
                    >
                      Select all {filtered.length}
                    </button>
                  )}
                  {selectedIds.length > 0 && (
                    <button
                      type="button"
                      className="border-0 bg-transparent text-[11px] font-bold text-brand-n700 underline underline-offset-2 disabled:opacity-40"
                      disabled={busy}
                      onClick={() => setSelectedIds([])}
                    >
                      Clear
                    </button>
                  )}
                  <PrimaryButton
                    compact
                    type="button"
                    disabled={busy || !selectedIds.length}
                    onClick={() => openEditor(selectedIds)}
                  >
                    Edit {selectedIds.length || ''} item{selectedIds.length === 1 ? '' : 's'}
                  </PrimaryButton>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border-0 bg-transparent text-brand-n700 hover:bg-brand-gold/20 hover:text-brand-ink disabled:opacity-40"
                    disabled={busy}
                    aria-label="Exit bulk edit"
                    onClick={exitBulk}
                  >
                    <FiX size={16} />
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* Labelled SearchBox matches SelectField height (label + h-10 input row). */}
          <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-6">
            <SearchBox
              label="Search"
              className="col-span-2 w-full"
              icon={<FiSearch />}
              placeholder="Search name"
              value={query}
              onChange={(e) => setQuery(e.target.value.replace(/[<>]/g, ''))}
            />
            <SelectField
              label="Category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="All">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </SelectField>
            {!isRestaurant && (
              <SelectField
                label="Pricing"
                value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value)}
              >
                <option value="all">All modes</option>
                <option value="pc">Per pc</option>
                <option value="kg">Per kg</option>
              </SelectField>
            )}
            <SelectField
              label="Discountable"
              value={discountFilter}
              onChange={(e) => setDiscountFilter(e.target.value)}
            >
              <option value="all">All items</option>
              <option value="yes">Discountable only</option>
              <option value="no">Not discountable</option>
            </SelectField>
            {!isRestaurant && (
              <SelectField
                label="Barcode"
                value={barcodeFilter}
                onChange={(e) => setBarcodeFilter(e.target.value)}
              >
                <option value="all">All items</option>
                <option value="has">Has barcode</option>
                <option value="missing">Missing barcode</option>
              </SelectField>
            )}
          </div>
        </div>

        <div className="overflow-auto">
          <table className="min-w-full text-left text-xs">
            <thead className={tableHeadClass}>
              <tr>
                {bulkMode && (
                  <th className="w-8 px-5 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={pageRows.length > 0 && pageRows.every((r) => selectedIds.includes(r.id))}
                      onChange={(e) => {
                        const next = new Set(selectedIds)
                        // Page-scoped, matching what the user can actually see and verify.
                        if (e.target.checked) pageRows.forEach((r) => next.add(r.id))
                        else pageRows.forEach((r) => next.delete(r.id))
                        setSelectedIds([...next])
                      }}
                    />
                  </th>
                )}
                <th className="px-5 py-3">Product</th>
                <th className="px-5 py-3">SKU</th>
                <th className="px-5 py-3 max-[700px]:hidden">Barcode</th>
                <th className="px-5 py-3 max-[700px]:hidden">Category</th>
                <th className="px-5 py-3 max-[700px]:hidden">{isRestaurant ? 'Kind' : 'Mode'}</th>
                <th className="px-5 py-3 text-center">Discountable</th>
                <th className="px-5 py-3 text-right">Price</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="p-0">
                    <SkeletonRows rows={8} cols={5} />
                  </td>
                </tr>
              ) : (
              pageRows.map((row) => (
                <tr key={row.id} className={tableRowClass}>
                  {bulkMode && (
                    <td className="px-5 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.name}`}
                        checked={selectedIds.includes(row.id)}
                        onChange={(e) => {
                          const next = new Set(selectedIds)
                          if (e.target.checked) next.add(row.id)
                          else next.delete(row.id)
                          setSelectedIds([...next])
                        }}
                      />
                    </td>
                  )}
                  <td className="px-5 py-3">
                    <strong className="block text-brand-ink">{row.name}</strong>
                  </td>
                  <td className="px-5 py-3">{row.sku}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{row.barcode || '—'}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{row.category || '—'}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">
                    {isRestaurant ? row.menuKind || '—' : row.pricingMode}
                  </td>
                  <td className="px-5 py-3 text-center">
                    <span
                      className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                        row.discountEligible
                          ? 'bg-brand-success-bg text-brand-success-text'
                          : 'bg-brand-n200 text-brand-subtle'
                      }`}
                    >
                      {row.discountEligible ? 'Yes' : 'No'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-bold text-brand-ink">
                    {money(row.price)}
                    {row.budgetPrice != null && (
                      <span className="mt-0.5 block text-[10px] font-normal text-brand-subtle">
                        Budget {money(row.budgetPrice)}
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {/* One "⋯" per row instead of a stack of per-field links — the row
                        editor covers every field, so a second link per field would just
                        be a second way into the same sheet. */}
                    <div className="relative inline-block text-left">
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-expanded={rowMenuId === row.id}
                        aria-label={`Actions for ${row.name}`}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-brand-border bg-brand-card text-brand-n700 hover:bg-brand-n50 active:bg-brand-n150"
                        onClick={() => setRowMenuId(rowMenuId === row.id ? null : row.id)}
                      >
                        <FiMoreHorizontal size={16} />
                      </button>
                      {rowMenuId === row.id && (
                        <>
                          {/* Click-away layer — a menu that only closes via its own items
                              is a menu people leave open by accident. */}
                          <button
                            type="button"
                            aria-label="Close menu"
                            className="fixed inset-0 z-10 cursor-default border-0 bg-transparent"
                            onClick={() => setRowMenuId(null)}
                          />
                          <div
                            role="menu"
                            className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-[7px] border border-brand-line bg-brand-card py-1 text-left shadow-lg"
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="block w-full border-0 bg-transparent px-3 py-2 text-left text-xs font-bold text-brand-ink hover:bg-brand-n50"
                              onClick={() => openEditor([row.id])}
                            >
                              Edit item…
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="block w-full border-0 bg-transparent px-3 py-2 text-left text-xs text-brand-n700 hover:bg-brand-n50"
                              onClick={() => {
                                setBulkMode(true)
                                setSelectedIds((prev) =>
                                  prev.includes(row.id) ? prev : [...prev, row.id],
                                )
                                setRowMenuId(null)
                              }}
                            >
                              Add to bulk selection
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))
              )}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <div className="px-5 py-8 text-xs text-brand-subtle">
              No {isRestaurant ? 'restaurant' : 'retail'} catalog items yet. Add one to get started.
            </div>
          )}
        </div>
        {pageCount > 1 && (
          <Pager
            page={pageIndex + 1}
            pageCount={pageCount}
            total={filtered.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        )}
      </TableCard>

      <TableCard className="mb-4 max-h-none p-5">
        <h2 className="m-0 text-base">Import guide</h2>
        <p className="mt-1 text-xs text-brand-muted">
          Use this format for CSV/XLSX. Wrong headers are rejected before import.
        </p>
        {isRestaurant ? (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-brand-muted">
            <li>
              Required: <code>name</code>, <code>sku</code>, <code>price</code>, <code>category</code>,{' '}
              <code>discountEligible</code> (true/false)
            </li>
            <li>
              Optional: <code>menuKind</code>, <code>budgetPrice</code>, <code>barcode</code>
            </li>
            <li>
              Matching SKU (or barcode) <strong>updates</strong> the catalog row and cascades
              identity/price/Discountable to adopted branches — export, edit, re-import for bulk
              repricing
            </li>
            <li>Unchanged rows are skipped; new SKUs are created</li>
            <li>
              Sample:{' '}
              <a className="font-bold text-brand-ink" href="/samples/potahe-menu-import.csv" download>
                potahe-menu-import.csv
              </a>
            </li>
          </ul>
        ) : (
          <>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-brand-muted">
              <li>
                Required: <code>name</code>, <code>sku</code>, <code>barcode</code>,{' '}
                <code>category</code>, <code>pricingMode</code> (pc/kg), <code>price</code>,{' '}
                <code>discountEligible</code> (true/false)
              </li>
              <li>
                Optional: <code>lowStockAt</code> (default threshold only — not on-hand qty)
              </li>
              <li>
                Do <strong>not</strong> include <code>stock</code> — quantity on hand belongs on
                branch Inventory after adopt
              </li>
              <li>
              Matching SKU (or barcode) <strong>updates</strong> the catalog row and cascades
              identity/price/Discountable to adopted branches — export, edit, re-import for bulk
              repricing
            </li>
            <li>Unchanged rows are skipped; new SKUs are created</li>
              <li>
                Sample:{' '}
                <a
                  className="font-bold text-brand-ink"
                  href="/samples/network-catalog-import.csv"
                  download
                >
                  network-catalog-import.csv
                </a>
              </li>
            </ul>
            <pre className="mt-3 overflow-auto rounded-md bg-brand-n100 p-3 text-[11px] text-brand-ink">
{`name,sku,barcode,category,pricingMode,price,discountEligible
White Sugar 1kg,GRO-SUG-1,4801000000011,Groceries,pc,65,true
Pork Belly,MEA-BELLY,4801000000042,Meat,kg,320,false`}
            </pre>
          </>
        )}
      </TableCard>

      {showAdd && (
        <Modal wide onClose={() => !busy && setShowAdd(false)}>
          <h2 className="m-0 pr-8 text-lg">
            {isRestaurant ? 'Add potahe to network catalog' : 'Add product to network catalog'}
          </h2>
          <p className="mt-1 text-xs text-brand-muted">
            Shared master list · {isRestaurant ? 'restaurant' : 'retail'} · branches adopt later
          </p>
          {formError && (
            <p className="mt-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">
              {formError}
            </p>
          )}
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              saveNew()
            }}
          >
            <Field
              label={isRestaurant ? 'Potahe name' : 'Product name'}
              required
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
            />
            <Field
              label="SKU / item code"
              required
              value={form.sku}
              onChange={(e) => setField('sku', e.target.value)}
            />
            <Field
              label="Barcode"
              required={!isRestaurant}
              inputMode="numeric"
              value={form.barcode}
              onChange={(e) => setField('barcode', e.target.value)}
              placeholder={isRestaurant ? 'Optional' : undefined}
            />
            {isRestaurant ? (
              <SelectField
                label="Menu kind"
                value={form.menuKind}
                onChange={(e) => {
                  const kind = e.target.value
                  setForm((prev) => ({
                    ...prev,
                    menuKind: kind,
                    category: categoryForMenuKind(kind),
                    budgetPrice: hasBudgetTier(kind) ? prev.budgetPrice : '',
                  }))
                  setFormError('')
                }}
              >
                {MENU_KINDS.map((kind) => (
                  <option key={kind.id} value={kind.id}>
                    {kind.label}
                  </option>
                ))}
              </SelectField>
            ) : (
              <>
                <SelectField
                  label="Category"
                  value={form.category}
                  onChange={(e) => setField('category', e.target.value)}
                >
                  <option>Groceries</option>
                  <option>Bakery</option>
                  <option>Meat</option>
                </SelectField>
                <SelectField
                  label="Pricing mode"
                  value={form.pricingMode}
                  onChange={(e) => setField('pricingMode', e.target.value)}
                >
                  <option value="pc">Price per pc</option>
                  <option value="kg">Price per kg</option>
                </SelectField>
              </>
            )}
            <Field
              label={isRestaurant ? 'Regular price' : 'Price'}
              required
              inputMode="decimal"
              value={form.price}
              onChange={(e) => setField('price', e.target.value)}
            />
            {isRestaurant && hasBudgetTier(form.menuKind) && (
              <Field
                label="Budget price"
                inputMode="decimal"
                value={form.budgetPrice}
                onChange={(e) => setField('budgetPrice', e.target.value)}
                placeholder="Optional"
              />
            )}
            <label className="flex items-center gap-2 text-xs font-bold text-brand-n700">
              <input
                type="checkbox"
                checked={form.discountEligible === true}
                onChange={(e) => setForm((prev) => ({ ...prev, discountEligible: e.target.checked }))}
              />
              PWD / Senior discount eligible
            </label>
            <ModalActions>
              <SecondaryButton compact type="button" disabled={busy} onClick={() => setShowAdd(false)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton compact type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Add to catalog'}
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}

      {/* One editor, one row or many. Each row keeps its own values — this is not
          "set them all to X", which is almost never what a catalog needs — but the
          set-for-all row above the table covers the cases where it is. */}
      {editorIds && (
        <Modal xl onClose={() => !busy && setEditorIds(null)}>
          <h2 className="m-0 pr-8 text-lg">
            {editorIds.length === 1 ? 'Edit catalog item' : `Edit ${editorIds.length} catalog items`}
          </h2>
          <p className="mt-1 mb-3 text-xs text-brand-muted">
            Shared template. Saving here pushes every field to branches that already adopted
            the item, not just future adoptions — a price change is logged to that branch's
            Price Change Register just like editing it on the branch's own Catalog page.
          </p>
          {error && (
            <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">
              {error}
            </p>
          )}

          {editorIds.length > 1 && (
            <div className="mb-3 flex flex-wrap items-end gap-2 rounded-[7px] border border-brand-softline bg-brand-n50 px-3 py-2.5">
              <span className="text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Set for all {editorIds.length}
              </span>
              <SelectField
                label="Category"
                className="min-w-[150px]"
                value=""
                onChange={(e) => e.target.value && applyToAll('category', e.target.value)}
              >
                <option value="">Leave as is</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </SelectField>
              <SecondaryButton
                compact
                type="button"
                onClick={() => applyToAll('discountEligible', true)}
              >
                All discountable
              </SecondaryButton>
              <SecondaryButton
                compact
                type="button"
                onClick={() => applyToAll('discountEligible', false)}
              >
                None discountable
              </SecondaryButton>
            </div>
          )}

          <div className="max-h-[52vh] overflow-auto rounded border border-brand-softline">
            <table className="min-w-full text-left text-xs">
              <thead className={`sticky top-0 z-10 ${tableHeadClass}`}>
                <tr>
                  <th className="px-3 py-2 min-w-[180px]">Name</th>
                  <th className="px-3 py-2 min-w-[110px]">SKU</th>
                  <th className="px-3 py-2 min-w-[130px]">Barcode</th>
                  <th className="px-3 py-2 min-w-[140px]">Category</th>
                  <th className="px-3 py-2 text-right min-w-[110px]">Price</th>
                  <th className="px-3 py-2 text-center">Discountable</th>
                </tr>
              </thead>
              <tbody>
                {catalog
                  .filter((row) => editorIds.includes(row.id))
                  .map((row) => {
                    const draft = drafts[row.id]
                    if (!draft) return null
                    const priceChanged =
                      draft.price !== '' && Number(draft.price) !== Number(row.price)
                    return (
                      <tr key={row.id} className="border-t border-brand-softline align-top">
                        <td className="px-3 py-2">
                          <input
                            className="w-full rounded border border-brand-line bg-brand-card px-2 py-1 text-brand-ink outline-none"
                            value={draft.name}
                            aria-label={`Name for ${row.name}`}
                            onChange={(e) => setDraft(row.id, 'name', e.target.value)}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            className="w-full rounded border border-brand-line bg-brand-card px-2 py-1 text-brand-ink outline-none"
                            value={draft.sku}
                            aria-label={`SKU for ${row.name}`}
                            onChange={(e) => setDraft(row.id, 'sku', e.target.value)}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            className="w-full rounded border border-brand-line bg-brand-card px-2 py-1 text-brand-ink outline-none"
                            inputMode="numeric"
                            value={draft.barcode}
                            aria-label={`Barcode for ${row.name}`}
                            onChange={(e) => setDraft(row.id, 'barcode', e.target.value)}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <select
                            className="w-full rounded border border-brand-line bg-brand-card px-2 py-1 text-brand-ink outline-none"
                            value={draft.category}
                            aria-label={`Category for ${row.name}`}
                            onChange={(e) => setDraft(row.id, 'category', e.target.value)}
                          >
                            {categoryOptions.map((cat) => (
                              <option key={cat} value={cat}>
                                {cat}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            className={`w-24 rounded border bg-brand-card px-2 py-1 text-right text-brand-ink outline-none ${
                              priceChanged ? 'border-brand-gold' : 'border-brand-line'
                            }`}
                            inputMode="decimal"
                            value={draft.price}
                            aria-label={`Price for ${row.name}`}
                            onChange={(e) => setDraft(row.id, 'price', e.target.value)}
                          />
                          {priceChanged && (
                            <span className="mt-0.5 block text-[10px] text-brand-subtle line-through">
                              {money(row.price)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            aria-label={`Discountable for ${row.name}`}
                            checked={draft.discountEligible === true}
                            onChange={(e) => setDraft(row.id, 'discountEligible', e.target.checked)}
                          />
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>

          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setEditorIds(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={() => void saveEditor()}>
              {busy
                ? bulkProgress
                  ? `Saving ${bulkProgress.done + 1}/${bulkProgress.total}…`
                  : 'Saving…'
                : 'Save changes'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}
