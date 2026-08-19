/**
 * BIR (Philippines) VAT + SC/PWD engine — single source of truth for the checkout
 * preview, the printed receipt, and the frozen figures written to the sale record.
 * Pure and side-effect free so it can be reasoned about and tested on its own.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE (RA 9994 senior citizens / RA 10754 PWD). Read before editing.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   base = MIN(regular price, active promo price)      ← VAT-INCLUSIVE shelf price
 *
 *   if the customer presents a valid SC/PWD ID and the line is eligible:
 *       vatExclusive = base / (1 + vatRate)            ← strip VAT FIRST
 *       scPwdDiscount = vatExclusive * 0.20            ← 20% of the VAT-EXCLUSIVE base
 *       net = vatExclusive - scPwdDiscount
 *       line is VAT-EXEMPT (no output VAT at all)
 *   else:
 *       net = base
 *       line is VATable
 *
 * Two mistakes this is written to prevent, both of which overcharge or
 * undercharge and are the usual findings in a BIR POS review:
 *
 *   1. STACKING. There is exactly ONE discount computation. A promo does not
 *      produce its own deduction that is then followed by a second 20% deduction
 *      off the regular price. The promo's only role is to lower the *base* that
 *      the single 20% is computed from. Never subtract promoDiscount and
 *      scPwdDiscount from the regular price independently.
 *
 *   2. FORGETTING THE VAT STRIP. The 20% is 20% of base/1.12, not 20% of base.
 *      Taking 20% off the VAT-inclusive price over-discounts by ~2.4% of base
 *      and leaves the exempt sales figure wrong on the receipt. If the store is
 *      NOT VAT-registered, pass vatRegistered:false — then there is no VAT to
 *      strip and vatExclusive === base.
 *
 * Promo discounts are NOT a BIR receipt line: a promo price *is* the selling
 * price, so it is netted into the sales figures. The SC/PWD discount IS a
 * mandated "Less:" disclosure and is surfaced separately.
 */

export const VAT_RATE_DEFAULT = 0.12
export const SC_PWD_DISCOUNT_PCT = 0.2

/**
 * @param {object}  options
 * @param {Array}   options.items  [{ regularAmount, promoDiscountAmount, vatExempt }]
 *   regularAmount        VAT-inclusive line total at the regular (undiscounted) price
 *   promoDiscountAmount  amount the active promo takes off that line (0 if none).
 *                        `regularAmount - promoDiscountAmount` is the promo price,
 *                        i.e. the MIN() base in the rule above.
 *   vatExempt            true when this line is eligible AND SC/PWD is applied to this sale
 * @param {number}  options.vatRate
 * @param {boolean} options.vatRegistered  false for a non-VAT-registered store (skips the /1.12)
 *
 * Aggregates are summed at full precision and rounded ONCE at the end. Rounding
 * per line and then summing would let vatableSales + vatAmount drift away from
 * the rounded grand total on a multi-item cart.
 */
