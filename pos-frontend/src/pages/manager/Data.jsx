import { useEffect, useState } from 'react'
import { FiPlus, FiSearch, FiUpload } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import {
  ErrorBanner,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  Pager,
  PrimaryButton,
  SearchBox,
  SecondaryButton,
  SelectField,
  StatusOverlay,
  TableCard,
} from '../../components/ui'
import {
  bootstrapBranchData,
  commitInventoryImport,
  fetchBranches,
  fetchImportBatchItems,
  fetchImportBatches,
  findRecentImportByHash,
  hasSupabase,
  mapProduct,
  revertInventoryImport,
  updateProductPrice,
  fetchPriceHistory,
} from '../../lib/api'
import { useAuthStore, useProductStore } from '../../stores/posStore'
import { buildImportPreview, sha256Hex } from '../../utils/inventoryImport'
import { money, qty, stockTone } from '../../utils/format'
import { formatSupportError } from '../../utils/errors'
import { categoryForMenuKind, hasBudgetTier, MENU_KINDS } from '../../utils/ulam'
import {
  decimalOnly,
  digitsOnly,
  duplicateField,
  findProductDuplicate,
  sanitizeText,
} from '../../utils/validate'
import { isManagerRole } from '../../utils/roles'

const OFFLINE_KEY = 'cale-import-batches-v1'
const PAGE_SIZE = 10

const emptyAddForm = () => ({
  name: '',
  sku: '',
  barcode: '',
  category: 'Groceries',
  menuKind: 'meat',
  pricingMode: 'pc',
  price: '',
  budgetPrice: '',
  stock: '',
  availableToday: true,
  discountEligible: false,
  unitCost: '',
})

function loadOfflineBatches() {
  try {
    return JSON.parse(localStorage.getItem(OFFLINE_KEY) || '[]')
  } catch {
    return []
  }
}

function saveOfflineBatches(batches) {
  localStorage.setItem(OFFLINE_KEY, JSON.stringify(batches))
}

