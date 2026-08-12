import { useEffect, useMemo, useState } from 'react'
import { FiPlus, FiSearch } from 'react-icons/fi'
import {
  ErrorBanner,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  Pager,
  PrimaryButton,
  SearchBox,
  SecondaryButton,
  SelectField,
  SkeletonRows,
  TableCard,
  tableHeadClass,
  tableRowClass,
} from '../ui'
import {
  adoptCatalogProducts,
  bootstrapBranchData,
  fetchCatalogProducts,
  hasSupabase,
  updateProductRow,
} from '../../lib/api'
import {
  isOnline,
  readBranchSnapshot,
  readCatalogCache,
  writeCatalogCache,
} from '../../offline'
import { withTimeout } from '../../utils/withTimeout'
import { useAuthStore, useProductStore } from '../../stores/posStore'
import { money, qty } from '../../utils/format'
import { formatSupportError } from '../../utils/errors'

const PAGE_SIZE = 10

/**
 * Supervisor Catalog — same branch product table as before.
 * "Add item" opens a picker from the network catalog (filtered by branch type).
 * No manual field form, no CSV import (import lives on Inventory).
 */
export default function SupervisorCatalogAdopt() {
  const user = useAuthStore((s) => s.user)
  const setStoreProducts = useProductStore((s) => s.setProducts)
  const isRestaurant = user?.branchType === 'restaurant'
  const branchType = isRestaurant ? 'restaurant' : 'retail'

  const [products, setProducts] = useState([])
  const [catalog, setCatalog] = useState([])
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [stockFilter, setStockFilter] = useState('all')
  const [modeFilter, setModeFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [discountBusyId, setDiscountBusyId] = useState(null)

  const [showAdd, setShowAdd] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [loading, setLoading] = useState(true)

  const reload = async () => {
    if (!hasSupabase || !user?.branchId) {
      setProducts([])
      setCatalog([])
      setLoading(false)
      return
    }
    if (!isOnline()) {
      const local = await readBranchSnapshot(user.branchId)
      const cachedCatalog = (await readCatalogCache(branchType)) || []
      setProducts(local.products || [])
      setStoreProducts(local.products || [])
      setCatalog(cachedCatalog)
      setLoading(false)
      return
    }
    try {
      const [branch, catRows] = await Promise.all([
        withTimeout(bootstrapBranchData(user.branchId), 15000, 'Branch catalog'),
        withTimeout(fetchCatalogProducts({ branchType }), 15000, 'Network catalog'),
      ])
      setProducts(branch.products || [])
      setStoreProducts(branch.products || [])
      setCatalog(catRows || [])
      await writeCatalogCache(branchType, catRows || [])
    } catch {
      const local = await readBranchSnapshot(user.branchId)
      const cachedCatalog = (await readCatalogCache(branchType)) || []
      setProducts(local.products || [])
      setStoreProducts(local.products || [])
      setCatalog(cachedCatalog)
    }
    setLoading(false)
  }

  useEffect(() => {
    setLoading(true)
    reload().catch((err) => {
      setError(err.message)
      setLoading(false)
    })
  }, [user?.branchId, branchType])

  useEffect(() => {
    setPage(0)
  }, [query, categoryFilter, stockFilter, modeFilter])

  const branchSkus = useMemo(
    () => new Set(products.map((p) => String(p.sku || '').toLowerCase().trim()).filter(Boolean)),
    [products],
  )

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    [products],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((product) => {
      if (q) {
        const hay = `${product.productCode || ''} ${product.name} ${product.sku} ${product.barcode || ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      if (categoryFilter !== 'All' && product.category !== categoryFilter) return false
      if (!isRestaurant && stockFilter !== 'all') {
        if (stockFilter === 'out') {
          if (Number(product.stock) > 0) return false
        } else if (stockFilter !== 'all') {
          const tone =
            Number(product.stock) <= 0
              ? 'out'
              : Number(product.stock) <= Number(product.lowStockAt || 10)
                ? 'low'
                : Number(product.stock) <= Number(product.mediumStockAt || 30)
                  ? 'fair'
                  : 'good'
          if (tone !== stockFilter && !(stockFilter === 'out' && tone === 'out')) {
            if (stockFilter === 'low' && tone !== 'low') return false
            if (stockFilter === 'fair' && tone !== 'fair') return false
            if (stockFilter === 'good' && tone !== 'good') return false
          }
        }
      }
      if (isRestaurant && stockFilter === 'on' && product.availableToday === false) return false
      if (isRestaurant && stockFilter === 'off' && product.availableToday !== false) return false
      if (!isRestaurant && modeFilter !== 'all' && product.pricingMode !== modeFilter) return false
      return true
    })
  }, [products, query, categoryFilter, stockFilter, modeFilter, isRestaurant])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  const availableCatalog = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase()
    return catalog.filter((row) => {
      if (branchSkus.has(String(row.sku || '').toLowerCase().trim())) return false
      if (!q) return true
      return [row.name, row.sku, row.barcode, row.category].some((v) =>
        String(v || '').toLowerCase().includes(q),
      )
    })
  }, [catalog, branchSkus, pickerQuery])

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // "All" tracks the currently FILTERED list, not every selection ever made — narrowing
  // pickerQuery after selecting some items must not make the header checkbox forget them.
  const allVisibleSelected =
    availableCatalog.length > 0 && availableCatalog.every((row) => selected.has(row.id))
  const someVisibleSelected = !allVisibleSelected && availableCatalog.some((row) => selected.has(row.id))
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) availableCatalog.forEach((row) => next.delete(row.id))
      else availableCatalog.forEach((row) => next.add(row.id))
      return next
    })
  }

  const openAdd = () => {
    setSelected(new Set())
    setPickerQuery('')
    setShowAdd(true)
    setError('')
    setMessage('')
  }

  const adopt = async () => {
    if (!selected.size) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const count = await adoptCatalogProducts({
        branchId: user.branchId,
        catalogIds: [...selected],
        staffId: user.id,
      })
      setShowAdd(false)
      setSelected(new Set())
      setMessage(`Added ${count} product(s) to this branch. Use Inventory to set stock.`)
      await reload()
    } catch (err) {
      setError(formatSupportError(err, 'CAT01'))
    } finally {
      setBusy(false)
    }
  }

  // Edits this branch's own product (products table) — not the shared network
  // catalog template. Toggling "Discountable" in the network catalog only sets
  // the default for future adoptions, it does not change items already adopted.
  const toggleDiscountable = async (product) => {
    setDiscountBusyId(product.id)
    setError('')
    const next = !product.discountEligible
    try {
      await updateProductRow(
        product.id,
        {
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          category: product.category,
          menuKind: product.menuKind,
          pricingMode: product.pricingMode,
          price: product.price,
          budgetPrice: product.budgetPrice,
          lowStockAt: product.lowStockAt,
          discountEligible: next,
        },
        { branchId: user.branchId, staffId: user.id, previousPrice: product.price },
      )
      const updated = products.map((p) => (p.id === product.id ? { ...p, discountEligible: next } : p))
      setProducts(updated)
      setStoreProducts(updated)
    } catch (err) {
      setError(formatSupportError(err, 'CAT05'))
    } finally {
      setDiscountBusyId(null)
    }
  }

  if (loading && !products.length) {
    return <PageSkeleton variant="table" />
  }

  return (
    <div>
      <PageHeader eyebrow="CATALOG" title="Branch products">
        <span className="text-xs text-brand-muted">
          {isRestaurant ? 'Restaurant menu items' : 'Retail goods'} · select from network catalog to add
        </span>
      </PageHeader>

      <TableCard className="mb-4 max-h-none overflow-visible p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <p className="m-0 text-xs text-brand-muted sm:pb-1">
            Branch: <strong className="text-brand-ink">{user?.branchName || 'Assigned branch'}</strong>
          </p>
          <PrimaryButton
            compact
            type="button"
            className="!h-8 !min-h-0 !gap-1 !px-2.5 !text-[11px]"
            disabled={busy}
            onClick={openAdd}
          >
            <FiPlus className="text-sm" /> Add item
          </PrimaryButton>
        </div>
        {error && <ErrorBanner className="mt-3 mb-0" error={error} onDismiss={() => setError('')} />}
        {message && (
          <p className="mt-3 mb-0 rounded-md bg-brand-success-bg px-3 py-2 text-xs text-brand-success">{message}</p>
        )}
      </TableCard>

      <TableCard className="mb-4 max-h-none">
        <div className="flex flex-col gap-3 border-b border-brand-softline px-5 py-4">
          <div className="min-w-0">
            <h2 className="m-0 text-base">Branch products</h2>
            <p className="m-0 mt-1 text-[11px] text-brand-subtle">
              {filtered.length} shown · {products.length} total
            </p>
          </div>
          {/* Search belongs ON the filter row, not floated opposite the heading — it is a
              filter like the other three, and splitting it out made the controls read as
              two unrelated groups. `label` gives it the same height as the selects. */}
          <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-4">
            <SearchBox
              label="Search"
              icon={<FiSearch />}
              placeholder="ID, name, SKU, barcode"
              value={query}
              onChange={(e) => setQuery(e.target.value.replace(/[<>]/g, ''))}
            />
            <SelectField label="Category" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="All">All categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </SelectField>
            {!isRestaurant && (
              <SelectField label="Stock" value={stockFilter} onChange={(e) => setStockFilter(e.target.value)}>
                <option value="all">All stock</option>
                <option value="low">Low</option>
                <option value="fair">Fair</option>
                <option value="good">Good</option>
                <option value="out">Out of stock</option>
              </SelectField>
            )}
            {isRestaurant && (
              <SelectField label="Serving" value={stockFilter} onChange={(e) => setStockFilter(e.target.value)}>
                <option value="all">All items</option>
                <option value="on">On today</option>
                <option value="off">Off today</option>
              </SelectField>
            )}
            {!isRestaurant && (
              <SelectField label="Pricing" value={modeFilter} onChange={(e) => setModeFilter(e.target.value)}>
                <option value="all">All modes</option>
                <option value="pc">Per pc</option>
                <option value="kg">Per kg</option>
              </SelectField>
            )}
          </div>
        </div>
        <div className="overflow-auto">
          <table className="min-w-full text-left text-xs">
            <thead className={tableHeadClass}>
              <tr>
                <th className="px-5 py-3">ID</th>
                <th className="px-5 py-3">Product</th>
                <th className="px-5 py-3">SKU</th>
                <th className="px-5 py-3 max-[700px]:hidden">Barcode</th>
                <th className="px-5 py-3 max-[700px]:hidden">Category</th>
                <th className="px-5 py-3 max-[700px]:hidden">Mode</th>
                <th className="px-5 py-3 text-center">Discountable</th>
                <th className="px-5 py-3 text-right">Price</th>
                <th className="px-5 py-3 text-right">On hand</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="p-0">
                    <SkeletonRows rows={8} cols={5} />
                  </td>
                </tr>
              ) : (
              pageRows.map((product) => (
                <tr key={product.id} className={tableRowClass}>
                  <td className="px-5 py-3 tabular-nums font-bold text-brand-ink">
                    {product.productCode || '—'}
                  </td>
                  <td className="px-5 py-3">
                    <strong className="block text-brand-ink">{product.name}</strong>
                  </td>
                  <td className="px-5 py-3">{product.sku}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{product.barcode || '—'}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{product.category}</td>
                  <td className="px-5 py-3 max-[700px]:hidden">{product.pricingMode}</td>
                  <td className="px-5 py-3 text-center">
                    <button
                      type="button"
                      className={`rounded-full px-2 py-1 text-[10px] font-bold disabled:opacity-50 ${
                        product.discountEligible
                          ? 'bg-brand-success-bg text-brand-success-text'
                          : 'bg-brand-n200 text-brand-subtle'
                      }`}
                      disabled={discountBusyId === product.id}
                      onClick={() => toggleDiscountable(product)}
                      title="Toggle PWD/Senior discount eligibility for this branch's product"
                    >
                      {discountBusyId === product.id ? '…' : product.discountEligible ? 'Yes' : 'No'}
                    </button>
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums font-bold text-brand-ink">
                    {money(product.price)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {qty(product.stock, product.pricingMode === 'kg' ? 'kg' : 'pc')}
                  </td>
                </tr>
              ))
              )}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <div className="px-5 py-6 text-xs text-brand-subtle">
              No products on this branch yet. Click Add item to select from the network catalog.
            </div>
          )}
        </div>
        {!loading && pageCount > 1 && (
          <Pager
            page={pageIndex + 1}
            pageCount={pageCount}
            total={filtered.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        )}
      </TableCard>

      {showAdd && (
        <Modal wide onClose={() => !busy && setShowAdd(false)}>
          <h2 className="m-0 mb-1 text-lg">Add from network catalog</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            Showing {isRestaurant ? 'restaurant' : 'retail'} products not yet on this branch. Select items, then
            add.
          </p>
          <SearchBox
            className="mb-3"
            icon={<FiSearch />}
            placeholder="Search catalog…"
            value={pickerQuery}
            onChange={(e) => setPickerQuery(e.target.value)}
          />
          <div className="max-h-[min(50vh,360px)] overflow-auto rounded border border-brand-softline">
            <div className="grid grid-cols-[2rem_1.4fr_0.9fr_0.9fr_0.7fr] gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[700px]:grid-cols-[2rem_1fr_0.8fr]">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someVisibleSelected
                }}
                onChange={toggleAll}
                disabled={availableCatalog.length === 0}
                aria-label="Select all"
              />
              <span>Product</span>
              <span className="max-[700px]:hidden">SKU</span>
              <span className="max-[700px]:hidden">Category</span>
              <span className="text-right">Price</span>
            </div>
            {availableCatalog.map((row) => (
              <label
                key={row.id}
                className={`grid cursor-pointer grid-cols-[2rem_1.4fr_0.9fr_0.9fr_0.7fr] items-center gap-2 px-3 py-2 text-xs max-[700px]:grid-cols-[2rem_1fr_0.8fr] ${tableRowClass}`}
              >
                <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} />
                <strong className="truncate text-brand-ink">{row.name}</strong>
                <span className="truncate max-[700px]:hidden">{row.sku}</span>
                <span className="truncate max-[700px]:hidden">{row.category || '—'}</span>
                <span className="text-right tabular-nums">{money(row.price)}</span>
              </label>
            ))}
            {availableCatalog.length === 0 && (
              <div className="px-3 py-6 text-xs text-brand-subtle">
                {catalog.length === 0
                  ? `No ${branchType} catalog products yet. Ask a manager to add them.`
                  : 'All matching catalog products are already on this branch.'}
              </div>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" disabled={busy} onClick={() => setShowAdd(false)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={busy || !selected.size} onClick={adopt}>
              {busy ? 'Adding…' : `Add selected (${selected.size})`}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}
