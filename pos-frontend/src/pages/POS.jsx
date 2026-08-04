import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FiSearch } from 'react-icons/fi'
import Cart from '../components/pos/Cart'
import WeightModal from '../components/pos/WeightModal'
import SupervisorApprove from '../components/shared/SupervisorApprove'
import { Field, Modal, ModalActions, PageHeader, PrimaryButton, SearchBox, SecondaryButton, Eyebrow } from '../components/ui'
import { isDeviceEnabled } from '../devices'
import { fetchActivePromoEventWithRules, hasSupabase, updateProductPrice } from '../lib/api'
import { useAuthStore, useCartStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { businessDate, formatOpenHourLabel, isTillClosed, money } from '../utils/format'
import { isSupervisorOrAbove } from '../utils/roles'
import { formatSupportError } from '../utils/errors'

function menuSetupKey(branchId, bizDate) {
  return `cale-menu-setup:${branchId || 'x'}:${bizDate}`
}

function POS() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const setProducts = useProductStore((state) => state.setProducts)
  const toggleAvailableToday = useProductStore((state) => state.toggleAvailableToday)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const addItem = useCartStore((state) => state.addItem)
  const items = useCartStore((state) => state.items)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [weighted, setWeighted] = useState(null)
  const [manageMenu, setManageMenu] = useState(false)
  const [flashId, setFlashId] = useState(null)
  const [priceTarget, setPriceTarget] = useState(null)
  const [priceValue, setPriceValue] = useState('')
  const [awaitingPriceApproval, setAwaitingPriceApproval] = useState(false)
  const [priceError, setPriceError] = useState('')
  const [inquiryMode, setInquiryMode] = useState(false)
  const [inquiryProduct, setInquiryProduct] = useState(null)
  const [searchPopupOpen, setSearchPopupOpen] = useState(false)
  const [cartOverlayOpen, setCartOverlayOpen] = useState(false)
  const [activePromo, setActivePromo] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const tillClosed = isTillClosed(dayEnds, dayOpenHour)
  const bizDate = businessDate(new Date(), dayOpenHour)
  const barcodeOn = isDeviceEnabled(user?.deviceSettings, 'barcode_scanner')
  const barcodeTableMode = barcodeOn && !isRestaurant && !manageMenu
  const cartEmpty = items.length === 0
  const promoProductIds = activePromo?.rules?.length
    ? new Set(activePromo.rules.flatMap((r) => (r.products || []).map((p) => p.productId)).filter(Boolean))
    : new Set()
  const categories = [
    'All',
    ...(promoProductIds.size ? ['Promos'] : []),
    ...new Set(products.map((product) => product.category)),
  ]
  const menuOnCount = products.filter((p) => p.availableToday !== false).length
  const menuOffCount = products.length - menuOnCount
  const canChangePriceDirect = isSupervisorOrAbove(user?.role)

  useEffect(() => {
    if (!isRestaurant) return
    const forceSetup = searchParams.get('menu') === '1'
    let needsSetup = false
    try {
      needsSetup = sessionStorage.getItem(menuSetupKey(user?.branchId, bizDate)) !== '1'
    } catch {
      needsSetup = true
    }
    if (forceSetup || (needsSetup && products.length > 0)) {
      setManageMenu(true)
    }
  }, [isRestaurant, searchParams, user?.branchId, bizDate, products.length])

  useEffect(() => {
    if (!hasSupabase || !user?.branchId) return
    let active = true
    void (async () => {
      const next = await fetchActivePromoEventWithRules(user.branchId)
      if (!active) return
      setActivePromo(next)
    })()
    return () => {
      active = false
    }
  }, [hasSupabase, user?.branchId])

  const finishMenuSetup = () => {
    try {
      sessionStorage.setItem(menuSetupKey(user?.branchId, bizDate), '1')
    } catch {
      /* ignore */
    }
    setManageMenu(false)
    if (searchParams.get('menu') === '1') {
      setSearchParams({}, { replace: true })
    }
  }

  const sellable = isRestaurant
    ? products.filter((p) => manageMenu || p.availableToday !== false)
    : products

  const visible = sellable.filter((product) => {
    if (category === 'Promos') {
      if (!promoProductIds.has(product.id)) return false
    } else if (category !== 'All' && product.category !== category) return false
    // Scanner mode: show results only after a barcode scan / search input.
    if (barcodeTableMode && !String(search || '').trim()) return false
    const q = search.toLowerCase()
    if (!q) return true
    const fields = [product.name, product.sku, product.productCode, product.barcode]
    return fields.some((value) => String(value || '').toLowerCase().includes(q))
  })

  const select = (product) => {
    if (tillClosed) return
    if (isRestaurant && manageMenu) return
    if (inquiryMode) {
      setInquiryProduct(product)
      return
    }
    if (product.pricingMode === 'kg') setWeighted(product)
    else addItem(product)
  }

  const applyPriceChange = async (approvedBy = null) => {
    if (!priceTarget) return
    const next = Number(priceValue)
    if (!Number.isFinite(next) || next < 0) {
      setPriceError('Enter a valid price.')
      return
    }
    setPriceError('')
    try {
      if (hasSupabase) {
        await updateProductPrice(priceTarget.id, next, {
          branchId: user?.branchId,
          staffId: approvedBy || user?.id,
          previousPrice: priceTarget.price,
          productName: priceTarget.name,
        })
      }
      setProducts(products.map((p) => (p.id === priceTarget.id ? { ...p, price: next } : p)))
      setPriceTarget(null)
      setAwaitingPriceApproval(false)
      setPriceValue('')
    } catch (err) {
      setPriceError(formatSupportError(err, 'PRICE01'))
    }
  }

  useEffect(() => {
    if (cartOverlayOpen || awaitingPriceApproval || priceTarget || weighted || inquiryProduct) {
      setSearchPopupOpen(false)
    }
  }, [cartOverlayOpen, awaitingPriceApproval, priceTarget, weighted, inquiryProduct])

  return (
    <div>
      <PageHeader
        eyebrow={isRestaurant ? 'CARINDERIA' : 'SALES FLOOR'}
        title={isRestaurant ? (manageMenu ? "Today's potahe" : 'Menu sale') : 'New sale'}
      >
        {isRestaurant &&
          (manageMenu ? (
            <PrimaryButton compact type="button" className="max-[700px]:w-full" onClick={finishMenuSetup}>
              {menuOnCount === 0 ? 'Skip for now' : 'Start selling'} <span aria-hidden>{'\u2192'}</span>
            </PrimaryButton>
          ) : (
            <button
              type="button"
              className="rounded-[5px] border border-brand-border bg-white px-3 py-2 text-xs font-bold text-[#606662] max-[700px]:w-full max-[700px]:px-2.5 max-[700px]:text-[11px]"
              onClick={() => setManageMenu(true)}
            >
              Edit potahe
            </button>
          ))}
      </PageHeader>
      {tillClosed && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-3 py-2.5 text-xs text-brand-danger">
          Business day {bizDate} is closed. Sales are locked until a manager reopens the till, or
          automatically at {formatOpenHourLabel(dayOpenHour)} for the next business day.
        </p>
      )}
      {isRestaurant && manageMenu && (
        <div className="mb-3 rounded-md border border-brand-dark/15 bg-[#f4f5f1] px-4 py-3">
          <strong className="block text-sm text-brand-ink">What are you serving today?</strong>
          <p className="m-0 mt-1 text-xs text-brand-muted">
            Tap a dish to toggle <span className="font-bold text-brand-success">Serving</span> or{' '}
            <span className="font-bold text-brand-danger">Not available</span>. Only serving items appear on
            the sale screen.
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded bg-[#eef6ea] px-2 py-1 font-bold text-brand-success">
              Serving {menuOnCount}
            </span>
            <span className="rounded bg-[#fce8e8] px-2 py-1 font-bold text-brand-danger">Off {menuOffCount}</span>
          </div>
        </div>
      )}
      <div
        className={`relative grid gap-6 max-[800px]:grid-cols-1 max-[800px]:gap-4 ${
          isRestaurant && manageMenu
            ? 'grid-cols-1'
            : barcodeTableMode
              ? 'grid-cols-1'
              : 'grid-cols-[minmax(0,1fr)_minmax(440px,480px)] max-[1100px]:grid-cols-[minmax(0,1fr)_420px]'
        }`}
      >
        {!barcodeTableMode && (
          <div
            className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-brand-line bg-white p-[18px] max-[700px]:p-3.5 max-[800px]:min-h-[390px] ${
              isRestaurant && manageMenu
                ? 'max-h-none'
                : barcodeTableMode
                  ? 'h-auto'
                  : 'h-[calc(100vh-140px)] max-[800px]:h-auto'
            }`}
          >
          <div className="mb-3.5 flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <SearchBox
                className="min-w-0 flex-1"
                icon={<FiSearch />}
                autoFocus={!tillClosed && !manageMenu}
                disabled={tillClosed}
                placeholder={
                  isRestaurant
                    ? manageMenu
                      ? 'Search potahe to turn on/off'
                      : 'Search menu / potahe (name, SKU, barcode)'
                    : 'Search name, SKU or barcode [F10]'
                }
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && visible[0] && !manageMenu) {
                    const q = search.trim().toLowerCase()
                    const exact = visible.find((p) => {
                      const sku = String(p.sku || '').toLowerCase()
                      const barcode = String(p.barcode || '').toLowerCase()
                      const code = String(p.productCode || '').toLowerCase()
                      return sku === q || barcode === q || code === q
                    })
                    select(exact || visible[0])
                  }
                }}
              />
              {!manageMenu && (
                <button
                  type="button"
                  className={`shrink-0 rounded-[5px] border px-3 py-2 text-xs font-bold ${
                    inquiryMode
                      ? 'border-brand-dark bg-brand-dark text-white'
                      : 'border-brand-border bg-white text-[#606662]'
                  }`}
                  onClick={() => setInquiryMode((v) => !v)}
                  title="Look up item details without adding to cart"
                >
                  Inquiry
                </button>
              )}
            </div>
            {!barcodeTableMode && (
              <div className="-mx-1 flex gap-[7px] overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
                {categories.map((item) => (
                  <button
                    key={item}
                    type="button"
                    disabled={tillClosed}
                    className={`shrink-0 rounded-[5px] border px-[11px] py-2 text-xs whitespace-nowrap transition-[background-color,border-color,transform,filter] duration-100 disabled:cursor-not-allowed ${
                      category === item
                        ? 'border-brand-dark bg-brand-dark text-white'
                        : 'border-brand-border bg-white text-[#606662] hover:border-[#b8bcb5] hover:bg-[#f4f5f1] active:bg-[#eceee9]'
                    }`}
                    onClick={() => setCategory(item)}
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </div>
          {barcodeTableMode ? (
            !String(search || '').trim() ? (
              cartEmpty ? (
                <div className="flex min-h-[340px] items-center justify-center px-3 py-6 text-center text-xs text-brand-subtle">
                  No items yet. Scan a barcode to see results.
                </div>
              ) : (
                <div className="min-h-[18px]" />
              )
            ) : (
              <div className="min-h-0 rounded border border-brand-softline">
                <div className="border-b border-brand-softline bg-[#f7f7f4] px-3 py-2 text-[11px] text-brand-subtle">
                  Scanner results
                </div>
                <table className="min-w-full text-left text-xs">
                  <thead className="sticky top-0 bg-[#f7f7f4] text-[10px] tracking-wide text-brand-subtle uppercase">
                    <tr>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Barcode</th>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-3 py-2 text-right">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((product) => (
                      <tr
                        key={product.id}
                        className="cursor-pointer border-t border-brand-softline hover:bg-[#fafaf7]"
                        onClick={() => select(product)}
                      >
                        <td className="px-3 py-2 font-mono text-[11px]">{product.sku || '—'}</td>
                        <td className="px-3 py-2 font-mono text-[11px]">{product.barcode || '—'}</td>
                        <td className="px-3 py-2">
                          <strong className="text-brand-ink">{product.name}</strong>
                          <div className="text-[10px] text-brand-subtle">{product.category || '—'}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-brand-ink">
                          {money(product.price)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {product.pricingMode === 'kg'
                            ? `${Number(product.stock || 0).toFixed(2)} kg`
                            : `${Number(product.stock || 0).toFixed(0)} pcs`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {visible.length === 0 && (
                  <p className="px-3 py-8 text-center text-xs text-brand-subtle">
                    No items found for that barcode.
                  </p>
                )}
              </div>
            )
          ) : (
            <div
              className={`grid min-h-0 flex-1 content-start gap-3 overflow-auto px-0.5 pt-1.5 pb-1 pr-1 ${
                manageMenu && isRestaurant
                  ? 'grid-cols-3 max-[1050px]:grid-cols-2 max-[700px]:grid-cols-1'
                  : 'grid-cols-5 max-[1050px]:grid-cols-3 max-[800px]:max-h-[52vh] max-[700px]:grid-cols-2'
              }`}
            >
              {visible.map((product) => {
                const offToday = isRestaurant && product.availableToday === false
                const flashing = flashId === product.id
                return (
                  <div key={product.id} className="relative">
                    <button
                      type="button"
                      disabled={tillClosed || (isRestaurant && !manageMenu && offToday)}
                      className={`tap-target flex min-h-[168px] w-full flex-col items-start rounded-[8px] border p-4 text-left transition-[border-color,box-shadow,transform,filter,opacity,background-color] duration-150 disabled:cursor-not-allowed ${
                        manageMenu && isRestaurant
                          ? offToday
                            ? `border-[#e8b4b4] bg-[#fdf6f6] ${flashing ? 'scale-[0.98]' : ''}`
                            : `border-[#9ec99a] bg-[#f4faf2] shadow-[inset_0_0_0_1px_#9ec99a55] ${
                                flashing ? 'scale-[0.98]' : ''
                              }`
                          : offToday && manageMenu
                            ? 'border-[#e8e9e3] bg-[#f3f3f0] opacity-55'
                            : 'border-[#e8e9e3] bg-[#fbfbf9] hover:border-brand-gold hover:shadow-[0_2px_8px_#00000012] active:border-brand-gold'
                      }`}
                      onClick={async () => {
                        if (manageMenu && isRestaurant) {
                          try {
                            setFlashId(product.id)
                            await toggleAvailableToday(product.id)
                            window.setTimeout(() => setFlashId(null), 180)
                          } catch (err) {
                            console.warn(err.message)
                            setFlashId(null)
                          }
                          return
                        }
                        select(product)
                      }}
                    >
                      {isRestaurant && manageMenu ? (
                        <span
                          className={`rounded px-2 py-1 text-[10px] font-bold tracking-wide uppercase ${
                            offToday ? 'bg-[#fce8e8] text-brand-danger' : 'bg-[#eef6ea] text-brand-success'
                          }`}
                        >
                          {offToday ? 'Not available' : 'Serving'}
                        </span>
                      ) : (
                        <div
                          className={`grid h-14 w-14 place-items-center rounded-lg text-xs font-bold ${
                            isRestaurant
                              ? product.menuKind === 'veggie'
                                ? 'bg-brand-success-bg text-brand-success-text'
                                : product.menuKind === 'drink' || product.menuKind === 'rice'
                                  ? 'bg-[#eef1f6] text-[#4a5568]'
                                  : 'bg-brand-meat text-brand-meat-text'
                              : product.category === 'Meat'
                                ? 'bg-brand-meat text-brand-meat-text'
                                : 'bg-brand-success-bg text-brand-success-text'
                          }`}
                        >
                          {isRestaurant
                            ? (product.menuKind || 'ON').slice(0, 4).toUpperCase()
                            : product.pricingMode === 'kg'
                              ? 'KG'
                              : 'PC'}
                        </div>
                      )}
                      <strong className="mt-auto line-clamp-2 text-[15px] leading-snug">{product.name}</strong>
                      <span className="mt-1.5 text-[12px] text-[#808581]">
                        {money(product.price)}
                        {isRestaurant && product.budgetPrice != null ? ` - ${money(product.budgetPrice)} bud` : ''}
                        {isRestaurant ? '' : ` / ${product.pricingMode === 'kg' ? 'kg' : 'pc'}`}
                      </span>
                      {isRestaurant && (
                        <span className="mt-1 text-[10px] font-bold text-brand-subtle">
                          {product.category}
                          {product.menuKind ? ` - ${product.menuKind}` : ''}
                        </span>
                      )}
                      {isRestaurant && manageMenu && (
                        <span className="mt-2 text-[10px] text-brand-muted">
                          Tap to mark {offToday ? 'serving' : 'unavailable'}
                        </span>
                      )}
                    </button>
                    {!(isRestaurant && manageMenu) && !tillClosed && (
                      <button
                        type="button"
                        title="Change price"
                        className="absolute top-2 right-2 rounded border border-brand-border bg-white/95 px-1.5 py-0.5 text-[10px] font-bold text-brand-ink"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPriceTarget(product)
                          setPriceValue(String(product.price))
                          setPriceError('')
                        }}
                      >
                        ₱
                      </button>
                    )}
                  </div>
                )
              })}
              {visible.length === 0 && (
                <p className="col-span-full py-10 text-center text-xs text-brand-subtle">
                  {isRestaurant
                    ? manageMenu
                      ? 'No menu items yet — ask a manager to add potahe.'
                      : "No potahe marked available today. Tap Edit today's potahe to enable items."
                    : 'No products match this search.'}
                </p>
              )}
            </div>
          )}
          {isRestaurant && manageMenu && (
            <div className="mt-4 flex justify-end border-t border-brand-softline pt-3">
              <PrimaryButton compact type="button" className="max-[700px]:w-full" onClick={finishMenuSetup}>
                {menuOnCount === 0 ? 'Skip for now' : `Sell (${menuOnCount} on)`}{' '}
                <span aria-hidden>{'\u2192'}</span>
              </PrimaryButton>
            </div>
          )}
          </div>
        )}

        {!(isRestaurant && manageMenu) && (
          <Cart
            tillClosed={tillClosed}
            barcodeMode={barcodeTableMode}
            onOverlayChange={setCartOverlayOpen}
            promoRules={activePromo?.rules || []}
            promoLabel={activePromo?.event?.name || null}
            headerActions={
              barcodeTableMode ? (
                <>
                  <button
                    type="button"
                    className={`rounded-[5px] border px-3 py-2 text-xs font-bold ${
                      inquiryMode
                        ? 'border-brand-dark bg-brand-dark text-white'
                        : 'border-brand-border bg-white text-brand-ink'
                    }`}
                    disabled={tillClosed || cartOverlayOpen}
                    onClick={() => setInquiryMode((v) => !v)}
                    title="Look up item details without adding to cart"
                  >
                    Inquiry
                  </button>
                  <button
                    type="button"
                    className="rounded-[5px] border border-brand-border bg-white px-3 py-2 text-xs font-bold text-brand-ink"
                    disabled={tillClosed || cartOverlayOpen}
                    onClick={() => setSearchPopupOpen(true)}
                  >
                    Search item
                  </button>
                </>
              ) : null
            }
          />
        )}
      </div>
      {/* Barcode scanner mode: "Search / Scan" modal (SearchBox consumes scanner keystrokes, then Add/View results). */}
      {barcodeTableMode && searchPopupOpen && !cartOverlayOpen && (
        <Modal wide layer onClose={() => setSearchPopupOpen(false)}>
          <Eyebrow>ITEM SEARCH</Eyebrow>
          <div className="mb-3 flex items-center justify-between gap-2">
            <p className="m-0 text-xs text-brand-muted">
              {inquiryMode ? 'Inquiry mode on: view price/details only.' : 'Search or scan to add to cart.'}
            </p>
            <button
              type="button"
              className={`shrink-0 rounded-[5px] border px-2.5 py-1.5 text-[11px] font-bold ${
                inquiryMode
                  ? 'border-brand-dark bg-brand-dark text-white'
                  : 'border-brand-border bg-white text-brand-ink'
              }`}
              onClick={() => setInquiryMode((v) => !v)}
            >
              Inquiry
            </button>
          </div>
          <div className="mb-3">
            <SearchBox
              className="min-w-0"
              icon={<FiSearch />}
              autoFocus={!tillClosed}
              disabled={tillClosed}
              placeholder="Search name, SKU or barcode"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible[0] && !manageMenu) {
                  const q = search.trim().toLowerCase()
                  const exact = visible.find((p) => {
                    const sku = String(p.sku || '').toLowerCase()
                    const barcode = String(p.barcode || '').toLowerCase()
                    const code = String(p.productCode || '').toLowerCase()
                    return sku === q || barcode === q || code === q
                  })
                  select(exact || visible[0])
                  setSearchPopupOpen(false)
                }
              }}
            />
          </div>
          {String(search || '').trim() ? (
            <div className="-mx-5 max-h-[50vh] overflow-auto border-t border-brand-softline max-[700px]:-mx-4">
              <table className="min-w-full text-left text-xs">
                <thead className="sticky top-0 bg-[#f7f7f4] text-[10px] tracking-wide text-brand-subtle uppercase">
                  <tr>
                    <th className="px-3 py-2">SKU</th>
                    <th className="px-3 py-2">Barcode</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((product) => (
                    <tr
                      key={product.id}
                      className="cursor-pointer border-t border-brand-softline hover:bg-[#fafaf7]"
                      onClick={() => {
                        select(product)
                        setSearchPopupOpen(false)
                      }}
                    >
                      <td className="px-3 py-2 font-mono text-[11px]">{product.sku || '—'}</td>
                      <td className="px-3 py-2 font-mono text-[11px]">{product.barcode || '—'}</td>
                      <td className="px-3 py-2">
                        <strong className="text-brand-ink">{product.name}</strong>
                        <div className="text-[10px] text-brand-subtle">{product.category || '—'}</div>
                        <div className="text-[10px] text-brand-subtle">
                          Discountable: {product.discountEligible ? 'Yes' : 'No'}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-brand-ink">{money(product.price)}</td>
                      <td className="px-3 py-2 text-right">
                        {product.pricingMode === 'kg'
                          ? `${Number(product.stock || 0).toFixed(2)} kg`
                          : `${Number(product.stock || 0).toFixed(0)} pcs`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visible.length === 0 && (
                <p className="px-3 py-8 text-center text-xs text-brand-subtle">No items found for that barcode.</p>
              )}
            </div>
          ) : (
            <p className="m-0 rounded-md border border-brand-softline bg-[#f7f7f4] px-3 py-4 text-center text-xs text-brand-subtle">
              Scan barcode or type item name, SKU, or barcode.
            </p>
          )}
        </Modal>
      )}
      {weighted && !tillClosed && (
        <WeightModal
          product={weighted}
          close={() => setWeighted(null)}
          add={(weight) => {
            addItem(weighted, weight)
            setWeighted(null)
          }}
        />
      )}
      {priceTarget && !awaitingPriceApproval && (
        <Modal onClose={() => setPriceTarget(null)}>
          <h2 className="mb-1 text-lg">Change price</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            {priceTarget.name} · current {money(priceTarget.price)}
            {!canChangePriceDirect ? ' · supervisor PIN required' : ''}
          </p>
          <Field
            label="New price"
            value={priceValue}
            onChange={(e) => setPriceValue(e.target.value.replace(/[^\d.]/g, ''))}
            inputMode="decimal"
            autoFocus
          />
          {priceError && <p className="mt-2 text-xs text-brand-danger">{priceError}</p>}
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setPriceTarget(null)}>
              Cancel
            </SecondaryButton>
            <PrimaryButton
              compact
              type="button"
              onClick={() => {
                if (canChangePriceDirect) applyPriceChange(user?.id)
                else setAwaitingPriceApproval(true)
              }}
            >
              {canChangePriceDirect ? 'Save' : 'Continue'}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
      {awaitingPriceApproval && priceTarget && (
        <SupervisorApprove
          branchId={user?.branchId}
          title="Approve price change"
          detail={`Change ${priceTarget.name} to ${money(Number(priceValue) || 0)}`}
          onCancel={() => setAwaitingPriceApproval(false)}
          onApproved={({ staffId }) => applyPriceChange(staffId)}
        />
      )}
      {inquiryProduct && (
        <Modal onClose={() => setInquiryProduct(null)}>
          <Eyebrow>ITEM INQUIRY</Eyebrow>
          <h2 className="mb-1 text-lg">{inquiryProduct.name}</h2>
          <p className="m-0 text-xs text-brand-muted">
            {inquiryProduct.sku || 'No SKU'}
            {inquiryProduct.barcode ? ` · ${inquiryProduct.barcode}` : ''}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-[#f7f7f4] px-3 py-2">
              <span className="block text-[10px] text-brand-subtle">Price</span>
              <strong>{money(inquiryProduct.price)}</strong>
            </div>
            <div className="rounded-md bg-[#f7f7f4] px-3 py-2">
              <span className="block text-[10px] text-brand-subtle">On hand</span>
              <strong>
                {inquiryProduct.pricingMode === 'kg'
                  ? `${Number(inquiryProduct.stock || 0).toFixed(2)} kg`
                  : `${Number(inquiryProduct.stock || 0).toFixed(0)} pc`}
              </strong>
            </div>
            <div className="rounded-md bg-[#f7f7f4] px-3 py-2">
              <span className="block text-[10px] text-brand-subtle">Category</span>
              <strong>{inquiryProduct.category || '—'}</strong>
            </div>
            <div className="rounded-md bg-[#f7f7f4] px-3 py-2">
              <span className="block text-[10px] text-brand-subtle">Mode</span>
              <strong>{inquiryProduct.pricingMode === 'kg' ? 'Weighed' : 'Piece'}</strong>
            </div>
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setInquiryProduct(null)}>
              Close
            </SecondaryButton>
            {!tillClosed && (
              <PrimaryButton
                compact
                type="button"
                onClick={() => {
                  const product = inquiryProduct
                  setInquiryProduct(null)
                  setInquiryMode(false)
                  if (product.pricingMode === 'kg') setWeighted(product)
                  else addItem(product)
                }}
              >
                Add to cart
              </PrimaryButton>
            )}
          </ModalActions>
        </Modal>
      )}
    </div>
  )
}

export default POS
