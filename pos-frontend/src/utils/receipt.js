import { money, qty } from './format'

/**
 * Build a BIR-oriented receipt payload from branch + transaction detail.
 * Hardware printers can consume this object; browser print uses HTML.
 *
 * Invoice number: never generated on-device — a client-computed number is only
 * atomic within one browser's IndexedDB, not across every till selling at the branch, so
 * it can't be trusted as the official sequential number. The server assigns the real invoice
 * number (`allocate_invoice_number`, row-locked per branch) once this sale's queued write reaches it.
 * Until then the receipt prints PENDING with the sale's local reference (`transaction.id`,
 * same short id shown elsewhere in the app for an unsynced row) so this slip can be
 * matched to the synced sale later and reprinted with its real invoice number (Transactions → Reprint).
 */
export function buildReceipt({ branch = {}, transaction = {}, lines = [], user = {} }) {
  const businessName = branch.business_name || branch.name || 'CalePOS Store'
  const rawInvoiceNumber = transaction.invoiceNumber || transaction.invoice_number || null
  const isPendingInvoice = !rawInvoiceNumber
  const localRef = transaction.id ? String(transaction.id).slice(0, 8) : null
  const invoiceNumber = rawInvoiceNumber || (localRef ? `PENDING-${localRef}` : 'PENDING')
  return {
    header: {
      businessName,
      branchName: branch.name || '',
      address: branch.address || '',
      // Composed company TIN + BIR branch code (see api.composeTin / migrate_company_tin.sql).
      // `full_tin` is what fetchBranches attaches; `tin` is the pre-migration fallback.
      tin: branch.full_tin || branch.tin || '',
      branchTinCode: branch.branch_tin_code || branch.branchTinCode || '',
      birPermitNo: branch.bir_permit_no || branch.birPermitNo || '',
      machineId: branch.machine_identification_no || branch.machineId || '',
      serialNumber: branch.serial_number || branch.serialNumber || '',
    },
    document: {
      // EOPT Act (RA 11976) + RR 7-2024: the primary sales document is now an INVOICE, not an
      // "Official Receipt" — an OR is only a supplementary payment acknowledgment and is no
      // longer valid proof of sale. Printing "Official Receipt" as the primary document is one
      // of the most common post-EOPT compliance mistakes.
      title: 'SALES INVOICE',
      invoiceNumber,
      isPendingInvoice,
      dateTime: transaction.createdAt || transaction.time || new Date().toISOString(),
      cashier: transaction.cashier || user.name || 'Staff',
      status: transaction.status || 'Paid',
      voidReason: transaction.voidReason || null,
    },
    lines: (lines.length ? lines : transaction.lines || transaction.itemsList || []).map((line) => {
      const amount = line.quantity ?? (line.pricingMode === 'kg' ? line.weight : line.quantity)
      const unitPrice = line.unitPrice ?? line.price
      const lineTotal = line.lineTotal ?? unitPrice * amount
      const netLineTotal = Number(line.netLineTotal ?? lineTotal)
      return {
        name: line.name,
        sku: line.sku || '',
        qty: amount,
        unit: line.pricingMode === 'kg' || line.pricingMode === 'per_kg' ? 'kg' : 'pc',
        unitPrice,
        lineTotal,
        discountAmount: Number(line.discountAmount ?? 0),
        netLineTotal,
        // Derived from the net line, not unitPrice − discount/qty: on a VAT-exempt
        // SC/PWD line the VAT strip is part of the reduction but is not a discount,
        // so the subtraction form prints a unit price that doesn't match the amount.
        netUnitPrice: Number((netLineTotal / Math.max(1, Number(amount) || 1)).toFixed(2)),
        vatCategory: line.vatCategory || null,
      }
    }),
    totals: {
      total: Number(transaction.total ?? 0),
      tendered: transaction.tendered != null ? Number(transaction.tendered) : null,
      change: transaction.change != null ? Number(transaction.change) : null,
      payment: (() => {
        const m = transaction.paymentMethod || transaction.payment_method || 'cash'
        if (m === 'card') return 'Card'
        if (m === 'ewallet') {
          const ref = transaction.paymentReference || transaction.payment_reference
          return ref ? `E-wallet (${ref})` : 'E-wallet'
        }
        return 'Cash'
      })(),
      vatAmount: Number(transaction.vatAmount ?? transaction.vat_amount ?? 0),
      vatableSales: Number(transaction.vatableSales ?? transaction.vatable_sales ?? 0),
      vatExemptSales: Number(transaction.vatExemptSales ?? transaction.vat_exempt_sales ?? 0),
      zeroRatedSales: Number(transaction.zeroRatedSales ?? transaction.zero_rated_sales ?? 0),
      scPwdDiscount: Number(transaction.scPwdDiscount ?? transaction.sc_pwd_discount ?? 0),
      totalSales: Number(
        transaction.totalSales ??
          Number(transaction.vatableSales ?? transaction.vatable_sales ?? 0) +
            Number(transaction.vatAmount ?? transaction.vat_amount ?? 0) +
            Number(transaction.vatExemptSales ?? transaction.vat_exempt_sales ?? 0) +
            Number(transaction.zeroRatedSales ?? transaction.zero_rated_sales ?? 0),
      ),
      discountAmount: Number(transaction.discountAmount ?? transaction.discount_amount ?? 0),
      discountType: transaction.discountType || transaction.discount_type || null,
      discountIdNote: transaction.discountIdNote || transaction.discount_id_note || null,
    },
    footer: {
      note: 'This document is system-generated. Keep for your records. POS Software: CalePOS.',
      thankYou: 'Thank you for your purchase.',
    },
  }
}

