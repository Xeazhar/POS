import { useEffect, useMemo, useRef, useState } from 'react'
import { FiMinus, FiPlus, FiTrash2, FiX } from 'react-icons/fi'
import { useNavigate } from 'react-router-dom'
import { isDeviceEnabled, receiptPrinter } from '../../devices'
import { fetchBranchFiscalHeader, logApprovalEvent } from '../../lib/api'
import { useIsTouchUi } from '../../hooks/useIsTouchUi'
import { useAuthStore, useCartStore, useInventoryStore, useProductStore } from '../../stores/posStore'
import { formatSupportError } from '../../utils/errors'
import { buildReceipt } from '../../utils/receipt'
import { money, pesoWhole, PESO, qty, today, formatOpenHourLabel } from '../../utils/format'
import { buildCartDisplayGroups, computePromoDiscounts } from '../../utils/promo'
import { computeVatBreakdown, VAT_RATE_DEFAULT } from '../../utils/vat'
import { hasBudgetTier, lineTotal } from '../../utils/ulam'
import { isManagerRole, isSupervisorOrAbove } from '../../utils/roles'
import { Eyebrow, Modal, ModalActions, PrimaryButton, SecondaryButton, StatusOverlay, moneyClass } from '../ui'
import CartRemoveApprove from './CartRemoveApprove'
import NumPad from './NumPad'

const PAY_METHODS = [
  { id: 'cash', label: 'Cash' },
  { id: 'card', label: 'Card' },
  { id: 'ewallet', label: 'E-wallet' },
]

/** Joins distinct promo event names for display (e.g. transaction discount_type, header label). */
function joinPromoNames(names = []) {
  if (!names.length) return 'Promo'
  if (names.length <= 2) return names.join(' + ')
  return `${names.slice(0, 2).join(' + ')} +${names.length - 2} more`
}

/**
 * Renders the current POS cart and manages checkout, payment, discounts, and sale completion.
 * @param {Object} props - Cart configuration and callbacks.
 * @param {boolean} [props.tillClosed=false] - Whether checkout and sales are unavailable because the till is closed.
 * @param {React.ReactNode} [props.headerActions=null] - Content rendered in the cart header.
 * @param {Function} [props.onOverlayChange=null] - Called with whether a modal or overlay is currently active.
 * @param {boolean} [props.barcodeMode=false] - Whether to use the barcode-oriented cart layout.
 * @param {Array} [props.promoRules=[]] - Promotion rules used to calculate and display discounts.
 * @returns {JSX.Element} The cart interface and its checkout-related overlays.
 */