export function computeVatBreakdown({
  items = [],
  vatRate = VAT_RATE_DEFAULT,
  vatRegistered = true,
} = {}) {
  const effectiveRate = vatRegistered ? vatRate : 0

  let vatableGrossSum = 0 // VATable lines, VAT-inclusive, at the promo (base) price
  let exemptExclusiveSum = 0 // SC/PWD lines, VAT-exclusive base, BEFORE the 20%
  let exemptVatRemovedSum = 0 // VAT not charged because of the exemption (BIR reporting)
  let promoDiscountSum = 0
  const zeroRatedSales = 0 // nothing is tagged zero-rated today; kept for receipt completeness

  const lineBreakdown = items.map((item) => {
    const regularAmount = Number(item.regularAmount || 0)
    const promoDiscountAmount = Number(item.promoDiscountAmount || 0)
    // The single base: the lower of regular and promo price. Everything below
    // derives from this one number — see "THE RULE" above.
    const baseAmount = Math.max(0, regularAmount - promoDiscountAmount)
    promoDiscountSum += promoDiscountAmount

    if (!item.vatExempt) {
      vatableGrossSum += baseAmount
      return {
        vatCategory: 'vatable',
        regularAmount: round2(regularAmount),
        promoDiscountAmount: round2(promoDiscountAmount),
        baseAmount: round2(baseAmount),
        vatExclusiveAmount: round2(effectiveRate > 0 ? baseAmount / (1 + effectiveRate) : baseAmount),
        scPwdDiscountAmount: 0,
        netAmount: round2(baseAmount),
        // Stored/displayed line discount. VATable line: the promo is the only discount.
        discountAmount: round2(promoDiscountAmount),
      }
    }

    // Exempt line: strip VAT first, then take 20% of what's left.
    const vatExclusiveAmount = effectiveRate > 0 ? baseAmount / (1 + effectiveRate) : baseAmount
    const scPwdDiscountAmount = vatExclusiveAmount * SC_PWD_DISCOUNT_PCT
    exemptExclusiveSum += vatExclusiveAmount
    exemptVatRemovedSum += baseAmount - vatExclusiveAmount

    return {
      vatCategory: 'exempt',
      regularAmount: round2(regularAmount),
      promoDiscountAmount: round2(promoDiscountAmount),
      baseAmount: round2(baseAmount),
      vatExclusiveAmount: round2(vatExclusiveAmount),
      scPwdDiscountAmount: round2(scPwdDiscountAmount),
      netAmount: round2(vatExclusiveAmount - scPwdDiscountAmount),
      // Stored/displayed line discount. Exempt line: the BIR-disclosed 20% only —
      // the VAT that came off is an exemption, reported via vatExemptedAmount, not
      // as a discount. (Adding it here would double-count against the receipt's
      // "Less: SC/PWD Discount" line.)
      discountAmount: round2(scPwdDiscountAmount),
    }
  })

  const vatableGrossRounded = round2(vatableGrossSum)
  const vatableSales =
    effectiveRate > 0 ? round2(vatableGrossSum / (1 + effectiveRate)) : vatableGrossRounded
  // Residual, not an independent rounding — guarantees vatableSales + vatAmount
  // === vatableGrossRounded exactly.
  const vatAmount = effectiveRate > 0 ? round2(vatableGrossRounded - vatableSales) : 0

  // Pre-discount, like VATable Sales is: the 20% is its own "Less:" line at the
  // bottom of the receipt, a BIR-mandated disclosure, not netted in here.
  const vatExemptSales = round2(exemptExclusiveSum)
  const scPwdDiscount = round2(exemptExclusiveSum * SC_PWD_DISCOUNT_PCT)
  const vatExemptedAmount = round2(exemptVatRemovedSum)

  const promoDiscountAmount = round2(promoDiscountSum)
  // What the customer saved in total, off the regular price. Not a receipt line —
  // the receipt shows promo via the reduced selling price and the 20% via "Less:".
  const discountAmount = round2(scPwdDiscount + promoDiscountAmount)

  const totalSales = round2(vatableSales + vatAmount + vatExemptSales + zeroRatedSales)
  const amountDue = round2(totalSales - scPwdDiscount)

  return {
    vatRate: effectiveRate,
    vatRegistered,
    vatableSales,
    vatAmount,
    vatExemptSales,
    zeroRatedSales,
    /** Output VAT not charged because of the SC/PWD exemption — BIR reporting. */
    vatExemptedAmount,
    scPwdDiscount,
    promoDiscountAmount,
    discountAmount,
    totalSales,
    amountDue,
    lineBreakdown,
  }
}

/** Change owed on a cash sale — never negative even if tendered is short. */
export function computeChange(tendered, total) {
  return Math.max(0, Number(tendered || 0) - Number(total || 0))
}

/** Whether Complete Sale can be pressed right now — till open, cart non-empty, tender/reference/ID-note requirements met per payment method and discount type. */
export function canCompleteSale({
  tillClosed,
  itemCount,
  paying,
  paymentMethod,
  tendered,
  payTotal,
  paymentReference,
  discountType,
  discountIdNote,
}) {
  const needsCash = paymentMethod === 'cash'
  return (
    !tillClosed &&
    itemCount > 0 &&
    !paying &&
    (needsCash ? Number(tendered) >= payTotal : true) &&
    (paymentMethod !== 'ewallet' || String(paymentReference).trim().length > 0) &&
    (!(discountType === 'pwd' || discountType === 'senior') || String(discountIdNote).trim().length > 0)
  )
}

function round2(value) {
  return Number((Number(value) || 0).toFixed(2))
}
