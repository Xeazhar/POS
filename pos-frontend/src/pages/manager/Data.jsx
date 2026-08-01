import { useEffect, useState } from 'react'
import { FiSearch, FiUpload } from 'react-icons/fi'
import * as XLSX from 'xlsx'
import {
  Field,
  Modal,
  ModalActions,
  PageHeader,
  Pager,
  PrimaryButton,
  SearchBox,
  SecondaryButton,
  SelectField,
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
} from '../../lib/api'
import { useAuthStore, useProductStore } from '../../stores/posStore'
import { buildImportPreview, sha256Hex } from '../../utils/inventoryImport'
import { money, qty } from '../../utils/format'
import { decimalOnly } from '../../utils/validate'

const OFFLINE_KEY = 'cale-import-batches-v1'
const PAGE_SIZE = 10

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
  const [branches, setBranches] = useState([])
  const [branchId, setBranchId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState([])
  const [products, setProducts] = useState([])
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState(null)
  const [duplicate, setDuplicate] = useState(null)
  const [acknowledgeDuplicate, setAcknowledgeDuplicate] = useState(false)
  const [detailBatch, setDetailBatch] = useState(null)
  const [detailItems, setDetailItems] = useState([])
  const [confirmRevert, setConfirmRevert] = useState(null)
  const [priceEdit, setPriceEdit] = useState(null)
  const [priceValue, setPriceValue] = useState('')

  const refreshCatalog = async (id = branchId) => {
    if (!id) {
      setProducts([])
      return
    }
    if (!hasSupabase) {
      setProducts(useProductStore.getState().products.filter((p) => !p.branchId || p.branchId === id))
      return
    }
    const data = await bootstrapBranchData(id)
    setProducts(data.products)
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
    if (!hasSupabase) {
      setBranches([{ id: user?.branchId || 'demo-main-branch', name: user?.branchName || 'Demo branch' }])
      setBranchId(user?.branchId || 'demo-main-branch')
      return
    }
    fetchBranches()
      .then((rows) => {
        setBranches(rows)
        setBranchId(rows[0]?.id || '')
      })
      .catch((err) => setError(err.message))
  }, [user])

  useEffect(() => {
    if (!branchId && hasSupabase) return
    setPage(0)
    Promise.all([refreshHistory(branchId), refreshCatalog(branchId)]).catch((err) => setError(err.message))
  }, [branchId])

  useEffect(() => {
    setPage(0)
  }, [query])

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
        ...buildImportPreview(rawRows, catalog),
        filename: file.name,
        fileHash,
        branchId,
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
    try {
      if (hasSupabase) {
        await commitInventoryImport({
          branchId: preview.branchId,
          staffId: user.id,
          filename: preview.filename,
          fileHash: preview.fileHash,
          preview,
        })
      } else {
        await useProductStore.getState().importInventoryRows(preview.lines.map((line) => line.values))
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
    } catch (err) {
      setError(err.message || 'Import failed')
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
      setError(err.message || 'Price update failed')
    } finally {
      setBusy(false)
    }
  }

  const canCommit = preview && (!duplicate || acknowledgeDuplicate) && preview.lines.length > 0
  const filtered = products.filter((product) =>
    [product.name, product.sku, product.barcode].some((value) =>
      String(value || '').toLowerCase().includes(query.toLowerCase()),
    ),
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  return (
    <div>
      <PageHeader eyebrow="MANAGER" title="Inventory data" />
      <p className="mb-4 max-w-3xl text-xs text-brand-muted">
        Browse and update branch pricing, or import CSV/XLSX. Import columns: name, sku, barcode, category,
        pricingMode (kg or pc), price, stock.
      </p>

      <TableCard className="mb-4 max-h-none p-5">
        <div className="grid grid-cols-[1fr_auto] items-end gap-3 max-[700px]:grid-cols-1">
          <SelectField
            label="Branch"
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
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-[5px] border border-brand-border bg-white px-4 text-xs font-bold text-[#4d534f]">
            <FiUpload /> Choose file
            <input className="hidden" type="file" accept=".csv,.xlsx,.xls" disabled={busy || !branchId} onChange={onFile} />
          </label>
        </div>
        {error && <p className="mt-3 text-xs text-brand-danger">{error}</p>}
      </TableCard>

      <TableCard className="mb-4 max-h-none">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-brand-softline px-5 py-3">
          <div>
            <h2 className="m-0 text-base">Branch catalog</h2>
            <p className="m-0 mt-1 text-[11px] text-brand-subtle">{products.length} products · edit price from the table</p>
          </div>
          <SearchBox
            className="w-full max-w-[280px]"
            icon={<FiSearch />}
            placeholder="Search catalog"
            value={query}
            onChange={(e) => setQuery(e.target.value.replace(/[<>]/g, ''))}
          />
        </div>
        <div className="overflow-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
              <tr>
                <th className="px-5 py-3 w-10">#</th>
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
              {pageRows.map((product, index) => (
                <tr key={product.id} className="border-t border-brand-softline">
                  <td className="px-5 py-3 tabular-nums text-brand-subtle">{pageIndex * PAGE_SIZE + index + 1}</td>
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
                    <button
                      type="button"
                      className="border-0 bg-transparent text-xs font-bold text-brand-ink underline"
                      onClick={() => openPriceEdit(product)}
                    >
                      Edit price
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && (
            <div className="px-5 py-6 text-xs text-brand-subtle">No products for this branch yet. Import a file to start.</div>
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

      <TableCard className="max-h-none">
        <div className="border-b border-brand-softline px-5 py-3">
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
                      {batch.status === 'committed' && (
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
        <Modal wide className="w-[min(720px,calc(100%-32px))]" onClose={() => setDetailBatch(null)}>
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
