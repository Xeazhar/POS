import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { Field, PageHeader, PrimaryButton, SelectField, TableCard } from '../../components/ui'
import {
  fetchAuditEvents,
  fetchBranches,
  fetchDailyReading,
  fetchFiscalBackup,
  fetchInventoryReport,
  fetchReportSalesDetail,
  fetchSaleEvents,
  hasSupabase,
} from '../../lib/api'
import { money, today } from '../../utils/format'

const REPORTS = [
  { id: 'inventory', title: 'Inventory Report', blurb: 'Current stock levels and thresholds' },
  { id: 'sales-invoice', title: 'Sales Per Invoice Report', blurb: 'OR-numbered transaction totals' },
  { id: 'price-listing', title: 'Price Listing', blurb: 'Current product catalog with prices' },
  { id: 'pos-sales-detail', title: 'POS Sales Detail Report', blurb: 'Line-item sales with filters' },
  { id: 'order-status', title: 'Order Status Listing', blurb: 'Paid vs voided orders' },
  { id: 'void-log', title: 'Void / Refund Log', blurb: 'Append-only void and refund events' },
  { id: 'audit-trail', title: 'User Login & Audit Trail', blurb: 'Sign-in, void, and system events' },
  { id: 'salesman', title: 'Salesman Listing', blurb: 'Sales performance per staff' },
  { id: 'z-reading', title: 'Daily Z Reading', blurb: 'End-of-day OR range and totals' },
  { id: 'x-reading', title: 'Daily X Reading', blurb: 'Mid-day sales snapshot (same day)' },
  { id: 'bir-summary', title: 'Daily BIR Sales Summary', blurb: 'Gross, voids, net, OR range' },
  { id: 'fiscal-backup', title: 'Fiscal Data Backup', blurb: 'JSON export of sales, voids, audit, day-ends' },
]

