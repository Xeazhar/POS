import { useMemo, useState } from 'react'
import { FiMinus, FiPlus, FiTrash2 } from 'react-icons/fi'
import { useNavigate } from 'react-router-dom'
import { isDeviceEnabled, receiptPrinter } from '../../devices'
import { useIsTouchUi } from '../../hooks/useIsTouchUi'
import { useAuthStore, useCartStore, useInventoryStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { buildReceipt } from '../../utils/receipt'
import { money, qty, today, formatOpenHourLabel } from '../../utils/format'
import { hasBudgetTier, lineTotal } from '../../utils/ulam'
import { isSupervisorOrAbove } from '../../utils/roles'
import { Eyebrow, Modal, ModalActions, PrimaryButton, SecondaryButton, StatusOverlay } from '../ui'
import SupervisorApprove from '../shared/SupervisorApprove'
import NumPad from './NumPad'

const PAY_METHODS = [
  { id: 'cash', label: 'Cash' },
  { id: 'card', label: 'Card' },
  { id: 'ewallet', label: 'E-wallet' },
]

function Cart({ tillClosed = false }) {
  const {
    items,
    removeItem,
    adjustQuantity,
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
  const canRemoveDirect = isSupervisorOrAbove(user?.role)
  const [tendered, setTendered] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [paymentReference, setPaymentReference] = useState('')
  const [discountType, setDiscountType] = useState('')
  const [discountIdNote, setDiscountIdNote] = useState('')
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [paying, setPaying] = useState(false)
  const [paidResult, setPaidResult] = useState(null)
  const [dayEndNudge, setDayEndNudge] = useState(false)
  const [error, setError] = useState('')
  const [removeIndex, setRemoveIndex] = useState(null)
  const touchUi = useIsTouchUi()
  const navigate = useNavigate()
  const rawSubtotal = total()
  const combo = isRestaurant ? ulamCombo() : null
  const vatRate = Number(user?.vatRate ?? 0.12)

  const pricing = useMemo(() => {
    const eligible = items.filter((item) => item.discountEligible === true)
    const eligibleTotal = eligible.reduce((sum, item) => sum + lineTotal(item), 0)
    const discountPct = discountType === 'pwd' || discountType === 'senior' ? 0.2 : 0
    const discountAmount = Number((eligibleTotal * discountPct).toFixed(2))
    const afterDiscount = Math.max(0, Number((rawSubtotal - discountAmount).toFixed(2)))
    const vatableSales = afterDiscount
    const vatAmount =
      vatRate > 0
        ? Number(((vatableSales * vatRate) / (1 + vatRate)).toFixed(2))
        : 0
    return {
      discountAmount,
      discountType: discountType || null,
      afterDiscount,
      vatableSales,
      vatAmount,
      total: afterDiscount,
    }
  }, [items, rawSubtotal, discountType, vatRate])

  const payTotal = pricing.total
  const needsCash = paymentMethod === 'cash'
  const canPay =
    !tillClosed &&
    items.length > 0 &&
    !paying &&
    (needsCash ? Number(tendered) >= payTotal : true) &&
    (paymentMethod !== 'ewallet' || String(paymentReference).trim().length > 0) &&
    (!(discountType === 'pwd' || discountType === 'senior') || String(discountIdNote).trim().length > 0)

  const shouldNudgeDayEnd = () => {
    const hour = new Date().getHours()
    const open = Number(dayOpenHour ?? 7)
    // Soft nudge in the last 2 hours before typical close (open + 14h), or after 8:00 PM
    const closeHour = (open + 14) % 24
    if (hour >= 20) return true
    if (closeHour > open) return hour >= closeHour - 2
    // Overnight close window (e.g. open 10 -> close 0): nudge from 22:00
    return hour >= 22
  }

  const dayEndNudgeMessage = () => {
    const open = Number(dayOpenHour ?? 7)
    const closeHour = (open + 14) % 24
    const closeLabel = formatOpenHourLabel(closeHour)
    const now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return `It's ${now}. Typical day-end is around ${closeLabel} (or after 8:00 PM). Close the till when you're ready.`
  }

  const complete = async () => {
    if (tillClosed) {
      setError(
        formatSupportError(
          { message: 'Till is closed — ask a manager to reopen.', code: 'TILL01' },
          'TILL01',
        ),
      )
      setCheckoutOpen(false)
      return
    }
    if (paymentMethod === 'ewallet' && !String(paymentReference).trim()) {
      setError('E-wallet reference is required.')
      setCheckoutOpen(false)
      return
    }
    setError('')
    setCheckoutOpen(false)
    setPaying(true)
    try {
      const cash =
        paymentMethod === 'cash' ? Number(tendered) : Number(payTotal)
      const saved = await addTransaction({
        id: `TX-${items.length}-${Math.round(payTotal * 100)}`,
        time: 'Just now',
        cashier: user?.name || 'Staff',
        total: payTotal,
        tendered: cash,
        status: 'Paid',
        items: items.length,
        itemsList: items,
        date: today(dayOpenHour),
        orderType: isRestaurant ? orderType : undefined,
        ulamCombo: combo?.code || null,
        paymentMethod,
        paymentReference: paymentMethod === 'ewallet' ? String(paymentReference).trim() : null,
        vatAmount: pricing.vatAmount,
        vatableSales: pricing.vatableSales,
        discountAmount: pricing.discountAmount,
        discountType: pricing.discountType,
        discountIdNote: pricing.discountType ? String(discountIdNote).trim() : null,
      })
      const cartItems = [...items]
      const change = Math.max(0, cash - payTotal)
      const orLabel = saved?.orNumber || saved?.id || '—'
      const saleOrderType = isRestaurant ? orderType : undefined

      clear()
      setTendered('')
      setPaymentReference('')
      setDiscountType('')
      setDiscountIdNote('')
      setPaymentMethod('cash')
      setPaying(false)
      setPaidResult({
        orNumber: orLabel,
        total: payTotal,
        tendered: cash,
        change,
        paymentMethod,
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
          total: payTotal,
          cashier: user?.name || 'Staff',
          status: 'Paid',
          createdAt: saved?.createdAt || new Date().toISOString(),
          orderType: saleOrderType,
          paymentMethod,
          paymentReference: paymentMethod === 'ewallet' ? String(paymentReference).trim() : null,
          vatAmount: pricing.vatAmount,
          vatableSales: pricing.vatableSales,
          discountAmount: pricing.discountAmount,
          discountType: pricing.discountType,
          discountIdNote: pricing.discountType ? String(discountIdNote).trim() : null,
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

      if (shouldNudgeDayEnd()) {
        setTimeout(() => setDayEndNudge(true), 400)
      }
    } catch (err) {
      setError(formatSupportError(err, 'SALE01'))
      setPaying(false)
    }
  }

  const requestRemove = (index) => {
    if (canRemoveDirect) {
      removeItem(index)
      return
    }
    setRemoveIndex(index)
  }

  const bumpQty = (index, delta) => {
    const item = items[index]
    if (!item) return
    if (item.pricingMode === 'kg') {
      const next = Number(item.weight || 0) + delta * 0.1
      if (next <= 0) {
        requestRemove(index)
        return
      }
      adjustQuantity(index, delta)
      return
    }
    const next = Number(item.quantity || 0) + delta
    if (next <= 0) {
      requestRemove(index)
      return
    }
    adjustQuantity(index, delta)
  }

  const groups = items.reduce((result, item, index) => {
    const key = `${item.id}:${item.priceTier || 'regular'}`
    if (!result[key]) result[key] = []
    result[key].push({ item, index })
    return result
  }, {})

  const quickCash = [
    { label: 'Exact', value: payTotal },
    { label: '₱50', value: 50 },
    { label: '₱100', value: 100 },
    { label: '₱200', value: 200 },
    { label: '₱500', value: 500 },
    { label: '₱1000', value: 1000 },
  ]

  const methodLabel =
    PAY_METHODS.find((m) => m.id === paymentMethod)?.label || 'Cash'

  const openCheckout = () => {
    if (!items.length || tillClosed) return
    if (paymentMethod === 'cash' && (tendered === '' || Number(tendered) < payTotal)) {
      setTendered(String(Math.round(payTotal * 100) / 100))
    }
    setCheckoutOpen(true)
  }

  const applyQuickCash = (item) => {
    const add = Number(item.value)
    if (!Number.isFinite(add)) return
    if (item.label === 'Exact') {
      setTendered(String(Math.round(add * 100) / 100))
      return
    }
    const current = Number(tendered || 0)
    const next = (Number.isFinite(current) ? current : 0) + add
    setTendered(String(Math.round(next * 100) / 100))
  }

  return (
    <>
      {checkoutOpen && (
        <Modal wide onClose={() => setCheckoutOpen(false)}>
          <Eyebrow>CHECKOUT</Eyebrow>
          <h2 className="mb-1 pr-8 text-[22px] max-[700px]:text-xl">{money(payTotal)}</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            {items.length} item{items.length === 1 ? '' : 's'}
            {pricing.discountAmount > 0 ? ` · discount −${money(pricing.discountAmount)}` : ''}
          </p>

          <p className="mb-1.5 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">Payment</p>
          <div className="mb-3 flex gap-1.5">
            {PAY_METHODS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`flex-1 rounded-[5px] border px-2 py-2.5 text-xs font-bold max-[700px]:py-2 ${
                  paymentMethod === m.id
                    ? 'border-brand-dark bg-brand-dark text-white'
                    : 'border-brand-border bg-white text-brand-ink'
                }`}
                onClick={() => {
                  setPaymentMethod(m.id)
                  if (m.id !== 'cash') setTendered(String(payTotal))
                  else if (tendered === '') setTendered(String(Math.round(payTotal * 100) / 100))
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          {paymentMethod === 'ewallet' && (
            <label className="mb-3 block text-xs text-brand-muted">
              Reference
              <input
                className="mt-1 w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="Ref no."
              />
            </label>
          )}

          <p className="mb-1.5 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">Discount</p>
          <div className="mb-3 flex gap-1.5">
            {[
              { id: '', label: 'None' },
              { id: 'pwd', label: 'PWD 20%' },
              { id: 'senior', label: 'Senior 20%' },
            ].map((d) => (
              <button
                key={d.id || 'none'}
                type="button"
                className={`flex-1 rounded-[5px] border px-2 py-2 text-[11px] font-bold ${
                  discountType === d.id
                    ? 'border-brand-dark bg-brand-dark text-white'
                    : 'border-brand-border bg-white text-brand-ink'
                }`}
                onClick={() => setDiscountType(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
          {(discountType === 'pwd' || discountType === 'senior') && (
            <label className="mb-3 block text-xs text-brand-muted">
              ID note
              <input
                className="mt-1 w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
                value={discountIdNote}
                onChange={(e) => setDiscountIdNote(e.target.value)}
                placeholder="ID number"
              />
            </label>
          )}

          {needsCash && (
            <div className="mb-3 rounded-md border border-brand-softline bg-[#f7f7f4] p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-brand-muted">Cash tendered</span>
                <strong className="font-mono text-lg tabular-nums text-brand-ink">
                  {tendered === '' ? '0.00' : tendered}
                </strong>
              </div>
              {touchUi ? (
                <NumPad
                  value={tendered}
                  onChange={setTendered}
                  allowDecimal
                  quickAmounts={quickCash}
                  onQuickAmount={applyQuickCash}
                />
              ) : (
                <>
                  <input
                    className="mb-2 w-full rounded border border-brand-line bg-white p-2.5 text-right font-mono text-brand-ink outline-none"
                    value={tendered}
                    onChange={(event) =>
                      setTendered(event.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))
                    }
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                  <div className="grid grid-cols-3 gap-1.5">
                    {quickCash.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="rounded-[5px] border border-brand-border bg-white px-1 py-2 text-[11px] font-bold text-brand-ink hover:border-brand-dark"
                        onClick={() => applyQuickCash(item)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="mt-2 flex justify-between text-sm text-brand-ink">
                <span>Change</span>
                <strong className="text-brand-success">
                  {money(Math.max(0, Number(tendered || 0) - payTotal))}
                </strong>
              </div>
            </div>
          )}

          {vatRate > 0 && (
            <p className="m-0 mb-3 text-[11px] text-brand-subtle">
              VAT ({(vatRate * 100).toFixed(0)}% incl.) {money(pricing.vatAmount)}
            </p>
          )}

          <ModalActions>
            <SecondaryButton compact type="button" onClick={() => setCheckoutOpen(false)}>
              Back
            </SecondaryButton>
            <PrimaryButton compact type="button" disabled={!canPay} onClick={complete}>
              Confirm {methodLabel.toLowerCase()}
            </PrimaryButton>
          </ModalActions>
        </Modal>
      )}
      {paying && <StatusOverlay title="Processing payment" message="Recording sale…" />}
      {paidResult && !dayEndNudge && (
        <StatusOverlay
          done
          title="Sale complete"
          message={`OR ${paidResult.orNumber} · ${money(paidResult.total)} · ${methodLabel}${
            paidResult.paymentMethod === 'cash' ? ` · Change ${money(paidResult.change)}` : ''
          }`}
          onClose={() => setPaidResult(null)}
          closeLabel="New sale"
        />
      )}
      {dayEndNudge && (
        <StatusOverlay
          done
          title="Day end?"
          message={dayEndNudgeMessage()}
          onClose={() => {
            setDayEndNudge(false)
            setPaidResult(null)
          }}
          closeLabel="Dismiss"
          actions={
            <PrimaryButton
              compact
              type="button"
              onClick={() => {
                setDayEndNudge(false)
                setPaidResult(null)
                navigate('/day-end')
              }}
            >
              Continue to Day end
            </PrimaryButton>
          }
        />
      )}
      {removeIndex != null && (
        <SupervisorApprove
          branchId={user?.branchId}
          title="Remove cart item"
          detail={`Supervisor PIN required to remove ${items[removeIndex]?.name || 'this item'} from the cart.`}
          onCancel={() => setRemoveIndex(null)}
          onApproved={() => {
            removeItem(removeIndex)
            setRemoveIndex(null)
          }}
        />
      )}
      <section className="flex h-[calc(100vh-140px)] min-h-0 min-w-0 flex-col rounded-[10px] border border-brand-line bg-brand-panel text-white max-[1050px]:h-auto max-[1050px]:min-h-[520px] max-[800px]:h-auto max-[800px]:min-h-[560px]">
        <div className="flex shrink-0 items-start justify-between border-b border-brand-cart-line px-5 pt-5 pb-4 max-[700px]:px-3.5">
          <div>
            <Eyebrow className="text-[#a8aeaa]">CURRENT SALE</Eyebrow>
            <h2 className="m-0 text-lg capitalize">Receipt / cart</h2>
          </div>
          <span className="text-xs text-[#797e7b]">{items.length} items</span>
        </div>
        {error && <p className="px-5 pt-2 text-xs text-[#ffb4b4] max-[700px]:px-3.5">{error}</p>}
        {tillClosed && (
          <p className="px-5 pt-2 text-xs text-[#ffb4b4] max-[700px]:px-3.5">
            Till closed — sales unavailable until a manager reopens.
          </p>
        )}
        {isRestaurant && (
          <div className="flex gap-2 px-5 pt-3 max-[700px]:px-3.5">
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
          <p className="mx-5 mt-2 rounded-[5px] border border-brand-gold/40 bg-brand-gold/10 px-2.5 py-1.5 text-[11px] font-bold text-brand-gold max-[700px]:mx-3.5">
            Combo: {combo.label}
            <span className="ml-1 font-normal text-[#a8aeaa]">(info only — priced per item)</span>
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-2 max-[1050px]:min-h-[320px] max-[800px]:min-h-[340px] max-[700px]:px-3.5">
          {items.length ? (
            Object.values(groups).flatMap((group) => [
              <div
                className="border-b border-brand-cart-row pt-3 pb-[3px] text-[11px] font-bold tracking-[0.5px] text-brand-gold"
                key={`${group[0].item.id}-${group[0].item.priceTier || 'regular'}-group`}
              >
                {group[0].item.name}
              </div>,
              ...group.map(({ item, index }) => {
                const showTier =
                  isRestaurant && hasBudgetTier(item.menuKind) && item.budgetPrice != null
                return (
                  <div
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-brand-cart-row py-4"
                    key={`${item.id}-${item.priceTier || 'regular'}-${index}`}
                  >
                    <div>
                      <strong className="block text-[13px] leading-snug">
                        {item.pricingMode === 'kg' ? 'Weigh-in' : item.name}
                      </strong>
                      <small className="mt-1.5 block text-[11px] text-brand-cart-muted">
                        {item.pricingMode === 'kg'
                          ? `${qty(item.weight, 'kg')} Ã— ${money(item.price)}/kg`
                          : `${money(item.price)}/pc${
                              showTier && item.priceTier === 'budget' ? ' · budget' : ''
                            }`}
                      </small>
                      <div className="mt-2.5 flex items-center gap-2">
                        <button
                          type="button"
                          className="grid h-8 w-8 place-items-center rounded border border-brand-cart-border text-[#aab0ac]"
                          onClick={() => bumpQty(index, -1)}
                          aria-label="Decrease quantity"
                        >
                          <FiMinus size={13} />
                        </button>
                        <span className="min-w-[2.75rem] text-center text-xs font-bold tabular-nums text-white">
                          {item.pricingMode === 'kg'
                            ? qty(item.weight, 'kg')
                            : `${Number(item.quantity).toFixed(0)} pc`}
                        </span>
                        <button
                          type="button"
                          className="grid h-8 w-8 place-items-center rounded border border-brand-cart-border text-[#aab0ac]"
                          onClick={() => bumpQty(index, 1)}
                          aria-label="Increase quantity"
                        >
                          <FiPlus size={13} />
                        </button>
                      </div>
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
                    <b className="text-[13px] tabular-nums">{money(lineTotal(item))}</b>
                    <button
                      type="button"
                      className="border-0 bg-transparent p-1 text-brand-cart-muted transition-[transform,color] duration-100 hover:text-white active:scale-90 active:text-white"
                      onClick={() => requestRemove(index)}
                      title={canRemoveDirect ? 'Remove' : 'Remove (supervisor PIN)'}
                    >
                      <FiTrash2 size={16} />
                    </button>
                  </div>
                )
              }),
            ])
          ) : (
            <div className="mt-[140px] px-2 text-center text-sm leading-[1.8] text-[#bbc0bd]">
              Your cart is ready.
              <br />
              <span className="text-xs text-[#7f8782]">Select a product to begin.</span>
            </div>
          )}
        </div>

        {/* Slim sticky footer — payment details live in Checkout modal */}
        <footer className="shrink-0 border-t border-brand-cart-line bg-[#1a1d1b] px-5 py-4 max-[700px]:px-3.5">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <span className="block text-[11px] text-[#8a908c]">
                {items.length} item{items.length === 1 ? '' : 's'}
                {pricing.discountAmount > 0 ? ` · −${money(pricing.discountAmount)} disc.` : ''}
              </span>
              <strong className="mt-0.5 block text-xl tabular-nums text-white">{money(payTotal)}</strong>
            </div>
            {vatRate > 0 && (
              <span className="text-[10px] text-[#6e7470]">VAT incl. {money(pricing.vatAmount)}</span>
            )}
          </div>
          <PrimaryButton
            className="w-full justify-between"
            disabled={!items.length || tillClosed || paying}
            onClick={openCheckout}
          >
            <span>Checkout</span>
            <span aria-hidden>{'\u2192'}</span>
          </PrimaryButton>
        </footer>
      </section>
    </>
  )
}

export default Cart
