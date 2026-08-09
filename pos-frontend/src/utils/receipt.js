import { money, qty } from './format'

/**
 * Build a BIR-oriented receipt payload from branch + transaction detail.
 * Hardware printers can consume this object; browser print uses HTML.
 */
export function buildReceipt({ branch = {}, transaction = {}, lines = [], user = {} }) {
  const businessName = branch.business_name || branch.name || 'CalePOS Store'
  // The real OR number is allocated server-side (allocate_or_number) once the sale reaches
  // Supabase, which can be moments after this receipt prints (offline-first: local-first
  // write, sync happens in the background). Until then, transaction.id is only the local
  // client id (e.g. "txn_83abe93d-…") — show that plainly as pending rather than printing
  // the raw id as if it were the OR number.
  const rawOrNumber = transaction.orNumber || transaction.or_number || null
  const isPendingOr = !rawOrNumber
  const orNumber = rawOrNumber || 'PENDING'
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
      orNumber,
      isPendingOr,
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
  const lineRows = receipt.lines
    .map(
      (line) => `
      <tr>
        <td>
          ${escapeHtml(line.name)}
          ${
            line.discountAmount > 0
              ? `<div class="muted">Discount${
                  t.discountType ? ` (${escapeHtml(t.discountType)})` : ''
                } -${money(line.discountAmount)}</div>`
              : ''
          }
          ${line.vatCategory === 'exempt' ? '<div class="muted">VAT-EXEMPT</div>' : ''}
        </td>
        <td class="num">${qty(line.qty, line.unit)}</td>
        <td class="num">${
          line.netLineTotal < line.lineTotal
            ? `<div class="muted strike">${money(line.unitPrice)}</div>${money(line.netUnitPrice)}`
            : money(line.unitPrice)
        }</td>
        <td class="num">${
          line.netLineTotal < line.lineTotal
            ? `<div class="muted strike">${money(line.lineTotal)}</div>${money(line.netLineTotal)}`
            : money(line.lineTotal)
        }</td>
      </tr>`,
    )
    .join('')

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(d.title)} ${escapeHtml(String(d.orNumber))}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: #111; margin: 0; padding: 16px; }
    .ticket { width: 280px; margin: 0 auto; }
    h1 { font-size: 14px; margin: 0 0 4px; text-align: center; }
    .center { text-align: center; }
    .muted { color: #555; }
    .strike { text-decoration: line-through; }
    .rule { border-top: 1px dashed #999; margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 2px 0; vertical-align: top; }
    td.num { text-align: right; white-space: nowrap; }
    .totals td { padding-top: 4px; }
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
    <div>Invoice No: <strong>${escapeHtml(String(d.orNumber))}</strong>${d.isPendingOr ? ' <span class="muted">(assigns on sync)</span>' : ''}</div>
    <div>Date: ${escapeHtml(formatReceiptDate(d.dateTime))}</div>
    <div>Cashier: ${escapeHtml(d.cashier)}</div>
    <div>Status: ${escapeHtml(d.status)}${d.voidReason ? ` (${escapeHtml(d.voidReason)})` : ''}</div>
    <div class="rule"></div>
    <table>
      <thead>
        <tr><td>Item</td><td class="num">Qty</td><td class="num">Price</td><td class="num">Amt</td></tr>
      </thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div class="rule"></div>
    <table class="totals">
      <tr><td>VATable Sales</td><td class="num">${money(t.vatableSales)}</td></tr>
      <tr><td>VAT-Exempt Sales</td><td class="num">${money(t.vatExemptSales)}</td></tr>
      <tr><td>Zero-Rated Sales</td><td class="num">${money(t.zeroRatedSales)}</td></tr>
      <tr><td>VAT Amount</td><td class="num">${money(t.vatAmount)}</td></tr>
      <tr><td colspan="2"><div class="rule"></div></td></tr>
      <tr><td>Total Sales</td><td class="num">${money(t.totalSales)}</td></tr>
      <tr><td>Less: SC/PWD Discount</td><td class="num">-${money(t.scPwdDiscount)}</td></tr>
      <tr><td colspan="2"><div class="rule"></div></td></tr>
      <tr><td>TOTAL AMOUNT DUE</td><td class="num"><strong>${money(t.total)}</strong></td></tr>
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

/** Open a print-ready receipt window (works without a thermal printer). */
export function printReceiptBrowser(receipt) {
  const html = receiptToHtml(receipt)
  // Do not use noopener here — it returns null / blocks document.write and leaves about:blank.
  const win = window.open('', '_blank', 'width=360,height=720')
  if (!win) {
    throw new Error('Pop-up blocked — allow pop-ups to print receipts.')
  }
  try {
    win.opener = null
  } catch {
    /* ignore */
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
  // Close the print window after the dialog finishes (or after a short delay).
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
