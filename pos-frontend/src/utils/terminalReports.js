/**
 * Terminal / Cashier / Department / PLU report data + plain thermal & print-PDF.
 * One data object per report; both outputs consume the same object.
 */

const W = 39

export function moneyR(n) {
  const v = Number(n || 0)
  if (!Number.isFinite(v) || Math.abs(v) < 0.0005) return '.00'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function qtyR(n) {
  const v = Number(n || 0)
  if (!Number.isFinite(v) || Math.abs(v) < 0.0005) return '.00'
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function padLabel(label, width = 17) {
  return String(label).padEnd(width, ' ')
}

function row(label, value) {
  return `${padLabel(label)}: ${value}`
}

function dash(ch = '-', n = W) {
  return ch.repeat(n)
}

function spaceTitle(text) {
  return text.split('').join(' ')
}

function trunc(s, n) {
  const t = String(s || '')
  return t.length <= n ? t.padEnd(n, ' ') : t.slice(0, n)
}

function fmtPrintDt(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const yy = String(d.getFullYear()).slice(-2)
  let h = d.getHours()
  const min = String(d.getMinutes()).padStart(2, '0')
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${mm}/${dd}/${yy}/${String(h).padStart(2, '0')}:${min}${ap}`
}

function fmtDateSlash(isoDate) {
  if (!isoDate) return ''
  const [y, m, d] = String(isoDate).slice(0, 10).split('-')
  return `${m}/${d}/${y}`
}

function fmtLongDate(isoDate) {
  if (!isoDate) return ''
  const dt = new Date(`${isoDate}T12:00:00`)
  return dt.toLocaleDateString('en-US', { month: 'long', day: '2-digit', year: 'numeric' })
}

function entryKind(rowOrReason) {
  if (rowOrReason && typeof rowOrReason === 'object') {
    if (rowOrReason.kind === 'change_fund') return 'float'
    if (rowOrReason.kind === 'pickup') return 'pickup'
    if (rowOrReason.kind === 'paid_out') return 'paid_out'
    return entryKind(rowOrReason.reason)
  }
  const r = String(rowOrReason || '')
  if (r.startsWith('[CHANGE FUND]')) return 'float'
  if (r.startsWith('[PICKUP]')) return 'pickup'
  return 'paid_out'
}

/** localStorage counters for X/Z reading numbers */
export function reportCounters(branchId) {
  const key = `cale-report-counters:${branchId || 'all'}`
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}')
    } catch {
      return {}
    }
  }
  const write = (data) => localStorage.setItem(key, JSON.stringify(data))
  return {
    peekX(date) {
      const data = read()
      return Number(data.xByDate?.[date] || 0)
    },
    bumpX(date) {
      const data = read()
      data.xByDate = data.xByDate || {}
      data.xByDate[date] = Number(data.xByDate[date] || 0) + 1
      data.zCount = Number(data.zCount || 0)
      write(data)
      return { z: data.zCount || 1, x: data.xByDate[date] }
    },
    bumpZ() {
      const data = read()
      data.zCount = Number(data.zCount || 0) + 1
      write(data)
      return data.zCount
    },
    zCount() {
      return Number(read().zCount || 0)
    },
  }
}

/**
 * Build one terminal/cashier report data object from fetched source rows.
 */
export function buildTerminalReportData({
  mode = 'x', // x | z | cashier
  branch = {},
  operatorName = '',
  date,
  printedAt = new Date(),
  transactions = [],
  lineItems = [],
  pettyCash = [],
  dayEnd = null,
  oldGrandTotal = 0,
  readingMeta = {},
  staffId = null,
  staffName = '',
  staffCode = '',
  shiftNo = 1,
  cashCount = null,
}) {
  const txns = (transactions || []).filter((t) => {
    if (staffId && t.staff_id !== staffId && t.staffId !== staffId) return false
    return true
  })

  const completed = txns.filter((t) => t.status === 'completed' || t.status === 'Paid')
  const voided = txns.filter((t) => t.status === 'voided' || t.status === 'Voided')

  const grossSales = completed.reduce((s, t) => {
    const net = Number(t.total_amount ?? t.total ?? 0)
    const disc = Number(t.discount_amount ?? t.discountAmount ?? 0)
    return s + net + disc
  }, 0)
  const totalDisc = completed.reduce(
    (s, t) => s + Number(t.discount_amount ?? t.discountAmount ?? 0),
    0,
  )
  const dailySales = completed.reduce(
    (s, t) => s + Number(t.total_amount ?? t.total ?? 0) - Number(t.refunded_amount ?? t.refundedAmount ?? 0),
    0,
  )
  const refund = completed.reduce(
    (s, t) => s + Number(t.refunded_amount ?? t.refundedAmount ?? 0),
    0,
  )
  const voidAmt = voided.reduce((s, t) => s + Number(t.total_amount ?? t.total ?? 0), 0)

  const vat = completed.reduce((s, t) => s + Number(t.vat_amount ?? t.vatAmount ?? 0), 0)
  const taxable = completed.reduce((s, t) => {
    const v = Number(t.vatable_sales ?? t.vatableSales ?? 0)
    if (v) return s + v
    const vatRow = Number(t.vat_amount ?? t.vatAmount ?? 0)
    return s + (vatRow ? Number((vatRow / 0.12).toFixed(2)) : 0)
  }, 0)
  // VAT-Exempt + Zero-Rated Sales, tracked directly (migrate_vat_breakdown.sql) rather than
  // guessed as a residual. Rows from before that migration default these to 0 — their exempt
  // portion (if any) was, under the pre-fix formula, already folded into taxable/vat instead;
  // this only affects historical report accuracy for date ranges spanning the migration.
  const exemptSales = completed.reduce((s, t) => s + Number(t.vat_exempt_sales ?? t.vatExemptSales ?? 0), 0)
  const zeroRatedSales = completed.reduce((s, t) => s + Number(t.zero_rated_sales ?? t.zeroRatedSales ?? 0), 0)
  const nonTaxable = Number((exemptSales + zeroRatedSales).toFixed(2))

  const seniorDisc = completed.reduce((s, t) => {
    // sc_pwd_discount is the correctly-computed figure (20% of the VAT-exclusive base);
    // fall back to the old discount_type match for rows from before that column existed.
    const scPwd = Number(t.sc_pwd_discount ?? t.scPwdDiscount ?? 0)
    if (scPwd > 0) return s + scPwd
    const typ = t.discount_type || t.discountType
    if (typ === 'senior' || typ === 'pwd') return s + Number(t.discount_amount ?? t.discountAmount ?? 0)
    return s
  }, 0)
  const otherDisc = Math.max(0, Number((totalDisc - seniorDisc).toFixed(2)))

  let qtySold = 0
  const byDept = new Map()
  const byPlu = new Map()

  const txnIds = new Set(completed.map((t) => t.id))
  ;(lineItems || []).forEach((line) => {
    const tid = line.transaction_id || line.transactions?.id
    if (tid && !txnIds.has(tid)) return
    if (staffId) {
      const sid = line.transactions?.staff_id
      if (sid && sid !== staffId) return
    }
    const status = line.transactions?.status
    if (status && status !== 'completed' && status !== 'Paid') return

    const qty = Number(line.quantity || 0)
    const amt = Number(line.line_total ?? line.lineTotal ?? 0)
    qtySold += qty

    const dept = line.products?.categories?.name || line.category || 'UNASSIGNED'
    const prevD = byDept.get(dept) || { name: dept, qty: 0, amount: 0 }
    prevD.qty += qty
    prevD.amount += amt
    byDept.set(dept, prevD)

    const pname = line.products?.name || line.name || 'ITEM'
    const prevP = byPlu.get(pname) || { name: pname, qty: 0, amount: 0 }
    prevP.qty += qty
    prevP.amount += amt
    byPlu.set(pname, prevP)
  })

  // Fallback qty/amount from txn totals when no lines
  if (!lineItems?.length && completed.length) {
    qtySold = completed.length
  }

  const pay = { cash: 0, card: 0, charge: 0, ewallet: 0, other: 0 }
  const payCount = { cash: 0, card: 0, charge: 0, ewallet: 0, other: 0 }
  completed.forEach((t) => {
    const m = String(t.payment_method || t.paymentMethod || 'cash').toLowerCase()
    const amt = Number(t.total_amount ?? t.total ?? 0) - Number(t.refunded_amount ?? t.refundedAmount ?? 0)
    if (m === 'card') {
      pay.card += amt
      payCount.card += 1
    } else if (m === 'ewallet') {
      pay.ewallet += amt
      payCount.ewallet += 1
    } else if (m === 'charge') {
      pay.charge += amt
      payCount.charge += 1
    } else {
      pay.cash += amt
      payCount.cash += 1
    }
  })

  let floatAmt = 0
  let pickupCash = 0
  let paidOut = 0
  ;(pettyCash || []).forEach((row) => {
    const kind = entryKind(row)
    // 'fulfilled' is the disbursement, not 'approved' — an approved request is money still
    // sitting in the till. Counting 'approved' here made every X/Z reading deduct cash that
    // had not been handed over, and (after the three-state split) miss the cash that had.
    const status = row.status || (kind === 'paid_out' ? 'fulfilled' : 'recorded')
    if (kind === 'paid_out' && status !== 'fulfilled') return
    const amt = Number(row.amount || 0)
    if (kind === 'float') floatAmt += amt
    else if (kind === 'pickup') pickupCash += amt
    else paidOut += amt
  })

  const cashInDrawer = Number((pay.cash + floatAmt - paidOut - pickupCash).toFixed(2))
  const declared =
    cashCount != null
      ? Number(cashCount)
      : dayEnd?.declared_cash != null
        ? Number(dayEnd.declared_cash)
        : dayEnd?.cash_count != null
          ? Number(dayEnd.cash_count)
          : null
  const short =
    declared != null ? Number((cashInDrawer - declared).toFixed(2)) : null

  const walkIn = completed.filter((t) => {
    const o = String(t.order_type || t.orderType || 'walk-in').toLowerCase()
    return !o.includes('deliver')
  })
  const delivery = completed.filter((t) => {
    const o = String(t.order_type || t.orderType || '').toLowerCase()
    return o.includes('deliver')
  })

  const newGrand = Number((Number(oldGrandTotal || 0) + dailySales).toFixed(2))
  const deptRows = [...byDept.values()].sort((a, b) => b.amount - a.amount)
  const pluRows = [...byPlu.values()].sort((a, b) => b.amount - a.amount)
  const deptGross = deptRows.reduce((s, r) => s + r.amount, 0) || grossSales

  return {
    mode,
    branch: {
      name: branch.business_name || branch.name || 'CalePOS',
      tradeName: branch.name || '',
      address: branch.address || '',
      tin: branch.full_tin || branch.tin || '',
      serial: branch.serial_number || branch.serialNumber || '',
      terminal: branch.or_prefix || branch.terminal_id || '00001',
      footerOfficial: branch.receipt_footer_official || 'THIS IS YOUR OFFICIAL RECEIPT',
      footerThanks: branch.receipt_footer_thanks || 'THANK YOU, COME AGAIN',
      footerContact: branch.receipt_footer_contact || branch.contact_phone || '',
      footerTagline: branch.receipt_footer_tagline || '',
    },
    operatorName: operatorName || '',
    date,
    printedAt,
    printedLabel: fmtPrintDt(printedAt),
    dateSlash: fmtDateSlash(date),
    dateLong: fmtLongDate(date),
    readingMeta,
    staffName,
    staffCode: staffCode || readingMeta.staffCode || '',
    shiftNo,
    grossSales: Number(grossSales.toFixed(2)),
    totalDisc: Number(totalDisc.toFixed(2)),
    dailySales: Number(dailySales.toFixed(2)),
    quantitySold: Number(qtySold.toFixed(2)),
    totalAmount: Number(dailySales.toFixed(2)),
    oldGrandTotal: Number(Number(oldGrandTotal || 0).toFixed(2)),
    newGrandTotal: newGrand,
    taxable: Number(taxable.toFixed(2)),
    nonTaxable: Number(nonTaxable.toFixed(2)),
    vat: Number(vat.toFixed(2)),
    localTax: 0,
    cashSales: Number(pay.cash.toFixed(2)),
    nonCash: {
      card: Number(pay.card.toFixed(2)),
      charge: Number(pay.charge.toFixed(2)),
      cheques: 0,
      gc: Number(pay.ewallet.toFixed(2)),
      creditMemo: 0,
      redemptions: 0,
      sweep: 0,
    },
    cashInDrawer,
    pickup: { cash: Number(pickupCash.toFixed(2)), card: 0, cheque: 0, total: Number(pickupCash.toFixed(2)) },
    roa: { cash: 0, card: 0, cheque: 0, total: 0 },
    paidOut: Number(paidOut.toFixed(2)),
    float: Number(floatAmt.toFixed(2)),
    voidAmt: Number(voidAmt.toFixed(2)),
    refund: Number(refund.toFixed(2)),
    charges: 0,
    seniorDisc: Number(seniorDisc.toFixed(2)),
    itemDisc: 0,
    subtlDisc: Number(totalDisc.toFixed(2)),
    tranCounts: {
      cash: payCount.cash || '',
      card: payCount.card || '',
      charge: payCount.charge || '',
      cheque: '',
      gc: payCount.ewallet || '',
      redemptions: '',
      sweep: '',
      crMemo: '',
      refund: refund > 0 ? completed.filter((t) => Number(t.refunded_amount || t.refundedAmount || 0) > 0).length : '',
      void: voided.length || '',
      total: completed.length || '',
      guest: completed.length || '',
    },
    customerLevels: [
      {
        label: 'WALK-IN',
        trans: walkIn.length,
        amount: walkIn.reduce((s, t) => s + Number(t.total_amount ?? t.total ?? 0), 0),
      },
      {
        label: 'DELIVERY',
        trans: delivery.length,
        amount: delivery.reduce((s, t) => s + Number(t.total_amount ?? t.total ?? 0), 0),
      },
    ],
    discountsSummary: {
      senior: Number(seniorDisc.toFixed(2)),
      other: Number(otherDisc.toFixed(2)),
    },
    cashCount: declared,
    short,
    departments: deptRows.map((r) => ({
      ...r,
      pct: deptGross ? Math.round((r.amount / deptGross) * 100) : 0,
    })),
    deptTotals: {
      qty: Number(qtySold.toFixed(2)),
      amount: Number((deptGross || grossSales).toFixed(2)),
    },
    plu: pluRows,
    pluTotals: {
      qty: Number(qtySold.toFixed(2)),
      amount: Number((deptGross || grossSales).toFixed(2)),
    },
  }
}

function center(text, width = W) {
  const t = String(text || '')
  if (t.length >= width) return t.slice(0, width)
  const pad = width - t.length
  const left = Math.floor(pad / 2)
  return `${' '.repeat(left)}${t}${' '.repeat(pad - left)}`
}

function headerBlock(data, { centered = false, width = W } = {}) {
  const b = data.branch
  const raw = []
  raw.push(String(b.name || '').toUpperCase())
  if (data.operatorName) raw.push(`OPTD BY:${String(data.operatorName).toUpperCase()}`)
  if (b.address) raw.push(String(b.address).toUpperCase())
  if (b.tin) raw.push(`TIN NO.${b.tin}`)
  if (b.serial) raw.push(`SN# ${b.serial}`)
  if (!centered) return raw
  return raw.map((line) => center(line, width))
}

function footerBlock(data) {
  const b = data.branch
  const lines = ['', `     ${b.footerOfficial}`, `        ${b.footerThanks}`]
  if (b.footerContact) lines.push(b.footerContact.startsWith('CP') ? b.footerContact : `CP ${b.footerContact}`)
  if (b.footerTagline) lines.push(b.footerTagline)
  return lines
}

function moneyBlockCommon(data, { includeGrand = true, cashierExtras = false } = {}) {
  const lines = []
  lines.push(row('Gross Sales', moneyR(data.grossSales)))
  lines.push(row('Total Disc', moneyR(data.totalDisc)))
  lines.push(row('Daily Sales', moneyR(data.dailySales)))
  lines.push(row('Quantity Sold', qtyR(data.quantitySold)))
  lines.push(row('Total Amount', moneyR(data.totalAmount)))
  if (includeGrand) {
    lines.push(row('OLD GRAND TOTAL', moneyR(data.oldGrandTotal)))
    lines.push(row('NEW GRAND TOTAL', moneyR(data.newGrandTotal)))
  }
  lines.push('')
  lines.push(row('Taxable', moneyR(data.taxable)))
  lines.push(row('Non Taxable', moneyR(data.nonTaxable)))
  lines.push(row('VAT', moneyR(data.vat)))
  lines.push('')
  lines.push(row('Local Tax', moneyR(data.localTax)))
  lines.push(row('Cash Sales', moneyR(data.cashSales)))
  lines.push('Non-Cash Sales')
  lines.push(`  ${padLabel('Card', 15)}: ${moneyR(data.nonCash.card)}`)
  lines.push(`  ${padLabel('Charge', 15)}: ${moneyR(data.nonCash.charge)}`)
  lines.push(`  ${padLabel('Cheques', 15)}: ${moneyR(data.nonCash.cheques)}`)
  if (cashierExtras) {
    lines.push(`  ${padLabel('Credit Memo', 15)}: ${moneyR(data.nonCash.creditMemo)}`)
  }
  lines.push(`  ${padLabel(cashierExtras ? 'Gc' : 'GC', 15)}: ${moneyR(data.nonCash.gc)}`)
  lines.push(`  ${padLabel('Redemptions', 15)}: ${moneyR(data.nonCash.redemptions)}`)
  if (!cashierExtras) {
    lines.push(`  ${padLabel('Sweep', 15)}: ${moneyR(data.nonCash.sweep)}`)
  }
  lines.push(row('Cash-in-Drawer', moneyR(data.cashInDrawer)))
  lines.push('')
  if (cashierExtras) {
    lines.push(row('Pick-up', moneyR(data.pickup.total)))
  } else {
    lines.push('Pick-up')
  }
  lines.push(`  ${padLabel('Cash', 15)}: ${moneyR(data.pickup.cash)}`)
  lines.push(`  ${padLabel('Card', 15)}: ${moneyR(data.pickup.card)}`)
  lines.push(`  ${padLabel('Cheque', 15)}: ${moneyR(data.pickup.cheque)}`)
  if (cashierExtras) {
    lines.push(row('Recv-on-Acct', moneyR(data.roa.total)))
  } else {
    lines.push('Recv-on-Acct')
  }
  lines.push(`  ${padLabel('Cash', 15)}: ${moneyR(data.roa.cash)}`)
  lines.push(`  ${padLabel('Card', 15)}: ${moneyR(data.roa.card)}`)
  lines.push(`  ${padLabel('Cheque', 15)}: ${moneyR(data.roa.cheque)}`)
  lines.push(row('Paid-Out', moneyR(data.paidOut)))
  lines.push(row('Float', moneyR(data.float)))
  lines.push(row('Void', moneyR(data.voidAmt)))
  lines.push(row('Refund', moneyR(data.refund)))
  lines.push(row('Charges', moneyR(data.charges)))
  lines.push(row('Senior Disc.', moneyR(data.seniorDisc)))
  lines.push(row('Item Disc.', moneyR(data.itemDisc)))
  lines.push(row('Subtl Disc.', moneyR(data.subtlDisc)))
  lines.push(`Cash   Tran      : ${data.tranCounts.cash}`)
  lines.push(`Card   Tran      : ${data.tranCounts.card}`)
  lines.push(`Charge Tran      : ${data.tranCounts.charge}`)
  lines.push(`Cheque Tran      : ${data.tranCounts.cheque}`)
  if (cashierExtras) {
    lines.push(`Redemptions      : ${data.tranCounts.redemptions}`)
    lines.push(`Gc Tran          : ${data.tranCounts.gc}`)
    lines.push(`Cr Memo Tran     : ${data.tranCounts.crMemo}`)
  } else {
    lines.push(`Gc               : ${data.tranCounts.gc}`)
    lines.push(`Redemptions      : ${data.tranCounts.redemptions}`)
    lines.push(`Sweep Trans      : ${data.tranCounts.sweep}`)
    lines.push(`CR Memo Tran     : ${data.tranCounts.crMemo}`)
  }
  lines.push(`Refund Tran      : ${data.tranCounts.refund}`)
  lines.push(`Void Tran        : ${data.tranCounts.void}`)
  lines.push(`Total Trans      : ${data.tranCounts.total}`)
  if (cashierExtras) {
    lines.push(row('Cash Count', data.cashCount != null ? moneyR(data.cashCount) : ''))
    lines.push(`Guest Count      : ${data.tranCounts.guest}`)
    lines.push(row('Short', data.short != null ? moneyR(data.short) : ''))
  } else {
    lines.push(`Guest Count      : ${data.tranCounts.guest}`)
  }
  return lines
}

/** Thermal text — Terminal X/Z */
export function formatTerminalThermal(data) {
  const lines = []
  headerBlock(data).forEach((l) => lines.push(l))
  lines.push(dash())
  lines.push('')
  lines.push(`    ${spaceTitle('TERMINAL REPORT')}`)
  lines.push('')
  lines.push(dash())
  lines.push('')
  lines.push(`DATE/TIME PRINTED : ${data.printedLabel}`)
  lines.push('')
  lines.push(`DATE      : ${data.dateSlash}`)
  lines.push(`TERMINAL  :  ${String(data.branch.terminal || '00001').padStart(5, '0')}`)
  if (data.mode === 'z') {
    lines.push(`Z READ    :  ${data.readingMeta.label || data.readingMeta.z || ''}`)
  } else {
    const t = data.printedAt instanceof Date ? data.printedAt : new Date(data.printedAt)
    let h = t.getHours()
    const min = String(t.getMinutes()).padStart(2, '0')
    const ap = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    lines.push(
      `X READ    :  ${data.readingMeta.label || ''}    ${h}:${min} ${ap}`.trimEnd(),
    )
  }
  lines.push('')
  lines.push(...moneyBlockCommon(data, { includeGrand: true, cashierExtras: false }))
  lines.push('')
  lines.push('')
  lines.push('CUSTOMER LEVEL SUMMARY')
  lines.push(dash())
  data.customerLevels.forEach((c) => {
    const left = `${c.label.padEnd(14)}:`
    const mid = String(c.trans).padStart(4)
    lines.push(`${left}  ${mid} Trans /  ${moneyR(c.amount)}`)
  })
  lines.push('')
  lines.push('DISCOUNTS')
  lines.push(dash())
  lines.push(`SENIOR DISCOUNT  : ${moneyR(data.discountsSummary.senior)}`)
  lines.push(`OTHER DISCOUNT   : ${moneyR(data.discountsSummary.other)}`)
  lines.push(...footerBlock(data))
  return lines.join('\n')
}

/** Thermal text — Cashier */
export function formatCashierThermal(data) {
  const lines = []
  headerBlock(data).forEach((l) => lines.push(l))
  lines.push(dash())
  lines.push('')
  lines.push(`     ${spaceTitle('CASHIER REPORT')} `)
  lines.push('')
  lines.push(dash())
  lines.push('')
  lines.push(`DATE/TIME PRINTED : ${data.printedLabel}`)
  lines.push('')
  lines.push(`DATE      : ${data.dateSlash}`)
  lines.push(`TERMINAL  : ${String(data.branch.terminal || '001')}`)
  lines.push(`CASHIER   : ${data.staffCode || ''}`)
  if (data.staffName) lines.push(`            ${String(data.staffName).toUpperCase()}`)
  lines.push(`SHIFT     : ${data.shiftNo}`)
  lines.push('')
  lines.push(...moneyBlockCommon(data, { includeGrand: false, cashierExtras: true }))
  lines.push(...footerBlock(data))
  return lines.join('\n')
}

/** Thermal — Department */
export function formatDepartmentThermal(data) {
  const lines = []
  headerBlock(data).forEach((l) => lines.push(l))
  lines.push(dash())
  lines.push('')
  lines.push(`   ${spaceTitle('DEPARTMENT REPORT')}`)
  lines.push('')
  lines.push(dash())
  lines.push('')
  lines.push(`DATE/TIME PRINTED : ${data.printedLabel}`)
  lines.push('')
  lines.push(`DATE      : ${data.dateSlash}`)
  lines.push(`TERMINAL  :  ${String(data.branch.terminal || '00001').padStart(5, '0')}`)
  lines.push('')
  lines.push('')
  data.departments.forEach((d) => {
    lines.push(String(d.name).toUpperCase())
    const q = qtyR(d.qty).padStart(10)
    const a = moneyR(d.amount).padStart(12)
    const p = `${d.pct}%`.padStart(6)
    lines.push(`       ${q}  ${a}  ${p}`)
  })
  lines.push('')
  lines.push(' --------------  -------------    ----')
  const tq = qtyR(data.deptTotals.qty).padStart(10)
  const ta = moneyR(data.deptTotals.amount).padStart(12)
  lines.push(`       ${tq}  ${ta}    100%`)
  lines.push(' ==============  =============    ====')
  lines.push(...footerBlock(data))
  return lines.join('\n')
}

/** Thermal — PLU (40-col fixed spacing, matches reference printout) */
export function formatPluThermal(data, { start, end } = {}) {
  const TW = 40
  const NAME_W = 22
  const QTY_W = 8
  const AMT_W = 10
  const lines = []
  headerBlock(data, { centered: true, width: TW }).forEach((l) => lines.push(l))
  lines.push(dash('-', TW))
  lines.push(center('P L U   R E P O R T', TW))
  lines.push(dash('-', TW))
  lines.push('')
  lines.push(`START DATE : ${fmtDateSlash(start || data.date)}`)
  lines.push(`END DATE   : ${fmtDateSlash(end || data.date)}`)
  lines.push('')
  lines.push('Filter : Sales')
  lines.push('')
  lines.push(dash('-', TW))
  lines.push(`${'Item'.padEnd(NAME_W)}${'Qty'.padStart(QTY_W)}${'Amount'.padStart(AMT_W)}`)
  lines.push(dash('-', TW))
  const items = data.plu?.length ? data.plu : []
  if (!items.length) {
    lines.push(`${'(no sales)'.padEnd(NAME_W)}${qtyR(0).padStart(QTY_W)}${moneyR(0).padStart(AMT_W)}`)
  } else {
    items.forEach((p) => {
      const name = trunc(String(p.name || '').toUpperCase(), NAME_W)
      lines.push(`${name}${qtyR(p.qty).padStart(QTY_W)}${moneyR(p.amount).padStart(AMT_W)}`)
    })
  }
  lines.push(`${' '.repeat(21)}${'-'.repeat(8)} ${'-'.repeat(10)}`)
  lines.push(
    `${' '.repeat(21)}${qtyR(data.pluTotals.qty).padStart(8)} ${moneyR(data.pluTotals.amount).padStart(10)}`,
  )
  lines.push(`${' '.repeat(21)}${'='.repeat(8)} ${'='.repeat(10)}`)
  return lines.join('\n')
}

/** Simple printable HTML (browser Save as PDF) — same fields, plain letterhead layout */
export function formatReportPdfHtml(kind, data, opts = {}) {
  const title =
    kind === 'cashier'
      ? 'Cashier Report'
      : kind === 'department'
        ? 'Department Report'
        : kind === 'plu'
          ? 'PLU Report'
          : kind === 'z'
            ? 'Z-Read / Terminal Report'
            : 'X-Read / Terminal Report'

  const b = data.branch || {}
  const range =
    opts.start && opts.end && opts.start !== opts.end
      ? `${opts.start} → ${opts.end}`
      : data.dateSlash || opts.start || ''

  const moneyRow = (label, val) =>
    `<tr><td>${esc(label)}</td><td align="right">${esc(moneyR(val))}</td></tr>`

  let body = ''
  if (kind === 'department') {
    body = `<table>
      <thead><tr><th align="left">Department</th><th align="right">Qty</th><th align="right">Amount</th><th align="right">%</th></tr></thead>
      <tbody>
      ${data.departments
        .map(
          (d) =>
            `<tr><td>${esc(d.name)}</td><td align="right">${qtyR(d.qty)}</td><td align="right">${moneyR(d.amount)}</td><td align="right">${d.pct}%</td></tr>`,
        )
        .join('')}
      <tr class="total"><td>Total</td><td align="right">${qtyR(data.deptTotals.qty)}</td><td align="right">${moneyR(data.deptTotals.amount)}</td><td align="right">100%</td></tr>
      </tbody></table>`
  } else if (kind === 'plu') {
    body = `<table>
      <thead><tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Amount</th></tr></thead>
      <tbody>
      ${data.plu
        .map(
          (p) =>
            `<tr><td>${esc(p.name)}</td><td align="right">${qtyR(p.qty)}</td><td align="right">${moneyR(p.amount)}</td></tr>`,
        )
        .join('')}
      <tr class="total"><td>Total</td><td align="right">${qtyR(data.pluTotals.qty)}</td><td align="right">${moneyR(data.pluTotals.amount)}</td></tr>
      </tbody></table>`
  } else {
    body = `<table class="kv">
      <tbody>
      ${moneyRow('Gross Sales', data.grossSales)}
      ${moneyRow('Total Disc', data.totalDisc)}
      ${moneyRow('Daily Sales', data.dailySales)}
      ${moneyRow('Quantity Sold', data.quantitySold)}
      ${moneyRow('Total Amount', data.totalAmount)}
      ${kind !== 'cashier' ? moneyRow('Old Grand Total', data.oldGrandTotal) : ''}
      ${kind !== 'cashier' ? moneyRow('New Grand Total', data.newGrandTotal) : ''}
      ${moneyRow('Taxable', data.taxable)}
      ${moneyRow('Non Taxable', data.nonTaxable)}
      ${moneyRow('VAT', data.vat)}
      ${moneyRow('Cash Sales', data.cashSales)}
      ${moneyRow('Card', data.nonCash?.card)}
      ${moneyRow('E-wallet / GC', data.nonCash?.gc)}
      ${moneyRow('Cash-in-Drawer', data.cashInDrawer)}
      ${moneyRow('Pick-up', data.pickup?.total ?? data.pickup?.cash)}
      ${moneyRow('Paid-Out', data.paidOut)}
      ${moneyRow('Float', data.float)}
      ${moneyRow('Void', data.voidAmt)}
      ${moneyRow('Refund', data.refund)}
      ${moneyRow('Senior Disc.', data.seniorDisc)}
      ${moneyRow('Subtl Disc.', data.subtlDisc)}
      <tr><td>Cash Tran</td><td align="right">${esc(data.tranCounts?.cash)}</td></tr>
      <tr><td>Void Tran</td><td align="right">${esc(data.tranCounts?.void)}</td></tr>
      <tr><td>Total Trans</td><td align="right">${esc(data.tranCounts?.total)}</td></tr>
      ${
        kind === 'cashier'
          ? `${moneyRow('Cash Count', data.cashCount)}
             ${moneyRow('Short', data.short)}`
          : ''
      }
      </tbody></table>`
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:0;padding:20px;max-width:720px}
  .head{border-bottom:2px solid #222;padding-bottom:10px;margin-bottom:14px}
  .head h1{margin:0;font-size:18px}
  .head p{margin:2px 0;color:#333}
  h2{font-size:14px;margin:0 0 10px;border-bottom:1px solid #999;padding-bottom:4px}
  table{width:100%;border-collapse:collapse;margin:8px 0 16px}
  th,td{padding:5px 6px;border-bottom:1px solid #ddd;vertical-align:top}
  th{background:#f0f0f0;text-align:left}
  tr.total td{font-weight:bold;border-top:2px solid #222;border-bottom:2px solid #222}
  .kv td:first-child{width:55%}
  .actions{margin-bottom:12px}
  .actions button{margin-right:8px;padding:6px 12px;font-size:12px;cursor:pointer}
  .foot{margin-top:20px;font-size:11px;color:#444;border-top:1px solid #ccc;padding-top:8px}
  @media print{.actions{display:none} body{padding:8px}}
</style></head><body>
<div class="actions">
  <button type="button" onclick="window.print()">Print / Save as PDF</button>
</div>
<div class="head">
  <h1>${esc(b.name || 'CalePOS')}</h1>
  <p>${esc(b.address || '')}</p>
  <p>${b.tin ? `TIN: ${esc(b.tin)}` : ''}${b.serial ? ` · SN: ${esc(b.serial)}` : ''}</p>
  <p>Operator: ${esc(data.operatorName || '')}${data.staffName ? ` · Cashier: ${esc(data.staffName)}` : ''}</p>
  <p><b>${esc(title)}</b> · ${esc(range)} · Printed ${esc(data.printedLabel || '')}</p>
</div>
<h2>Summary</h2>
${body || '<p>No rows.</p>'}
<div class="foot">
  <div>${esc(b.footerOfficial || 'THIS IS YOUR OFFICIAL RECEIPT')}</div>
  <div>${esc(b.footerThanks || 'THANK YOU, COME AGAIN')}</div>
  ${b.footerContact ? `<div>${esc(b.footerContact)}</div>` : ''}
  ${b.footerTagline ? `<div>${esc(b.footerTagline)}</div>` : ''}
</div>
</body></html>`
}

/** PDF HTML for flat table reports (inventory, audit, etc.) */
export function formatTablePdfHtml({ title, branchName, start, end, rows }) {
  const keys = rows?.length ? Object.keys(rows[0]) : []
  const head = keys.map((k) => `<th>${esc(k)}</th>`).join('')
  const body = (rows || [])
    .map(
      (row) =>
        `<tr>${keys.map((k) => `<td>${esc(row[k])}</td>`).join('')}</tr>`,
    )
    .join('')
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;font-size:11px;margin:16px;color:#111}
  h1{font-size:16px;margin:0 0 4px}
  .meta{color:#444;margin-bottom:12px}
  table{width:100%;border-collapse:collapse}
  th,td{border:1px solid #ccc;padding:4px 6px;text-align:left}
  th{background:#eee}
  .actions{margin-bottom:10px}
  @media print{.actions{display:none}}
</style></head><body>
<div class="actions"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
<h1>${esc(title)}</h1>
<div class="meta">${esc(branchName || 'All branches')} · ${esc(start)} → ${esc(end)}</div>
${
  keys.length
    ? `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : '<p>No records for this range.</p>'
}
</body></html>`
}

/**
 * Escapes HTML-sensitive characters in a value.
 * @param {*} s - The value to escape.
 * @return {string} The HTML-escaped string, or an empty string for nullish values.
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Open HTML via blob URL (document.write + noopener leaves a blank tab). */
export function openPrintWindow(html) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const w = window.open(url, '_blank')
  if (!w) {
    const a = document.createElement('a')
    a.href = url
    a.download = 'calepos-report.html'
    a.click()
    throw new Error('Popup blocked — downloaded report.html instead. Open it and print to PDF.')
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000)
}

export function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function printThermalText(text) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Receipt</title>
<style>
  @page { margin: 3mm; size: 80mm auto; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 4px;
    background: #fff;
    color: #000;
  }
  .actions { margin: 0 0 10px; }
  .actions button { padding: 6px 12px; font: 12px Arial, sans-serif; cursor: pointer; }
  pre.receipt {
    margin: 0;
    padding: 0;
    font-family: "Courier New", Courier, monospace;
    font-size: 11px;
    line-height: 1.2;
    letter-spacing: 0;
    white-space: pre;
    tab-size: 1;
    overflow-x: auto;
  }
  @media print {
    .actions { display: none !important; }
    body { padding: 0; }
    pre.receipt { overflow: visible; }
  }
</style></head><body>
<div class="actions"><button type="button" onclick="window.print()">Print receipt</button></div>
<pre class="receipt">${esc(text)}</pre>
</body></html>`
  openPrintWindow(html)
}

/**
 * Receipt-width text for table reports (spaced columns, no pipes).
 */
export function formatTableThermal({
  title,
  branchName,
  start,
  end,
  rows,
  width = 40,
}) {
  const list = rows?.length ? rows : [{ result: 'No records.' }]
  const keys = Object.keys(list[0])
  const lines = []
  lines.push(center(String(branchName || 'CalePOS').toUpperCase(), width))
  lines.push(center(String(title || 'REPORT').toUpperCase(), width))
  lines.push(dash('-', width))
  lines.push(`FROM : ${fmtDateSlash(start)}`)
  lines.push(`TO   : ${fmtDateSlash(end)}`)
  lines.push(dash('-', width))

  // Prefer compact key:value blocks for wide tables; 2-col when few keys
  if (keys.length <= 3) {
    const widths = keys.map((k, i) => {
      if (i === 0) return Math.floor(width * 0.45)
      return Math.floor((width - Math.floor(width * 0.45)) / Math.max(1, keys.length - 1))
    })
    // fix sum to width
    let sum = widths.reduce((a, b) => a + b, 0)
    widths[widths.length - 1] += width - sum
    lines.push(
      keys
        .map((k, i) => trunc(String(k), widths[i]))
        .join(''),
    )
    lines.push(dash('-', width))
    list.forEach((row) => {
      lines.push(
        keys
          .map((k, i) => {
            const val = String(row[k] ?? '')
            return i === 0 ? trunc(val, widths[i]) : val.slice(0, widths[i]).padStart(widths[i], ' ')
          })
          .join(''),
      )
    })
  } else {
    list.forEach((row, idx) => {
      if (idx > 0) lines.push(dash('-', width))
      keys.forEach((k) => {
        const label = trunc(`${k}`, 14)
        const val = String(row[k] ?? '')
        const rest = width - 14
        if (val.length <= rest) {
          lines.push(`${label}${val.padStart(rest, ' ')}`)
        } else {
          lines.push(`${label}${val.slice(0, rest)}`)
          let offset = rest
          while (offset < val.length) {
            lines.push(`${''.padEnd(14)}${val.slice(offset, offset + rest)}`)
            offset += rest
          }
        }
      })
    })
  }

  lines.push(dash('=', width))
  lines.push(center(`${list.length} row(s)`, width))
  return lines.join('\n')
}
