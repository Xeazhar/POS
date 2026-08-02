import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FiSearch } from 'react-icons/fi'
import Cart from '../components/pos/Cart'
import WeightModal from '../components/pos/WeightModal'
import { PageHeader, PrimaryButton, SearchBox } from '../components/ui'
import { isDeviceEnabled } from '../devices'
import { useAuthStore, useCartStore, useInventoryStore, useProductStore } from '../stores/posStore'
import { businessDate, formatOpenHourLabel, isTillClosed, money } from '../utils/format'

function menuSetupKey(branchId, bizDate) {
  return `cale-menu-setup:${branchId || 'x'}:${bizDate}`
}

function POS() {
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const products = useProductStore((state) => state.products)
  const toggleAvailableToday = useProductStore((state) => state.toggleAvailableToday)
  const dayEnds = useInventoryStore((state) => state.dayEnds)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const addItem = useCartStore((state) => state.addItem)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [weighted, setWeighted] = useState(null)
  const [manageMenu, setManageMenu] = useState(false)
  const [flashId, setFlashId] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const tillClosed = isTillClosed(dayEnds, dayOpenHour)
  const bizDate = businessDate(new Date(), dayOpenHour)
  const barcodeOn = isDeviceEnabled(user?.deviceSettings, 'barcode_scanner')
  const categories = ['All', ...new Set(products.map((product) => product.category))]
  const menuOnCount = products.filter((p) => p.availableToday !== false).length
  const menuOffCount = products.length - menuOnCount

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
    if (category !== 'All' && product.category !== category) return false
    const q = search.toLowerCase()
    if (!q) return true
    const fields = [product.name, product.sku, product.productCode]
    if (barcodeOn) fields.push(product.barcode)
    return fields.some((value) => String(value || '').toLowerCase().includes(q))
  })

  const select = (product) => {
    if (tillClosed) return
    if (isRestaurant && manageMenu) return
    if (product.pricingMode === 'kg') setWeighted(product)
    else addItem(product)
  }

  return (
    <div>
      <PageHeader
        eyebrow={isRestaurant ? 'CARINDERIA' : 'SALES FLOOR'}
        title={isRestaurant ? (manageMenu ? "Today's potahe" : 'Menu sale') : 'New sale'}
      >
        {isRestaurant && (
          manageMenu ? (
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
          )
        )}
      </PageHeader>
      {tillClosed && (
        <p className="mb-3 rounded-md bg-brand-danger-bg px-3 py-2.5 text-xs text-brand-danger">
          Business day {bizDate} is closed. Sales are locked until a manager reopens the till,
          or automatically at {formatOpenHourLabel(dayOpenHour)} for the next business day.
        </p>
      )}
      {isRestaurant && manageMenu && (
        <div className="mb-3 rounded-md border border-brand-dark/15 bg-[#f4f5f1] px-4 py-3">
          <strong className="block text-sm text-brand-ink">What are you serving today?</strong>
          <p className="m-0 mt-1 text-xs text-brand-muted">
            Tap a dish to toggle <span className="font-bold text-brand-success">Serving</span> or{' '}
            <span className="font-bold text-brand-danger">Not available</span>. Only serving items
            appear on the sale screen.
          </p>
          <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
            <span className="rounded bg-[#eef6ea] px-2 py-1 font-bold text-brand-success">
              Serving {menuOnCount}
            </span>
            <span className="rounded bg-[#fce8e8] px-2 py-1 font-bold text-brand-danger">
              Off {menuOffCount}
            </span>
          </div>
        </div>
      )}
      <div
        className={`grid gap-6 max-[1050px]:grid-cols-1 max-[1050px]:gap-4 ${
          isRestaurant && manageMenu
            ? 'grid-cols-1'
            : 'grid-cols-[minmax(0,1fr)_360px]'
        }`}
      >
        <div
          className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-brand-line bg-white p-[18px] max-[700px]:p-3.5 max-[1050px]:min-h-[390px] ${
            tillClosed ? 'opacity-60' : ''
          }`}
        >
          <div className="mb-3.5 flex min-w-0 flex-col gap-3">
            <SearchBox
              className="w-full min-w-0"
              icon={<FiSearch />}
              autoFocus={!tillClosed && !manageMenu}
              disabled={tillClosed}
              placeholder={
                isRestaurant
                  ? manageMenu
                    ? 'Search potahe to turn on/off'
                    : 'Search menu / potahe'
                  : barcodeOn
                    ? 'Search, scan barcode or enter SKU'
                    : 'Search name or SKU'
              }
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible[0] && !manageMenu) select(visible[0])
              }}
            />
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
          </div>
          <div
            className={`grid min-h-0 flex-1 content-start gap-3 overflow-auto px-0.5 pt-1.5 pb-1 pr-1 ${
              manageMenu && isRestaurant
                ? 'grid-cols-3 max-[1050px]:grid-cols-2 max-[700px]:grid-cols-1'
                : 'grid-cols-5 max-[1050px]:grid-cols-3 max-[1050px]:max-h-[52vh] max-[700px]:grid-cols-2'
            }`}
          >
            {visible.map((product) => {
              const offToday = isRestaurant && product.availableToday === false
              const flashing = flashId === product.id
              return (
                <button
                  key={product.id}
                  type="button"
                  disabled={tillClosed || (isRestaurant && !manageMenu && offToday)}
                  className={`tap-target flex min-h-[168px] flex-col items-start rounded-[8px] border p-4 text-left transition-[border-color,box-shadow,transform,filter,opacity,background-color] duration-150 disabled:cursor-not-allowed ${
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
                        offToday
                          ? 'bg-[#fce8e8] text-brand-danger'
                          : 'bg-[#eef6ea] text-brand-success'
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
                    {isRestaurant && product.budgetPrice != null
                      ? ` - ${money(product.budgetPrice)} bud`
                      : ''}
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
              )
            })}
            {visible.length === 0 && (
              <p className="col-span-full py-10 text-center text-xs text-brand-subtle">
                {isRestaurant
                  ? manageMenu
                    ? 'No menu items yet — ask a manager to add potahe.'
                    : 'No potahe marked available today. Tap Edit today\'s potahe to enable items.'
                  : 'No products match this search.'}
              </p>
            )}
          </div>
          {isRestaurant && manageMenu && (
            <div className="mt-4 flex justify-end border-t border-brand-softline pt-3">
              <PrimaryButton compact type="button" className="max-[700px]:w-full" onClick={finishMenuSetup}>
                {menuOnCount === 0 ? 'Skip for now' : `Sell (${menuOnCount} on)`}{' '}
                <span aria-hidden>{'\u2192'}</span>
              </PrimaryButton>
            </div>
          )}
        </div>
        {!(isRestaurant && manageMenu) && <Cart tillClosed={tillClosed} />}
      </div>
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
    </div>
  )
}

export default POS