function ManagerData() {
  const user = useAuthStore((state) => state.user)
  const managerView = isManagerRole(user?.role)
  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState([])
  const [products, setProducts] = useState([])
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [stockFilter, setStockFilter] = useState('all')
  const [modeFilter, setModeFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState(null)
  const [duplicate, setDuplicate] = useState(null)
  const [acknowledgeDuplicate, setAcknowledgeDuplicate] = useState(false)
  const [detailBatch, setDetailBatch] = useState(null)
  const [detailItems, setDetailItems] = useState([])
  const [confirmRevert, setConfirmRevert] = useState(null)
  const [priceEdit, setPriceEdit] = useState(null)
  const [priceValue, setPriceValue] = useState('')
  const [priceHistory, setPriceHistory] = useState(null)
  const [priceHistoryRows, setPriceHistoryRows] = useState([])
  const [importProgress, setImportProgress] = useState(null)
  const [importDone, setImportDone] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState(emptyAddForm)
  const [addError, setAddError] = useState('')

  const selectedBranch = branches.find((b) => b.id === branchId)
  const isRestaurant =
    selectedBranch?.branch_type === 'restaurant' ||
    (!managerView && user?.branchType === 'restaurant')

  const refreshCatalog = async (id = branchId) => {
    if (!id) {
      setProducts([])
      return
    }
    if (!hasSupabase) {
      const local = useProductStore.getState().products.filter((p) => !p.branchId || p.branchId === id)
      setProducts(local)
      return
    }
    const data = await bootstrapBranchData(id)
    setProducts(data.products)
    // Keep POS / Inventory in sync when editing the signed-in branch
    if (id === user?.branchId) {
      useProductStore.getState().setProducts(data.products)
    }
  }

  const refreshHistory = async (id = branchId) => {
    if (!hasSupabase) {
      const all = loadOfflineBatches()
      setHistory(id ? all.filter((row) => row.branch_id === id) : all)
      return
    }
    setHistory(await fetchImportBatches(id || null))
  }

  useEffect(() => {
    if (!managerView) {
      const id = user?.branchId || (hasSupabase ? '' : 'demo-main-branch')
      setBranches([
        {
          id,
          name: user?.branchName || 'My branch',
          branch_type: user?.branchType || 'retail',
        },
      ])
      setBranchId(id)
      return
    }
    if (!hasSupabase) {
      setBranches([{ id: user?.branchId || 'demo-main-branch', name: user?.branchName || 'Demo branch', branch_type: user?.branchType || 'retail' }])
      setBranchId(user?.branchId || 'demo-main-branch')
      return
    }
    fetchBranches()
      .then((rows) => {
        setBranches(rows)
        setBranchId(rows[0]?.id || '')
      })
      .catch((err) => setError(err.message))
  }, [user, managerView])

  useEffect(() => {
    if (!branchId && hasSupabase) return
    setPage(0)
    Promise.all([refreshHistory(branchId), refreshCatalog(branchId)]).catch((err) => setError(err.message))
  }, [branchId])

  useEffect(() => {
    setPage(0)
  }, [query, categoryFilter, stockFilter, modeFilter])

  useEffect(() => {
    let active = true
    if (!priceHistory?.id || !hasSupabase) {
      setPriceHistoryRows([])
      return undefined
    }
    fetchPriceHistory(priceHistory.id, branchId || priceHistory.branchId)
      .then((rows) => {
        if (active) setPriceHistoryRows(rows)
      })
      .catch(() => {
        if (active) setPriceHistoryRows([])
      })
    return () => {
      active = false
    }
  }, [priceHistory, branchId])

  const openAdd = () => {
    setAddError('')
    setAddForm({
      ...emptyAddForm(),
      category: isRestaurant ? 'Meat' : 'Groceries',
      menuKind: 'meat',
      availableToday: true,
    })
    setShowAdd(true)
  }

  const setAddField = (key, value) => {
    let next = value
    if (key === 'barcode') next = digitsOnly(value)
    else if (key === 'price' || key === 'stock' || key === 'budgetPrice') next = decimalOnly(value)
    else if (key === 'name' || key === 'sku') next = value.replace(/[<>]/g, '')
    setAddForm((prev) => ({ ...prev, [key]: next }))
    setAddError('')
  }

  const saveNewItem = async () => {
    if (!branchId || !user) {
      setAddError('Select a branch first.')
      return
    }
    const name = sanitizeText(addForm.name)
    const sku = sanitizeText(addForm.sku)
    const barcode = digitsOnly(addForm.barcode)
    if (!name || !sku) {
      setAddError('Name and SKU are required.')
      return
    }
    if (!isRestaurant && !barcode) {
      setAddError('Name, SKU, and barcode are required.')
      return
    }
    if (addForm.price === '' || Number(addForm.price) < 0) {
      setAddError('Enter a valid price.')
      return
    }
    if (
      isRestaurant &&
      addForm.budgetPrice !== '' &&
      (Number.isNaN(Number(addForm.budgetPrice)) || Number(addForm.budgetPrice) < 0)
    ) {
      setAddError('Enter a valid budget price (or leave blank).')
      return
    }
    if (!isRestaurant && (addForm.stock === '' || Number.isNaN(Number(addForm.stock)))) {
      setAddError('Enter a valid stock amount.')
      return
    }
    const duplicate = findProductDuplicate(products, { name, sku, barcode })
    if (duplicate) {
      setAddError(`Duplicate ${duplicateField(duplicate, { name, sku, barcode })} already exists.`)
      return
    }

    const menuKind = isRestaurant ? addForm.menuKind : undefined
    const values = {
      branchId,
      _restaurant: isRestaurant,
      branchType: isRestaurant ? 'restaurant' : 'retail',
      name,
      sku,
      barcode: barcode || null,
      category: isRestaurant ? categoryForMenuKind(menuKind, addForm.category) : addForm.category,
      menuKind,
      pricingMode: isRestaurant ? 'pc' : addForm.pricingMode,
      price: Number(addForm.price),
      budgetPrice:
        isRestaurant && hasBudgetTier(menuKind) && addForm.budgetPrice !== ''
          ? Number(addForm.budgetPrice)
          : null,
      stock: isRestaurant ? 0 : Number(addForm.stock),
      lowStockAt: 5,
      availableToday: isRestaurant ? addForm.availableToday !== false : true,
      unitCost: addForm.unitCost !== '' ? Number(addForm.unitCost) : 0,
      discountEligible: addForm.discountEligible === true,
    }

    setBusy(true)
    setAddError('')
    try {
      await useProductStore.getState().addProduct(values)
      await refreshCatalog(branchId)
      setShowAdd(false)
      setAddForm(emptyAddForm())
    } catch (err) {
      setAddError(formatSupportError(err, 'DATA02'))
    } finally {
      setBusy(false)
    }
  }

  const clearPreview = () => {
    setPreview(null)
    setDuplicate(null)
    setAcknowledgeDuplicate(false)
    setError('')
  }

  const onFile = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!branchId) {
      setError('Select a branch first.')
      return
    }
    setBusy(true)
    setError('')
    setAcknowledgeDuplicate(false)
    try {
      const buffer = await file.arrayBuffer()
      const fileHash = await sha256Hex(buffer)
      const workbook = XLSX.read(buffer, { type: 'array' })
      const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]])

      let catalog = products
      if (hasSupabase) {
        const data = await bootstrapBranchData(branchId)
        catalog = data.products
        setProducts(catalog)
        const recent = await findRecentImportByHash(branchId, fileHash)
        setDuplicate(recent)
      } else {
        catalog = useProductStore.getState().products.filter((p) => !p.branchId || p.branchId === branchId)
        setProducts(catalog)
        const recent = loadOfflineBatches().find(
          (row) =>
            row.branch_id === branchId &&
            row.file_hash === fileHash &&
            Date.now() - new Date(row.created_at).getTime() < 24 * 60 * 60 * 1000,
        )
        setDuplicate(recent || null)
      }

      setPreview({
        ...buildImportPreview(rawRows, catalog, { restaurant: isRestaurant }),
        filename: file.name,
        fileHash,
        branchId,
        restaurant: isRestaurant,
      })
    } catch (err) {
      setError(err.message || 'Could not read file')
      clearPreview()
    } finally {
      setBusy(false)
    }
  }

  const commit = async () => {
    if (!preview || !user) return
    if (duplicate && !acknowledgeDuplicate) {
      setError('Acknowledge the duplicate-file warning before importing.')
      return
    }
    setBusy(true)
    setError('')
    setImportDone(false)
    setImportProgress({ current: 0, total: preview.lines.length || 1, label: 'Starting…' })
    try {
      if (hasSupabase) {
        await commitInventoryImport({
          branchId: preview.branchId,
          staffId: user.id,
          filename: preview.filename,
          fileHash: preview.fileHash,
          preview,
          onProgress: setImportProgress,
        })
      } else {
        const lines = preview.lines
        for (let i = 0; i < lines.length; i += 1) {
          await useProductStore.getState().importInventoryRows([
            {
              ...lines[i].values,
              _restaurant: Boolean(preview.restaurant),
            },
          ])
          setImportProgress({
            current: i + 1,
            total: lines.length,
            label: lines[i].values.name,
          })
        }
        const batch = {
          id: crypto.randomUUID(),
          branch_id: preview.branchId,
          staff_id: user.id,
          staff: { full_name: user.name },
          branches: { name: user.branchName },
          filename: preview.filename,
          file_hash: preview.fileHash,
          row_count: preview.rowCount,
          created_count: preview.createCount,
          updated_count: preview.updateCount,
          skipped_count: preview.skippedCount,
          status: 'committed',
          created_at: new Date().toISOString(),
          items: preview.lines.map((line) => ({
            action: line.action,
            quantity_added: line.quantityAdded,
            name: line.values.name,
            sku: line.values.sku,
            barcode: line.values.barcode,
          })),
        }
        saveOfflineBatches([batch, ...loadOfflineBatches()])
      }
      clearPreview()
      await Promise.all([refreshHistory(branchId), refreshCatalog(branchId)])
      setImportDone(true)
    } catch (err) {
      setError(formatSupportError(err, 'DATA01'))
      setImportProgress(null)
      setImportDone(false)
    } finally {
      setBusy(false)
    }
  }

  const openDetail = async (batch) => {
    setDetailBatch(batch)
    if (hasSupabase) {
      try {
        setDetailItems(await fetchImportBatchItems(batch.id))
      } catch (err) {
        setError(err.message)
      }
    } else {
      setDetailItems(batch.items || [])
    }
  }

  const doRevert = async () => {
    if (!confirmRevert || !user) return
    setBusy(true)
    setError('')
    try {
      if (hasSupabase) {
        await revertInventoryImport(confirmRevert.id, user.id)
      } else {
        saveOfflineBatches(
          loadOfflineBatches().map((row) =>
            row.id === confirmRevert.id
              ? { ...row, status: 'reverted', reverted_at: new Date().toISOString() }
              : row,
          ),
        )
      }
      setConfirmRevert(null)
      setDetailBatch(null)
      await Promise.all([refreshHistory(branchId), refreshCatalog(branchId)])
    } catch (err) {
      setError(err.message || 'Revert failed')
    } finally {
      setBusy(false)
    }
  }

  const openPriceEdit = (product) => {
    setPriceEdit(product)
    setPriceValue(String(product.price))
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
      if (hasSupabase) {
        const row = await updateProductPrice(priceEdit.id, next, {
          branchId: priceEdit.branchId || branchId,
          staffId: user?.id,
          previousPrice: priceEdit.price,
          productName: priceEdit.name,
        })
        const mapped = mapProduct(row, priceEdit.stock, {
          updatedAt: priceEdit.updatedAt,
          lastMovementAt: priceEdit.lastMovementAt,
        })
        setProducts((prev) => prev.map((item) => (item.id === mapped.id ? { ...item, price: mapped.price } : item)))
        // Refresh so movement history includes the price change when opened elsewhere
        await refreshCatalog(branchId)
      } else {
        useProductStore.getState().setProducts(
          useProductStore.getState().products.map((item) =>
            item.id === priceEdit.id ? { ...item, price: next } : item,
          ),
        )
        setProducts((prev) => prev.map((item) => (item.id === priceEdit.id ? { ...item, price: next } : item)))
      }
      setPriceEdit(null)
    } catch (err) {
      setError(formatSupportError(err, 'DATA03'))
    } finally {
      setBusy(false)
    }
  }

  const canCommit = preview && (!duplicate || acknowledgeDuplicate) && preview.lines.length > 0
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))].sort()
  const filtered = products.filter((product) => {
    const q = query.toLowerCase()
    if (q) {
      const hit = [product.productCode, product.id, product.name, product.sku, product.barcode].some((value) =>
        String(value || '').toLowerCase().includes(q),
      )
      if (!hit) return false
    }
    if (categoryFilter !== 'All' && product.category !== categoryFilter) return false
    if (modeFilter !== 'all' && product.pricingMode !== modeFilter) return false
    if (!isRestaurant && stockFilter !== 'all') {
      if (stockFilter === 'out') {
        if (Number(product.stock) > 0) return false
      } else if (stockTone(product) !== stockFilter) {
        return false
      }
    }
    if (isRestaurant && stockFilter === 'off' && product.availableToday !== false) return false
    if (isRestaurant && stockFilter === 'on' && product.availableToday === false) return false
    return true
  })
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  return (
    <div>
      {(importProgress || importDone) && (
        <StatusOverlay
          title={importDone ? 'Import complete' : 'Importing…'}
          message={
            importDone
              ? 'Catalog updated.'
              : importProgress?.label || 'Please wait'
          }
          progress={importDone ? null : importProgress}
          done={importDone}
          onClose={() => {
            setImportProgress(null)
            setImportDone(false)
          }}
          closeLabel="Close"
        />
      )}
      <PageHeader
        eyebrow={managerView ? 'MANAGER' : 'SUPERVISOR'}
        title={isRestaurant ? 'Menu data' : 'Products'}
      />
      <p className="mb-4 max-w-3xl text-xs text-brand-muted">
        {isRestaurant
          ? 'Add one potahe at a time, or import CSV/XLSX. Required for import: name, sku, category, price. Optional: menuKind, budgetPrice, barcode, availableToday.'
          : 'Add one product, browse pricing, or import CSV/XLSX. Required for import: name, sku, barcode, price, stock. Optional: category, pricingMode (kg or pc), lowStockAt.'}
      </p>

      <TableCard className="mb-4 max-h-none p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {managerView ? (
            <SelectField
              label="Branch"
              className="w-full min-w-0 sm:max-w-[260px]"
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value)
                clearPreview()
              }}
            >
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </SelectField>
          ) : (
            <p className="m-0 text-xs text-brand-muted sm:pb-1">
              Branch: <strong className="text-brand-ink">{user?.branchName || 'Assigned branch'}</strong>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton
              compact
              type="button"
              className="!h-8 !min-h-0 !gap-1 !px-2.5 !text-[11px]"
              disabled={busy || !branchId}
              onClick={openAdd}
            >
              <FiPlus className="text-sm" /> Add item
            </PrimaryButton>
            <label
              className={`inline-flex h-8 cursor-pointer items-center gap-1 rounded-[5px] border border-brand-border bg-white px-2.5 text-[11px] font-bold text-[#4d534f] ${
                busy || !branchId ? 'pointer-events-none opacity-35' : ''
              }`}
            >
              <FiUpload className="text-sm" /> Import
              <input
                className="hidden"
                type="file"
                accept=".csv,.xlsx,.xls"
                disabled={busy || !branchId}
                onChange={onFile}
              />
            </label>
          </div>
        </div>
        {error && <ErrorBanner className="mt-3 mb-0" error={formatSupportError(error)} onDismiss={() => setError('')} />}
      </TableCard>

      <TableCard className="mb-4 max-h-none">
        <div className="flex flex-col gap-3 border-b border-brand-softline px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="m-0 text-base">{managerView ? 'Branch catalog' : 'Branch products'}</h2>
              <p className="m-0 mt-1 text-[11px] text-brand-subtle">
                {filtered.length} shown · {products.length} total
                {managerView ? ' · export from Reports → Price Listing' : ''}
              </p>
            </div>
            <SearchBox
              className="w-full sm:w-[260px] sm:shrink-0"
              icon={<FiSearch />}
              placeholder="Search ID, name, SKU, barcode"
              value={query}
              onChange={(e) => setQuery(e.target.value.replace(/[<>]/g, ''))}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SelectField
              label="Category"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="All">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </SelectField>
            {!isRestaurant && (
              <SelectField
                label="Stock"
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value)}
              >
                <option value="all">All stock</option>
                <option value="low">Low</option>
                <option value="fair">Fair</option>
                <option value="good">Good</option>
                <option value="out">Out of stock</option>
              </SelectField>
            )}
            {isRestaurant && (
              <SelectField
                label="Serving"
                value={stockFilter}
                onChange={(e) => setStockFilter(e.target.value)}
              >
                <option value="all">All items</option>
                <option value="on">On today</option>
                <option value="off">Off today</option>
              </SelectField>
            )}
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
            <thead className="bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
              <tr>
                <th className="px-5 py-3">ID</th>
                <th className="px-5 py-3">Product</th>
                <th className="px-5 py-3">SKU</th>
                <th className="px-5 py-3 max-[700px]:hidden">Category</th>
                <th className="px-5 py-3 max-[700px]:hidden">Mode</th>
                <th className="px-5 py-3 text-right">Price</th>
                <th className="px-5 py-3 text-right">On hand</th>
                <th className="px-5 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((product) => (
                <tr key={product.id} className="border-t border-brand-softline">
                  <td className="px-5 py-3 tabular-nums font-bold text-brand-ink">
                    {product.productCode || '—'}
                  </td>
                  <td className="px-5 py-3">
                    <strong className="block text-brand-ink">{product.name}</strong>
                    <small className="text-[10px] text-brand-subtle">{product.barcode}</small>
                  </td>
                  <td className="px-5 py-3">{product.sku}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{product.category}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{product.pricingMode}</td>
                  <td className="px-5 py-3 text-right tabular-nums font-bold text-brand-ink">{money(product.price)}</td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {qty(product.stock, product.pricingMode === 'kg' ? 'kg' : 'pc')}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex flex-col items-end gap-1">
                      <button
                        type="button"
                        className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                        onClick={() => openPriceEdit(product)}
                      >
                        Edit price
                      </button>
                      {isRestaurant && (
                        <button
                          type="button"
                          className="border-0 bg-transparent text-[11px] font-bold text-brand-slate underline"
                          onClick={() => setPriceHistory(product)}
                        >
                          Price history
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="px-5 py-6 text-xs text-brand-subtle">
              No products for this branch yet. Add an item or import a file.
            </div>
          )}
        </div>
        {filtered.length > 0 && (
          <Pager
            page={pageIndex + 1}
            pageCount={pageCount}
            total={filtered.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        )}
      </TableCard>

      {preview && (
        <TableCard className="mb-4 max-h-none p-5">
          <h2 className="m-0 text-lg">Import preview</h2>
          <p className="mt-1 text-xs text-brand-muted">
            {preview.filename} · {preview.createCount} new · {preview.updateCount} restock · {preview.skippedCount} skipped
          </p>

          {duplicate && (
            <div className="mt-3 rounded-md border border-[#e8d4a8] bg-[#fff8ea] px-3 py-3 text-xs text-[#6a5520]">
              <p className="m-0 font-bold">
                This file was already imported on{' '}
                {new Date(duplicate.created_at).toLocaleString()}
                {duplicate.status === 'reverted' ? ' (later reverted)' : ''}.
              </p>
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={acknowledgeDuplicate}
                  onChange={(e) => setAcknowledgeDuplicate(e.target.checked)}
                />
                Import anyway
              </label>
            </div>
          )}

          <div className="mt-4 overflow-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
                <tr>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Add</th>
                  <th className="px-3 py-2 text-right">Stock after</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((line) => (
                  <tr key={`${line.action}-${line.values.sku}`} className="border-t border-brand-softline">
                    <td className="px-3 py-2 font-bold">{line.action === 'create' ? 'New' : 'Restock'}</td>
                    <td className="px-3 py-2">{line.values.name}</td>
                    <td className="px-3 py-2">{line.values.sku}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(line.values.price)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty(line.quantityAdded)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{qty(line.nextStock)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.skipped.length > 0 && (
            <p className="mt-3 text-[11px] text-brand-subtle">
              Skipped: {preview.skipped.map((row) => `${row.values?.sku || 'row'} (${row.reason})`).join(' · ')}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <PrimaryButton compact type="button" disabled={!canCommit || busy} onClick={commit}>
              Confirm import
            </PrimaryButton>
            <SecondaryButton compact type="button" disabled={busy} onClick={clearPreview}>
              Cancel
            </SecondaryButton>
          </div>
        </TableCard>
      )}

      <TableCard className="mb-4 max-h-none">
        <div className="border-b border-brand-softline px-5 py-4">
          <h2 className="m-0 text-base">Import history</h2>
        </div>
        {history.length === 0 ? (
          <div className="p-5 text-xs text-brand-subtle">No imports yet for this branch.</div>
        ) : (
          <div className="overflow-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
                <tr>
                  <th className="px-5 py-3">When</th>
                  <th className="px-5 py-3">File</th>
                  <th className="px-5 py-3">By</th>
                  <th className="px-5 py-3">Rows</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {history.map((batch) => (
                  <tr key={batch.id} className="border-t border-brand-softline">
                    <td className="px-5 py-3">{new Date(batch.created_at).toLocaleString()}</td>
                    <td className="px-5 py-3">{batch.filename}</td>
                    <td className="px-5 py-3">{batch.staff?.full_name || '—'}</td>
                    <td className="px-5 py-3">
                      {batch.created_count} new / {batch.updated_count} restock / {batch.skipped_count} skip
                    </td>
                    <td className="px-5 py-3 font-bold">{batch.status}</td>
                    <td className="px-5 py-3 text-right">
                      <button type="button" className="mr-2 border-0 bg-transparent text-xs font-bold text-brand-ink underline" onClick={() => openDetail(batch)}>
                        View
                      </button>
                      {batch.status === 'committed' && managerView && (
                        <button type="button" className="border-0 bg-transparent text-xs font-bold text-brand-danger underline" onClick={() => setConfirmRevert(batch)}>
                          Revert
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TableCard>

      {detailBatch && (
        <Modal wide className="sm:!w-[min(720px,100%)]" onClose={() => setDetailBatch(null)}>
          <h2 className="m-0 pr-8 text-lg">Import · {detailBatch.filename}</h2>
          <p className="mt-1 text-xs text-brand-muted">
            {new Date(detailBatch.created_at).toLocaleString()} · {detailBatch.staff?.full_name || 'Staff'} · hash{' '}
            {String(detailBatch.file_hash).slice(0, 12)}…
          </p>
          <div className="mt-4 max-h-[360px] overflow-auto rounded-md border border-brand-softline">
            <table className="min-w-full text-left text-xs">
              <thead className="sticky top-0 bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
                <tr>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Product</th>
                  <th className="px-3 py-2">SKU</th>
                  <th className="px-3 py-2">Barcode</th>
                  <th className="px-3 py-2 text-right">Qty added</th>
                </tr>
              </thead>
              <tbody>
                {detailItems.map((item) => (
                  <tr key={item.id || `${item.sku}-${item.action}`} className="border-t border-brand-softline">
                    <td className="px-3 py-2.5 font-bold capitalize">{item.action}</td>
                    <td className="px-3 py-2.5">{item.name}</td>
                    <td className="px-3 py-2.5">{item.sku || '—'}</td>
                    <td className="px-3 py-2.5">{item.barcode || '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{qty(item.quantity_added)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {detailItems.length === 0 && (
              <div className="px-3 py-4 text-xs text-brand-subtle">No line items logged for this import.</div>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setDetailBatch(null)}>Close</SecondaryButton>
          </ModalActions>
        </Modal>
      )}

      {isRestaurant ? (
        <TableCard className="mb-4 max-h-none p-5">
          <h2 className="m-0 text-base">Ulam / potahe import guide</h2>
          <ol className="mt-3 mb-0 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-brand-muted">
            <li>Select the restaurant branch above.</li>
            <li>
              Import with <code>sku</code>. The system assigns product IDs <strong>0001</strong>,{' '}
              <strong>0002</strong>, … (easy to track) plus an internal UUID for Power BI joins.
            </li>
            <li>
              Columns: <code>name</code>, <code>sku</code>, <code>category</code>, <code>price</code>
              (optional <code>menuKind</code>, <code>budgetPrice</code>, <code>barcode</code>,{' '}
              <code>availableToday</code>).
            </li>
            <li>
              Categories: <strong>Meat</strong>, <strong>Veggie</strong>, <strong>Pancit</strong>,{' '}
              <strong>Drink</strong>, <strong>Rice</strong>, <strong>Extra</strong>.
            </li>
            <li>
              Sample:{' '}
              <a className="font-bold text-brand-ink" href="/samples/potahe-menu-import.csv" download>
                potahe-menu-import.csv
              </a>
              . Export catalog from <strong>Reports → Price Listing / Catalog</strong>.
            </li>
          </ol>
          <pre className="mt-4 overflow-auto rounded-md bg-[#f7f7f4] p-3 text-[11px] leading-relaxed text-brand-ink">
{`name,sku,category,menuKind,price,budgetPrice,availableToday
Adobo,ULAM-ADOB,Meat,meat,70,55,true
Pinakbet,ULAM-PINAK,Veggie,veggie,60,45,true
Cabagan Special,PAN-CAB,Pancit,pancit,90,,true
Plain Rice,RICE-1,Rice,rice,15,,true
Softdrinks,DRK-SODA,Drink,drink,25,,true`}
          </pre>
        </TableCard>
      ) : (
        <TableCard className="mb-4 max-h-none p-5">
          <h2 className="m-0 text-base">Inventory import guide</h2>
          <ol className="mt-3 mb-0 list-decimal space-y-2 pl-4 text-xs leading-relaxed text-brand-muted">
            <li>Select the retail branch above.</li>
            <li>
              Import with <code>sku</code> + <code>barcode</code>. Product IDs are assigned as{' '}
              <strong>0001</strong>, <strong>0002</strong>, … per branch.
            </li>
            <li>
              Columns: <code>name</code>, <code>sku</code>, <code>barcode</code>, <code>price</code>,{' '}
              <code>stock</code> (optional <code>category</code>, <code>pricingMode</code>,{' '}
              <code>lowStockAt</code>).
            </li>
            <li>
              <code>pricingMode</code>: <strong>pc</strong> or <strong>kg</strong>. Re-importing the same SKU{' '}
              <strong>adds</strong> stock (restock).
            </li>
            <li>
              Sample:{' '}
              <a className="font-bold text-brand-ink" href="/samples/inventory-import.csv" download>
                inventory-import.csv
              </a>
              . Export catalog from <strong>Reports → Price Listing / Catalog</strong>.
            </li>
          </ol>
          <pre className="mt-4 overflow-auto rounded-md bg-[#f7f7f4] p-3 text-[11px] leading-relaxed text-brand-ink">
{`name,sku,barcode,category,pricingMode,price,stock,lowStockAt
White Sugar 1kg,GRO-SUG-1,4801000000011,Groceries,pc,65,24,5
Pork Belly,MEA-BELLY,4801000000028,Meat,kg,320,12.5,3
Pandesa,BAK-PAN,4801000000035,Bakery,pc,8,80,20`}
          </pre>
        </TableCard>
      )}

      {showAdd && (
        <Modal wide onClose={() => !busy && setShowAdd(false)}>
          <h2 className="m-0 pr-8 text-lg">
            {isRestaurant ? 'Add potahe / menu item' : 'Add product'}
          </h2>
          <p className="mt-1 text-xs text-brand-muted">
            {selectedBranch?.name || 'Selected branch'}
          </p>
          {addError && (
            <p className="mt-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">
              {addError}
            </p>
          )}
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              saveNewItem()
            }}
          >
            <Field
              label={isRestaurant ? 'Potahe name' : 'Product name'}
              required
              value={addForm.name}
              onChange={(e) => setAddField('name', e.target.value)}
            />
            <Field
              label="SKU / item code"
              required
              value={addForm.sku}
              onChange={(e) => setAddField('sku', e.target.value)}
            />
            <Field
              label="Barcode"
              required={!isRestaurant}
              inputMode="numeric"
              value={addForm.barcode}
              onChange={(e) => setAddField('barcode', e.target.value)}
              placeholder={isRestaurant ? 'Optional' : undefined}
            />
            {isRestaurant ? (
              <SelectField
                label="Menu kind"
                value={addForm.menuKind}
                onChange={(e) => {
                  const kind = e.target.value
                  setAddForm((prev) => ({
                    ...prev,
                    menuKind: kind,
                    category: categoryForMenuKind(kind),
                    budgetPrice: hasBudgetTier(kind) ? prev.budgetPrice : '',
                  }))
                  setAddError('')
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
                  value={addForm.category}
                  onChange={(e) => setAddField('category', e.target.value)}
                >
                  <option>Groceries</option>
                  <option>Bakery</option>
                  <option>Meat</option>
                </SelectField>
                <SelectField
                  label="Pricing mode"
                  value={addForm.pricingMode}
                  onChange={(e) => setAddField('pricingMode', e.target.value)}
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
              value={addForm.price}
              onChange={(e) => setAddField('price', e.target.value)}
            />
            {isRestaurant && hasBudgetTier(addForm.menuKind) && (
              <Field
                label="Budget price"
                inputMode="decimal"
                value={addForm.budgetPrice}
                onChange={(e) => setAddField('budgetPrice', e.target.value)}
                placeholder="Optional"
              />
            )}
            {!isRestaurant && (
              <Field
                label="Starting stock"
                required
                inputMode="decimal"
                value={addForm.stock}
                onChange={(e) => setAddField('stock', e.target.value)}
              />
            )}
            {isRestaurant && (
              <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
                <input
                  type="checkbox"
                  checked={addForm.availableToday !== false}
                  onChange={(e) =>
                    setAddForm((prev) => ({ ...prev, availableToday: e.target.checked }))
                  }
                />
                Serving today
              </label>
            )}
            <Field
              label="Unit cost (optional)"
              inputMode="decimal"
              value={addForm.unitCost}
              onChange={(e) => setAddField('unitCost', e.target.value)}
            />
            <label className="flex items-center gap-2 text-xs font-bold text-[#646a66]">
              <input
                type="checkbox"
                checked={addForm.discountEligible === true}
                onChange={(e) =>
                  setAddForm((prev) => ({ ...prev, discountEligible: e.target.checked }))
                }
              />
              PWD / Senior discount eligible
            </label>
            <ModalActions>
              <SecondaryButton compact type="button" disabled={busy} onClick={() => setShowAdd(false)}>
                Cancel
              </SecondaryButton>
              <PrimaryButton compact type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Add item'}
              </PrimaryButton>
            </ModalActions>
          </form>
        </Modal>
      )}

      {priceEdit && (
        <Modal onClose={() => setPriceEdit(null)}>
          <h2 className="m-0 pr-8 text-lg">Update price</h2>
          <p className="mt-1 text-xs text-brand-muted">
            {priceEdit.name} · {priceEdit.sku} · per {priceEdit.pricingMode}
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
            <SecondaryButton compact type="button" onClick={() => setPriceEdit(null)}>Cancel</SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={savePrice}>Save price</PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {priceHistory && (
        <Modal wide onClose={() => { setPriceHistory(null); setPriceHistoryRows([]) }}>
          <h2 className="m-0 pr-8 text-lg">Price history</h2>
          <p className="mt-1 mb-3 text-xs text-brand-muted">
            {priceHistory.name} · {priceHistory.sku}
          </p>
          <div className="max-h-[280px] overflow-auto rounded-md border border-brand-softline">
            <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 bg-[#f7f7f4] px-3 py-2 text-[9px] font-bold tracking-wide text-[#989e99] uppercase">
              <span>Date</span>
              <span className="text-right">Old</span>
              <span className="text-right">New</span>
            </div>
            {priceHistoryRows.length === 0 ? (
              <div className="px-3 py-4 text-xs text-brand-subtle">No price changes recorded yet.</div>
            ) : (
              priceHistoryRows.map((row) => (
                <div
                  key={row.id}
                  className="grid grid-cols-[1fr_1fr_1fr] gap-2 border-t border-brand-softline px-3 py-2 text-xs"
                >
                  <span>{row.date}</span>
                  <span className="text-right tabular-nums">{money(row.oldPrice)}</span>
                  <strong className="text-right tabular-nums">{money(row.newPrice)}</strong>
                </div>
              ))
            )}
          </div>
          <ModalActions>
            <PrimaryButton compact type="button" onClick={() => { setPriceHistory(null); setPriceHistoryRows([]) }}>
              Close
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {confirmRevert && (
        <Modal onClose={() => setConfirmRevert(null)}>
          <h2 className="m-0 pr-8 text-lg">Revert this import?</h2>
          <p className="mt-2 text-sm text-brand-slate">
            This reverses stock added by <strong>{confirmRevert.filename}</strong> and deactivates products
            created in that batch. Sales already made from those items are not voided.
          </p>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirmRevert(null)}>Cancel</SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy} onClick={doRevert}>Revert import</PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default ManagerData