function Cart({
  tillClosed = false,
  headerActions = null,
  onOverlayChange = null,
  barcodeMode = false,
  promoRules = [],
}) {
  const {
    items,
    removeItem,
    removePromoEntries,
    adjustQuantity,
    clear,
    total,
    orderType,
    setOrderType,
    setPriceTier,
    ulamCombo,
    cartId,
    ensureCartId,
  } = useCartStore()
  const products = useProductStore((state) => state.products)
  const addTransaction = useInventoryStore((state) => state.addTransaction)
  const dayOpenHour = useInventoryStore((state) => state.dayOpenHour)
  const user = useAuthStore((state) => state.user)
  const deviceSessionId = useAuthStore((state) => state.deviceSessionId)
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
  const lastReceiptRef = useRef(null)
  const [dayEndNudge, setDayEndNudge] = useState(false)
  const [error, setError] = useState('')
  const [removeIndex, setRemoveIndex] = useState(null)
  const [removeGroup, setRemoveGroup] = useState(null)
  const touchUi = useIsTouchUi()
  const navigate = useNavigate()
  const rawSubtotal = total()
  const combo = isRestaurant ? ulamCombo() : null
  // Flat 12% nationwide (BIR) — not branch-configurable.
  const vatRate = VAT_RATE_DEFAULT

  const pricing = useMemo(() => {
    const isPwdSenior = discountType === 'pwd' || discountType === 'senior'

    // Eligibility is checked against the *current* catalog, not the flag frozen on the cart
    // line at add-time — otherwise fixing "Discountable" on a product wouldn't take effect
    // for an item already sitting in the cart until it's removed and re-added.
    const productById = new Map(products.map((p) => [p.id, p]))
    const isEligible = (item) => {
      const live = productById.get(item.id)
      return live ? live.discountEligible === true : item.discountEligible === true
    }

    const hasEligibleItems = items.some(isEligible)
    const eligibleTotal = items.reduce((sum, item) => sum + (isEligible(item) ? lineTotal(item) : 0), 0)

    // Why each line is / isn't eligible, so a "but it says Discountable!" report can be
    // answered at the counter instead of guessed at. `missing` means the product wasn't in
    // the branch catalog this tab loaded at all — that's a data/sync problem, not a flag one.
    const eligibilityDebug = items.map((item) => {
      const live = productById.get(item.id)
      if (!live) return { name: item.name, state: 'missing', eligible: item.discountEligible === true }
      return {
        name: item.name,
        state: live.discountEligible === true ? 'eligible' : 'not-flagged',
        eligible: live.discountEligible === true,
      }
    })

    // Promos are computed ALWAYS, including when SC/PWD is selected — but they are not a
    // second deduction. A promo only lowers the *base* that the single 20% is taken from:
    //   base = MIN(regular, promo price), then 20% of base/1.12 on eligible lines.
    // Never subtract promo and SC/PWD from the regular price independently (RA 9994 /
    // RA 10754 — one discount only). The arithmetic lives in utils/vat.js; read the rule
    // block at the top of that file before changing anything here.
    const promoDiscount = computePromoDiscounts(items, promoRules)
    const linePromoNames = promoDiscount?.linePromoNames || items.map(() => null)
    // Display-only — a bundle's own name (e.g. "Meryenda Bundle"), never persisted.
    // linePromoNames (the event name) is what transaction_items.promo_name gets, so promo
    // sales stats keep matching against the event, not the bundle.
    const lineBundleNames = promoDiscount?.lineBundleNames || items.map(() => null)

    const vat = computeVatBreakdown({
      vatRate,
      items: items.map((item, index) => ({
        regularAmount: lineTotal(item),
        promoDiscountAmount: promoDiscount?.lineDiscounts[index] || 0,
        vatExempt: isPwdSenior && isEligible(item),
      })),
    })
    const lineDiscounts = vat.lineBreakdown.map((row) => row.discountAmount)
    const lineVatCategories = vat.lineBreakdown.map((row) => row.vatCategory)

    // Which label heads the discount row. SC/PWD wins the headline when applied, but a
    // promo can still be feeding the base underneath it — the per-line rows show both.
    const promoLabel = promoDiscount ? joinPromoNames(promoDiscount.appliedEventNames) : null
    const appliedDiscountSource = isPwdSenior ? discountType : promoDiscount ? 'promo' : null
    const appliedDiscountLabel = isPwdSenior
      ? promoLabel
        ? `${discountType === 'pwd' ? 'PWD' : 'Senior'} + ${promoLabel}`
        : discountType
      : promoLabel

    return {
      discountAmount: vat.discountAmount,
      scPwdDiscount: vat.scPwdDiscount,
      promoDiscountAmount: vat.promoDiscountAmount,
      vatExemptedAmount: vat.vatExemptedAmount,
      discountType: appliedDiscountLabel,
      afterDiscount: vat.amountDue,
      eligibleTotal,
      hasEligibleItems,
      eligibilityDebug,
      lineBreakdown: vat.lineBreakdown,
      lineDiscounts,
      lineVatCategories,
      linePromoNames,
      lineBundleNames,
      promoLabel,
      appliedDiscountSource,
      isPwdSenior,
      vatRate,
      vatableSales: vat.vatableSales,
      vatAmount: vat.vatAmount,
      vatExemptSales: vat.vatExemptSales,
      zeroRatedSales: vat.zeroRatedSales,
      totalSales: vat.totalSales,
      total: vat.amountDue,
    }
  }, [items, discountType, vatRate, promoRules, products])

  const displayGroups = useMemo(
    () => buildCartDisplayGroups(items, promoRules),
    [items, promoRules],
  )

  const promoGroupMetaByLine = useMemo(() => {
    const map = new Map()
    for (const group of displayGroups) {
      if (group.kind !== 'promo') continue
      for (const entry of group.entries) {
        map.set(entry.lineIndex, {
          promoGroupId: group.id,
          promoGroupType: group.type,
          promoGroupName: group.name,
        })
      }
    }
    return map
  }, [displayGroups])

  const lineUnits = (item) =>
    item?.pricingMode === 'kg' ? Number(item.weight || 0) : Number(item.quantity || 0)

  const entryGross = (entry) => {
    const item = items[entry.lineIndex]
    if (!item) return 0
    const units = lineUnits(item)
    if (!(units > 0)) return 0
    return (lineTotal(item) / units) * Number(entry.units || 0)
  }

  const entryDiscount = (entry) => {
    const item = items[entry.lineIndex]
    if (!item) return 0
    const units = lineUnits(item)
    if (!(units > 0)) return 0
    return ((pricing.lineDiscounts[entry.lineIndex] || 0) / units) * Number(entry.units || 0)
  }

  const entryNet = (entry) => {
    const item = items[entry.lineIndex]
    if (!item) return 0
    const units = lineUnits(item)
    if (!(units > 0)) return 0
    const net = Number(pricing.lineBreakdown[entry.lineIndex]?.netAmount ?? lineTotal(item))
    return (net / units) * Number(entry.units || 0)
  }

  const groupGross = (group) =>
    group.entries.reduce((sum, entry) => sum + entryGross(entry), 0)

  const groupDiscount = (group) =>
    group.entries.reduce((sum, entry) => sum + entryDiscount(entry), 0)

  const groupNet = (group) =>
    group.entries.reduce((sum, entry) => sum + entryNet(entry), 0)

  useEffect(() => {
    if ((discountType === 'pwd' || discountType === 'senior') && !pricing.hasEligibleItems) {
      // Discount selection must clear when cart contents no longer qualify.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDiscountType('')
    }
  }, [discountType, pricing.hasEligibleItems])

  /**
   * Warn when a promo expires out from under a cart that was already priced with it.
   *
   * Promos are refetched live (useLiveData in POS.jsx) and auto-expire on their end date,
   * so a cart sitting open across the cutoff silently reprices upward. Without a notice the
   * cashier just sees a different total than the one they quoted the customer, mid-sale.
   *
   * Cart edits alone (remove line, drop qty below a BOGO/bundle threshold) can also strip
   * a promo name from a remaining line — that is not "promo ended". Only warn when the
   * event itself left the live `promoRules` set.
   */
  const [expiredPromoNotice, setExpiredPromoNotice] = useState(null)
  const prevPromoByLineRef = useRef(new Map())
  useEffect(() => {
    const liveEventNames = new Set(
      (promoRules || []).map((r) => r.eventName || r.event_name).filter(Boolean),
    )
    // Keyed by product id + price tier (not cart index) so a line that's still in the
    // cart but lost its promo reads as "expired", while a line the cashier just removed
    // does not — removing an item is not the same event as its promo ending.
    const currentByLine = new Map()
    items.forEach((item, i) => {
      const key = `${item.id}:${item.priceTier || 'regular'}`
      currentByLine.set(key, pricing.linePromoNames[i] || null)
    })
    const lost = []
    currentByLine.forEach((promoName, key) => {
      const prevPromoName = prevPromoByLineRef.current.get(key)
      if (
        prevPromoName &&
        promoName !== prevPromoName &&
        !liveEventNames.has(prevPromoName)
      ) {
        lost.push(prevPromoName)
      }
    })
    prevPromoByLineRef.current = currentByLine
    if (lost.length) setExpiredPromoNotice([...new Set(lost)].join(', '))
  }, [items, pricing.linePromoNames, promoRules])

  const payTotal = pricing.total
  /**
   * Full per-line audit trail for the checkout breakdown: regular price → which promo
   * (if any) set the base → VAT stripped → the single 20% → final line total. Shown so
   * the cashier can answer "why is this the price?" at the counter, and so a BIR review
   * can see the computation was done in the mandated order.
   */
  const discountedItemBreakdown = useMemo(
    () =>
      items
        .map((item, index) => {
          const line = pricing.lineBreakdown[index] || {}
          const scPwdLabel = discountType === 'pwd' ? 'PWD' : discountType === 'senior' ? 'Senior' : null
          return {
            name: item.name,
            amount: Number(pricing.lineDiscounts[index] || 0),
            regularAmount: Number(line.regularAmount || 0),
            promoDiscountAmount: Number(line.promoDiscountAmount || 0),
            baseAmount: Number(line.baseAmount || 0),
            vatExclusiveAmount: Number(line.vatExclusiveAmount || 0),
            scPwdDiscountAmount: Number(line.scPwdDiscountAmount || 0),
            netAmount: Number(line.netAmount || 0),
            isExempt: line.vatCategory === 'exempt',
            // Display only, prefers the bundle's own name — pricing.linePromoNames (the
            // event name) is the one that gets persisted, see checkout below.
            promoName: pricing.lineBundleNames[index] || pricing.linePromoNames[index] || null,
            // Headline tag for the row: what actually produced this line's discount.
            promo:
              line.vatCategory === 'exempt'
                ? scPwdLabel
                : pricing.lineBundleNames[index] || pricing.linePromoNames[index] || pricing.promoLabel,
          }
        })
        .filter((row) => row.amount > 0 || row.promoDiscountAmount > 0),
    [
      items,
      pricing.lineBreakdown,
      pricing.lineDiscounts,
      pricing.linePromoNames,
      pricing.lineBundleNames,
      pricing.promoLabel,
      discountType,
    ],
  )
  // Net line figures come straight from the VAT engine — never re-derived here as
  // "price − discount/qty", which silently breaks on exempt lines where the VAT strip
  // is part of the reduction but is not a discount.
  const lineNetTotal = (index, item) => Number(pricing.lineBreakdown[index]?.netAmount ?? lineTotal(item))
  const lineTag = (index) => {
    const row = pricing.lineBreakdown[index]
    if (!row) return null
    if (row.vatCategory === 'exempt') return discountType === 'pwd' ? 'PWD 20%' : 'Senior 20%'
    // Bundle name on screen (what a cashier recognizes), event name persisted separately
    // for promo sales stats (see pricing.linePromoNames / promoName below) — the two can
    // legitimately differ and that's fine, only the display prefers the bundle.
    return pricing.lineBundleNames[index] || pricing.linePromoNames[index] || pricing.promoLabel || 'Promo'
  }

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
        const line = pricing.lineBreakdown[index] || {}
        const discountAmount = pricing.lineDiscounts[index] || 0
        const groupMeta = promoGroupMetaByLine.get(index) || {}
        return {
          ...item,
          discountEligible: discountAmount > 0,
          discountAmount,
          vatCategory: pricing.lineVatCategories[index] || 'vatable',
          promoName: Number(line.promoDiscountAmount || 0) > 0 ? pricing.linePromoNames[index] || null : null,
          promoGroupId: item.promoGroupId || groupMeta.promoGroupId || null,
          promoGroupType: item.promoGroupType || groupMeta.promoGroupType || null,
          promoGroupName: item.promoGroupName || groupMeta.promoGroupName || null,
          netLineTotal: Number(line.netAmount ?? lineTotal(item)),
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
        vatExemptSales: pricing.vatExemptSales,
        zeroRatedSales: pricing.zeroRatedSales,
        scPwdDiscount: pricing.scPwdDiscount,
        vatRateApplied: pricing.vatRate,
        discountAmount: pricing.discountAmount,
        discountType: pricing.discountType,
        discountIdNote:
          discountType === 'pwd' || discountType === 'senior' ? String(discountIdNote).trim() : null,
      })
      const change = Math.max(0, cash - payTotal)
      const orLabel = saved?.orNumber || 'PENDING'
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

      const branchHeader =
        (await fetchBranchFiscalHeader(user?.branchId)) || {
          name: user?.branchName,
          business_name: user?.branchName,
        }

      const receipt = buildReceipt({
        branch: branchHeader,
        user,
        transaction: {
          ...saved,
          orNumber: saved?.orNumber || null,
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
          vatExemptSales: pricing.vatExemptSales,
          zeroRatedSales: pricing.zeroRatedSales,
          scPwdDiscount: pricing.scPwdDiscount,
          totalSales: pricing.totalSales,
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
          netLineTotal: item.netLineTotal ?? lineTotal(item),
          discountEligible: item.discountEligible === true,
          // Drives the per-line VAT-EXEMPT marker the BIR receipt format requires.
          vatCategory: item.vatCategory || 'vatable',
          priceTier: item.priceTier,
        })),
      })
      lastReceiptRef.current = receipt

      const tryPrint = async () => {
        try {
          await receiptPrinter.printReceipt(receipt)
        } catch (printErr) {
          console.warn('Receipt print skipped:', printErr.message)
        }
      }
      if (isDeviceEnabled(user?.deviceSettings, 'receipt_printer')) {
        void tryPrint()
      }

      if (shouldNudgeDayEnd() && !isManagerRole(user?.role)) {
        setTimeout(() => setDayEndNudge(true), 400)
      }
    } catch (err) {
      setError(formatSupportError(err, 'SALE01'))
      setPaying(false)
    }
  }

  const requestRemove = (index) => {
    ensureCartId()
    if (canRemoveDirect) {
      removeItem(index)
      return
    }
    setRemoveGroup(null)
    setRemoveIndex(index)
  }

  const requestRemoveGroup = (group) => {
    ensureCartId()
    if (canRemoveDirect) {
      removePromoEntries(group.entries)
      return
    }
    setRemoveIndex(null)
    setRemoveGroup(group)
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
    { label: 'Clear', value: null },
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
    if (item.label === 'Clear') {
      setTendered('')
      return
    }
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
      checkoutOpen || paying || Boolean(paidResult) || dayEndNudge || removeIndex != null || removeGroup != null,
    )
  }, [checkoutOpen, paying, paidResult, dayEndNudge, removeIndex, removeGroup, onOverlayChange])

  /**
   * One sale-ticket-style row per cart line — name/qty/tags on top, price right-aligned,
   * qty stepper + remove below. Shared by both barcode and normal layouts so the two
   * never drift into two different cart designs (they used to be two near-identical
   * spreadsheet-table blocks).
   */
  const renderPromoGroupRow = (group) => {
    const gross = groupGross(group)
    const discount = groupDiscount(group)
    const net = groupNet(group)
    const discounted = discount > 0.004
    return (
      <div
        key={group.id}
        className="border-t border-brand-n150 px-3 py-2.5 text-xs first:border-t-0"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-brand-ink">{group.name}</strong>
            <span className="mt-0.5 block text-[10px] leading-snug text-brand-cart-muted">{group.sublabel}</span>
            {discounted && (
              <span className="mt-0.5 block text-[10px] font-bold text-brand-danger">
                Promo −{money(discount)}
              </span>
            )}
          </div>
          <div className={`shrink-0 text-right ${moneyClass}`}>
            {discounted ? (
              <>
                <span className="block text-[10px] text-brand-subtle line-through">{money(gross)}</span>
                <span className="text-sm font-bold text-brand-danger">{money(net)}</span>
              </>
            ) : (
              <span className="text-sm font-bold text-brand-ink">{money(gross)}</span>
            )}
          </div>
        </div>
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            className="inline-flex items-center gap-1 border-0 bg-transparent p-1 text-[11px] font-bold text-brand-cart-muted transition-[transform,color] duration-100 hover:text-brand-ink active:scale-90 active:text-brand-ink"
            onClick={() => requestRemoveGroup(group)}
            title={canRemoveDirect ? 'Remove promo set' : 'Remove promo set (supervisor PIN)'}
          >
            <FiTrash2 size={14} />
            Remove set
          </button>
        </div>
      </div>
    )
  }

  const renderCartLine = (item, index, { units = null } = {}) => {
    const showTier = isRestaurant && hasBudgetTier(item.menuKind) && item.budgetPrice != null
    const qtyLabel =
      item.pricingMode === 'kg'
        ? qty(units ?? item.weight, 'kg')
        : `${Number(units ?? item.quantity).toFixed(0)} ${Number(units ?? item.quantity) > 1 ? 'pcs' : 'pc'}`
    const lineGross =
      units != null && lineUnits(item) > 0
        ? (lineTotal(item) / lineUnits(item)) * Number(units)
        : lineTotal(item)
    const lineDisc =
      units != null && lineUnits(item) > 0
        ? ((pricing.lineDiscounts[index] || 0) / lineUnits(item)) * Number(units)
        : pricing.lineDiscounts[index] || 0
    const lineNet =
      units != null && lineUnits(item) > 0
        ? ((Number(pricing.lineBreakdown[index]?.netAmount ?? lineTotal(item))) / lineUnits(item)) *
          Number(units)
        : lineNetTotal(index, item)
    const discounted = lineNet < lineGross - 0.004
    const showPromoTag = discounted && lineDisc > 0.004
    return (
      <div
        key={`${item.id}-${item.priceTier || 'regular'}-${index}`}
        className="border-t border-brand-n150 px-3 py-2.5 text-xs first:border-t-0"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <strong className="block truncate text-brand-ink">{item.name}</strong>
            <span className="text-[10px] text-brand-cart-muted">
              {qtyLabel}
              {showTier && item.priceTier === 'budget' ? ' · budget' : ''}
            </span>
            {showPromoTag && (
              <span className="mt-0.5 block text-[10px] font-bold text-brand-danger">
                {lineTag(index)} −{money(lineDisc)}
              </span>
            )}
            {pricing.lineBreakdown[index]?.vatCategory === 'exempt' && (
              <span className="mt-0.5 block text-[10px] font-bold text-brand-success-text">VAT-exempt</span>
            )}
            {(discountType === 'pwd' || discountType === 'senior') &&
              pricing.lineBreakdown[index]?.vatCategory !== 'exempt' && (
                <span className="mt-0.5 block text-[10px] text-brand-subtle">Not discount eligible</span>
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
                        : 'border-brand-cart-border text-brand-ondark-dim'
                    }`}
                    onClick={() => setPriceTier(index, tier.id)}
                  >
                    {tier.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={`shrink-0 text-right ${moneyClass}`}>
            {discounted ? (
              <>
                <span className="block text-[10px] text-brand-subtle line-through">{money(lineGross)}</span>
                <span className="text-sm font-bold text-brand-danger">{money(lineNet)}</span>
              </>
            ) : (
              <span className="text-sm font-bold text-brand-ink">{money(lineGross)}</span>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="grid h-7 w-7 place-items-center rounded border border-brand-cart-border text-brand-n500"
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
              className="grid h-7 w-7 place-items-center rounded border border-brand-cart-border text-brand-n500"
              onClick={() => bumpQty(index, 1)}
              aria-label="Increase quantity"
            >
              <FiPlus size={12} />
            </button>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 border-0 bg-transparent p-1 text-[11px] font-bold text-brand-cart-muted transition-[transform,color] duration-100 hover:text-brand-ink active:scale-90 active:text-brand-ink"
            onClick={() => requestRemove(index)}
            title={canRemoveDirect ? 'Remove' : 'Remove (supervisor PIN)'}
          >
            <FiTrash2 size={14} />
            Remove
          </button>
        </div>
      </div>
    )
  }

  const renderDisplayGroup = (group) => {
    if (group.kind === 'promo') return renderPromoGroupRow(group)
    const entry = group.entries[0]
    if (!entry) return null
    const item = items[entry.lineIndex]
    if (!item) return null
    const partial = entry.units < lineUnits(item) - 0.0001
    return renderCartLine(item, entry.lineIndex, partial ? { units: entry.units } : {})
  }

  const renderCartGroups = () => {
    const rendered = displayGroups.map((group) => renderDisplayGroup(group))
    const hasVisibleRows = rendered.some(Boolean)
    if (items.length > 0 && !hasVisibleRows) {
      return items.map((item, index) => renderCartLine(item, index))
    }
    return rendered
  }

  /**
   * Subtotal → discount → VAT → TOTAL, in that order — the same hierarchy the checkout
   * modal uses. Shared so the pre-checkout summary never disagrees with itself between
   * barcode and normal layouts.
   */
  const renderSaleSummary = () => (
    <>
      <div className="flex items-center justify-between text-xs text-brand-muted">
        <span>Subtotal</span>
        <strong className={`text-brand-ink ${moneyClass}`}>{money(rawSubtotal)}</strong>
      </div>
      {pricing.discountAmount > 0 && (
        <div className="mt-2 flex items-center justify-between text-xs text-brand-muted">
          <span>
            Discount
            {pricing.discountType ? ` (${pricing.discountType})` : ''}
          </span>
          <strong className={`text-brand-danger ${moneyClass}`}>−{money(pricing.discountAmount)}</strong>
        </div>
      )}
      {pricing.appliedDiscountSource === 'promo' && discountedItemBreakdown.length > 0 && (
        <div className="mt-2 space-y-1 border-t border-brand-n150 pt-2">
          {discountedItemBreakdown.map((row, idx) => (
            <div
              key={`${row.name}-${idx}`}
              className="flex items-center justify-between gap-2 text-[10px] text-brand-muted"
            >
              <span className="min-w-0 truncate">
                {row.name}
                {row.promo ? (
                  <span className="mt-0.5 block truncate font-bold text-brand-danger">{row.promo}</span>
                ) : null}
              </span>
              <strong className={`shrink-0 text-brand-danger ${moneyClass}`}>−{money(row.amount)}</strong>
            </div>
          ))}
        </div>
      )}
      {vatRate > 0 && (
        <div className="mt-2 flex items-center justify-between text-xs text-brand-muted">
          <span>VAT incl.</span>
          <strong className="text-brand-ink">{money(pricing.vatAmount)}</strong>
        </div>
      )}
      <div className="mt-3 border-t border-brand-n150 pt-3">
        <span className="block text-[11px] text-brand-ondark-dim">
          {items.length} item{items.length === 1 ? '' : 's'}
        </span>
        <strong className={`mt-1 block text-2xl text-brand-ink ${moneyClass}`}>{money(payTotal)}</strong>
      </div>
    </>
  )

  return (
    <>
      {checkoutOpen && (
        <Modal xl onClose={() => setCheckoutOpen(false)}>
          <Eyebrow>CHECKOUT</Eyebrow>
          <h2 className={`mb-1 pr-8 text-[22px] max-[700px]:text-xl ${moneyClass}`}>{money(payTotal)}</h2>
          <p className="m-0 mb-3 text-xs text-brand-muted">
            {items.length} item{items.length === 1 ? '' : 's'}
            {pricing.discountAmount > 0 ? ` · discount −${money(pricing.discountAmount)}` : ''}
          </p>

          {/* Two columns: everything the cashier READS (what's being bought, why the price
              is what it is) on the left; everything they ACT ON (payment, discount, cash)
              on the right. Single-column meant a long breakdown pushed the tender input
              off-screen and scrolled under the sticky action bar. */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
            <div className="min-w-0">
              <p className="mb-1.5 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
                Items ({items.length})
              </p>
              <div className="mb-3 max-h-[280px] overflow-auto rounded border border-brand-softline">
                {items.map((item, index) => {
                  const line = pricing.lineBreakdown[index] || {}
                  const discounted = lineNetTotal(index, item) < lineTotal(item)
                  return (
                    <div
                      key={`${item.id}-${item.priceTier || 'regular'}-${index}`}
                      className="flex items-start justify-between gap-3 border-b border-brand-n150 px-2.5 py-2 text-xs last:border-b-0"
                    >
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-brand-ink">{item.name}</strong>
                        <span className="text-[10px] text-brand-subtle">
                          {item.pricingMode === 'kg'
                            ? qty(item.weight, 'kg')
                            : `${Number(item.quantity).toFixed(0)} × ${money(item.price)}`}
                        </span>
                        {line.vatCategory === 'exempt' && (
                          <span className="ml-1 text-[10px] font-bold text-brand-success-text">VAT-exempt</span>
                        )}
                      </span>
                      <span className={`shrink-0 text-right tabular-nums ${moneyClass}`}>
                        {discounted ? (
                          <>
                            <span className="block text-[10px] text-brand-subtle line-through">
                              {money(lineTotal(item))}
                            </span>
                            <span className="font-bold text-brand-danger">
                              {money(lineNetTotal(index, item))}
                            </span>
                          </>
                        ) : (
                          money(lineTotal(item))
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>

          {/* One breakdown panel for every discount case — SC/PWD, promo, or both feeding
              one base. Per line it walks the mandated order: regular → promo base → VAT
              stripped → single 20% → net, so the cashier can explain any price on the spot. */}
          {discountedItemBreakdown.length > 0 && (
            <div className="mb-3 bg-transparent px-0 py-1 text-xs">
              <div className="flex items-center justify-between text-brand-muted">
                <span>Original total</span>
                <strong className={`text-brand-ink ${moneyClass}`}>{money(rawSubtotal)}</strong>
              </div>
              {pricing.isPwdSenior && (
                <div className="flex items-center justify-between text-brand-muted">
                  <span>Eligible items</span>
                  <strong className={`text-brand-ink ${moneyClass}`}>{money(pricing.eligibleTotal)}</strong>
                </div>
              )}
              <div className="mt-1 flex items-center justify-between text-brand-muted">
                <span>Total discount{pricing.discountType ? ` (${pricing.discountType})` : ''}</span>
                <strong className={`text-brand-danger ${moneyClass}`}>−{money(pricing.discountAmount)}</strong>
              </div>

              <div className="mt-2 space-y-2 border-t border-brand-n150 pt-2">
                <div className="text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
                  Per item
                </div>
                {discountedItemBreakdown.map((row, idx) => (
                  <div key={`${row.name}-${idx}`} className="rounded border border-brand-n150 px-2 py-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate font-bold text-brand-ink">{row.name}</span>
                      {row.isExempt && (
                        <span className="shrink-0 rounded bg-brand-success-bg px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-brand-success-text uppercase">
                          VAT-exempt
                        </span>
                      )}
                    </div>
                    <div className="mt-1 space-y-0.5 text-[10px] text-brand-muted">
                      <div className="flex justify-between gap-2">
                        <span>Regular price</span>
                        <span className={row.promoDiscountAmount > 0 ? 'text-brand-subtle line-through' : ''}>
                          {money(row.regularAmount)}
                        </span>
                      </div>
                      {row.promoDiscountAmount > 0 && (
                        <div className="flex justify-between gap-2">
                          <span className="min-w-0 truncate">
                            Promo price{row.promoName ? ` · ${row.promoName}` : ''}
                            <span className="text-brand-subtle"> (base used)</span>
                          </span>
                          <span className="shrink-0 font-bold text-brand-ink">{money(row.baseAmount)}</span>
                        </div>
                      )}
                      {row.isExempt && (
                        <>
                          <div className="flex justify-between gap-2">
                            <span>VAT-exclusive ({(pricing.vatRate * 100).toFixed(0)}% removed)</span>
                            <span>{money(row.vatExclusiveAmount)}</span>
                          </div>
                          <div className="flex justify-between gap-2">
                            <span>{discountType === 'pwd' ? 'PWD' : 'Senior'} discount 20%</span>
                            <span className="text-brand-danger">−{money(row.scPwdDiscountAmount)}</span>
                          </div>
                        </>
                      )}
                      <div className="flex justify-between gap-2 border-t border-brand-n150 pt-0.5 font-bold text-brand-ink">
                        <span>Line total</span>
                        <span>{money(row.netAmount)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Transaction-level totals — BIR reporting, not just customer display. */}
              <div className="mt-2 space-y-0.5 border-t border-brand-n150 pt-2 text-[11px]">
                {pricing.promoDiscountAmount > 0 && (
                  <div className="flex justify-between gap-2 text-brand-muted">
                    <span>Promo discount given</span>
                    <span className="text-brand-danger">−{money(pricing.promoDiscountAmount)}</span>
                  </div>
                )}
                {pricing.scPwdDiscount > 0 && (
                  <div className="flex justify-between gap-2 text-brand-muted">
                    <span>Total SC/PWD discount</span>
                    <span className="text-brand-danger">−{money(pricing.scPwdDiscount)}</span>
                  </div>
                )}
                {pricing.vatExemptedAmount > 0 && (
                  <div className="flex justify-between gap-2 text-brand-muted">
                    <span>Total VAT exempted</span>
                    <span>{money(pricing.vatExemptedAmount)}</span>
                  </div>
                )}
                <div className="mt-1 flex items-center justify-between">
                  <span className="font-bold text-brand-ink">Net total</span>
                  <strong className={`text-base text-brand-ink ${moneyClass}`}>{money(payTotal)}</strong>
                </div>
              </div>
            </div>
          )}
            </div>

            <div className="min-w-0">
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
          {/* When PWD/Senior can't be applied, say WHY per item. "Not in this branch's
              catalog" vs "not flagged discountable" are completely different problems and
              guessing between them has cost real time at the counter. */}
          {!pricing.hasEligibleItems && items.length > 0 && (
            <div className="mb-3 rounded border border-brand-softline bg-brand-n50 px-2.5 py-2">
              <p className="m-0 mb-1 text-[11px] font-bold text-brand-ink">
                No discount-eligible items in this cart.
              </p>
              <div className="space-y-0.5">
                {pricing.eligibilityDebug.map((row, idx) => (
                  <div key={`${row.name}-${idx}`} className="flex justify-between gap-2 text-[10px]">
                    <span className="min-w-0 truncate text-brand-muted">{row.name}</span>
                    <span className="shrink-0 text-brand-subtle">
                      {row.state === 'missing'
                        ? 'not in this branch’s catalog — re-sync'
                        : 'not marked discountable'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

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
              <div className="mt-2 flex justify-between text-2xl text-brand-ink">
                <span>Change</span>
                <strong className="text-brand-success">
                  {money(Math.max(0, Number(tendered || 0) - payTotal))}
                </strong>
              </div>
            </div>
          )}

          {vatRate > 0 && pricing.vatableSales > 0 && (
            <p className="m-0 mb-1 text-[11px] text-brand-subtle">
              VAT ({(vatRate * 100).toFixed(0)}% incl.) {money(pricing.vatAmount)}
            </p>
          )}
          {pricing.vatExemptSales > 0 && (
            <p className="m-0 mb-3 text-[11px] text-brand-subtle">VAT-exempt (SC/PWD) {money(pricing.vatExemptSales)}</p>
          )}
            </div>
          </div>

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
          actions={
            <SecondaryButton
              compact
              type="button"
              onClick={() => {
                const receipt = lastReceiptRef.current
                if (receipt) void receiptPrinter.printReceipt(receipt).catch(() => {})
              }}
            >
              Print receipt
            </SecondaryButton>
          }
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
      {removeGroup != null && (
        <CartRemoveApprove
          item={{ name: removeGroup.name }}
          cartId={cartId}
          onCancel={() => setRemoveGroup(null)}
          onAllowed={async ({ staffId, name, role, via, requestId }) => {
            void logApprovalEvent({
              branchId: user?.branchId,
              requestedBy: user?.id,
              approvedBy: staffId,
              approverName: name,
              approverRole: role,
              deviceId: deviceSessionId || null,
              action: via === 'self_allowed' ? 'cart_line_remove_self' : 'cart_line_remove',
              detail: `Removed promo set "${removeGroup.name}" from cart`,
              meta: {
                action: 'REMOVE_CART_ITEM',
                cart_id: cartId || null,
                till_action_id: requestId || null,
                promo_group: removeGroup.id,
                promo_name: removeGroup.name,
                line_count: removeGroup.entries?.length ?? null,
                line_total: Number(
                  (removeGroup.entries || []).reduce((sum, entry) => sum + lineTotal(entry), 0).toFixed(2),
                ),
                via: via || 'pin',
                offline: via === 'pin_offline',
              },
            })
            removePromoEntries(removeGroup.entries)
            setRemoveGroup(null)
          }}
        />
      )}
      {removeIndex != null && (
        <CartRemoveApprove
          item={items[removeIndex]}
          cartId={cartId}
          onCancel={() => setRemoveIndex(null)}
          onAllowed={async ({ staffId, name, role, via, requestId }) => {
            const removed = items[removeIndex]
            void logApprovalEvent({
              branchId: user?.branchId,
              requestedBy: user?.id,
              approvedBy: staffId,
              approverName: name,
              approverRole: role,
              deviceId: deviceSessionId || null,
              action: via === 'self_allowed' ? 'cart_line_remove_self' : 'cart_line_remove',
              detail: `Removed ${removed?.name || 'item'} from cart`,
              meta: {
                action: 'REMOVE_CART_ITEM',
                cart_id: cartId || null,
                till_action_id: requestId || null,
                product_id: removed?.id || null,
                product_name: removed?.name || null,
                quantity_removed: removed?.quantity ?? removed?.weight ?? null,
                unit_price: removed?.unitPrice ?? removed?.price ?? null,
                line_total: Number(lineTotal(removed).toFixed(2)),
                via: via || 'pin',
                offline: via === 'pin_offline',
              },
            })
            removeItem(removeIndex)
            setRemoveIndex(null)
          }}
        />
      )}
      <section className="flex h-full min-h-0 min-w-0 flex-col rounded-[10px] border border-brand-line bg-white text-brand-ink max-[800px]:min-h-[520px] max-[800px]:h-auto">
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-brand-cart-line px-5 pt-5 pb-4 max-[700px]:px-3.5">
          <div>
            <Eyebrow className="text-brand-n500">CURRENT SALE</Eyebrow>
            <h2 className="m-0 text-lg">Current transaction</h2>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <span className="text-xs text-brand-n600">{items.length} items</span>
          </div>
        </div>
        {error && <p className="px-5 pt-2 text-xs text-brand-danger-ondark max-[700px]:px-3.5">{error}</p>}
        {expiredPromoNotice && (
          <div
            role="alert"
            className="mx-5 mt-2 flex items-start justify-between gap-2 rounded-[6px] border border-brand-warn/40 bg-brand-gold/10 px-2.5 py-2 max-[700px]:mx-3.5"
          >
            <p className="m-0 text-[11px] leading-snug text-brand-ink">
              <strong>Promo ended — {expiredPromoNotice}.</strong>{' '}
              <span className="text-brand-muted">
                Items in this cart are back to regular price. Re-quote the total before taking payment.
              </span>
            </p>
            <button
              type="button"
              className="shrink-0 border-0 bg-transparent p-0.5 text-sm leading-none text-brand-muted"
              aria-label="Dismiss promo notice"
              onClick={() => setExpiredPromoNotice(null)}
            >
              <FiX />
            </button>
          </div>
        )}
        {tillClosed && (
          <p className="px-5 pt-2 text-xs text-brand-danger-ondark max-[700px]:px-3.5">
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
                disabled={tillClosed}
                className={`flex-1 rounded-[5px] border px-2 py-2 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  orderType === opt.id
                    ? 'border-brand-gold bg-brand-gold/20 text-brand-gold'
                    : 'border-brand-cart-border bg-transparent text-brand-n500'
                }`}
                onClick={() => {
                  if (tillClosed) return
                  setOrderType(opt.id)
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
        {combo && (
          <p className="mx-5 mt-2 rounded-[5px] border border-brand-gold/40 bg-brand-gold/10 px-2.5 py-1.5 text-[11px] font-bold text-brand-gold max-[700px]:mx-3.5">
            Combo: {combo.label}
            <span className="ml-1 font-normal text-brand-n500">(info only — priced per item)</span>
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
                <div className="overflow-hidden rounded-[6px] border border-brand-n150 bg-white">
                  <div className="border-b border-brand-n150 bg-brand-n50 px-3 py-1.5 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
                    Items ({items.length})
                  </div>
                  {renderCartGroups()}
                </div>
              ) : (
                <div className="mt-[140px] px-2 text-center text-sm leading-[1.8] text-brand-n500">
                  Your cart is ready.
                  <br />
                  <span className="text-xs text-brand-n600">Scan or search to begin.</span>
                </div>
              )}
            </div>
            {/* Sale summary rail (sticky via checkout modal) */}
            <aside className="flex flex-col gap-3 bg-brand-n50 px-5 py-4 max-[700px]:px-3.5">
              <div className="bg-white px-3 py-3">
                <span className="block text-[10px] font-bold tracking-wide text-brand-subtle uppercase">Sale summary</span>
                <div className="mt-3">{renderSaleSummary()}</div>
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
                <div className="overflow-hidden rounded-[6px] border border-brand-n150 bg-white">
                  <div className="border-b border-brand-n150 bg-brand-n50 px-3 py-1.5 text-[10px] font-bold tracking-wide text-brand-subtle uppercase">
                    Items ({items.length})
                  </div>
                  {renderCartGroups()}
                </div>
              ) : (
                <div className="mt-[140px] px-2 text-center text-sm leading-[1.8] text-brand-n500">
                  Your cart is ready.
                  <br />
                  <span className="text-xs text-brand-n600">Select a product to begin.</span>
                </div>
              )}
            </div>

            <footer className="shrink-0 border-t border-brand-cart-line bg-white px-5 py-4 max-[700px]:px-3.5">
              {renderSaleSummary()}
              <PrimaryButton
                className="mt-3 w-full justify-between"
                disabled={!items.length || tillClosed || paying}
                onClick={openCheckout}
              >
                <span>Checkout</span>
                <span aria-hidden>{'→'}</span>
              </PrimaryButton>
            </footer>
          </>
        )}
      </section>
    </>
  )
}

export default Cart
