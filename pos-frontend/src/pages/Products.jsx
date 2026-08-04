import { useEffect, useState } from 'react'
import { FiEdit2, FiSearch, FiX } from 'react-icons/fi'
import {
  Eyebrow,
  Field,
  Modal,
  ModalActions,
  PageHeader,
  Pager,
  PrimaryButton,
  SearchBox,
  SecondaryButton,
  SelectField,
  StockBadge,
  TableCard,
} from '../components/ui'
import { useAuthStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { money, qty, today, formatDate, stockTone } from '../utils/format'
import {
  decimalOnly,
  digitsOnly,
  duplicateField,
  findProductDuplicate,
  sanitizeText,
} from '../utils/validate'
import { hasSupabase } from '../lib/api'

const PAGE_SIZE = 10

const emptyForm = {
  name: '',
  sku: '',
  barcode: '',
  category: 'Groceries',
  menuKind: 'meat',
  pricingMode: 'pc',
  price: '',
  budgetPrice: '',
  stock: '',
}

function Products() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const updateProduct = useProductStore((state) => state.updateProduct)
  const toggleAvailableToday = useProductStore((state) => state.toggleAvailableToday)
  const movements = useInventoryStore((state) => state.movements)
  const addMovement = useInventoryStore((state) => state.addMovement)
  const [query, setQuery] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All')
  const [stockFilter, setStockFilter] = useState('all')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [confirmSave, setConfirmSave] = useState(false)
  const [confirmAdjust, setConfirmAdjust] = useState(null)

  useEffect(() => {
    setPage(0)
  }, [query, categoryFilter, stockFilter])

  const close = () => {
    setSelected(null)
    setEditing(false)
    setError('')
    setConfirmSave(false)
    setConfirmAdjust(null)
  }

  const open = (product) => {
    if (!product) return
    setSelected(product.id)
    setEditing(false)
    setError('')
    setForm({
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      category: product.category,
      menuKind: product.menuKind || 'extra',
      pricingMode: product.pricingMode,
      price: String(product.price),
      budgetPrice: product.budgetPrice != null ? String(product.budgetPrice) : '',
      stock: String(product.stock ?? ''),
    })
  }

  const setField = (key, value) => {
    let next = value
    if (key === 'barcode') next = digitsOnly(value)
    else if (key === 'price' || key === 'stock' || key === 'budgetPrice') next = decimalOnly(value)
    else if (key === 'name' || key === 'sku') next = value.replace(/[<>]/g, '')
    setForm((prev) => ({ ...prev, [key]: next }))
    setError('')
  }

  const validateForm = () => {
    const name = sanitizeText(form.name)
    const sku = sanitizeText(form.sku)
    const barcode = digitsOnly(form.barcode)
    if (!name || !sku) return 'Name and SKU are required.'
    if (!isRestaurant && !barcode) return 'Name, SKU, and barcode are required.'
    if (barcode && !/^\d+$/.test(barcode)) return 'Barcode must contain numbers only.'
    if (form.price === '' || Number(form.price) < 0) return 'Enter a valid price.'
    if (
      isRestaurant &&
      form.budgetPrice !== '' &&
      (Number.isNaN(Number(form.budgetPrice)) || Number(form.budgetPrice) < 0)
    ) {
      return 'Enter a valid budget price (or leave blank).'
    }
    if (!isRestaurant && (form.stock === '' || Number.isNaN(Number(form.stock)))) {
      return 'Enter a valid stock amount.'
    }
    const duplicate = findProductDuplicate(products, { name, sku, barcode }, selected)
    if (duplicate) return `Duplicate ${duplicateField(duplicate, { name, sku, barcode })} already exists.`
    return null
  }

  const commitSave = async () => {
    const previous = products.find((item) => item.id === selected)
    const values = {
      name: sanitizeText(form.name),
      sku: sanitizeText(form.sku),
      barcode: digitsOnly(form.barcode),
      category: form.category,
      menuKind: isRestaurant ? form.menuKind : undefined,
      pricingMode: form.pricingMode,
      price: Number(form.price),
      budgetPrice:
        isRestaurant && form.budgetPrice !== '' ? Number(form.budgetPrice) : null,
      stock: Number(form.stock),
      lowStockAt: previous?.lowStockAt ?? 5,
    }
    try {
      await updateProduct(selected, values)
      if (!hasSupabase && previous && previous.stock !== values.stock) {
        const delta = Number((values.stock - previous.stock).toFixed(2))
        await addMovement({
          date: today(),
          productId: selected,
          product: values.name,
          type: 'Adjustment',
          quantityChange: delta,
          resultingStock: values.stock,
        })
      }
      setForm({ ...form, name: values.name, sku: values.sku, barcode: values.barcode, stock: String(values.stock) })
      setEditing(false)
      setConfirmSave(false)
    } catch (err) {
      setError(err.message || 'Save failed')
      setConfirmSave(false)
    }
  }

  const requestSave = (event) => {
    event.preventDefault()
    const message = validateForm()
    if (message) {
      setError(message)
      return
    }
    setConfirmSave(true)
  }

  const requestAdjust = (event) => {
    event.preventDefault()
    const amount = Number(decimalOnly(event.currentTarget.quantity.value))
    const action = event.currentTarget.action.value
    if (!amount || amount <= 0) {
      setError('Enter a valid adjustment quantity.')
      return
    }
    if (action === 'Shrinkage' && form.category !== 'Meat') {
      setError('Shrinkage is only available for Meat products.')
      return
    }
    setConfirmAdjust({ amount, action })
    event.currentTarget.reset()
  }

  const commitAdjust = async () => {
    const { amount, action } = confirmAdjust
    const signed = action === 'Restock' ? amount : -amount
    const product = products.find((item) => item.id === selected)
    const stock = Number((product.stock + signed).toFixed(2))
    try {
      if (hasSupabase) {
        await addMovement({
          productId: selected,
          product: product.name,
          action,
          amount,
        })
        const refreshed = useProductStore.getState().products.find((item) => item.id === selected)
        setForm((prev) => ({ ...prev, stock: String(refreshed?.stock ?? stock) }))
      } else {
        await updateProduct(selected, { stock })
        await addMovement({
          date: today(),
          productId: selected,
          product: product.name,
          type: action,
          quantityChange: signed,
          resultingStock: stock,
        })
        setForm((prev) => ({ ...prev, stock: String(stock) }))
      }
      setConfirmAdjust(null)
    } catch (err) {
      setError(err.message || 'Adjustment failed')
      setConfirmAdjust(null)
    }
  }

  const unit = form.pricingMode === 'kg' ? 'kg' : 'pc'
  const productMovements = movements.filter((movement) => movement.productId === selected)
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))].sort()
  const list = products.filter((product) => {
    const q = query.toLowerCase()
    if (q) {
      const hit = [product.name, product.sku, product.barcode].some((value) =>
        String(value || '').toLowerCase().includes(q),
      )
      if (!hit) return false
    }
    if (categoryFilter !== 'All' && product.category !== categoryFilter) return false
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
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = list.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  return (
    <div>
      <PageHeader
        eyebrow={isRestaurant ? 'CARINDERIA MENU' : 'STOCK CONTROL'}
        title={isRestaurant ? 'Menu / potahe' : 'Inventory'}
      >
        <span className="text-xs text-[#797e7b]">
          {products.length} {isRestaurant ? 'items' : 'SKUs'}
        </span>
      </PageHeader>
      <div className="mb-[18px] flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
        <SearchBox
          className="w-full max-w-[330px]"
          icon={<FiSearch />}
          placeholder="Search name, SKU or barcode"
          value={query}
          onChange={(event) => setQuery(event.target.value.replace(/[<>]/g, ''))}
        />
        <SelectField
          label="Category"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="w-full max-w-[180px]"
        >
          <option value="All">All categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </SelectField>
        {isRestaurant ? (
          <SelectField
            label="Serving"
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value)}
            className="w-full max-w-[160px]"
          >
            <option value="all">All items</option>
            <option value="on">On today</option>
            <option value="off">Off today</option>
          </SelectField>
        ) : (
          <SelectField
            label="Stock"
            value={stockFilter}
            onChange={(e) => setStockFilter(e.target.value)}
            className="w-full max-w-[160px]"
          >
            <option value="all">All stock</option>
            <option value="low">Low</option>
            <option value="fair">Fair</option>
            <option value="good">Good</option>
            <option value="out">Out of stock</option>
          </SelectField>
        )}
      </div>
      {error && isRestaurant && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>
      )}
      <TableCard>
        <div className={`grid gap-3 border-0 bg-[#f7f7f4] px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase ${
          isRestaurant
            ? 'grid-cols-[2.5rem_1.5fr_1fr_0.7fr_0.8fr] max-[700px]:grid-cols-[2rem_1.4fr_0.8fr]'
            : 'grid-cols-[2.5rem_1.5fr_0.7fr_0.8fr_0.7fr_0.9fr_0.9fr] max-[700px]:grid-cols-[2rem_1.4fr_0.8fr_0.7fr]'
        }`}>
          <span>#</span>
          <span>{isRestaurant ? 'Potahe' : 'Product'}</span>
          <span className="max-[700px]:hidden">{isRestaurant ? 'Plate' : 'Type'}</span>
          {isRestaurant ? (
            <>
              <span className="text-center">Today</span>
              <span className="text-right">Price</span>
            </>
          ) : (
            <>
              <span className="text-right tabular-nums">On hand</span>
              <span className="text-center">Status</span>
              <span className="text-right max-[700px]:hidden">Updated</span>
              <span className="text-right max-[700px]:hidden">Last move</span>
            </>
          )}
        </div>
        {pageRows.map((product, index) => {
          const tone = stockTone(product)
          const label = tone === 'low' ? 'Low' : tone === 'fair' ? 'Fair' : 'Good'
          return (
            <div
              key={product.id}
              role={isRestaurant ? undefined : 'button'}
              tabIndex={isRestaurant ? undefined : 0}
              className={`grid items-center gap-3 border-t border-brand-softline px-5 py-[17px] text-xs text-brand-slate ${
                isRestaurant
                  ? 'grid-cols-[2.5rem_1.5fr_1fr_0.7fr_0.8fr] max-[700px]:grid-cols-[2rem_1.4fr_0.8fr]'
                  : 'tap-row cursor-pointer grid-cols-[2.5rem_1.5fr_0.7fr_0.8fr_0.7fr_0.9fr_0.9fr] hover:bg-[#fafaf7] active:bg-[#f0f1ec] max-[700px]:grid-cols-[2rem_1.4fr_0.8fr_0.7fr]'
              }`}
              onClick={isRestaurant ? undefined : () => open(product)}
              onKeyDown={
                isRestaurant
                  ? undefined
                  : (event) => {
                      if (event.key === 'Enter' || event.key === ' ') open(product)
                    }
              }
            >
              <span className="tabular-nums text-brand-subtle">{pageIndex * PAGE_SIZE + index + 1}</span>
              <div>
                <strong className="block text-brand-ink">{product.name}</strong>
                <small className="text-[10px] text-brand-subtle">{product.sku}</small>
              </div>
              <span className="max-[700px]:hidden">{isRestaurant ? product.category : product.pricingMode === 'kg' ? 'Meat' : 'Retail'}</span>
              {isRestaurant ? (
                <>
                  <span className="justify-self-center">
                    <button
                      type="button"
                      className={`rounded-full px-2 py-1 text-[10px] font-bold ${
                        product.availableToday !== false
                          ? 'bg-brand-success-bg text-brand-success-text'
                          : 'bg-[#eceee9] text-brand-subtle'
                      }`}
                      onClick={async () => {
                        try {
                          await toggleAvailableToday(product.id)
                        } catch (err) {
                          setError(err.message)
                        }
                      }}
                    >
                      {product.availableToday !== false ? 'Serving' : 'Off'}
                    </button>
                  </span>
                  <span className="text-right tabular-nums font-bold text-brand-ink">{money(product.price)}</span>
                </>
              ) : (
                <>
                  <span className="text-right tabular-nums">
                    {qty(product.stock, product.pricingMode === 'kg' ? 'kg' : 'pc')}
                  </span>
                  <span className="justify-self-center">
                    <StockBadge tone={tone}>{label}</StockBadge>
                  </span>
                  <span className="text-right max-[700px]:hidden">{formatDate(product.updatedAt)}</span>
                  <span className="text-right max-[700px]:hidden">{formatDate(product.lastMovementAt)}</span>
                </>
              )}
            </div>
          )
        })}
        {list.length === 0 && (
          <div className="border-t border-brand-softline px-5 py-6 text-xs text-brand-subtle">No products found.</div>
        )}
        {list.length > 0 && (
          <Pager
            page={pageIndex + 1}
            pageCount={pageCount}
            total={list.length}
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        )}
      </TableCard>

      {selected && !isRestaurant && (
        <div className="fixed inset-0 z-[5] bg-[#20242666]" onClick={close}>
          <aside
            className="absolute top-0 right-0 h-full w-[min(560px,92vw)] overflow-auto bg-white p-7 shadow-[-8px_0_24px_#20242622]"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="absolute top-[17px] right-[17px] border-0 bg-transparent text-lg text-[#6e7470]"
              onClick={close}
            >
              <FiX />
            </button>
            <Eyebrow>PRODUCT DETAIL</Eyebrow>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="m-0 text-lg capitalize">{form.name || 'Product'}</h2>
              {!editing && (
                <SecondaryButton compact type="button" onClick={() => setEditing(true)}>
                  <FiEdit2 /> Edit
                </SecondaryButton>
              )}
            </div>
            {typeof form.discountEligible === 'boolean' && (
              <p className="m-0 mb-2 text-[11px] text-brand-subtle">
                Discountable: {form.discountEligible ? 'Yes' : 'No'}
              </p>
            )}
            {error && (
              <p className="my-2 mb-3 rounded-md bg-brand-danger-bg px-2.5 py-2 text-xs text-brand-danger">{error}</p>
            )}

            <h3 className="mt-[22px] mb-2.5 text-sm">Movement history</h3>
                <div className="rounded-none border border-brand-sheet">
                  <div className="grid grid-cols-[1.2fr_0.9fr_1.4fr_1fr] gap-1.5 bg-brand-sheet-head p-2 text-[11px] font-bold">
                    <span>Type</span>
                    <span>Date</span>
                    <span>Change</span>
                    <span className="text-right tabular-nums">Balance</span>
                  </div>
                  {productMovements.length === 0 ? (
                    <div className="border-t border-brand-sheet-line p-2 text-[11px] text-brand-subtle">
                      No movements yet.
                    </div>
                  ) : (
                    productMovements.map((movement, index) => {
                      const isPrice =
                        movement.movementType === 'price_change' || movement.type === 'Price change'
                      return (
                        <div
                          key={movement.id}
                          className={`grid grid-cols-[1.2fr_0.9fr_1.4fr_1fr] gap-1.5 border-t border-brand-sheet-line p-2 text-[11px] ${
                            index % 2 === 0 ? 'bg-white' : 'bg-brand-sheet-alt'
                          }`}
                        >
                          <span className={isPrice ? 'font-bold text-brand-ink' : ''}>{movement.type}</span>
                          <span>{movement.date}</span>
                          <span className="tabular-nums">
                            {isPrice
                              ? `${money(movement.oldPrice)} → ${money(movement.newPrice)}`
                              : movement.quantityChange > 0
                                ? `+${qty(movement.quantityChange, unit)}`
                                : movement.quantityChange < 0
                                  ? `−${qty(Math.abs(movement.quantityChange), unit)}`
                                  : '—'}
                          </span>
                          <strong
                            className={`text-right tabular-nums ${
                              !isPrice && movement.resultingStock < 0 ? 'text-brand-danger' : ''
                            }`}
                          >
                            {isPrice ? '—' : qty(movement.resultingStock, unit)}
                          </strong>
                        </div>
                      )
                    })
                  )}
                </div>

                <form className="mt-5 grid gap-4 border-t border-brand-sheet-head pt-5" onSubmit={requestAdjust}>
                  <h3 className="m-0 text-sm">Adjust stock</h3>
                  <SelectField label="Action" name="action" defaultValue="Restock">
                    <option>Restock</option>
                    <option>Adjustment</option>
                    {form.category === 'Meat' && <option>Shrinkage</option>}
                  </SelectField>
                  <Field
                    label="Quantity"
                    name="quantity"
                    required
                    inputMode="decimal"
                    onChange={(event) => {
                      event.target.value = decimalOnly(event.target.value)
                    }}
                  />
                  <div>
                    <PrimaryButton compact type="submit">
                      Save adjustment
                    </PrimaryButton>
                  </div>
                </form>

            {editing ? (
              <form className="mt-3.5 grid gap-3" onSubmit={requestSave}>
                <h3 className="m-0 text-sm">Edit product</h3>
                <Field label="Product name" required value={form.name} onChange={(e) => setField('name', e.target.value)} />
                <Field label="SKU / item code" required value={form.sku} onChange={(e) => setField('sku', e.target.value)} />
                <Field
                  label="Barcode"
                  required
                  inputMode="numeric"
                  value={form.barcode}
                  onChange={(e) => setField('barcode', e.target.value)}
                />
                <SelectField label="Category" value={form.category} onChange={(e) => setField('category', e.target.value)}>
                  {isRestaurant ? (
                    <>
                      <option>Meat</option>
                      <option>Veggie</option>
                      <option>Pancit</option>
                      <option>Drink</option>
                      <option>Rice</option>
                      <option>Extra</option>
                    </>
                  ) : (
                    <>
                      <option>Groceries</option>
                      <option>Bakery</option>
                      <option>Meat</option>
                    </>
                  )}
                </SelectField>
                {isRestaurant && (
                  <SelectField
                    label="Menu kind"
                    value={form.menuKind}
                    onChange={(e) => {
                      const kind = e.target.value
                      setForm((prev) => ({
                        ...prev,
                        menuKind: kind,
                        category:
                          kind === 'meat'
                            ? 'Meat'
                            : kind === 'veggie'
                              ? 'Veggie'
                              : kind === 'pancit'
                                ? 'Pancit'
                                : kind === 'drink'
                                  ? 'Drink'
                                  : kind === 'rice'
                                    ? 'Rice'
                                    : 'Extra',
                      }))
                    }}
                  >
                    <option value="meat">Meat ulam</option>
                    <option value="veggie">Veggie ulam</option>
                    <option value="pancit">Pancit</option>
                    <option value="drink">Drinks</option>
                    <option value="rice">Rice</option>
                    <option value="extra">Extra</option>
                  </SelectField>
                )}
                {!isRestaurant && (
                  <SelectField
                    label="Pricing mode"
                    value={form.pricingMode}
                    onChange={(e) => setField('pricingMode', e.target.value)}
                  >
                    <option value="pc">Price per pc</option>
                    <option value="kg">Price per kg</option>
                  </SelectField>
                )}
                <Field
                  label={isRestaurant ? 'Regular price' : 'Price'}
                  required
                  inputMode="decimal"
                  value={form.price}
                  onChange={(e) => setField('price', e.target.value)}
                />
                {isRestaurant && (form.menuKind === 'meat' || form.menuKind === 'veggie') && (
                  <Field
                    label="Budget price"
                    inputMode="decimal"
                    value={form.budgetPrice}
                    onChange={(e) => setField('budgetPrice', e.target.value)}
                    placeholder="Optional"
                  />
                )}
                {!isRestaurant && (
                  <Field
                    label="Current stock"
                    required
                    inputMode="decimal"
                    value={form.stock}
                    onChange={(e) => setField('stock', e.target.value)}
                  />
                )}
                <div className="mt-3 flex justify-end gap-2">
                  <SecondaryButton compact type="button" onClick={() => setEditing(false)}>
                    Cancel
                  </SecondaryButton>
                  <PrimaryButton compact type="submit">
                    Save product
                  </PrimaryButton>
                </div>
              </form>
            ) : (
              <div className="mt-[18px]">
                <h3 className="mb-2.5 text-sm">Product info</h3>
                <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2 text-xs text-brand-slate">
                  <span>SKU</span>
                  <strong className="text-brand-ink">{form.sku}</strong>
                  <span>Barcode</span>
                  <strong className="text-brand-ink">{form.barcode}</strong>
                  <span>Category</span>
                  <strong className="text-brand-ink">{form.category}</strong>
                  <span>Price</span>
                  <strong className="text-brand-ink">
                    {money(form.price)}
                    {isRestaurant && form.budgetPrice !== ''
                      ? ` · budget ${money(form.budgetPrice)}`
                      : ''}
                  </strong>
                  <span>On hand</span>
                  <strong className="text-brand-ink">{qty(form.stock, unit)}</strong>
                  <span>Added</span>
                  <strong className="text-brand-ink">
                    {formatDate(products.find((p) => p.id === selected)?.createdAt)}
                  </strong>
                  <span>Updated</span>
                  <strong className="text-brand-ink">
                    {formatDate(products.find((p) => p.id === selected)?.updatedAt)}
                  </strong>
                  <span>Last move</span>
                  <strong className="text-brand-ink">
                    {formatDate(products.find((p) => p.id === selected)?.lastMovementAt)}
                  </strong>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {confirmSave && (
        <Modal wide layer onClose={() => setConfirmSave(false)}>
          <Eyebrow>CONFIRM UPDATE</Eyebrow>
          <h2 className="mb-3 text-[22px]">Save product changes?</h2>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-[#e1e3dd] py-3.5 text-[13px]">
            <span>Name</span>
            <strong className="text-right">{sanitizeText(form.name)}</strong>
            <span>SKU</span>
            <strong className="text-right">{sanitizeText(form.sku)}</strong>
            <span>Stock</span>
            <strong className="text-right">{qty(form.stock, unit)}</strong>
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirmSave(false)}>
              Back
            </SecondaryButton>
            <PrimaryButton compact type="button" onClick={commitSave}>
              Confirm
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}

      {confirmAdjust && (
        <Modal wide layer onClose={() => setConfirmAdjust(null)}>
          <Eyebrow>CONFIRM MOVEMENT</Eyebrow>
          <h2 className="mb-3 text-[22px]">Record {confirmAdjust.action.toLowerCase()}?</h2>
          <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-[#e1e3dd] py-3.5 text-[13px]">
            <span>Product</span>
            <strong className="text-right">{form.name}</strong>
            <span>Quantity</span>
            <strong className="text-right">
              {confirmAdjust.action === 'Restock' ? '+' : '-'}
              {qty(confirmAdjust.amount, unit)}
            </strong>
            <span>New on hand</span>
            <strong className="text-right">
              {qty(
                Number(form.stock) +
                  (confirmAdjust.action === 'Restock' ? confirmAdjust.amount : -confirmAdjust.amount),
                unit,
              )}
            </strong>
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setConfirmAdjust(null)}>
              Back
            </SecondaryButton>
            <PrimaryButton compact type="button" onClick={commitAdjust}>
              Confirm
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default Products
