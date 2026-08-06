import { money, qty } from './format'

/**
 * Build a BIR-oriented receipt payload from branch + transaction detail.
 * Hardware printers can consume this object; browser print uses HTML.
 */
export function buildReceipt({ branch = {}, transaction = {}, lines = [], user = {} }) {
  const businessName = branch.business_name || branch.name || 'CalePOS Store'
  const orNumber = transaction.orNumber || transaction.or_number || transaction.id
  return {
    header: {
      businessName,
      branchName: branch.name || '',
      address: branch.address || '',
      tin: branch.tin || '',
      birPermitNo: branch.bir_permit_no || branch.birPermitNo || '',
      machineId: branch.machine_identification_no || branch.machineId || '',
      serialNumber: branch.serial_number || branch.serialNumber || '',
    },
    document: {
      title: 'OFFICIAL RECEIPT',
      orNumber,
      dateTime: transaction.createdAt || transaction.time || new Date().toISOString(),
      cashier: transaction.cashier || user.name || 'Staff',
      status: transaction.status || 'Paid',
      voidReason: transaction.voidReason || null,
    },
    lines: (lines.length ? lines : transaction.lines || transaction.itemsList || []).map((line) => {
      const amount = line.quantity ?? (line.pricingMode === 'kg' ? line.weight : line.quantity)
      const unitPrice = line.unitPrice ?? line.price
      const lineTotal = line.lineTotal ?? unitPrice * amount
      return {
        name: line.name,
        sku: line.sku || '',
        qty: amount,
        unit: line.pricingMode === 'kg' || line.pricingMode === 'per_kg' ? 'kg' : 'pc',
        unitPrice,
        lineTotal,
        discountAmount: Number(line.discountAmount ?? 0),
        netLineTotal: Number(line.netLineTotal ?? lineTotal),
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
      discountAmount: Number(transaction.discountAmount ?? transaction.discount_amount ?? 0),
      discountType: transaction.discountType || transaction.discount_type || null,
      discountIdNote: transaction.discountIdNote || transaction.discount_id_note || null,
    },
    footer: {
      note: 'This document is computer-generated. Keep for your records.',
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
        </td>
        <td class="num">${qty(line.qty, line.unit)}</td>
        <td class="num">${
          line.discountAmount > 0
            ? `<div class="muted strike">${money(line.unitPrice)}</div>${money(
                Number(
                  (
                    line.unitPrice -
                    line.discountAmount / Math.max(1, Number(line.qty) || 1)
                  ).toFixed(2),
                ),
              )}`
            : money(line.unitPrice)
        }</td>
        <td class="num">${
          line.discountAmount > 0
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
    <div class="center muted">Permit: ${escapeHtml(h.birPermitNo || '—')}</div>
    <div class="center muted">MIN: ${escapeHtml(h.machineId || '—')} · SN: ${escapeHtml(h.serialNumber || '—')}</div>
    <div class="rule"></div>
    <div class="center"><strong>${escapeHtml(d.title)}</strong></div>
    <div>OR No: <strong>${escapeHtml(String(d.orNumber))}</strong></div>
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
      ${t.discountAmount > 0 ? `<tr><td>Discount${t.discountType ? ` (${escapeHtml(t.discountType)})` : ''}</td><td class="num">-${money(t.discountAmount)}</td></tr>` : ''}
      ${t.vatableSales > 0 ? `<tr><td>VATable Sales</td><td class="num">${money(t.vatableSales)}</td></tr>` : ''}
      ${t.vatAmount > 0 ? `<tr><td>VAT</td><td class="num">${money(t.vatAmount)}</td></tr>` : ''}
      <tr><td>TOTAL</td><td class="num"><strong>${money(t.total)}</strong></td></tr>
      ${t.tendered != null && (transactionPaymentIsCash(t.payment)) ? `<tr><td>Cash</td><td class="num">${money(t.tendered)}</td></tr>` : ''}
      ${t.change != null && transactionPaymentIsCash(t.payment) ? `<tr><td>Change</td><td class="num">${money(t.change)}</td></tr>` : ''}
      <tr><td>Payment</td><td class="num">${escapeHtml(t.payment)}</td></tr>
      ${t.discountIdNote ? `<tr><td>ID</td><td class="num">${escapeHtml(t.discountIdNote)}</td></tr>` : ''}
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