function exportRows(rows, name) {
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

function ManagerReports() {
  const [selected, setSelected] = useState('inventory')
  const [branches, setBranches] = useState([])
  const [filters, setFilters] = useState({ start: today(), end: today(), branchId: '', category: '' })
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!hasSupabase) return
    fetchBranches().then(setBranches).catch((err) => setError(err.message))
  }, [])

  const run = async () => {
    setError('')
    setNote('')
    try {
      if (!hasSupabase) {
        setRows([{ note: 'Connect Supabase and seed data to generate live reports.' }])
        return
      }

      if (selected === 'fiscal-backup') {
        const pack = await fetchFiscalBackup({
          start: filters.start,
          end: filters.end,
          branchId: filters.branchId || null,
        })
        downloadJson(pack, `calepos-fiscal-backup-${filters.start}-${filters.end}`)
        setRows([
          {
            exported_at: pack.exportedAt,
            transactions: pack.transactions.length,
            sale_events: pack.saleEvents.length,
            audit_events: pack.auditEvents.length,
            day_ends: pack.dayEnds.length,
          },
        ])
        setNote('Fiscal backup JSON downloaded. Also keep Supabase project backups enabled.')
        return
      }

      if (selected === 'inventory' || selected === 'price-listing') {
        const data = await fetchInventoryReport(filters.branchId || null)
        setRows(
          data.map((row) => ({
            branch: row.branches?.name,
            product: row.products?.name,
            sku: row.products?.sku,
            category: row.products?.categories?.name,
            price: Number(row.products?.price || 0),
            on_hand: Number(row.quantity_on_hand),
            low_at: Number(row.products?.low_stock_threshold || 0),
            status: Number(row.quantity_on_hand) <= Number(row.products?.low_stock_threshold || 0) ? 'Low' : 'OK',
          })),
        )
        return
      }

      if (selected === 'void-log') {
        const events = await fetchSaleEvents({
          start: filters.start,
          end: filters.end,
          branchId: filters.branchId || null,
        })
        setRows(
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
        )
        return
      }

      if (selected === 'audit-trail') {
        const events = await fetchAuditEvents({
          start: filters.start,
          end: filters.end,
          branchId: filters.branchId || null,
        })
        setRows(
          events.map((e) => ({
            when: e.created_at,
            event: e.event_type,
            detail: e.detail,
            staff: e.staff?.full_name,
            branch: e.branches?.name,
          })),
        )
        return
      }

      if (selected === 'z-reading' || selected === 'x-reading' || selected === 'bir-summary') {
        const reading = await fetchDailyReading({
          date: filters.end || filters.start || today(),
          branchId: filters.branchId || null,
        })
        setNote(
          selected === 'x-reading'
            ? 'X reading = mid-day snapshot (same counters, no reset). Not a BIR-accredited format.'
            : 'Operational Z/BIR summary from live sales. Formal BIR accreditation is separate.',
        )
        setRows([
          {
            date: reading.date,
            or_from: reading.orFrom,
            or_to: reading.orTo,
            sales_count: reading.transactionCount,
            void_count: reading.voidCount,
            gross_sales: reading.salesTotal,
            void_total: reading.voidTotal,
            net_sales: reading.netSales,
          },
          ...reading.rows.map((r) => ({
            or_number: r.or_number,
            status: r.status,
            total: r.total,
            cashier: r.cashier,
            time: r.time,
            void_reason: r.void_reason || '',
          })),
        ])
        return
      }

      const includeVoided = selected === 'order-status' || selected === 'sales-invoice'
      const detail = await fetchReportSalesDetail({ ...filters, includeVoided })
      if (selected === 'pos-sales-detail') {
        setRows(
          detail.map((row) => ({
            date: row.transactions?.created_at?.slice(0, 10),
            or_number: row.transactions?.or_number || row.transactions?.id,
            cashier: row.transactions?.staff?.full_name,
            product: row.products?.name,
            category: row.products?.categories?.name,
            qty: Number(row.quantity),
            unit_price: Number(row.unit_price),
            line_total: Number(row.line_total),
            payment: 'Cash',
          })),
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
        setRows(Object.values(byTxn))
        return
      }
      if (selected === 'salesman') {
        const byStaff = {}
        detail.forEach((row) => {
          if (row.transactions?.status === 'voided') return
          const name = row.transactions?.staff?.full_name || 'Unknown'
          if (!byStaff[name]) byStaff[name] = { cashier: name, invoices: new Set(), sales: 0 }
          byStaff[name].invoices.add(row.transactions?.or_number || row.transactions?.id)
          byStaff[name].sales += Number(row.line_total)
        })
        setRows(
          Object.values(byStaff).map((row) => ({
            cashier: row.cashier,
            invoices: row.invoices.size,
            sales: row.sales,
          })),
        )
        return
      }
      setRows([{ note: 'Unknown report type.' }])
    } catch (err) {
      setError(err.message)
    }
  }

  const active = REPORTS.find((item) => item.id === selected)

  return (
    <div>
      <PageHeader eyebrow="MANAGER" title="Reports suite" />
      <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-4 max-[900px]:grid-cols-1">
        <TableCard className="max-h-none p-3">
          {REPORTS.map((report) => (
            <button
              key={report.id}
              type="button"
              className={`mb-1 w-full rounded-md border-0 px-3 py-3 text-left text-xs ${
                selected === report.id ? 'bg-brand-dark text-white' : 'bg-transparent text-brand-slate'
              }`}
              onClick={() => setSelected(report.id)}
            >
              <strong className="block">{report.title}</strong>
              <span className={`mt-1 block text-[10px] ${selected === report.id ? 'text-brand-soft' : 'text-brand-subtle'}`}>
                {report.blurb}
              </span>
            </button>
          ))}
        </TableCard>
        <div>
          <TableCard className="mb-3.5 max-h-none p-5">
            <h2 className="m-0 text-lg">{active?.title}</h2>
            <p className="mt-1 text-xs text-brand-muted">{active?.blurb}</p>
            <div className="mt-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
              <Field label="Start date" type="date" value={filters.start} onChange={(e) => setFilters({ ...filters, start: e.target.value })} />
              <Field label="End date" type="date" value={filters.end} onChange={(e) => setFilters({ ...filters, end: e.target.value })} />
              <SelectField label="Branch" value={filters.branchId} onChange={(e) => setFilters({ ...filters, branchId: e.target.value })}>
                <option value="">All branches</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </SelectField>
              <SelectField label="Item category" value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
                <option value="">All</option>
                <option>Meat</option>
                <option>Bakery</option>
                <option>Groceries</option>
              </SelectField>
            </div>
            <div className="mt-4 flex gap-2">
              <PrimaryButton compact type="button" onClick={run}>
                {selected === 'fiscal-backup' ? 'Download backup' : 'Run report'}
              </PrimaryButton>
              <PrimaryButton
                compact
                type="button"
                disabled={!rows.length || selected === 'fiscal-backup'}
                onClick={() => exportRows(rows, selected)}
              >
                Export CSV
              </PrimaryButton>
            </div>
            {note && <p className="mt-3 text-xs text-brand-muted">{note}</p>}
            {error && <p className="mt-3 text-xs text-brand-danger">{error}</p>}
          </TableCard>
          <TableCard>
            {rows.length === 0 ? (
              <div className="p-5 text-xs text-brand-subtle">Run a report to preview rows.</div>
            ) : (
              <div className="overflow-auto">
                <table className="min-w-full text-left text-xs">
                  <thead className="bg-[#f7f7f4] text-[9px] tracking-[1px] text-[#989e99] uppercase">
                    <tr>
                      {Object.keys(rows[0]).map((key) => (
                        <th key={key} className="px-4 py-3 font-bold">{key}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index} className="border-t border-brand-softline">
                        {Object.entries(row).map(([key, value]) => (
                          <td key={key} className="px-4 py-3">
                            {typeof value === 'number' &&
                            (key.includes('price') ||
                              key === 'sales' ||
                              key === 'total' ||
                              key === 'line_total' ||
                              key.includes('sales') ||
                              key.includes('void_total') ||
                              key === 'amount' ||
                              key === 'gross_sales' ||
                              key === 'net_sales')
                              ? money(value)
                              : String(value ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TableCard>
        </div>
      </div>
    </div>
  )
}

export default ManagerReports
