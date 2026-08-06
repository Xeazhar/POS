import { useEffect, useMemo, useState } from 'react'
import { FiPlus, FiSearch, FiUpload } from 'react-icons/fi'
import * as XLSX from 'xlsx'
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
  tableRowClass,
} from '../ui'
import {
  commitCatalogImport,
  createCatalogProduct,
  fetchCatalogProducts,
  hasSupabase,
  updateCatalogProduct,
} from '../../lib/api'
import {
  buildCatalogImportPreview,
  normalizeSheetRows,
  sha256Hex,
  validateImportHeaders,
} from '../../utils/inventoryImport'
import { money } from '../../utils/format'
import { formatSupportError } from '../../utils/errors'
import { categoryForMenuKind, hasBudgetTier, MENU_KINDS } from '../../utils/ulam'
import { decimalOnly, digitsOnly, sanitizeText } from '../../utils/validate'

const PAGE_SIZE = 12

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
 * Manager Data — network / universal product catalog.
 * Manual add creates catalog_products; branches adopt via supervisor Catalog.
 */
export default function ManagerNetworkCatalog() {
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

  const [priceEdit, setPriceEdit] = useState(null)
  const [priceValue, setPriceValue] = useState('')
  const [discountEdit, setDiscountEdit] = useState(null)
  const [discountValue, setDiscountValue] = useState(false)

  const [preview, setPreview] = useState(null)
  const [importProgress, setImportProgress] = useState(null)
  const [loading, setLoading] = useState(true)

  const isRestaurant = branchType === 'restaurant'

  const reload = async () => {
    if (!hasSupabase) {
      setCatalog([])
      setLoading(false)
      return
    }
    setCatalog(await fetchCatalogProducts({ branchType }))
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
    setPreview(null)
  }, [branchType])

  useEffect(() => {
    setPage(0)
  }, [query, categoryFilter, modeFilter])

  const categories = useMemo(
    () => [...new Set(catalog.map((p) => p.category).filter(Boolean))].sort(),
    [catalog],
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
      return true
    })
  }, [catalog, query, categoryFilter, modeFilter, isRestaurant])

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
    setBusy(true)
    setError('')
    setPreview(null)
    try {
      const buf = await file.arrayBuffer()
      await sha256Hex(buf)
      const wb = XLSX.read(buf, { type: 'array' })
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

  const savePrice = async () => {
    if (!priceEdit) return
    const next = Number(priceValue)
    if (Number.isNaN(next) || next < 0) {
      setError('Enter a valid price.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await updateCatalogProduct(priceEdit.id, {
        ...priceEdit,
        price: next,
      })
      setPriceEdit(null)
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'CAT03'))
    } finally {
      setBusy(false)
    }
  }

  const saveDiscount = async () => {
    if (!discountEdit) return
    setBusy(true)
    setError('')
    try {
      await updateCatalogProduct(discountEdit.id, {
        ...discountEdit,
        discountEligible: discountValue === true,
      })
      setDiscountEdit(null)
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'CAT04'))
    } finally {
      setBusy(false)
    }
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
        Add retail goods or restaurant menu items to the shared catalog (manually or CSV import).
        Supervisors then add them to their branch from Catalog.
      </p>

      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <SelectField
            label="Catalog type"
            className="w-full min-w-0 sm:max-w-[220px]"
            value={branchType}
            onChange={(e) => setBranchType(e.target.value)}
          >
            <option value="retail">Retail goods</option>
            <option value="restaurant">Restaurant / potahe</option>
          </SelectField>
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
            <label
              className={`inline-flex h-8 cursor-pointer items-center gap-1 rounded-[5px] border border-brand-border bg-white px-2.5 text-[11px] font-bold text-[#4d534f] ${
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
            {preview.filename} · {preview.createCount} new · {preview.skippedCount} skipped
          </p>
          <div className="mt-3 max-h-56 overflow-auto text-xs">
            {(preview.lines || []).slice(0, 40).map((line, i) => (
              <div
                key={`c-${i}`}
                className="flex justify-between gap-2 border-t border-brand-softline py-1.5 first:border-t-0"
              >
                <span className="truncate">
                  {line.values?.name || '—'}{' '}
                  <span className="text-brand-subtle">({line.values?.sku})</span>
                </span>
                <span className="shrink-0 text-brand-success">create</span>
              </div>
            ))}
            {(preview.skipped || []).length > 0 && (
              <div className="mt-3 border-t border-brand-line pt-2">
                <p className="m-0 mb-1 text-[11px] font-bold text-brand-warn">Skipped</p>
                {(preview.skipped || []).slice(0, 40).map((line, i) => (
                  <div
                    key={`s-${i}`}
                    className="flex justify-between gap-2 border-t border-brand-softline py-1.5 text-brand-subtle"
                  >
                    <span className="truncate">
                      {line.values?.name || line.values?.sku || '—'} — {line.reason}
                    </span>
                    <span className="shrink-0">skip</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-4 flex gap-2">
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              disabled={busy || !preview.createCount}
              onClick={commitImport}
            >
              {busy ? 'Importing…' : `Import ${preview.createCount} item(s)`}
            </PrimaryButton>
          </div>
        </TableCard>
      )}

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
            <li>Skipped if SKU already exists in the network catalog</li>
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
              <li>Skipped if SKU already exists in the network catalog</li>
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
            <pre className="mt-3 overflow-auto rounded-md bg-[#f6f6f3] p-3 text-[11px] text-brand-ink">
{`name,sku,barcode,category,pricingMode,price,discountEligible
White Sugar 1kg,GRO-SUG-1,4801000000011,Groceries,pc,65,true
Pork Belly,MEA-BELLY,4801000000042,Meat,kg,320,false`}
            </pre>
          </>
        )}
      </TableCard>

      <TableCard className="mb-4 max-h-none">
        <div className="flex flex-col gap-3 border-b border-brand-softline px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="m-0 text-base">
                {isRestaurant ? 'Restaurant catalog' : 'Retail catalog'}
              </h2>
              <p className="m-0 mt-1 text-[11px] text-brand-subtle">
                {filtered.length} shown · {catalog.length} total
              </p>
            </div>
            <SearchBox
              className="w-full sm:w-[260px] sm:shrink-0"
              icon={<FiSearch />}
              placeholder="Search name, SKU, barcode"
              value={query}
              onChange={(e) => setQuery(e.target.value.replace(/[<>]/g, ''))}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
          </div>
        </div>

        <div className="overflow-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-brand-dark text-[9px] tracking-[1px] text-[#c8ceca] uppercase">
              <tr>
                <th className="px-5 py-3">Product</th>
                <th className="px-5 py-3">SKU</th>
                <th className="px-5 py-3 max-[700px]:hidden">Category</th>
                <th className="px-5 py-3 max-[700px]:hidden">{isRestaurant ? 'Kind' : 'Mode'}</th>
                <th className="px-5 py-3 text-right">Price</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="p-0">
                    <SkeletonRows rows={8} cols={5} />
                  </td>
                </tr>
              ) : (
              pageRows.map((row) => (
                <tr key={row.id} className={tableRowClass}>
                  <td className="px-5 py-3">
                    <strong className="block text-brand-ink">{row.name}</strong>
                    <small className="text-[10px] text-brand-subtle">{row.barcode || '—'}</small>
                    <div className="text-[10px] text-brand-subtle">
                      Discountable: {row.discountEligible ? 'Yes' : 'No'}
                    </div>
                  </td>
                  <td className="px-5 py-3">{row.sku}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{row.category || '—'}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">
                    {isRestaurant ? row.menuKind || '—' : row.pricingMode}
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
                    <div className="flex flex-col items-end gap-1">
                      <button
                        type="button"
                        className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                        onClick={() => {
                          setPriceEdit(row)
                          setPriceValue(String(row.price ?? ''))
                        }}
                      >
                        Edit price
                      </button>
                      <button
                        type="button"
                        className="border-0 bg-transparent text-[11px] font-bold text-brand-slate underline"
                        onClick={() => {
                          setDiscountEdit(row)
                          setDiscountValue(row.discountEligible === true)
                        }}
                      >
                        Edit discountable
                      </button>
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
        <Pager
          page={pageIndex}
          pageCount={pageCount}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
        />
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
            <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
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

      {priceEdit && (
        <Modal onClose={() => !busy && setPriceEdit(null)}>
          <h2 className="m-0 pr-8 text-lg">Update catalog price</h2>
          <p className="mt-1 text-xs text-brand-muted">
            {priceEdit.name} · {priceEdit.sku}
          </p>
          <div className="mt-4">
            <Field
              label="New price (₱)"
              inputMode="decimal"
              value={priceValue}
              onChange={(e) => setPriceValue(decimalOnly(e.target.value))}
            />
            <p className="mt-2 text-[11px] text-brand-subtle">Current: {money(priceEdit.price)}</p>
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setPriceEdit(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={savePrice}>
              {busy ? 'Saving…' : 'Save price'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {discountEdit && (
        <Modal onClose={() => !busy && setDiscountEdit(null)}>
          <h2 className="m-0 pr-8 text-lg">Edit discountable</h2>
          <p className="mt-1 text-xs text-brand-muted">
            {discountEdit.name} · {discountEdit.sku}
          </p>
          <div className="mt-4">
            <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
              <input
                type="checkbox"
                checked={discountValue === true}
                onChange={(e) => setDiscountValue(e.target.checked)}
              />
              PWD / Senior discount eligible
            </label>
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setDiscountEdit(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={saveDiscount}>
              {busy ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}
