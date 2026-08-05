import { useEffect, useMemo, useState } from 'react'
import { FiMinus, FiPlus, FiTrash2 } from 'react-icons/fi'
import { useNavigate } from 'react-router-dom'
import { isDeviceEnabled, receiptPrinter } from '../../devices'
import { useIsTouchUi } from '../../hooks/useIsTouchUi'
import { useAuthStore, useCartStore, useInventoryStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { buildReceipt } from '../../utils/receipt'
import { money, pesoWhole, PESO, qty, today, formatOpenHourLabel } from '../../utils/format'
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

function Cart({
  tillClosed = false,
  headerActions = null,
  onOverlayChange = null,
  barcodeMode = false,
  promoRules = [],
  promoLabel = null,
}) {
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
    const isPwdSenior = discountType === 'pwd' || discountType === 'senior'
    const pwdDiscountPct = isPwdSenior ? 0.2 : 0

    const hasEligibleItems = items.some((item) => item.discountEligible === true)
    const eligibleTotal = items.reduce((sum, item) => sum + (item.discountEligible === true ? lineTotal(item) : 0), 0)

    const pwdLineDiscounts = items.map((item) =>
      item.discountEligible === true && pwdDiscountPct > 0 ? Number((lineTotal(item) * pwdDiscountPct).toFixed(2)) : 0,
    )
    const pwdDiscountAmount = Number(pwdLineDiscounts.reduce((sum, v) => sum + v, 0).toFixed(2))

    const computePromoDiscounts = () => {
      if (isPwdSenior) return null
      if (!promoRules?.length) return null

      const lineDiscounts = items.map(() => 0)

      const lineQtyPc = (item) => (item.pricingMode === 'kg' ? 0 : Number(item.quantity || 0))
      const lineUnit = (idx) => Number(items[idx]?.price ?? 0)

      const indicesByProductId = {}
      items.forEach((item, idx) => {
        if (item.pricingMode === 'kg') return
        if (!indicesByProductId[item.id]) indicesByProductId[item.id] = []
        indicesByProductId[item.id].push(idx)
      })

      const allocateUnitsForProduct = (productId, unitsToDiscount, discountAmountPerUnitFn) => {
        const indices = indicesByProductId[productId] || []
        let remaining = unitsToDiscount
        for (const idx of indices) {
          if (remaining <= 0) break
          const q = lineQtyPc(items[idx])
          if (q <= 0) continue
          const take = Math.min(q, remaining)
          lineDiscounts[idx] = Number((lineDiscounts[idx] + discountAmountPerUnitFn(idx, take)).toFixed(2))
          remaining -= take
        }
      }

      for (const rule of promoRules || []) {
        const pct = Number(rule.discountPct || 0) / 100
        if (pct <= 0) continue

        const productIds = (rule.products || []).map((p) => p.productId)
        if (!productIds.length) continue

        if (rule.ruleType === 'item_pct') {
          const productId = productIds[0]
          for (const idx of indicesByProductId[productId] || []) {
            lineDiscounts[idx] = Number((lineDiscounts[idx] + lineTotal(items[idx]) * pct).toFixed(2))
          }
          continue
        }

        if (rule.ruleType === 'pair_pct') {
          const [a, b] = productIds
          if (!a || !b) continue
          const idxsA = indicesByProductId[a] || []
          const idxsB = indicesByProductId[b] || []
          const totalA = idxsA.reduce((s, idx) => s + lineQtyPc(items[idx]), 0)
          const totalB = idxsB.reduce((s, idx) => s + lineQtyPc(items[idx]), 0)
          const pairs = Math.min(totalA, totalB)
          if (pairs <= 0) continue

          const perUnit = (idx, take) => lineUnit(idx) * take * pct
          allocateUnitsForProduct(a, pairs, perUnit)
          allocateUnitsForProduct(b, pairs, perUnit)
          continue
        }

        if (rule.ruleType === 'bundle_pct') {
          if (productIds.length < 2) continue
          const ids = productIds
          const totals = ids.map((pid) => (indicesByProductId[pid] || []).reduce((s, idx) => s + lineQtyPc(items[idx]), 0))
          const bundles = Math.min(...totals)
          if (bundles <= 0) continue

          const perUnit = (idx, take) => lineUnit(idx) * take * pct
          for (const pid of ids) allocateUnitsForProduct(pid, bundles, perUnit)
          continue
        }

        if (rule.ruleType === 'bogo_pct') {
          const productId = productIds[0]
          if (!productId) continue
          const idxs = indicesByProductId[productId] || []
          const total = idxs.reduce((s, idx) => s + lineQtyPc(items[idx]), 0)
          if (total <= 0) continue

          const buyQty = Number(rule.buyQty ?? 1)
          const getQty = Number(rule.getQty ?? 1)
          const group = buyQty + getQty
          if (group <= 0) continue

          const fullGroups = Math.floor(total / group)
          const remainder = total % group
          const freeUnits = fullGroups * getQty + Math.max(0, remainder - buyQty)
          if (freeUnits <= 0) continue

          const perUnit = (idx, take) => lineUnit(idx) * take * pct
          allocateUnitsForProduct(productId, freeUnits, perUnit)
          continue
        }
      }

      // Clamp to line totals so multiple rules never exceed the item price.
      for (let i = 0; i < lineDiscounts.length; i += 1) {
        const maxDiscount = lineTotal(items[i])
        lineDiscounts[i] = Math.min(lineDiscounts[i], maxDiscount)
      }

      const promoDiscountAmount = Number(lineDiscounts.reduce((sum, v) => sum + v, 0).toFixed(2))
      return promoDiscountAmount > 0 ? { lineDiscounts, promoDiscountAmount } : null
    }

    const promoDiscount = computePromoDiscounts()
    const appliedDiscountSource =
      isPwdSenior ? discountType : promoDiscount ? 'promo' : null

    const appliedLineDiscounts = isPwdSenior ? pwdLineDiscounts : promoDiscount?.lineDiscounts || items.map(() => 0)
    const discountAmount = isPwdSenior ? pwdDiscountAmount : Number(promoDiscount?.promoDiscountAmount || 0)

    const afterDiscount = Math.max(0, Number((rawSubtotal - discountAmount).toFixed(2)))
    const vatableSales = afterDiscount
    const vatAmount = vatRate > 0 ? Number(((vatableSales * vatRate) / (1 + vatRate)).toFixed(2)) : 0

    const appliedDiscountLabel =
      appliedDiscountSource === 'promo' ? promoLabel || 'Promo' : discountType || null

    return {
      discountAmount,
      discountType: appliedDiscountLabel,
      afterDiscount,
      eligibleTotal,
      hasEligibleItems,
      lineDiscounts: appliedLineDiscounts,
      appliedDiscountSource,
      vatableSales,
      vatAmount,
      total: afterDiscount,
    }
  }, [items, rawSubtotal, discountType, vatRate, promoRules, promoLabel])

  useEffect(() => {
    if ((discountType === 'pwd' || discountType === 'senior') && !pricing.hasEligibleItems) {
      // Discount selection must clear when cart contents no longer qualify.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDiscountType('')
    }
  }, [discountType, pricing.hasEligibleItems])

  const payTotal = pricing.total
  const discountedItemBreakdown = useMemo(
    () =>
      items
        .map((item, index) => ({
          name: item.name,
          amount: Number(pricing.lineDiscounts[index] || 0),
        }))
        .filter((row) => row.amount > 0),
    [items, pricing.lineDiscounts],
  )
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
      const cartItems = items.map((item, index) => {
        const discountAmount = pricing.lineDiscounts[index] || 0
        return {
          ...item,
          // For persistence/reporting, treat any discounted line as discount-eligible for that transaction.
          discountEligible: discountAmount > 0,
          discountAmount,
          netLineTotal: Number((lineTotal(item) - discountAmount).toFixed(2)),
        }
      })
      const cash =
        paymentMethod === 'cash' ? Number(tendered) : Number(payTotal)
      const saved = await addTransaction({
        time: 'Just now',
        cashier: user?.name || 'Staff',
        total: payTotal,
        tendered: cash,
        status: 'Paid',
        items: items.length,
        itemsList: cartItems,
        date: today(dayOpenHour),
        orderType: isRestaurant ? orderType : undefined,
        ulamCombo: combo?.code || null,
        paymentMethod,
        paymentReference: paymentMethod === 'ewallet' ? String(paymentReference).trim() : null,
        vatAmount: pricing.vatAmount,
        vatableSales: pricing.vatableSales,
        discountAmount: pricing.discountAmount,
        discountType: pricing.discountType,
        discountIdNote:
          discountType === 'pwd' || discountType === 'senior' ? String(discountIdNote).trim() : null,
      })
      const change = Math.max(0, cash - payTotal)
      const orLabel = saved?.orNumber || saved?.id || 'Sale'
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
          discountIdNote:
            discountType === 'pwd' || discountType === 'senior' ? String(discountIdNote).trim() : null,
        },
        lines: cartItems.map((item) => ({
          name: item.name,
          sku: item.sku,
          pricingMode: item.pricingMode,
          quantity: item.pricingMode === 'kg' ? item.weight : item.quantity,
          unitPrice: item.price,
          lineTotal: lineTotal(item),
          discountAmount: item.discountAmount || 0,
          netLineTotal: item.netLineTotal || lineTotal(item),
          discountEligible: item.discountEligible === true,
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

  const quickCash = [
    { label: 'Exact', value: payTotal },
    { label: pesoWhole(50), value: 50 },
    { label: pesoWhole(100), value: 100 },
    { label: pesoWhole(200), value: 200 },
    { label: pesoWhole(500), value: 500 },
    { label: pesoWhole(1000), value: 1000 },
  ]

  const methodLabel =
    PAY_METHODS.find((m) => m.id === paymentMethod)?.label || 'Cash'

  const openCheckout = () => {
    if (!items.length || tillClosed) return
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

  useEffect(() => {
    if (!onOverlayChange) return
    onOverlayChange(
      checkoutOpen || paying || Boolean(paidResult) || dayEndNudge || removeIndex != null,
    )
  }, [checkoutOpen, paying, paidResult, dayEndNudge, removeIndex, onOverlayChange])

  return (
    <>
      {checkoutOpen && (
        <Modal wide onClose={() => setCheckoutOpen(false)}>
          <Eyebrow>CHECKOUT</Eyebrow>
          <h2 className="mb-1 pr-8 text-[22px] max-[700px]:text-xl">{money(payTotal)}</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            {items.length} item{items.length === 1 ? '' : 's'}
            {pricing.discountAmount > 0 ? ` · discount -${money(pricing.discountAmount)}` : ''}
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
                  else setTendered('')
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
                } ${d.id && !pricing.hasEligibleItems ? 'cursor-not-allowed opacity-45' : ''}`}
                disabled={Boolean(d.id) && !pricing.hasEligibleItems}
                onClick={() => setDiscountType(d.id)}
              >
                {d.label}
              </button>
            ))}
          </div>
          {(discountType === 'pwd' || discountType === 'senior') && !pricing.hasEligibleItems && (
            <p className="m-0 mb-3 text-[11px] text-brand-subtle">
              No discount-eligible items in this cart.
            </p>
          )}
          {(discountType === 'pwd' || discountType === 'senior') && (
            <>
              <div className="mb-3 bg-transparent px-0 py-1 text-xs">
                <div className="flex items-center justify-between text-brand-muted">
                  <span>Eligible items</span>
                  <strong className="text-brand-ink">{money(pricing.eligibleTotal)}</strong>
                </div>
                <div className="flex items-center justify-between text-brand-muted">
                  <span>Original total</span>
                  <strong className="text-brand-ink">{money(rawSubtotal)}</strong>
                </div>
                <div className="mt-1 flex items-center justify-between text-brand-muted">
                  <span>Discount ({discountType === 'pwd' ? 'PWD' : 'Senior'} 20%)</span>
                  <strong className="text-brand-danger">-{money(pricing.discountAmount)}</strong>
                </div>
                {discountedItemBreakdown.length > 0 && (
                  <div className="mt-2 px-0 py-1">
                    <div className="mb-1 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
                      Discounted items
                    </div>
                    <div className="space-y-1">
                      {discountedItemBreakdown.map((row, idx) => (
                        <div key={`${row.name}-${idx}`} className="flex items-center justify-between gap-3 text-[11px] text-brand-muted">
                          <span className="truncate">{row.name}</span>
                          <strong className="shrink-0 text-brand-danger">-{money(row.amount)}</strong>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between">
                  <span className="font-bold text-brand-ink">Amount due</span>
                  <strong className="text-base text-brand-ink">{money(payTotal)}</strong>
                </div>
              </div>
              <label className="mb-3 block text-xs text-brand-muted">
                ID note
                <input
                  className="mt-1 w-full rounded border border-brand-line bg-white p-2.5 text-brand-ink outline-none"
                  value={discountIdNote}
                  onChange={(e) => setDiscountIdNote(e.target.value)}
                  placeholder="ID number"
                />
              </label>
            </>
          )}

          {pricing.appliedDiscountSource === 'promo' && (
            <div className="mb-3 bg-transparent px-0 py-1 text-xs">
              <div className="flex items-center justify-between text-brand-muted">
                <span>Original total</span>
                <strong className="text-brand-ink">{money(rawSubtotal)}</strong>
              </div>
              <div className="mt-1 flex items-center justify-between text-brand-muted">
                <span>Discount ({pricing.discountType || 'Promo'})</span>
                <strong className="text-brand-danger">-{money(pricing.discountAmount)}</strong>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="font-bold text-brand-ink">Amount due</span>
                <strong className="text-base text-brand-ink">{money(payTotal)}</strong>
              </div>
            </div>
          )}

          {needsCash && (
            <div className="mb-3 bg-transparent p-0">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-brand-muted">Cash tendered</span>
                <strong className="font-mono text-lg tabular-nums text-brand-ink">
                  {tendered === '' ? money(0) : `${PESO}${tendered}`}
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
                  <label className="mb-2 flex items-center rounded border border-brand-line bg-white px-2.5">
                    <span className="shrink-0 font-mono text-brand-subtle">{PESO}</span>
                    <input
                      className="w-full bg-transparent py-2.5 text-right font-mono text-brand-ink outline-none"
                      value={tendered}
                      onChange={(event) =>
                        setTendered(event.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))
                      }
                      inputMode="decimal"
                      placeholder="0.00"
                    />
                  </label>
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
      <section className="flex h-full min-h-0 min-w-0 flex-col rounded-[10px] border border-brand-line bg-white text-brand-ink max-[800px]:min-h-[520px] max-[800px]:h-auto">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-brand-cart-line px-5 pt-5 pb-4 max-[700px]:px-3.5">
          <div>
            <Eyebrow className="text-[#a8aeaa]">CURRENT SALE</Eyebrow>
            <h2 className="m-0 text-lg capitalize">Receipt / cart</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <span className="text-xs text-[#797e7b]">{items.length} items</span>
          </div>
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
        {/* Barcode scanner mode:
            - Left rail: cart line list (with per-line discount eligibility display)
            - Right rail: sale summary + checkout button */}
        {barcodeMode ? (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] max-[980px]:grid-cols-1">
            {/* Cart lines slot (scrollable) */}
            <div className="min-h-0 overflow-auto px-5 py-2 max-[1050px]:min-h-[320px] max-[800px]:min-h-[340px] max-[700px]:px-3.5">
              {items.length ? (
                <div className="overflow-hidden bg-white">
                  <div className="grid grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr_auto] gap-2 bg-brand-dark px-3 py-2 text-[10px] font-bold tracking-wide text-[#c8ceca] uppercase">
                    <span>Item</span>
                    <span className="text-right">Price</span>
                    <span className="text-center">Qty</span>
                    <span className="text-right">Total</span>
                    <span className="text-right">Action</span>
                  </div>
                  {items.map((item, index) => {
                    const showTier =
                      isRestaurant && hasBudgetTier(item.menuKind) && item.budgetPrice != null
                    const qtyLabel =
                      item.pricingMode === 'kg'
                        ? qty(item.weight, 'kg')
                        : `${Number(item.quantity).toFixed(0)} ${Number(item.quantity) > 1 ? 'pcs' : 'pc'}`
                    return (
                      <div
                        className="grid grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr_auto] items-center gap-2 border-t border-[#f1f1ed] px-3 py-2.5 text-xs bg-white"
                        key={`${item.id}-${item.priceTier || 'regular'}-${index}`}
                      >
                        <div className="min-w-0">
                          <strong className="block truncate text-brand-ink">{item.name}</strong>
                          <small className="block text-[10px] text-brand-cart-muted">
                            {item.pricingMode === 'kg' ? 'Weigh-in item' : 'Piece item'}
                            {showTier && item.priceTier === 'budget' ? ' · budget' : ''}
                          </small>
                          {pricing.lineDiscounts[index] > 0 && (
                            <small className="mt-0.5 block text-[10px] font-bold text-brand-danger">
                              {pricing.appliedDiscountSource === 'promo'
                                ? 'Promo'
                                : discountType === 'pwd'
                                  ? 'PWD'
                                  : 'Senior'}{' '}
                              discount -{money(pricing.lineDiscounts[index])}
                            </small>
                          )}
                          {(discountType === 'pwd' || discountType === 'senior') && !pricing.lineDiscounts[index] && (
                            <small className="mt-0.5 block text-[10px] text-brand-subtle">Not discount eligible</small>
                          )}
                          {showTier && (
                            <div className="mt-1 flex gap-1">
                              {[
                                { id: 'regular', label: `Reg ${money(item.regularPrice ?? item.price)}` },
                                { id: 'budget', label: `Bud ${money(item.budgetPrice)}` },
                              ].map((tier) => (
                                <button
                                  key={tier.id}
                                  type="button"
                                  className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${
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
                        <span className="text-right tabular-nums text-brand-ink">{money(item.price)}</span>
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            className="grid h-7 w-7 place-items-center rounded border border-brand-cart-border text-[#aab0ac]"
                            onClick={() => bumpQty(index, -1)}
                            aria-label="Decrease quantity"
                          >
                            <FiMinus size={12} />
                          </button>
                          <span className="min-w-[3.3rem] text-center text-[11px] font-bold tabular-nums text-brand-ink">
                            {qtyLabel}
                          </span>
                          <button
                            type="button"
                            className="grid h-7 w-7 place-items-center rounded border border-brand-cart-border text-[#aab0ac]"
                            onClick={() => bumpQty(index, 1)}
                            aria-label="Increase quantity"
                          >
                            <FiPlus size={12} />
                          </button>
                        </div>
                        <b className="text-right tabular-nums text-brand-ink">{money(lineTotal(item))}</b>
                        <button
                          type="button"
                          className="justify-self-end border-0 bg-transparent p-1 text-brand-cart-muted transition-[transform,color] duration-100 hover:text-brand-ink active:scale-90 active:text-brand-ink"
                          onClick={() => requestRemove(index)}
                          title={canRemoveDirect ? 'Remove' : 'Remove (supervisor PIN)'}
                        >
                          <FiTrash2 size={16} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="mt-[140px] px-2 text-center text-sm leading-[1.8] text-[#bbc0bd]">
                  Your cart is ready.
                  <br />
                  <span className="text-xs text-[#7f8782]">Scan or search to begin.</span>
                </div>
              )}
            </div>
            {/* Sale summary rail (sticky via checkout modal) */}
            <aside className="flex flex-col gap-3 bg-[#fbfbf9] px-5 py-4 max-[700px]:px-3.5">
              <div className="bg-white px-3 py-3">
                <span className="block text-[10px] font-bold tracking-wide text-brand-subtle uppercase">Sale summary</span>
                <div className="mt-3 flex items-center justify-between text-xs text-brand-muted">
                  <span>Subtotal</span>
                  <strong className="text-brand-ink">{money(rawSubtotal)}</strong>
                </div>
                {pricing.discountAmount > 0 && (
                  <div className="mt-2 flex items-center justify-between text-xs text-brand-muted">
                    <span>Discount</span>
                    <strong className="text-brand-danger">-{money(pricing.discountAmount)}</strong>
                  </div>
                )}
                {vatRate > 0 && (
                  <div className="mt-2 flex items-center justify-between text-xs text-brand-muted">
                    <span>VAT incl.</span>
                    <strong className="text-brand-ink">{money(pricing.vatAmount)}</strong>
                  </div>
                )}
                <div className="mt-3 border-t border-[#f1f1ed] pt-3">
                  <span className="block text-[11px] text-[#8a908c]">
                    {items.length} item{items.length === 1 ? '' : 's'}
                  </span>
                  <strong className="mt-1 block text-2xl tabular-nums text-brand-ink">{money(payTotal)}</strong>
                </div>
              </div>
              <PrimaryButton
                className="w-full justify-between"
                disabled={!items.length || tillClosed || paying}
                onClick={openCheckout}
              >
                <span>Checkout</span>
                <span aria-hidden>{'\u2192'}</span>
              </PrimaryButton>
            </aside>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-auto px-5 py-2 max-[1050px]:min-h-[320px] max-[800px]:min-h-[340px] max-[700px]:px-3.5">
              {items.length ? (
                <div className="overflow-hidden bg-white">
                  <div className="grid grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr_auto] gap-2 bg-brand-dark px-3 py-2 text-[10px] font-bold tracking-wide text-[#c8ceca] uppercase">
                    <span>Item</span>
                    <span className="text-right">Price</span>
                    <span className="text-center">Qty</span>
                    <span className="text-right">Total</span>
                    <span className="text-right">Action</span>
                  </div>
                  {items.map((item, index) => {
                    const showTier =
                      isRestaurant && hasBudgetTier(item.menuKind) && item.budgetPrice != null
                    const qtyLabel =
                      item.pricingMode === 'kg'
                        ? qty(item.weight, 'kg')
                        : `${Number(item.quantity).toFixed(0)} ${Number(item.quantity) > 1 ? 'pcs' : 'pc'}`
                    return (
                      <div
                        className="grid grid-cols-[1.6fr_0.8fr_0.8fr_0.8fr_auto] items-center gap-2 border-t border-[#f1f1ed] px-3 py-2.5 text-xs bg-white"
                        key={`${item.id}-${item.priceTier || 'regular'}-${index}`}
                      >
                        <div className="min-w-0">
                          <strong className="block truncate text-brand-ink">{item.name}</strong>
                          <small className="block text-[10px] text-brand-cart-muted">
                            {item.pricingMode === 'kg' ? 'Weigh-in item' : 'Piece item'}
                            {showTier && item.priceTier === 'budget' ? ' · budget' : ''}
                          </small>
                          {pricing.lineDiscounts[index] > 0 && (
                            <small className="mt-0.5 block text-[10px] font-bold text-brand-danger">
                              {pricing.appliedDiscountSource === 'promo'
                                ? 'Promo'
                                : discountType === 'pwd'
                                  ? 'PWD'
                                  : 'Senior'}{' '}
                              discount -{money(pricing.lineDiscounts[index])}
                            </small>
                          )}
                          {(discountType === 'pwd' || discountType === 'senior') && !pricing.lineDiscounts[index] && (
                            <small className="mt-0.5 block text-[10px] text-brand-subtle">Not discount eligible</small>
                          )}
                          {showTier && (
                            <div className="mt-1 flex gap-1">
                              {[
                                { id: 'regular', label: `Reg ${money(item.regularPrice ?? item.price)}` },
                                { id: 'budget', label: `Bud ${money(item.budgetPrice)}` },
                              ].map((tier) => (
                                <button
                                  key={tier.id}
                                  type="button"
                                  className={`rounded border px-1.5 py-0.5 text-[9px] font-bold ${
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
                        <span className="text-right tabular-nums text-brand-ink">{money(item.price)}</span>
                        <div className="flex items-center justify-center gap-1">
                          <button
                            type="button"
                            className="grid h-7 w-7 place-items-center rounded border border-brand-cart-border text-[#aab0ac]"
                            onClick={() => bumpQty(index, -1)}
                            aria-label="Decrease quantity"
                          >
                            <FiMinus size={12} />
                          </button>
                          <span className="min-w-[3.3rem] text-center text-[11px] font-bold tabular-nums text-brand-ink">
                            {qtyLabel}
                          </span>
                          <button
                            type="button"
                            className="grid h-7 w-7 place-items-center rounded border border-brand-cart-border text-[#aab0ac]"
                            onClick={() => bumpQty(index, 1)}
                            aria-label="Increase quantity"
                          >
                            <FiPlus size={12} />
                          </button>
                        </div>
                        <b className="text-right tabular-nums text-brand-ink">{money(lineTotal(item))}</b>
                        <button
                          type="button"
                          className="justify-self-end border-0 bg-transparent p-1 text-brand-cart-muted transition-[transform,color] duration-100 hover:text-brand-ink active:scale-90 active:text-brand-ink"
                          onClick={() => requestRemove(index)}
                          title={canRemoveDirect ? 'Remove' : 'Remove (supervisor PIN)'}
                        >
                          <FiTrash2 size={16} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="mt-[140px] px-2 text-center text-sm leading-[1.8] text-[#bbc0bd]">
                  Your cart is ready.
                  <br />
                  <span className="text-xs text-[#7f8782]">Select a product to begin.</span>
                </div>
              )}
            </div>

            <footer className="shrink-0 border-t border-brand-cart-line bg-white px-5 py-4 max-[700px]:px-3.5">
              <div className="mb-3 flex items-end justify-between gap-3">
                <div>
                  <span className="block text-[11px] text-[#8a908c]">
                    {items.length} item{items.length === 1 ? '' : 's'}
                    {pricing.discountAmount > 0 ? ` · -${money(pricing.discountAmount)} disc.` : ''}
                  </span>
                  <strong className="mt-0.5 block text-xl tabular-nums text-brand-ink">{money(payTotal)}</strong>
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
          </>
        )}
      </section>
    </>
  )
}

export default Cart
