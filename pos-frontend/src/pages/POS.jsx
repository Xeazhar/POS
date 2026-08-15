import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { FiSearch } from 'react-icons/fi'
import Cart from '../components/pos/Cart'
import OpenDrawer from '../components/pos/OpenDrawer'
import WeightModal from '../components/pos/WeightModal'
import SupervisorApprove from '../components/shared/SupervisorApprove'
import {
  Field,
  Modal,
  ModalActions,
  PageHeader,
  PageSkeleton,
  PrimaryButton,
  SearchBox,
  SecondaryButton,
  Eyebrow,
  UnitBadge,
  moneyClass,
} from '../components/ui'
import { isDeviceEnabled } from '../devices'
import {
  fetchActivePromoEventsWithRules,
  fetchBranchProducts,
  hasSupabase,
  logApprovalEvent,
  updateProductPrice,
} from '../lib/api'
import { useLiveData } from '../hooks/useLiveData'
import { isOnline, readPromoCache, writePromoCache } from '../offline'
import { useAuthStore, useCartStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { useShiftStore } from '../stores/shiftStore'
import {
  businessDate,
  formatOpenHourLabel,
  isDayFullyClosed,
  isDaySubmitted,
  isTillClosed,
  money,
} from '../utils/format'
import {
  buildPromoByProductId,
  collectPromoQuickSets,
  isItemPercentPromo,
  promoBadgeLabel,
  promoDisplayName,
  promoUnitPrice,
} from '../utils/promo'
import { isManagerRole, isSupervisorOrAbove } from '../utils/roles'
import { formatSupportError } from '../utils/errors'

function menuSetupKey(branchId, bizDate) {
  return `cale-menu-setup:${branchId || 'x'}:${bizDate}`
}

/**
 * Render and manage the point-of-sale screen, including product selection, cart operations, promotions, menu availability, price changes, and day-end restrictions.
 */
function POS() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const productsLoading = useProductStore((state) => state.loading)
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
  const [openDrawerOpen, setOpenDrawerOpen] = useState(false)
  const [activePromos, setActivePromos] = useState([])
  const shift = useShiftStore((state) => state.shift)
  const [requestManagerNotice, setRequestManagerNotice] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()
  const tillClosed = isTillClosed(dayEnds, dayOpenHour)
  const canOpenDrawer =
    Boolean(shift) && shift.holdsDrawer !== false && !tillClosed && Boolean(user?.branchId)
  const daySubmitted = isDaySubmitted(dayEnds, dayOpenHour)
  const dayFullyClosed = isDayFullyClosed(dayEnds, dayOpenHour)
  // Reopening a fully-closed day is manager-only; approving a submitted one is
  // supervisor+. Anyone below that can't act on /day-end here, so send them there
  // never redirects them into a screen that has nothing they can do.
  const canOpenDayEnd = dayFullyClosed ? isManagerRole(user?.role) : isSupervisorOrAbove(user?.role)
  const bizDate = businessDate(new Date(), dayOpenHour)
  const barcodeOn = isDeviceEnabled(user?.deviceSettings, 'barcode_scanner')
  const barcodeTableMode = barcodeOn && !isRestaurant && !manageMenu
  const cartEmpty = items.length === 0
  const clearCart = useCartStore((state) => state.clear)

  useEffect(() => {
    if (tillClosed) clearCart()
  }, [tillClosed, clearCart])
  // Flatten every live promo event's rules into one list, each tagged with
  // its own event name — several promos can be live on a branch at once.
  const promoRules = useMemo(
    () =>
      activePromos.flatMap((p) => (p.rules || []).map((r) => ({ ...r, eventName: p.event?.name || '' }))),
    [activePromos],
  )
  const promoProductIds = promoRules.length
    ? new Set(promoRules.flatMap((r) => (r.products || []).map((p) => p.productId)).filter(Boolean))
    : new Set()
  const promoByProductId = useMemo(() => buildPromoByProductId(promoRules), [promoRules])
  const promoQuickSets = useMemo(() => collectPromoQuickSets(promoRules), [promoRules])
  const categories = [
    'All',
    ...(promoProductIds.size ? ['Promos'] : []),
    ...new Set(products.map((product) => product.category)),
  ]
  const menuOnCount = products.filter((p) => p.availableToday !== false).length
  const menuOffCount = products.length - menuOnCount
  const canChangePrice = isManagerRole(user?.role)

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

  const branchId = user?.branchId || ''
  const liveEnabled = Boolean(hasSupabase && branchId)

  // Live: a manager creating/editing/activating a promo reaches this screen immediately.
  // promo_rules/promo_rule_products have no branch_id to filter on — cheap enough to
  // watch unfiltered and let the per-branch refetch do the real filtering.
  const loadPromos = useCallback(async () => {
    if (!branchId) {
      setActivePromos([])
      return
    }
    // Paint from IndexedDB first so Promos tiles/badges don't flash in after network RTT.
    const cached = await readPromoCache(branchId)
    if (cached?.active?.length) {
      setActivePromos(cached.active)
    }
    if (!isOnline()) {
      setActivePromos(cached?.active || [])
      return
    }
    try {
      const rows = await fetchActivePromoEventsWithRules(branchId)
      setActivePromos(rows)
      await writePromoCache(branchId, { active: rows })
    } catch (err) {
      console.warn('Failed to load active promos', err)
      setActivePromos(cached?.active || [])
    }
  }, [branchId])

  useLiveData({
    enabled: liveEnabled,
    fetch: loadPromos,
    tables: [
      { table: 'promo_events', filter: `branch_id=eq.${branchId}` },
      { table: 'promo_rules' },
      { table: 'promo_rule_products' },
    ],
  })

  // Live: a manager's price/stock/discount-eligibility edit reaches this screen immediately.
  const loadProducts = useCallback(async () => {
    if (!branchId) return
    useProductStore.getState().mergeProducts(await fetchBranchProducts(branchId))
  }, [branchId])

  // Private Broadcast (inventory/catalog) — refetch authoritative products; do not
  // apply payload quantities. postgres_changes omitted here to avoid double cost.
  useLiveData({
    enabled: liveEnabled,
    fetch: loadProducts,
    broadcasts: branchId
      ? [
          {
            topic: `pos:branch:${branchId}:inventory`,
            events: ['INVENTORY_CHANGED', 'CATALOG_CHANGED'],
          },
        ]
      : [],
  })

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
      // Set promos (bundle / pair / BOGO) are quick-add tiles only — not duplicate product tiles.
      const info = promoByProductId.get(product.id)
      if (!isItemPercentPromo(info)) return false
    } else if (category !== 'All' && product.category !== category) return false
    // Scanner mode: show results only after a barcode scan / search input.
    if (barcodeTableMode && !String(search || '').trim()) return false
    const q = search.toLowerCase()
    if (!q) return true
    const fields = [product.name, product.sku, product.productCode, product.barcode]
    return fields.some((value) => String(value || '').toLowerCase().includes(q))
  })

  const visibleQuickSets = useMemo(() => {
    if (category !== 'Promos' || manageMenu || barcodeTableMode) return []
    const q = search.trim().toLowerCase()
    if (!q) return promoQuickSets
    return promoQuickSets.filter((set) => {
      const hay = [
        set.name,
        set.sublabel,
        set.badge,
        ...set.products.map((p) => p.productName),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [category, promoQuickSets, search, manageMenu, barcodeTableMode])

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

  const newPromoGroupId = () =>
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `promo-${Date.now()}-${Math.random().toString(36).slice(2)}`

  const addPromoQuickSet = (set) => {
    if (tillClosed) return
    const groupId = newPromoGroupId()
    const group = { id: groupId, type: set.type, name: set.name }

    if (set.type === 'bogo') {
      const p = set.products[0]
      const product = products.find((item) => item.id === p.productId)
      if (product) {
        addItem(product, set.buyQty + set.getQty, { promoGroup: group })
      }
      return
    }

    for (const p of set.products) {
      const product = products.find((item) => item.id === p.productId)
      if (product) addItem(product, 1, { promoGroup: group })
    }
  }

  const applyPriceChange = async (approvedBy = null, approver = null) => {
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
        // The price-change row records one staff id, which conflates "who asked" with
        // "who authorised". The audit event keeps both apart.
        if (approvedBy && approvedBy !== user?.id) {
          void logApprovalEvent({
            branchId: user?.branchId,
            requestedBy: user?.id,
            approvedBy,
            approverName: approver?.name || null,
            approverRole: approver?.role || null,
            action: 'price_override',
            detail: `${priceTarget.name}: ${priceTarget.price} → ${next}`,
            meta: { product_id: priceTarget.id, old_price: priceTarget.price, new_price: next },
          })
        }
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

  if (tillClosed) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader className="mb-3 shrink-0" eyebrow="SALES FLOOR" title="POS locked">
          <span className="text-xs text-brand-subtle">Business day {bizDate}</span>
        </PageHeader>
        <div
          className="grid min-h-0 flex-1 place-items-center rounded-[10px] border border-brand-danger/25 bg-brand-danger-tint px-6 py-10"
          role="status"
          aria-live="polite"
        >
          <div className="max-w-md text-center">
            <strong className="block text-lg text-brand-danger">
              {dayFullyClosed
                ? 'POS is closed'
                : daySubmitted
                  ? 'Day end submitted'
                  : 'Till is closed'}
            </strong>
            <p className="m-0 mt-2 text-sm leading-relaxed text-brand-danger-deep">
              {dayFullyClosed
                ? `No sales until a manager reopens the till, or automatically at ${formatOpenHourLabel(dayOpenHour)} for the next business day.`
                : daySubmitted
                  ? 'Waiting for a manager to approve day end. POS stays locked — no sales, scans, or cart changes.'
                  : 'Sales are locked for this business day.'}
            </p>
            <p className="m-0 mt-3 text-xs text-brand-subtle">
              Nothing on this screen can be used until the till is reopened.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              {canOpenDayEnd ? (
                <Link
                  to="/day-end"
                  className="inline-flex items-center justify-center rounded-[5px] border-0 bg-brand-gold px-4 py-2.5 text-xs font-bold text-brand-on-gold no-underline"
                >
                  Open day end
                </Link>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-[5px] border-0 bg-brand-gold px-4 py-2.5 text-xs font-bold text-brand-on-gold"
                  onClick={() => setRequestManagerNotice(true)}
                >
                  Open day end
                </button>
              )}
            </div>
            {!canOpenDayEnd && requestManagerNotice && (
              <p className="m-0 mt-3 text-xs font-bold text-brand-danger-deep" role="status">
                {dayFullyClosed
                  ? 'Ask a manager to reopen the till.'
                  : 'Ask a supervisor or manager to approve day end.'}
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (productsLoading && !products.length) {
    return <PageSkeleton variant="dashboard" />
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {isRestaurant && (
        <div className="mb-3 flex shrink-0 justify-end">
          {manageMenu ? (
            <PrimaryButton compact type="button" className="max-[700px]:w-full" onClick={finishMenuSetup}>
              {menuOnCount === 0 ? 'Skip for now' : 'Start selling'} <span aria-hidden>{'\u2192'}</span>
            </PrimaryButton>
          ) : (
            <button
              type="button"
              className="rounded-[5px] border border-brand-border bg-brand-card px-3 py-2 text-xs font-bold text-brand-n700 max-[700px]:w-full max-[700px]:px-2.5 max-[700px]:text-[11px]"
              onClick={() => setManageMenu(true)}
            >
              Edit potahe
            </button>
          )}
        </div>
      )}
      {tillClosed && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-3 py-2.5 text-xs text-brand-danger">
          Business day {bizDate} is closed. Sales are locked until a manager reopens the till, or
          automatically at {formatOpenHourLabel(dayOpenHour)} for the next business day.
        </p>
      )}
      {isRestaurant && manageMenu && (
        <div className="mb-3 rounded-md border border-brand-dark/15 bg-brand-n100 px-4 py-3">
          <strong className="block text-sm text-brand-ink">What are you serving today?</strong>
          <p className="m-0 mt-1 text-xs text-brand-muted">
            Tap a dish to toggle <span className="font-bold text-brand-success">Serving</span> or{' '}
            <span className="font-bold text-brand-danger">Not available</span>. Only serving items appear on
            the sale screen.
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded bg-brand-success-bg px-2 py-1 font-bold text-brand-success-text">
              Serving {menuOnCount}
            </span>
            <span className="rounded bg-brand-danger-bg px-2 py-1 font-bold text-brand-danger">Off {menuOffCount}</span>
          </div>
        </div>
      )}
      <div
        className={`relative grid min-h-0 flex-1 gap-4 max-[800px]:grid-cols-1 max-[800px]:gap-3 max-[800px]:overflow-auto compact:grid-cols-1 compact:gap-3 compact:overflow-auto ${
          isRestaurant && manageMenu
            ? 'grid-cols-1'
            : barcodeTableMode
              ? 'grid-cols-1'
              : 'grid-cols-[minmax(0,1fr)_minmax(340px,380px)] max-[1100px]:grid-cols-[minmax(0,1fr)_320px]'
        }`}
      >
        {!barcodeTableMode && (
          <div
            className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-brand-line bg-brand-card p-[18px] max-[700px]:p-3.5 ${
              isRestaurant && manageMenu
                ? 'max-h-none'
                : barcodeTableMode
                  ? 'h-auto'
                  : 'h-full max-[800px]:min-h-[390px] max-[800px]:h-auto compact:min-h-[390px] compact:h-auto'
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
                      ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                      : 'border-brand-border bg-brand-card text-brand-n700'
                  }`}
                  onClick={() => setInquiryMode((v) => !v)}
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
                        ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                        : 'border-brand-border bg-brand-card text-brand-n700 hover:border-brand-n500 hover:bg-brand-n100 active:bg-brand-n200'
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
                <div className="border-b border-brand-softline bg-brand-n100 px-3 py-2 text-[11px] text-brand-subtle">
                  Scanner results
                </div>
                <table className="min-w-full text-left text-xs">
                  <thead className="sticky top-0 bg-brand-dark text-[10px] tracking-wide text-brand-ondark uppercase">
                    <tr>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Barcode</th>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2 text-right">Price</th>
                      <th className="px-3 py-2 text-right">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((product) => {
                      const promoInfo = promoByProductId.get(product.id)
                      const tilePromo = isItemPercentPromo(promoInfo) ? promoInfo : null
                      const salePrice = promoUnitPrice(product.price, tilePromo)
                      const badge = promoBadgeLabel(tilePromo)
                      return (
                      <tr
                        key={product.id}
                        className="cursor-pointer border-t border-brand-softline hover:bg-brand-n50"
                        onClick={() => select(product)}
                      >
                        <td className="px-3 py-2 font-mono text-[11px]">{product.sku || '—'}</td>
                        <td className="px-3 py-2 font-mono text-[11px]">{product.barcode || '—'}</td>
                        <td className="px-3 py-2">
                          <strong className="text-brand-ink">{product.name}</strong>
                          <div className="text-[10px] text-brand-subtle">{product.category || '—'}</div>
                          {badge && (
                            <div className="mt-0.5 text-[10px] font-bold text-brand-danger">
                              {badge}
                              {promoDisplayName(tilePromo) ? ` · ${promoDisplayName(tilePromo)}` : ''}
                            </div>
                          )}
                        </td>
                        <td className={`px-3 py-2 text-right font-bold text-brand-ink ${moneyClass}`}>
                          {salePrice != null ? (
                            <span className="block">
                              <span className="block text-[10px] font-normal text-brand-subtle line-through">
                                {money(product.price)}
                              </span>
                              <span className="text-brand-danger">{money(salePrice)}</span>
                            </span>
                          ) : (
                            money(product.price)
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {product.pricingMode === 'kg'
                            ? `${Number(product.stock || 0).toFixed(2)} kg`
                            : `${Number(product.stock || 0).toFixed(0)} pcs`}
                        </td>
                      </tr>
                      )
                    })}
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
              className={`grid min-h-0 flex-1 content-start gap-2 overflow-auto px-0.5 pt-1.5 pb-1 pr-1 ${
                manageMenu && isRestaurant
                  ? 'grid-cols-4 max-[1050px]:grid-cols-3 max-[700px]:grid-cols-2'
                  : 'grid-cols-6 max-[1200px]:grid-cols-5 max-[1050px]:grid-cols-4 max-[800px]:grid-cols-3 max-[800px]:max-h-[52vh] max-[520px]:grid-cols-2 compact:grid-cols-3 compact:max-h-[52vh]'
              }`}
            >
              {!manageMenu &&
                visibleQuickSets.map((set) => (
                  <div key={`quick-${set.ruleId}`} className="relative">
                    <button
                      type="button"
                      disabled={tillClosed}
                      className="tap-target flex h-[104px] w-full flex-col items-start gap-0.5 overflow-hidden rounded-[6px] border border-brand-gold/55 bg-brand-gold/10 p-2.5 text-left transition-[border-color,box-shadow,transform,filter] duration-150 hover:border-brand-gold hover:bg-brand-gold/15 hover:shadow-[0_2px_8px_#00000012] active:scale-[0.98] disabled:cursor-not-allowed max-[800px]:h-[124px] max-[800px]:p-3 compact:h-[124px] compact:p-3"
                      onClick={() => addPromoQuickSet(set)}
                    >
                      <span className="rounded bg-brand-gold px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-brand-on-gold uppercase">
                        {set.badge}
                      </span>
                      <strong className="line-clamp-2 min-h-0 flex-1 text-[13px] leading-snug text-brand-ink max-[800px]:text-sm">
                        {set.name}
                      </strong>
                      <span className="line-clamp-2 shrink-0 text-[9px] leading-snug text-brand-subtle">
                        {set.sublabel}
                      </span>
                      {set.discountPct > 0 ? (
                        <span className={`shrink-0 text-[10px] font-bold text-brand-danger ${moneyClass}`}>
                          {set.discountPct}% off
                        </span>
                      ) : null}
                    </button>
                  </div>
                ))}
              {visible.map((product) => {
                const offToday = isRestaurant && product.availableToday === false
                const flashing = flashId === product.id
                const promoInfo = promoByProductId.get(product.id)
                const tilePromo = isItemPercentPromo(promoInfo) ? promoInfo : null
                const salePrice = promoUnitPrice(product.price, tilePromo)
                const badge = promoBadgeLabel(tilePromo)
                return (
                  <div key={product.id} className="relative">
                    <button
                      type="button"
                      disabled={tillClosed || (isRestaurant && !manageMenu && offToday)}
                      className={`tap-target flex h-[104px] w-full flex-col items-start gap-0.5 overflow-hidden rounded-[6px] border p-2.5 text-left transition-[border-color,box-shadow,transform,filter,opacity,background-color] duration-150 disabled:cursor-not-allowed max-[800px]:h-[124px] max-[800px]:p-3 compact:h-[124px] compact:p-3 ${
                        manageMenu && isRestaurant
                          ? offToday
                            ? `border-brand-danger-line bg-brand-danger-tint-alt ${flashing ? 'scale-[0.98]' : ''}`
                            : `border-brand-success-line bg-brand-success-tint shadow-[inset_0_0_0_1px_#9ec99a55] ${
                                flashing ? 'scale-[0.98]' : ''
                              }`
                          : offToday && manageMenu
                            ? 'border-brand-n200 bg-brand-n100 opacity-55'
                            : tilePromo
                              ? 'border-brand-danger/40 bg-brand-danger-tint hover:border-brand-danger hover:shadow-[0_2px_8px_#00000012] active:border-brand-danger'
                              : 'border-brand-n200 bg-brand-n50 hover:border-brand-gold hover:shadow-[0_2px_8px_#00000012] active:border-brand-gold'
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
                      <div className="flex w-full shrink-0 items-center gap-1">
                        {isRestaurant && manageMenu ? (
                          <span
                            className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide uppercase ${
                              offToday
                                ? 'bg-brand-danger-bg text-brand-danger'
                                : 'bg-brand-success-bg text-brand-success-text'
                            }`}
                          >
                            {offToday ? 'Not available' : 'Serving'}
                          </span>
                        ) : badge ? (
                          <span className="truncate rounded bg-brand-danger px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-white uppercase">
                            {badge}
                          </span>
                        ) : isRestaurant ? (
                          <span
                            className={`inline-flex min-w-[2rem] items-center justify-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                              product.menuKind === 'veggie'
                                ? 'bg-brand-success-bg text-brand-success-text'
                                : product.menuKind === 'drink' || product.menuKind === 'rice'
                                  ? 'bg-brand-info-bg text-brand-info'
                                  : 'bg-brand-meat text-brand-meat-text'
                            }`}
                          >
                            {(product.menuKind || 'ON').slice(0, 4).toUpperCase()}
                          </span>
                        ) : (
                          <UnitBadge mode={product.pricingMode} />
                        )}
                      </div>
                      <strong className="line-clamp-2 min-h-0 flex-1 text-[13px] leading-snug max-[800px]:text-sm">
                        {product.name}
                      </strong>
                      <span className={`shrink-0 text-[11px] text-brand-n600 max-[800px]:text-xs ${moneyClass}`}>
                        {salePrice != null ? (
                          <>
                            <span className="mr-1.5 text-brand-n500 line-through">{money(product.price)}</span>
                            <span className="font-bold text-brand-danger">{money(salePrice)}</span>
                          </>
                        ) : (
                          money(product.price)
                        )}
                        {isRestaurant && product.budgetPrice != null ? ` - ${money(product.budgetPrice)} bud` : ''}
                        {isRestaurant ? '' : ` / ${product.pricingMode === 'kg' ? 'kg' : 'pc'}`}
                      </span>
                      {isRestaurant && (
                        <span className="line-clamp-1 shrink-0 text-[9px] font-bold text-brand-subtle">
                          {product.category}
                          {product.menuKind ? ` - ${product.menuKind}` : ''}
                        </span>
                      )}
                      {isRestaurant && manageMenu && (
                        <span className="shrink-0 text-[9px] text-brand-muted">
                          Tap to mark {offToday ? 'serving' : 'unavailable'}
                        </span>
                      )}
                    </button>
                    {!(isRestaurant && manageMenu) && !tillClosed && canChangePrice && (
                      <button
                        type="button"
                        className="absolute top-1.5 right-1.5 rounded border border-brand-border bg-white/95 px-1.5 py-0.5 text-[10px] font-bold text-brand-ink"
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
              {visible.length === 0 && visibleQuickSets.length === 0 && (
                <p className="col-span-full py-10 text-center text-xs text-brand-subtle">
                  {isRestaurant
                    ? manageMenu
                      ? 'No menu items yet — ask a manager to add potahe.'
                      : "No potahe marked available today. Tap Edit today's potahe to enable items."
                    : category === 'Promos'
                      ? 'No promo sets or item discounts match this search.'
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
            promoRules={promoRules}
            headerActions={
              <>
                {canOpenDrawer && (
                  <button
                    type="button"
                    className="rounded-[5px] border border-brand-border bg-brand-card px-3 py-2 text-xs font-bold text-brand-ink"
                    disabled={cartOverlayOpen}
                    onClick={() => setOpenDrawerOpen(true)}
                  >
                    Open Drawer
                  </button>
                )}
                {barcodeTableMode ? (
                  <>
                    <button
                      type="button"
                      className={`rounded-[5px] border px-3 py-2 text-xs font-bold ${
                        inquiryMode
                          ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                          : 'border-brand-border bg-brand-card text-brand-ink'
                      }`}
                      disabled={tillClosed || cartOverlayOpen}
                      onClick={() => setInquiryMode((v) => !v)}
                    >
                      Inquiry
                    </button>
                    <button
                      type="button"
                      className="rounded-[5px] border border-brand-border bg-brand-card px-3 py-2 text-xs font-bold text-brand-ink"
                      disabled={tillClosed || cartOverlayOpen}
                      onClick={() => setSearchPopupOpen(true)}
                    >
                      Search item
                    </button>
                  </>
                ) : null}
              </>
            }
          />
        )}
      </div>
      <OpenDrawer
        open={openDrawerOpen}
        onClose={() => setOpenDrawerOpen(false)}
        onDone={() => {
          void useShiftStore.getState().cashPosition?.()
          window.dispatchEvent(new CustomEvent('cale-cash-movements-changed'))
        }}
      />
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
                  ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                  : 'border-brand-border bg-brand-card text-brand-ink'
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
                <thead className="sticky top-0 bg-brand-dark text-[10px] tracking-wide text-brand-ondark uppercase">
                  <tr>
                    <th className="px-3 py-2">SKU</th>
                    <th className="px-3 py-2">Barcode</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2 text-right">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((product) => {
                    const promoInfo = promoByProductId.get(product.id)
                    const salePrice = promoUnitPrice(product.price, promoInfo)
                    const badge = promoBadgeLabel(promoInfo)
                    const partner = promoPartnerLabel(promoInfo)
                    return (
                    <tr
                      key={product.id}
                      className="cursor-pointer border-t border-brand-softline hover:bg-brand-n50"
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
                        {badge ? (
                          <div className="text-[10px] font-bold text-brand-danger">
                            {badge}
                            {promoDisplayName(promoInfo) ? ` · ${promoDisplayName(promoInfo)}` : ''}
                            {partner && (
                              <span className="font-normal text-brand-subtle">
                                {' '}
                                ({partner.text})
                              </span>
                            )}
                          </div>
                        ) : (
                          <div className="text-[10px] text-brand-subtle">
                            Discountable: {product.discountEligible ? 'Yes' : 'No'}
                          </div>
                        )}
                      </td>
                      <td className={`px-3 py-2 text-right font-bold text-brand-ink ${moneyClass}`}>
                        {salePrice != null ? (
                          <span className="block">
                            <span className="block text-[10px] font-normal text-brand-subtle line-through">
                              {money(product.price)}
                            </span>
                            <span className="text-brand-danger">{money(salePrice)}</span>
                          </span>
                        ) : (
                          money(product.price)
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {product.pricingMode === 'kg'
                          ? `${Number(product.stock || 0).toFixed(2)} kg`
                          : `${Number(product.stock || 0).toFixed(0)} pcs`}
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
              {visible.length === 0 && (
                <p className="px-3 py-8 text-center text-xs text-brand-subtle">No items found for that barcode.</p>
              )}
            </div>
          ) : (
            <p className="m-0 rounded-md border border-brand-softline bg-brand-n100 px-3 py-4 text-center text-xs text-brand-subtle">
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
            {!canChangePrice ? ' · managers only' : ''}
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
                if (canChangePrice) applyPriceChange(user?.id)
                else setAwaitingPriceApproval(true)
              }}
            >
              {canChangePrice ? 'Save' : 'Continue'}
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
          onApproved={({ staffId, name, role }) => applyPriceChange(staffId, { name, role })}
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
          {(() => {
            const promoInfo = promoByProductId.get(inquiryProduct.id)
            const salePrice = promoUnitPrice(inquiryProduct.price, promoInfo)
            const badge = promoBadgeLabel(promoInfo)
            const partner = promoPartnerLabel(promoInfo)
            return (
              <>
                {badge && (
                  <p className="mt-2 mb-0 text-xs font-bold text-brand-danger">
                    {badge}
                    {promoDisplayName(promoInfo) ? ` · ${promoDisplayName(promoInfo)}` : ''}
                    {partner && (
                      <span className="font-normal text-brand-subtle">
                        {' '}
                        ({partner.text})
                      </span>
                    )}
                  </p>
                )}
                <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-brand-n100 px-3 py-2">
                    <span className="block text-[10px] text-brand-subtle">
                      {salePrice != null ? 'Promo price' : 'Price'}
                    </span>
                    {salePrice != null ? (
                      <strong>
                        <span className="mr-1 text-brand-subtle line-through">{money(inquiryProduct.price)}</span>
                        <span className="text-brand-danger">{money(salePrice)}</span>
                      </strong>
                    ) : (
                      <strong>{money(inquiryProduct.price)}</strong>
                    )}
                  </div>
                  <div className="rounded-md bg-brand-n100 px-3 py-2">
                    <span className="block text-[10px] text-brand-subtle">On hand</span>
                    <strong>
                      {inquiryProduct.pricingMode === 'kg'
                        ? `${Number(inquiryProduct.stock || 0).toFixed(2)} kg`
                        : `${Number(inquiryProduct.stock || 0).toFixed(0)} pc`}
                    </strong>
                  </div>
                  <div className="rounded-md bg-brand-n100 px-3 py-2">
                    <span className="block text-[10px] text-brand-subtle">Category</span>
                    <strong>{inquiryProduct.category || '—'}</strong>
                  </div>
                  <div className="rounded-md bg-brand-n100 px-3 py-2">
                    <span className="block text-[10px] text-brand-subtle">Mode</span>
                    <strong>{inquiryProduct.pricingMode === 'kg' ? 'Weighed' : 'Piece'}</strong>
                  </div>
                </div>
              </>
            )
          })()}
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
