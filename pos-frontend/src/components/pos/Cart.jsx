import { useState } from 'react'
import { FiTrash2 } from 'react-icons/fi'
import { isDeviceEnabled, receiptPrinter } from '../../devices'
import { useIsTouchUi } from '../../hooks/useIsTouchUi'
import { useAuthStore, useCartStore, useInventoryStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { buildReceipt } from '../../utils/receipt'
import { money, qty, today } from '../../utils/format'
import { hasBudgetTier, lineTotal } from '../../utils/ulam'
import { Eyebrow, PrimaryButton, StatusOverlay } from '../ui'
import CashConfirm from './CashConfirm'
import NumPad from './NumPad'

function Cart({ tillClosed = false }) {
  const {
    items,
    removeItem,
    clear,
    total,
    orderType,
    setOrderType,
    setPriceTier,
    ulamCombo,
  } = useCartStore()
  const addTransaction = useInventoryStore((state) => state.addTransaction)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const user = useAuthStore((state) => state.user)
  const isRestaurant = user?.branchType === 'restaurant'
  const [tendered, setTendered] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [paying, setPaying] = useState(false)
  const [paidResult, setPaidResult] = useState(null)
  const [error, setError] = useState('')
  const touchUi = useIsTouchUi()
  const subtotal = total()
  const combo = isRestaurant ? ulamCombo() : null

  const complete = async () => {
    if (tillClosed) {
      setError(formatSupportError({ message: 'Till is closed — ask a manager to reopen.', code: 'TILL01' }, 'TILL01'))
      setConfirming(false)
      return
    }
    setError('')
    setConfirming(false)
    setPaying(true)
    try {
      const saved = await addTransaction({
        id: `TX-${items.length}-${Math.round(subtotal * 100)}`,
        time: 'Just now',
        cashier: user?.name || 'Staff',
        total: subtotal,
        tendered: Number(tendered),
        status: 'Paid',
        items: items.length,
        itemsList: items,
        date: today(dayOpenHour),
        orderType: isRestaurant ? orderType : undefined,
        ulamCombo: combo?.code || null,
      })
      const cartItems = [...items]
      const cash = Number(tendered)
      const change = Math.max(0, cash - subtotal)
      const orLabel = saved?.orNumber || saved?.id || '—'
      const saleOrderType = isRestaurant ? orderType : undefined

      // Show success immediately — print does not block the next sale
      clear()
      setTendered('')
      setPaying(false)
      setPaidResult({
        orNumber: orLabel,
        total: subtotal,
        tendered: cash,
        change,
      })

      const receipt = buildReceipt({
        branch: {
          name: user?.branchName,
          business_name: user?.branchName,
        },
        user,
        transaction: {
          ...saved,
          orNumber: orLabel,
          tendered: cash,
          change,
          total: subtotal,
          cashier: user?.name || 'Staff',
          status: 'Paid',
          createdAt: saved?.createdAt || new Date().toISOString(),
          orderType: saleOrderType,
        },
        lines: cartItems.map((item) => ({
          name: item.name,
          sku: item.sku,
          pricingMode: item.pricingMode,
          quantity: item.pricingMode === 'kg' ? item.weight : item.quantity,
          unitPrice: item.price,
          lineTotal: lineTotal(item),
          priceTier: item.priceTier,
        })),
      })
      void (async () => {
        if (!isDeviceEnabled(user?.deviceSettings, 'receipt_printer')) return
        try {
          await receiptPrinter.printReceipt(receipt)
        } catch (printErr) {
          console.warn('Receipt print skipped:', printErr.message)
        }
      })()
    } catch (err) {
      setError(formatSupportError(err, 'SALE01'))
      setPaying(false)
    }
  }

  const groups = items.reduce((result, item, index) => {
    const key = `${item.id}:${item.priceTier || 'regular'}`
    if (!result[key]) result[key] = []
    result[key].push({ item, index })
    return result
  }, {})

  const quickCash = [
    { label: 'Exact', value: subtotal },
    { label: '₱50', value: 50 },
    { label: '₱100', value: 100 },
    { label: '₱200', value: 200 },
    { label: '₱500', value: 500 },
    { label: '₱1000', value: 1000 },
  ]

  return (
    <>
      {confirming && (
        <CashConfirm
          items={items}
          total={subtotal}
          tendered={Number(tendered)}
          cancel={() => setConfirming(false)}
          confirm={complete}
          isRestaurant={isRestaurant}
        />
      )}
      {paying && (
        <StatusOverlay title="Processing payment" message="Recording sale…" />
      )}
      {paidResult && (
        <StatusOverlay
          done
          title="Sale complete"
          message={`OR ${paidResult.orNumber} · ${money(paidResult.total)} · Change ${money(paidResult.change)}`}
          onClose={() => setPaidResult(null)}
          closeLabel="New sale"
        />
      )}
      <section className="flex h-[calc(100vh-150px)] min-h-0 min-w-0 flex-col rounded-[10px] border border-brand-line bg-brand-panel p-[18px] text-white max-[1050px]:h-auto max-[1050px]:min-h-[390px] max-[700px]:p-3.5">
        <div className="flex items-start justify-between border-b border-brand-cart-line pb-5">
          <div>
            <Eyebrow className="text-[#a8aeaa]">CURRENT SALE</Eyebrow>
            <h2 className="m-0 text-lg capitalize">Receipt / cart</h2>
          </div>
          <span className="text-xs text-[#797e7b]">{items.length} items</span>
        </div>
        {error && <p className="mt-2 text-xs text-[#ffb4b4]">{error}</p>}
        {tillClosed && (
          <p className="mt-2 text-xs text-[#ffb4b4]">Till closed — sales unavailable until a manager reopens.</p>
        )}
        {isRestaurant && (
          <div className="mt-3 flex gap-2">
            {[
              { id: 'dine_in', label: 'Dine-in' },
              { id: 'takeout', label: 'Takeout' },
            ].map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`flex-1 rounded-[5px] border px-2 py-2 text-xs font-bold transition-colors ${
                  orderType === opt.id
                    ? 'border-brand-gold bg-brand-gold/20 text-brand-gold'
                    : 'border-brand-cart-border bg-transparent text-[#aab0ac]'
                }`}
                onClick={() => setOrderType(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
        {combo && (
          <p className="mt-2 rounded-[5px] border border-brand-gold/40 bg-brand-gold/10 px-2.5 py-1.5 text-[11px] font-bold text-brand-gold">
            Combo: {combo.label}
            <span className="ml-1 font-normal text-[#a8aeaa]">(info only — priced per item)</span>
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto max-[1050px]:min-h-[170px]">
          {items.length ? (
            Object.values(groups).flatMap((group) => [
              <div
                className="border-b border-brand-cart-row pt-3 pb-[3px] text-[10px] font-bold tracking-[0.5px] text-brand-gold"
                key={`${group[0].item.id}-${group[0].item.priceTier || 'regular'}-group`}
              >
                {group[0].item.name}
              </div>,
              ...group.map(({ item, index }) => {
                const showTier =
                  isRestaurant &&
                  hasBudgetTier(item.menuKind) &&
                  item.budgetPrice != null
                return (
                  <div
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-brand-cart-row py-3.5"
                    key={`${item.id}-${item.priceTier || 'regular'}-${index}`}
                  >
                    <div>
                      <strong className="block text-xs">
                        {item.pricingMode === 'kg'
                          ? 'Weigh-in'
                          : `${item.name} × ${Number(item.quantity).toFixed(0)} pc`}
                      </strong>
                      <small className="mt-1 block text-[10px] text-brand-cart-muted">
                        {item.pricingMode === 'kg'
                          ? `${qty(item.weight, 'kg')} × ${money(item.price)}/kg`
                          : `${money(item.price)}/pc${
                              showTier && item.priceTier === 'budget' ? ' · budget' : ''
                            }`}
                      </small>
                      {showTier && (
                        <div className="mt-2 flex gap-1">
                          {[
                            { id: 'regular', label: `Reg ${money(item.regularPrice ?? item.price)}` },
                            { id: 'budget', label: `Bud ${money(item.budgetPrice)}` },
                          ].map((tier) => (
                            <button
                              key={tier.id}
                              type="button"
                              className={`rounded border px-2 py-1 text-[10px] font-bold ${
                                (item.priceTier || 'regular') === tier.id
                                  ? 'border-brand-gold bg-brand-gold/25 text-brand-gold'
                                  : 'border-brand-cart-border text-[#8a908c]'
                              }`}
                              onClick={() => setPriceTier(index, tier.id)}
                            >
                              {tier.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <b className="text-xs">{money(lineTotal(item))}</b>
                    <button
                      type="button"
                      className="border-0 bg-transparent text-brand-cart-muted transition-[transform,color] duration-100 hover:text-white active:scale-90 active:text-white"
                      onClick={() => removeItem(index)}
                    >
                      <FiTrash2 />
                    </button>
                  </div>
                )
              }),
            ])
          ) : (
            <div className="mt-[150px] text-center text-[13px] leading-[1.8] text-[#bbc0bd]">
              Your cart is ready.
              <br />
              <span className="text-[11px] text-[#7f8782]">Select a product to begin.</span>
            </div>
          )}
        </div>
        <div className="border-t border-brand-cart-line pt-[18px]">
          <div className="mb-[15px] flex justify-between text-[13px]">
            <span>Subtotal</span>
            <strong>{money(subtotal)}</strong>
          </div>
          {touchUi ? (
            <div className="mb-3.5">
              <div className="mb-2 flex w-full items-center justify-between rounded-[6px] border border-brand-cart-border bg-brand-cart-input px-3 py-3">
                <span className="text-xs text-[#aab0ac]">Cash tendered</span>
                <strong className="font-mono text-lg text-white tabular-nums">
                  {tendered === '' ? '0.00' : tendered}
                </strong>
              </div>
              {items.length > 0 && !tillClosed && (
                <NumPad
                  variant="dark"
                  value={tendered}
                  onChange={setTendered}
                  allowDecimal
                  quickAmounts={quickCash}
                  onQuickAmount={(item) => {
                    const add = Number(item.value)
                    if (!Number.isFinite(add)) return
                    // Exact always sets the amount; bill shortcuts add on each press
                    if (item.label === 'Exact') {
                      setTendered(String(Math.round(add * 100) / 100))
                      return
                    }
                    const current = Number(tendered || 0)
                    const next = (Number.isFinite(current) ? current : 0) + add
                    setTendered(String(Math.round(next * 100) / 100))
                  }}
                />
              )}
            </div>
          ) : (
            <label className="mb-3.5 flex items-center justify-between text-xs text-[#aab0ac]">
              Cash tendered
              <input
                className="w-[100px] rounded border border-brand-cart-border bg-brand-cart-input p-2 text-right text-white outline-none"
                value={tendered}
                onChange={(event) => setTendered(event.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))}
                inputMode="decimal"
                placeholder="0.00"
              />
            </label>
          )}
          <div className="mb-[15px] flex justify-between text-[13px] text-brand-gold">
            <span>Change</span>
            <strong>{money(Math.max(0, Number(tendered || 0) - subtotal))}</strong>
          </div>
          <PrimaryButton
            className="justify-between"
            disabled={tillClosed || !items.length || Number(tendered) < subtotal || paying}
            onClick={() => setConfirming(true)}
          >
            <span>Pay cash</span>
            <span aria-hidden>→</span>
          </PrimaryButton>
        </div>
      </section>
    </>
  )
}

export default Cart
