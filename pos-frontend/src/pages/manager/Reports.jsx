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
  fetchAllStaff,
  fetchAuditEvents,
  fetchBranches,
  fetchDailyReading,
  fetchFiscalBackup,
  fetchInventoryReport,
  fetchReportSalesDetail,
  fetchSaleEvents,
  fetchTerminalReportSource,
  formatProductCode,
  hasSupabase,
  logAuditEvent,
} from '../../lib/api'
import { useAuthStore } from '../../stores/posStore'
import { money, today } from '../../utils/format'
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

/**
 * xlsx is ~410KB — the single largest chunk in the app. It is only needed the moment
 * someone actually picks a spreadsheet or exports one, which most sessions never do,
 * so it is loaded on demand instead of riding along with this page's bundle.
 */
let xlsxPromise = null
function loadXlsx() {
  if (!xlsxPromise) xlsxPromise = import('xlsx')
  return xlsxPromise
}

const TERMINAL_IDS = new Set(['x-read', 'z-read', 'cashier', 'department', 'plu'])

const REPORTS = [
  { id: 'x-read', group: 'Terminal', title: 'X-Read' },
  { id: 'z-read', group: 'Terminal', title: 'Z-Read' },
  { id: 'cashier', group: 'Terminal', title: 'Cashier Report' },
  { id: 'department', group: 'Terminal', title: 'Department Report' },
  { id: 'plu', group: 'Terminal', title: 'PLU Report' },
  { id: 'inventory', group: 'Catalog', title: 'Inventory' },
  { id: 'price-listing', group: 'Catalog', title: 'Price Listing' },
  { id: 'sales-invoice', group: 'Sales', title: 'Sales Per Invoice' },
  { id: 'pos-sales-detail', group: 'Sales', title: 'POS Sales Detail' },
  { id: 'order-status', group: 'Sales', title: 'Order Status' },
  { id: 'salesman', group: 'Sales', title: 'Salesman Listing' },
  { id: 'void-log', group: 'Audit', title: 'Void / Refund Log' },
  { id: 'audit-trail', group: 'Audit', title: 'Login & Audit Trail' },
  { id: 'bir-summary', group: 'Fiscal', title: 'BIR Sales Summary' },
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
  })
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
    setPreview(text || 'No activity in range.\n(Report still generated — all values at .00)')
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

    if (selected === 'inventory' || selected === 'price-listing') {
      const data = await fetchInventoryReport(branchId)
      setRows(
        ensureRows(
          data.map((row) => {
            const qtyOnHand = Number(row.quantity_on_hand || 0)
            const unitCost = Number(row.products?.unit_cost || 0)
            const unitPrice = Number(row.products?.price || 0)
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
              status: qtyOnHand <= Number(row.products?.low_stock_threshold || 0) ? 'Low' : 'OK',
            }
          }),
          'No products in catalog for this branch.',
        ),
      )
      return
    }

    if (selected === 'void-log') {
      const events = await fetchSaleEvents({
        start: filters.start,
        end: filters.end,
        branchId,
      })
      setRows(
        ensureRows(
          events
            .filter((e) => e.event_type === 'void' || e.event_type === 'refund')
            .map((e) => ({
              when: e.created_at,
              type: e.event_type,
              or_number: e.or_number,
              amount: Number(e.amount || 0),
              reason: e.reason,
              staff: e.staff?.full_name,
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

    if (selected === 'bir-summary') {
      // One summary row per day in range
      const days = []
      const cursor = new Date(`${filters.start}T12:00:00`)
      const end = new Date(`${filters.end}T12:00:00`)
      while (cursor <= end) {
        const key = cursor.toISOString().slice(0, 10)
        days.push(key)
        cursor.setDate(cursor.getDate() + 1)
      }
      const readings = []
      for (const date of days) {
        const reading = await fetchDailyReading({ date, branchId })
        readings.push({
          date: reading.date,
          or_from: reading.orFrom || '—',
          or_to: reading.orTo || '—',
          sales_count: reading.transactionCount,
          void_count: reading.voidCount,
          gross_sales: reading.salesTotal,
          void_total: reading.voidTotal,
          net_sales: reading.netSales,
        })
      }
      setNote('Operational summary from live sales (per day in range).')
      setRows(ensureRows(readings, 'No sales data in this range.'))
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
            or_number: row.transactions?.or_number || row.transactions?.id,
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
            or_number: row.transactions?.or_number || id,
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
        byStaff[sid].invoices.add(row.transactions?.or_number || row.transactions?.id)
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
  const hasOutput = isTerminal ? Boolean(preview) : rows.length > 0

  return (
    <div>
      {busy && (
        <StatusOverlay title="Generating report" message="Building preview — please wait…" />
      )}
      <PageHeader eyebrow="MANAGER" title="Reports" />

      <div className="mb-3 border border-[#c8ccc4] bg-white p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <label className="block text-[11px] font-bold text-[#555]">
            Report
            <select
              className="mt-1 block w-full border border-[#bbb] bg-white p-2 text-xs"
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
          </label>

          <Field
            label="From"
            type="date"
            value={filters.start}
            onChange={(e) => setFilters({ ...filters, start: e.target.value })}
          />
          <Field
            label="To"
            type="date"
            value={filters.end}
            onChange={(e) => setFilters({ ...filters, end: e.target.value })}
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

        {note && <p className="mt-2 mb-0 text-xs text-[#666]">{note}</p>}
        {error && <p className="mt-2 mb-0 text-xs text-brand-danger">{error}</p>}
      </div>

      <div className="border border-[#c8ccc4] bg-white">
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
            <div className="p-3 text-xs text-[#888]">Run to preview receipt layout.</div>
          ) : (
            <pre className="m-0 max-h-[70vh] overflow-auto border-0 bg-[#f7f7f4] p-3 font-mono text-[11px] leading-snug whitespace-pre">
              {preview}
            </pre>
          )
        ) : rows.length === 0 ? (
          <div className="p-3 text-xs text-[#888]">Run to preview table.</div>
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
                      const isMoney =
                        typeof value === 'number' &&
                        (key.includes('price') ||
                          key.includes('sales') ||
                          key.includes('total') ||
                          key.includes('amount') ||
                          key.includes('cost') ||
                          key === 'gross_sales' ||
                          key === 'net_sales' ||
                          key === 'void_total')
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
