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
      }
    }),
    totals: {
      total: Number(transaction.total ?? 0),
      tendered: transaction.tendered != null ? Number(transaction.tendered) : null,
      change: transaction.change != null ? Number(transaction.change) : null,
      payment: 'Cash',
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
        <td>${escapeHtml(line.name)}</td>
        <td class="num">${qty(line.qty, line.unit)}</td>
        <td class="num">${money(line.unitPrice)}</td>
        <td class="num">${money(line.lineTotal)}</td>
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
      <tr><td>TOTAL</td><td class="num"><strong>${money(t.total)}</strong></td></tr>
      ${t.tendered != null ? `<tr><td>Cash</td><td class="num">${money(t.tendered)}</td></tr>` : ''}
      ${t.change != null ? `<tr><td>Change</td><td class="num">${money(t.change)}</td></tr>` : ''}
      <tr><td>Payment</td><td class="num">${escapeHtml(t.payment)}</td></tr>
    </table>
    <div class="rule"></div>
    <div class="center muted">${escapeHtml(receipt.footer.thankYou)}</div>
    <div class="center muted">${escapeHtml(receipt.footer.note)}</div>
  </div>
  <script>window.onload = function () { window.print(); };</script>
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

function formatReceiptDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value || '—')
  return date.toLocaleString()
}

/** Open a print-ready receipt window (works without a thermal printer). */
export function printReceiptBrowser(receipt) {
  const html = receiptToHtml(receipt)
  const win = window.open('', '_blank', 'noopener,noreferrer,width=360,height=720')
  if (!win) {
    throw new Error('Pop-up blocked — allow pop-ups to print receipts.')
  }
  win.document.open()
  win.document.write(html)
  win.document.close()
}