export function receiptToHtml(receipt) {
  const h = receipt.header
  const d = receipt.document
  const t = receipt.totals

  const priceCell = (regular, net, { showRegular = true } = {}) => {
    const hasDiscount = net < regular - 0.004
    if (!hasDiscount) return money(regular)
    if (!showRegular) return money(net)
    return `<span class="price-stack"><span class="muted strike">${money(regular)}</span><span>${money(net)}</span></span>`
  }

  const lineRows = receipt.lines
    .map((line) => {
      const hasLineDiscount = line.discountAmount > 0
      const priceCol = priceCell(line.unitPrice, line.netUnitPrice)
      const amtCol = priceCell(line.lineTotal, line.netLineTotal)
      return `
      <tr>
        <td class="item">
          ${escapeHtml(line.name)}
          ${
            hasLineDiscount
              ? `<div class="line-note">Discount${t.discountType ? ` (${escapeHtml(t.discountType)})` : ''} −${money(line.discountAmount)}</div>`
              : ''
          }
          ${line.vatCategory === 'exempt' ? '<div class="line-note">VAT-EXEMPT</div>' : ''}
        </td>
        <td class="num">${priceCol}</td>
        <td class="num qty">${qty(line.qty, line.unit)}</td>
        <td class="num">${amtCol}</td>
      </tr>`
    })
    .join('')

  const scPwdDiscount = Number(t.scPwdDiscount || 0)
  const promoDiscount = Math.max(0, Number(t.discountAmount || 0) - scPwdDiscount)
  const hasScPwdDiscount = scPwdDiscount > 0.004
  const hasPromoDiscount = promoDiscount > 0.004
  // Amount the SC/PWD 20% is computed from — the VAT-exclusive base of exempt lines.
  const discountableAmount = Number(t.vatExemptSales || 0)

  const discountRows = [
    hasScPwdDiscount
      ? `<tr><td>Discountable</td><td class="num">${money(discountableAmount)}</td></tr>`
      : '',
    hasScPwdDiscount
      ? `<tr><td>Senior Citizen 20% / PWD</td><td class="num">-${money(scPwdDiscount)}</td></tr>`
      : '',
    hasPromoDiscount
      ? `<tr><td>Less: Discount${t.discountType ? ` (${escapeHtml(t.discountType)})` : ''}</td><td class="num">-${money(promoDiscount)}</td></tr>`
      : '',
  ]
    .filter(Boolean)
    .join('')

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(d.title)} ${escapeHtml(String(d.invoiceNumber))}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #111; margin: 0; padding: 16px; }
    .ticket { width: 300px; margin: 0 auto; }
    h1 { font-size: 14px; margin: 0 0 4px; text-align: center; }
    .center { text-align: center; }
    .muted { color: #555; }
    .strike { text-decoration: line-through; }
    .line-note { margin-top: 3px; font-size: 10px; line-height: 1.35; color: #555; }
    .price-stack { display: block; text-align: right; line-height: 1.35; }
    .price-stack .strike { display: block; margin-bottom: 1px; }
    .price-stack > span:last-child { display: block; }
    .rule { border-top: 1px dashed #999; margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    table.items col.col-item { width: 44%; }
    table.items col.col-qty { width: 20%; }
    table.items col.col-price { width: 18%; }
    table.items col.col-amt { width: 18%; }
    table.items td { padding: 4px 0; vertical-align: top; }
    table.items td.item { padding-right: 6px; word-break: break-word; }
    table.items td.qty { padding-right: 4px; }
    table.items thead td { padding-bottom: 6px; font-weight: bold; border-bottom: 1px dashed #ccc; }
    td.num { text-align: right; white-space: nowrap; padding-left: 4px; font-variant-numeric: tabular-nums; }
    .totals td { padding-top: 4px; vertical-align: top; }
    .totals td.num { padding-left: 8px; }
    @media print {
      body { padding: 0; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="ticket">
    <h1>${escapeHtml(h.businessName)}</h1>
    <div class="center muted">${escapeHtml(h.branchName)}</div>
    <div class="center muted">${escapeHtml(h.address)}</div>
    <div class="center muted">TIN: ${escapeHtml(h.tin || '—')}</div>
    <div class="center muted" style="font-weight:bold;">VAT REG TIN</div>
    <div class="center muted">Permit: ${escapeHtml(h.birPermitNo || '—')}</div>
    <div class="center muted">MIN: ${escapeHtml(h.machineId || '—')} · SN: ${escapeHtml(h.serialNumber || '—')}</div>
    <div class="rule"></div>
    <div class="center"><strong>${escapeHtml(d.title)}</strong></div>
    <div>Sales Invoice No: <strong>${escapeHtml(String(d.invoiceNumber))}</strong>${d.isPendingInvoice ? ' <span class="muted">(assigns on sync)</span>' : ''}</div>
    <div>Date: ${escapeHtml(formatReceiptDate(d.dateTime))}</div>
    <div>Cashier: ${escapeHtml(d.cashier)}</div>
    <div>Status: ${escapeHtml(d.status)}${d.voidReason ? ` (${escapeHtml(d.voidReason)})` : ''}</div>
    <div class="rule"></div>
    <table class="items">
      <colgroup>
        <col class="col-item" />
        <col class="col-price" />
        <col class="col-qty" />
        <col class="col-amt" />
      </colgroup>
      <thead>
        <tr><td>Item</td><td class="num">Price</td><td class="num">Qty</td><td class="num">Amt</td></tr>
      </thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div class="rule"></div>
    <table class="totals">
      <tr><td>Subtotal</td><td class="num">${money(t.totalSales)}</td></tr>
      <tr><td>Less 12% Vat</td><td class="num">-${money(t.vatAmount)}</td></tr>
      <tr><td>12% Vat</td><td class="num">${money(t.vatAmount)}</td></tr>
      ${discountRows}
      <tr><td colspan="2"><div class="rule"></div></td></tr>
      <tr><td><strong>Total</strong></td><td class="num"><strong>${money(t.total)}</strong></td></tr>
      ${t.tendered != null && (transactionPaymentIsCash(t.payment)) ? `<tr><td>Cash Tendered</td><td class="num">${money(t.tendered)}</td></tr>` : ''}
      ${t.change != null && transactionPaymentIsCash(t.payment) ? `<tr><td>Change</td><td class="num">${money(t.change)}</td></tr>` : ''}
      <tr><td>Payment</td><td class="num">${escapeHtml(t.payment)}</td></tr>
      ${t.discountIdNote ? `<tr><td>SC/PWD ID No.</td><td class="num">${escapeHtml(t.discountIdNote)}</td></tr>` : ''}
    </table>
    <div class="rule"></div>
    <div class="center muted">${escapeHtml(receipt.footer.thankYou)}</div>
    <div class="center muted">${escapeHtml(receipt.footer.note)}</div>
  </div>
  <script>
    window.onload = function () {
      window.focus();
      window.print();
    };
    window.onafterprint = function () {
      window.close();
    };
  </script>
</body>
</html>`
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function transactionPaymentIsCash(payment) {
  const p = String(payment || 'Cash').toLowerCase()
  return p === 'cash' || p.startsWith('cash')
}

function formatReceiptDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '—')
  return date.toLocaleString()
}

/**
 * Opens a browser window containing a print-ready receipt.
 * @param {Object} receipt - The receipt data to render.
 * @throws {Error} If the browser blocks the print window.
 */
export function printReceiptBrowser(receipt) {
  const html = receiptToHtml(receipt)
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank', 'width=360,height=720')
  if (!win) {
    URL.revokeObjectURL(url)
    throw new Error('Pop-up blocked. Allow pop-ups to print receipts.')
  }
  setTimeout(() => URL.revokeObjectURL(url), 120000)
  const closeSoon = () => {
    try {
      win.close()
    } catch {
      /* ignore */
    }
  }
  if (typeof win.addEventListener === 'function') {
    win.addEventListener('afterprint', closeSoon)
  }
  // Fallback if afterprint never fires (some browsers)
  setTimeout(closeSoon, 60000)
}
