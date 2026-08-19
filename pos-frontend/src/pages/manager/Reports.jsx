import { useEffect, useState } from 'react'
import {
  Field,
  PageHeader,
  PrimaryButton,
  SecondaryButton,
  SelectField,
  Skeleton,
  SkeletonRows,
  StatusOverlay,
  moneyClass,
  tableHeadClass,
  tableRowClass,
} from '../../components/ui'
import {
  approverLabel,
  fetchAllStaff,
  fetchAuditEvents,
  fetchBirDailyBreakdown,
  fetchBranches,
  fetchCashMovements,
  fetchCartRemoveReport,
  fetchDiscountReport,
  fetchElectronicJournal,
  fetchFiscalBackup,
  fetchGrossMarginReport,
  fetchInventoryReport,
  fetchPriceChangeReport,
  fetchReportSalesDetail,
  fetchSaleEvents,
  fetchScPwdReport,
  fetchShrinkageReport,
  fetchStockMovementReport,
  fetchTenderSummary,
  fetchTerminalReportSource,
  fetchEarliestTransactionDate,
  formatProductCode,
  hasSupabase,
  logAuditEvent,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { money, today } from '../../utils/format'
import { formatSupportError } from '../../utils/errors'
import {
  buildTerminalReportData,
  downloadText,
  formatCashierThermal,
  formatDepartmentThermal,
  formatPluThermal,
  formatReportPdfHtml,
  formatTablePdfHtml,
  formatTableThermal,
  formatTerminalThermal,
  openPrintWindow,
  printThermalText,
  reportCounters,
} from '../../utils/terminalReports'

import { loadXlsx } from '../../lib/xlsxLoader'

const TERMINAL_IDS = new Set(['x-read', 'z-read', 'cashier', 'department', 'plu'])

/**
 * X-Read and Z-Read are register readings for one trading period — a Z-Read is by
 * definition the end-of-day reset. Running either "for all time" is not a bigger version
 * of the same document, it is a meaningless one, so the All-records preset is refused for
 * them rather than quietly producing a number nobody should file.
 */
const NO_ALL_RANGE = new Set(['x-read', 'z-read'])

function isoDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function startOfThisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

/**
 * The report catalog. `note` is shown under the picker — it exists so a manager knows
 * what a document is FOR before filing it, and in particular which reports are statutory
 * records versus management information. Getting that wrong is how the wrong number ends
 * up on a return.
 */
const REPORTS = [
  { id: 'x-read', group: 'Terminal', title: 'X-Read', note: 'Mid-shift reading. No reset.' },
  { id: 'z-read', group: 'Terminal', title: 'Z-Read', note: 'End-of-day reading. Resets the counter.' },
  { id: 'cashier', group: 'Terminal', title: 'Cashier Report' },
  { id: 'department', group: 'Terminal', title: 'Department Report' },
  { id: 'plu', group: 'Terminal', title: 'PLU Report' },
  { id: 'inventory', group: 'Catalog', title: 'Inventory' },
  { id: 'price-listing', group: 'Catalog', title: 'Price Listing' },
  {
    id: 'price-changes',
    group: 'Catalog',
    title: 'Price Change Register',
    note: 'Every price edit, and who made it.',
  },
  {
    id: 'stock-movement',
    group: 'Catalog',
    title: 'Stock Movement Ledger',
    note: 'Every stock in/out with the balance it produced.',
  },
  {
    id: 'restock-summary',
    group: 'Catalog',
    title: 'Restock Summary',
    note: 'Per branch, staff, and item: total restocked, and when. Scan for a quantity lower than it should be.',
  },
  {
    id: 'shrinkage-report',
    group: 'Catalog',
    title: 'Reseko / Shrinkage Loss',
    note: 'Every waste/shrinkage movement with peso value lost, priced at current selling price (unit cost is usually unset).',
  },
  { id: 'sales-invoice', group: 'Sales', title: 'Sales Per Invoice' },
  { id: 'pos-sales-detail', group: 'Sales', title: 'POS Sales Detail' },
  { id: 'order-status', group: 'Sales', title: 'Order Status' },
  { id: 'salesman', group: 'Sales', title: 'Salesman Listing' },
  {
    id: 'tender-summary',
    group: 'Sales',
    title: 'Tender / Payment Summary',
    note: 'Reconcile the drawer and settlements against this.',
  },
  {
    id: 'gross-margin',
    group: 'Sales',
    title: 'Gross Margin (COGS)',
    note: 'Management report: costs are current, not frozen at sale time.',
  },
  {
    id: 'cash-movements',
    group: 'Audit',
    title: 'Cash Movements',
    note: 'Petty cash and pickups from POS Open Drawer: cross-session history.',
  },
  {
    id: 'cart-removes',
    group: 'Audit',
    title: 'Cart Item Removals',
    note: 'Every line removed before checkout: approved, self-allowed, denied, or pending. For fraud review.',
  },
  { id: 'void-log', group: 'Audit', title: 'Void / Refund Log' },
  { id: 'audit-trail', group: 'Audit', title: 'Login & Audit Trail' },
  {
    id: 'discount-report',
    group: 'Audit',
    title: 'Discount Report (all types)',
    note: 'Every discount granted: promo and statutory, shown apart.',
  },
  {
    id: 'bir-summary',
    group: 'Fiscal',
    title: 'BIR Sales Summary',
    note: 'Daily VATable / VAT / exempt / zero-rated breakdown for filing.',
  },
  {
    id: 'sc-pwd',
    group: 'Fiscal',
    title: 'Senior Citizen / PWD Register',
    note: 'Statutory record substantiating the 20% discount as a tax deduction.',
  },
  {
    id: 'e-journal',
    group: 'Fiscal',
    title: 'Electronic Journal (EJ)',
    note: 'Unabridged chronological record, voids included. Produce on BIR demand.',
  },
  { id: 'fiscal-backup', group: 'Fiscal', title: 'Fiscal Data Backup' },
]

async function exportRows(rows, name) {
  const XLSX = await loadXlsx()
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Report')
  XLSX.writeFile(book, `${name}.csv`)
}

function downloadJson(payload, name) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${name}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function ensureRows(list, emptyMessage) {
  if (list && list.length) return list
  return [{ result: emptyMessage || 'No records for this date range / branch.' }]
}

/**
 * Which numeric columns are pesos, so they get money formatting and tabular figures.
 *
 * The exclusions come first and matter more than they look: `discount_pct` and
 * `margin_pct` both contain "discount"/"margin", and a percentage rendered as ₱12.50 is
 * a number a manager can act on wrongly. Counts (`sales_count`, `qty_sold`,
 * `balance_after`) are likewise not money.
 */
function isMoneyColumn(key) {
  if (/_pct$|_count$|_rate$|^qty|_no$|balance_after|transactions/.test(key)) return false
  return /price|sales|total|amount|cost|vat|discount|margin|revenue|refunds|tendered|change/.test(key)
}

function ManagerReports() {
  const user = useAuthStore((s) => s.user)
  const [selected, setSelected] = useState('x-read')
  const [branches, setBranches] = useState([])
  const [allStaff, setAllStaff] = useState([])
  const [filters, setFilters] = useState({
    start: today(),
    end: today(),
    branchId: '',
    staffId: '',
    moveType: '',
    moveStatus: '',
    drawerId: '',
    cartRemoveOutcome: '',
  })
  const [rangeMode, setRangeMode] = useState('today')
  const [rangeNote, setRangeNote] = useState('')
  const [preview, setPreview] = useState('')
  const [termData, setTermData] = useState(null)
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const isTerminal = TERMINAL_IDS.has(selected)
  const cashiers = allStaff.filter((s) => {
    if (String(s.role || '').toLowerCase() !== 'cashier') return false
    if (!filters.branchId) return true
    return s.branch_id === filters.branchId
  })

  useEffect(() => {
    if (!hasSupabase) return
    fetchBranches()
      .then((list) => {
        setBranches(list)
        if (list[0]?.id) setFilters((f) => ({ ...f, branchId: f.branchId || list[0].id }))
      })
      .catch((err) => setError(err.message))
    fetchAllStaff()
      .then((staff) => setAllStaff(staff || []))
      .catch(() => setAllStaff([]))
  }, [])

  const clearOut = () => {
    setPreview('')
    setTermData(null)
    setRows([])
    setNote('')
    setError('')
  }

  const branchName =
    branches.find((b) => b.id === filters.branchId)?.name || (filters.branchId ? 'Branch' : 'All branches')


  /**
   * Date-range presets, including "All records" which anchors the start to the branch's
   * first-ever sale (see api.fetchEarliestTransactionDate) rather than an arbitrary floor —
   * a floor would make day-walking reports iterate thousands of empty days.
   */
  const applyRange = async (mode) => {
    setError('')
    setRangeNote('')
    if (mode === 'all' && NO_ALL_RANGE.has(selected)) {
      setError('X-Read and Z-Read cover a single trading period. Pick a date range instead.')
      return
    }
    setRangeMode(mode)
    if (mode === 'today') {
      setFilters((f) => ({ ...f, start: today(), end: today() }))
      return
    }
    if (mode === '7d') {
      setFilters((f) => ({ ...f, start: isoDaysAgo(6), end: today() }))
      return
    }
    if (mode === 'month') {
      setFilters((f) => ({ ...f, start: startOfThisMonth(), end: today() }))
      return
    }
    if (mode === 'all') {
      setBusy(true)
      try {
        const earliest = await fetchEarliestTransactionDate(filters.branchId || null)
        if (!earliest) {
          setRangeNote('No sales on record yet.')
          setFilters((f) => ({ ...f, start: today(), end: today() }))
          return
        }
        setFilters((f) => ({ ...f, start: earliest, end: today() }))
        setRangeNote(`All records, first sale ${earliest} to today.`)
      } catch (err) {
        setError(formatSupportError(err, 'DATA01'))
      } finally {
        setBusy(false)
      }
    }
  }

  const runTerminal = async () => {
    if (!filters.branchId) {
      setError('Select a branch.')
      return
    }
    if (!filters.start || !filters.end) {
      setError('Select start and end dates.')
      return
    }
    if (filters.end < filters.start) {
      setError('End date must be on or after start date.')
      return
    }

    const source = await fetchTerminalReportSource({
      date: filters.start,
      endDate: filters.end,
      branchId: filters.branchId,
      staffId: selected === 'cashier' && filters.staffId ? filters.staffId : null,
    })

    const counters = reportCounters(filters.branchId)
    const printedAt = new Date()
    let readingMeta = {}
    let mode = 'x'

    if (selected === 'x-read') {
      mode = 'x'
      const { z, x } = counters.bumpX(filters.start)
      const zLabel = String(z || 1).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      readingMeta = { label: `${zLabel}/${x}`, z, x }
      setNote('X-Read snapshot (no reset).')
    } else if (selected === 'z-read') {
      mode = 'z'
      const z = counters.bumpZ()
      readingMeta = { label: String(z), z }
      setNote('Z-Read recorded. Close till via Day end.')
      await logAuditEvent({
        branchId: filters.branchId,
        staffId: user?.id,
        eventType: 'z_read',
        detail: `Z-Read #${z} for ${filters.start}–${filters.end}`,
        meta: { start: filters.start, end: filters.end, z },
      }).catch(() => {})
    } else {
      mode = selected === 'cashier' ? 'cashier' : 'x'
    }

    const staffId = selected === 'cashier' ? filters.staffId || null : null
    const staffRow = staffId ? cashiers.find((c) => c.id === staffId) : null
    const staffName = staffId
      ? staffRow?.full_name || source.staffNames?.[staffId] || 'Cashier'
      : 'ALL CASHIERS'

    const report = buildTerminalReportData({
      mode,
      branch: source.branch || {},
      operatorName: user?.name || '',
      date: filters.start,
      printedAt,
      transactions: source.transactions,
      lineItems: source.lineItems,
      pettyCash: source.pettyCash,
      dayEnd: source.dayEnd,
      oldGrandTotal: source.oldGrandTotal,
      readingMeta,
      staffId: selected === 'cashier' ? staffId : null,
      staffName: selected === 'cashier' ? staffName : '',
      staffCode: staffId ? String(staffRow?.login_code || staffId).slice(0, 8) : '',
      shiftNo: 1,
      cashCount: source.dayEnd?.declared_cash ?? source.dayEnd?.cash_counted ?? null,
    })

    let text = ''
    if (selected === 'x-read' || selected === 'z-read') text = formatTerminalThermal(report)
    else if (selected === 'cashier') text = formatCashierThermal(report)
    else if (selected === 'department') text = formatDepartmentThermal(report)
    else if (selected === 'plu') text = formatPluThermal(report, { start: filters.start, end: filters.end })

    setTermData({
      kind: selected === 'z-read' ? 'z' : selected,
      report,
      opts: { start: filters.start, end: filters.end },
    })
    setPreview(text || 'No activity in range.\n(Report still generated, all values at .00)')
    setRows([])
  }

  const runTable = async () => {
    if (!filters.start || !filters.end) {
      setError('Select start and end dates.')
      return
    }
    if (filters.end < filters.start) {
      setError('End date must be on or after start date.')
      return
    }

    const branchId = filters.branchId || null

    if (selected === 'fiscal-backup') {
      const pack = await fetchFiscalBackup({
        start: filters.start,
        end: filters.end,
        branchId,
      })
      downloadJson(pack, `calepos-fiscal-backup-${filters.start}-${filters.end}`)
      setRows(
        ensureRows(
          [
            {
              exported_at: pack.exportedAt,
              transactions: pack.transactions.length,
              sale_events: pack.saleEvents.length,
              audit_events: pack.auditEvents.length,
              day_ends: pack.dayEnds.length,
            },
          ],
          'Backup created with 0 records.',
        ),
      )
      setNote('Fiscal backup JSON downloaded.')
      return
    }

    /**
     * Price Listing is a PRICE LIST, not a stock report.
     *
     * It used to share the Inventory handler, which is why it carried on-hand counts,
     * unit cost, extended totals and a Low/OK status — none of which belong on a price
     * list. Two concrete problems came from that:
     *
     *   - It leaked COST. A price list is the document you hand to staff, print for the
     *     shelf, or send to a customer who asks what things cost. Margin should not
     *     travel with it.
     *   - The "total" columns went NEGATIVE, which is what prompted this. They were
     *     unit_price × quantity_on_hand, so any product sitting at negative stock
     *     produced a negative extended value. That is a real signal — but it is a signal
     *     about STOCK, and it is meaningless on a price list.
     *
     * Negative on-hand is now surfaced where it belongs: the Inventory report flags it
     * explicitly instead of burying it inside an extended total.
     */
    if (selected === 'price-listing') {
      const data = await fetchInventoryReport(branchId)
      setNote('Current selling prices. No stock or cost figures, safe to print or hand out.')
      setRows(
        ensureRows(
          data
            .map((row) => ({
              product_code: formatProductCode(row.products?.product_no),
              branch: row.branches?.name,
              barcode: row.products?.barcode || '',
              product: row.products?.name,
              sku: row.products?.sku || '',
              category: row.products?.categories?.name || '—',
              unit: row.products?.pricing_mode === 'kg' ? 'per kg' : 'per piece',
              unit_price: Number(row.products?.price || 0),
              discountable: row.products?.discount_eligible ? 'Yes' : 'No',
            }))
            .sort(
              (a, b) =>
                String(a.category).localeCompare(String(b.category)) ||
                String(a.product).localeCompare(String(b.product)),
            ),
          'No products in catalog for this branch.',
        ),
      )
      return
    }

    if (selected === 'inventory') {
      const data = await fetchInventoryReport(branchId)
      let negatives = 0
      const table = data.map((row) => {
        const qtyOnHand = Number(row.quantity_on_hand || 0)
        const unitCost = Number(row.products?.unit_cost || 0)
        const unitPrice = Number(row.products?.price || 0)
        if (qtyOnHand < 0) negatives += 1
        return {
          product_code: formatProductCode(row.products?.product_no),
          branch: row.branches?.name,
          barcode: row.products?.barcode || '',
          product: row.products?.name,
          sku: row.products?.sku,
          category: row.products?.categories?.name,
          on_hand: qtyOnHand,
          unit_cost: unitCost,
          unit_price: unitPrice,
          total_cost: Number((unitCost * qtyOnHand).toFixed(2)),
          total_price: Number((unitPrice * qtyOnHand).toFixed(2)),
          // Negative stock is called out by name. It means the POS sold more than the
          // system thought existed, so the valuation below it is wrong too — that is
          // worth a word, not a silent minus sign in a total.
          status:
            qtyOnHand < 0
              ? 'NEGATIVE: recount'
              : qtyOnHand <= Number(row.products?.low_stock_threshold || 0)
                ? 'Low'
                : 'OK',
        }
      })
      setNote(
        negatives > 0
          ? `${negatives} product(s) show NEGATIVE stock. More was sold than the system had on record. Recount those before trusting the valuation totals.`
          : 'Stock valuation at current cost and price.',
      )
      setRows(ensureRows(table, 'No products in catalog for this branch.'))
      return
    }

    if (selected === 'void-log') {
      const events = await fetchSaleEvents({
        start: filters.start,
        end: filters.end,
        branchId,
        limit: null,
      })
      setRows(
        ensureRows(
          events
            .filter((e) => e.event_type === 'void' || e.event_type === 'refund')
            .map((e) => ({
              when: e.created_at,
              type: e.event_type,
              invoice_number: e.invoice_number,
              amount: Number(e.amount || 0),
              reason: e.reason,
              staff: e.staff?.full_name,
              approved_by: approverLabel(e.approver_name, e.approver_role) || '—',
              branch: e.branches?.name,
            })),
          'No voids or refunds in this range.',
        ),
      )
      return
    }

    if (selected === 'audit-trail') {
      const events = await fetchAuditEvents({
        start: filters.start,
        end: filters.end,
        branchId,
        limit: null,
      })
      setRows(
        ensureRows(
          events.map((e) => ({
            when: e.created_at,
            event: e.event_type,
            detail: e.detail,
            staff: e.staff?.full_name,
            branch: e.branches?.name,
          })),
          'No audit events in this range.',
        ),
      )
      return
    }

    if (selected === 'cart-removes') {
      const OUTCOME_LABEL = {
        removed: 'Removed (approved)',
        removed_unapproved: 'Removed (unapproved)',
        denied: 'Denied',
        cancelled: 'Cancelled',
        pending: 'Pending',
      }
      const data = await fetchCartRemoveReport({
        start: filters.start,
        end: filters.end,
        branchId,
        requestedBy: filters.staffId || null,
        outcome: filters.cartRemoveOutcome || null,
      })
      const unapproved = data.filter((r) => r.outcome === 'removed_unapproved').length
      setNote(
        unapproved > 0
          ? `${unapproved} removal(s) proceeded without manager approval. Review self-allowed rows first.`
          : 'Supervisor PIN, manager remote, or on-site approval is required before a line leaves the cart.',
      )
      setRows(
        ensureRows(
          data.map((row) => ({
            when: row.when ? new Date(row.when).toLocaleString() : '',
            branch: row.branch,
            item: row.item,
            quantity: row.quantity,
            cashier: row.cashier,
            approved_by: row.approved_by,
            outcome: OUTCOME_LABEL[row.outcome] || row.outcome,
            method: row.method,
            detail: row.detail,
          })),
          'No cart removals in this range.',
        ),
      )
      return
    }

    if (selected === 'bir-summary') {
      // One ranged query, bucketed per day in api.js. Previously this looped
      // fetchDailyReading once per day — first sequentially (365 round trips for a year),
      // then via Promise.all, which just turned that into 365 concurrent paged fetches and
      // made rate-limiting fail the entire report. With "All records" the range is
      // unbounded, so neither shape held up.
      const readings = await fetchBirDailyBreakdown({
        start: filters.start,
        end: filters.end,
        branchId,
      })
      const totals = {
        gross_sales: 0,
        discounts: 0,
        net_sales: 0,
        vatable_sales: 0,
        vat_amount: 0,
        vat_exempt_sales: 0,
        zero_rated_sales: 0,
        sc_pwd_discount: 0,
        void_total: 0,
      }
      const table = readings.map((reading) => {
        const row = {
          date: reading.date,
          invoice_from: reading.invoiceFrom || '—',
          invoice_to: reading.invoiceTo || '—',
          sales_count: reading.transactionCount,
          void_count: reading.voidCount,
          gross_sales: reading.grossSales,
          discounts: reading.discountTotal,
          net_sales: reading.netSales,
          // The four BIR categories, each stated on its own. A return needs them apart.
          vatable_sales: reading.vatableSales,
          vat_amount: reading.vatAmount,
          vat_exempt_sales: reading.vatExemptSales,
          zero_rated_sales: reading.zeroRatedSales,
          sc_pwd_discount: reading.scPwdDiscount,
          void_total: reading.voidTotal,
        }
        Object.keys(totals).forEach((key) => {
          totals[key] += Number(row[key] || 0)
        })
        return row
      })
      // A period total belongs on the document itself — re-adding a column by hand in a
      // spreadsheet is exactly where a filing error gets introduced.
      if (table.length > 1) {
        table.push({
          date: 'TOTAL',
          invoice_from: '',
          invoice_to: '',
          sales_count: table.reduce((n, r) => n + Number(r.sales_count || 0), 0),
          void_count: table.reduce((n, r) => n + Number(r.void_count || 0), 0),
          ...Object.fromEntries(
            Object.entries(totals).map(([key, value]) => [key, Number(value.toFixed(2))]),
          ),
        })
      }
      setNote(
        'Per-day BIR breakdown from live sales. VATable / VAT / VAT-exempt / zero-rated are reported separately, as filed.',
      )
      setRows(ensureRows(table, 'No sales data in this range.'))
      return
    }

    if (selected === 'sc-pwd') {
      const data = await fetchScPwdReport({ start: filters.start, end: filters.end, branchId })
      const missingId = data.filter((r) => r.id_number === '(NOT RECORDED)').length
      setNote(
        missingId > 0
          ? `${missingId} of ${data.length} sale(s) have no ID number recorded. BIR will disallow the deduction on those. Capture the ID at checkout.`
          : 'Every discounted sale has an ID number on record.',
      )
      setRows(ensureRows(data, 'No Senior Citizen / PWD discounts in this range.'))
      return
    }

    if (selected === 'discount-report') {
      const data = await fetchDiscountReport({ start: filters.start, end: filters.end, branchId })
      setRows(ensureRows(data, 'No discounts granted in this range.'))
      return
    }

    if (selected === 'e-journal') {
      const data = await fetchElectronicJournal({ start: filters.start, end: filters.end, branchId })
      const voided = data.filter((r) => r.status === 'VOIDED').length
      setNote(
        `${data.length} transaction(s), ${voided} voided. Voids are included on purpose, an EJ with them removed proves nothing.`,
      )
      setRows(ensureRows(data, 'No transactions in this range.'))
      return
    }

    if (selected === 'tender-summary') {
      const data = await fetchTenderSummary({ start: filters.start, end: filters.end, branchId })
      setRows(ensureRows(data, 'No completed sales in this range.'))
      return
    }

    if (selected === 'cash-movements') {
      const data = await fetchCashMovements({
        branchId,
        start: filters.start,
        end: filters.end,
        type: filters.moveType || null,
        status: filters.moveStatus || null,
        requestedBy: filters.staffId || null,
        drawerId: filters.drawerId || null,
      })
      setNote(
        'Self-recorded and flagged rows surface here for investigation. Creation is only on POS → Open Drawer.',
      )
      setRows(
        ensureRows(
          data.map((row) => ({
            when: row.requestedAt
              ? new Date(row.requestedAt).toLocaleString()
              : '',
            branch_id: row.branchId,
            type:
              row.type === 'pickup'
                ? 'Pickup'
                : row.type === 'cash_in'
                  ? 'Cash in'
                  : row.type === 'opening_float'
                    ? 'Opening float'
                    : 'Petty cash',
            amount: row.amount,
            status: row.status,
            drawer: row.drawerLabel || row.drawerId,
            cashier: row.requestedByName || row.requestedBy,
            reason: row.reason,
            approved_by: row.approvedByName || '',
            reviewed_by: row.reviewedByName || '',
            review_action: row.reviewAction || '',
          })),
          'No cash movements in this range.',
        ),
      )
      return
    }

    if (selected === 'gross-margin') {
      const data = await fetchGrossMarginReport({ start: filters.start, end: filters.end, branchId })
      setNote('Cost uses each product’s current unit cost, not the cost at time of sale.')
      setRows(ensureRows(data, 'No sales in this range.'))
      return
    }

    if (selected === 'stock-movement') {
      const data = await fetchStockMovementReport({ start: filters.start, end: filters.end, branchId })
      setRows(ensureRows(data, 'No stock movements in this range.'))
      return
    }

    if (selected === 'restock-summary') {
      const data = await fetchStockMovementReport({
        start: filters.start,
        end: filters.end,
        branchId,
        movementTypes: ['restock'],
      })
      // A void reversal also writes movement_type='restock' (stock coming BACK from a
      // cancelled sale) — that is not a restock anyone performed, and counting it here
      // would inflate a staff member's total for a sale they never actually restocked.
      //
      // Grouped down to branch+staff+PRODUCT, not just branch+staff — a count of "12
      // events" doesn't tell a manager which items moved or by how much; this is meant
      // to be read line by line against what was actually supposed to arrive.
      const byGroup = {}
      data
        .filter((row) => !String(row.detail || '').startsWith('Void restock'))
        .forEach((row) => {
          const key = `${row.branch}::${row.staff}::${row.sku || row.product}`
          if (!byGroup[key]) {
            byGroup[key] = {
              branch: row.branch,
              staff: row.staff,
              product: row.product,
              sku: row.sku,
              events: 0,
              qty: 0,
              first: row.when,
              last: row.when,
            }
          }
          byGroup[key].events += 1
          byGroup[key].qty += row.qty_in
          if (row.when < byGroup[key].first) byGroup[key].first = row.when
          if (row.when > byGroup[key].last) byGroup[key].last = row.when
        })
      setRows(
        ensureRows(
          Object.values(byGroup)
            .map((row) => ({
              branch: row.branch,
              staff: row.staff,
              product: row.product,
              sku: row.sku,
              restock_events: row.events,
              qty_restocked: Number(row.qty.toFixed(2)),
              first_restock: row.first?.slice(0, 10) || '',
              last_restock: row.last?.slice(0, 10) || '',
            }))
            .sort(
              (a, b) =>
                a.branch.localeCompare(b.branch) ||
                a.staff.localeCompare(b.staff) ||
                a.product.localeCompare(b.product),
            ),
          'No restocks in this range.',
        ),
      )
      return
    }

    if (selected === 'shrinkage-report') {
      const data = await fetchShrinkageReport({ start: filters.start, end: filters.end, branchId })
      const totalLoss = data.reduce((sum, row) => sum + Number(row.loss_amount || 0), 0)
      setNote(
        `Total value lost: ${money(totalLoss)}. Valued at each product's CURRENT selling price — a price change restates older rows, same caveat as Gross Margin.`,
      )
      setRows(ensureRows(data, 'No shrinkage in this range.'))
      return
    }

    if (selected === 'price-changes') {
      const data = await fetchPriceChangeReport({ start: filters.start, end: filters.end, branchId })
      setRows(ensureRows(data, 'No price changes in this range.'))
      return
    }

    const includeVoided = selected === 'order-status' || selected === 'sales-invoice'
    const detail = await fetchReportSalesDetail({
      start: filters.start,
      end: filters.end,
      branchId,
      includeVoided,
    })

    if (selected === 'pos-sales-detail') {
      setRows(
        ensureRows(
          detail.map((row) => ({
            date: row.transactions?.created_at?.slice(0, 10),
            invoice_number: row.transactions?.invoice_number || row.transactions?.id,
            cashier: row.transactions?.staff?.full_name,
            product: row.products?.name,
            sku: row.products?.sku || '',
            category: row.products?.categories?.name,
            qty: Number(row.quantity),
            unit_price: Number(row.unit_price),
            line_total: Number(row.line_total),
            payment: row.transactions?.payment_method || 'cash',
          })),
          'No sale lines in this range.',
        ),
      )
      return
    }

    if (selected === 'sales-invoice' || selected === 'order-status') {
      const byTxn = {}
      detail.forEach((row) => {
        const id = row.transactions?.id
        if (!byTxn[id]) {
          byTxn[id] = {
            invoice_number: row.transactions?.invoice_number || id,
            date: row.transactions?.created_at?.slice(0, 10),
            cashier: row.transactions?.staff?.full_name,
            status: row.transactions?.status,
            void_reason: row.transactions?.void_reason || '',
            total: 0,
            lines: 0,
          }
        }
        byTxn[id].total += Number(row.line_total)
        byTxn[id].lines += 1
      })
      setRows(
        ensureRows(
          Object.values(byTxn),
          selected === 'order-status' ? 'No orders in this range.' : 'No invoices in this range.',
        ),
      )
      return
    }

    if (selected === 'salesman') {
      const byStaff = {}
      detail.forEach((row) => {
        if (row.transactions?.status === 'voided') return
        const sid = row.transactions?.staff_id || 'unknown'
        const name = row.transactions?.staff?.full_name || 'Unknown'
        if (!byStaff[sid]) byStaff[sid] = { cashier: name, invoices: new Set(), sales: 0 }
        byStaff[sid].invoices.add(row.transactions?.invoice_number || row.transactions?.id)
        byStaff[sid].sales += Number(row.line_total)
      })
      setRows(
        ensureRows(
          Object.values(byStaff).map((row) => ({
            cashier: row.cashier,
            invoices: row.invoices.size,
            sales: row.sales,
          })),
          'No cashier sales in this range.',
        ),
      )
      return
    }

    setRows([{ result: 'Unknown report type.' }])
  }

  const run = async () => {
    clearOut()
    setBusy(true)
    try {
      if (!hasSupabase) {
        setError('Connect Supabase to generate reports.')
        return
      }
      if (isTerminal) await runTerminal()
      else await runTable()
    } catch (err) {
      setError(err.message || 'Report failed')
      setRows([{ result: `Error: ${err.message || 'Report failed'}` }])
    } finally {
      setBusy(false)
    }
  }

  const onPrintReceipt = () => {
    try {
      setError('')
      if (isTerminal) {
        if (!preview) {
          setError('Run the report first.')
          return
        }
        printThermalText(preview)
        return
      }
      if (!rows.length) {
        setError('Run the report first.')
        return
      }
      const text = formatTableThermal({
        title: REPORTS.find((r) => r.id === selected)?.title || selected,
        branchName,
        start: filters.start,
        end: filters.end,
        rows,
      })
      printThermalText(text)
    } catch (err) {
      setError(err.message)
    }
  }

  const onPdf = () => {
    try {
      if (isTerminal && termData) {
        const kind =
          termData.kind === 'cashier'
            ? 'cashier'
            : termData.kind === 'department'
              ? 'department'
              : termData.kind === 'plu'
                ? 'plu'
                : termData.kind === 'z'
                  ? 'z'
                  : 'terminal'
        openPrintWindow(formatReportPdfHtml(kind, termData.report, termData.opts))
        return
      }
      openPrintWindow(
        formatTablePdfHtml({
          title: REPORTS.find((r) => r.id === selected)?.title || selected,
          branchName,
          start: filters.start,
          end: filters.end,
          rows,
        }),
      )
    } catch (err) {
      setError(err.message)
    }
  }

  const groups = [...new Set(REPORTS.map((r) => r.group))]
  const selectedReport = REPORTS.find((r) => r.id === selected)
  const hasOutput = isTerminal ? Boolean(preview) : rows.length > 0

  return (
    <div>
      {busy && (
        <StatusOverlay title="Generating report" message="Building preview, please wait…" />
      )}
      <PageHeader eyebrow="MANAGER" title="Reports" />

      <div className="mb-3 rounded-[10px] border border-brand-line bg-brand-card p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <label className="block text-[11px] font-bold text-brand-n800">
            Report
            <select
              className="mt-[7px] block w-full rounded-[5px] border border-brand-input bg-brand-card p-2.5 text-[13px]"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value)
                clearOut()
              }}
            >
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {REPORTS.filter((r) => r.group === g).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selectedReport?.note && (
              <span className="mt-1 block text-[10px] leading-snug font-normal text-brand-subtle">
                {selectedReport.note}
              </span>
            )}
          </label>

          <div className="col-span-full">
            <span className="mb-1 block text-xs font-bold text-brand-muted">Range</span>
            <div className="flex flex-wrap gap-1.5">
              {[
                { id: 'today', label: 'Today' },
                { id: '7d', label: 'Last 7 days' },
                { id: 'month', label: 'This month' },
                { id: 'all', label: 'All records' },
              ].map((r) => {
                const blocked = r.id === 'all' && NO_ALL_RANGE.has(selected)
                return (
                  <button
                    key={r.id}
                    type="button"
                    disabled={busy || blocked}
                    className={`rounded-[5px] border px-2.5 py-1.5 text-[11px] font-bold disabled:cursor-not-allowed disabled:opacity-40 ${
                      rangeMode === r.id
                        ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                        : 'border-brand-border bg-brand-card text-brand-ink'
                    }`}
                    onClick={() => void applyRange(r.id)}
                  >
                    {r.label}
                  </button>
                )
              })}
            </div>
            {rangeNote && <p className="m-0 mt-1.5 text-[11px] text-brand-subtle">{rangeNote}</p>}
          </div>

          <Field
            label="From"
            type="date"
            value={filters.start}
            onChange={(e) => {
              setRangeMode('custom')
              setRangeNote('')
              setFilters({ ...filters, start: e.target.value })
            }}
          />
          <Field
            label="To"
            type="date"
            value={filters.end}
            onChange={(e) => {
              setRangeMode('custom')
              setRangeNote('')
              setFilters({ ...filters, end: e.target.value })
            }}
          />
          <SelectField
            label="Branch"
            value={filters.branchId}
            onChange={(e) => setFilters({ ...filters, branchId: e.target.value, staffId: '' })}
          >
            {!isTerminal && <option value="">All branches</option>}
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </SelectField>
          {selected === 'cashier' && (
            <SelectField
              label="Cashier"
              value={filters.staffId}
              onChange={(e) => setFilters({ ...filters, staffId: e.target.value })}
            >
              <option value="">All cashiers</option>
              {cashiers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.full_name}
                </option>
              ))}
            </SelectField>
          )}
          {selected === 'cart-removes' && (
            <>
              <SelectField
                label="Cashier"
                value={filters.staffId}
                onChange={(e) => setFilters({ ...filters, staffId: e.target.value })}
              >
                <option value="">All cashiers</option>
                {cashiers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Outcome"
                value={filters.cartRemoveOutcome || ''}
                onChange={(e) => setFilters({ ...filters, cartRemoveOutcome: e.target.value })}
              >
                <option value="">All outcomes</option>
                <option value="removed">Removed (approved)</option>
                <option value="removed_unapproved">Removed (unapproved)</option>
                <option value="denied">Denied</option>
                <option value="cancelled">Cancelled</option>
                <option value="pending">Pending</option>
              </SelectField>
            </>
          )}
          {selected === 'cash-movements' && (
            <>
              <SelectField
                label="Cashier"
                value={filters.staffId}
                onChange={(e) => setFilters({ ...filters, staffId: e.target.value })}
              >
                <option value="">All cashiers</option>
                {cashiers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Type"
                value={filters.moveType}
                onChange={(e) => setFilters({ ...filters, moveType: e.target.value })}
              >
                <option value="">All types</option>
                <option value="petty_cash">Petty cash</option>
                <option value="pickup">Pickup</option>
                <option value="cash_in">Cash in</option>
                <option value="opening_float">Opening float</option>
              </SelectField>
              <SelectField
                label="Status"
                value={filters.moveStatus}
                onChange={(e) => setFilters({ ...filters, moveStatus: e.target.value })}
              >
                <option value="">All statuses</option>
                <option value="pending_remote">Pending remote</option>
                <option value="approved">Approved</option>
                <option value="remote_approved">Approved (remote)</option>
                <option value="denied">Denied</option>
                <option value="self_recorded">Unauthorized</option>
                <option value="confirmed">Resolved</option>
                <option value="flagged_for_investigation">Flagged</option>
              </SelectField>
              <Field
                label="Drawer id"
                value={filters.drawerId}
                onChange={(e) => setFilters({ ...filters, drawerId: e.target.value })}
                placeholder="e.g. main"
              />
            </>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <PrimaryButton compact type="button" disabled={busy} onClick={run}>
            {busy ? '…' : 'Run'}
          </PrimaryButton>
          <SecondaryButton compact type="button" disabled={!hasOutput} onClick={onPrintReceipt}>
            Print receipt
          </SecondaryButton>
          <SecondaryButton compact type="button" disabled={!hasOutput} onClick={onPdf}>
            PDF
          </SecondaryButton>
          {isTerminal ? (
            <SecondaryButton
              compact
              type="button"
              disabled={!preview}
              onClick={() => downloadText(preview, `${selected}-${filters.start}-${filters.end}.txt`)}
            >
              Save .txt
            </SecondaryButton>
          ) : (
            <SecondaryButton
              compact
              type="button"
              disabled={!rows.length || selected === 'fiscal-backup'}
              onClick={() => void exportRows(rows, `${selected}-${filters.start}-${filters.end}`)}
            >
              CSV
            </SecondaryButton>
          )}
        </div>

        {note && <p className="mt-2 mb-0 text-xs text-brand-n700">{note}</p>}
        {error && <p className="mt-2 mb-0 text-xs text-brand-danger">{error}</p>}
      </div>

      <div className="overflow-hidden rounded-[10px] border border-brand-line bg-brand-card">
        {busy ? (
          <div className="p-3" role="status" aria-label="Loading">
            {isTerminal ? (
              <div className="space-y-2">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-56" />
                <Skeleton className="mt-2 h-48 w-full" />
              </div>
            ) : (
              <SkeletonRows rows={8} cols={5} />
            )}
          </div>
        ) : isTerminal ? (
          !preview ? (
            <div className="p-3 text-xs text-brand-n600">Run to preview receipt layout.</div>
          ) : (
            <pre className="m-0 max-h-[70vh] overflow-auto border-0 bg-brand-n100 p-3 font-mono text-[11px] leading-snug whitespace-pre">
              {preview}
            </pre>
          )
        ) : rows.length === 0 ? (
          <div className="p-3 text-xs text-brand-n600">Run to preview table.</div>
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="min-w-full border-collapse text-left text-xs">
              <thead>
                <tr className={`${tableHeadClass} border-b border-brand-dark`}>
                  {Object.keys(rows[0]).map((key) => (
                    <th key={key} className="px-2 py-1.5 font-bold whitespace-nowrap">
                      {key}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index} className={tableRowClass}>
                    {Object.entries(row).map(([key, value]) => {
                      const isMoney = typeof value === 'number' && isMoneyColumn(key)
                      return (
                        <td key={key} className={`px-2 py-1.5 whitespace-nowrap ${isMoney ? moneyClass : ''}`}>
                          {isMoney ? money(value) : String(value ?? '')}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

export default ManagerReports
