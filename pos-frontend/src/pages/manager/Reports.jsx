import { useEffect, useState } from 'react'
import * as XLSX from 'xlsx'
import { Field, PageHeader, PrimaryButton, SelectField, TableCard } from '../../components/ui'
import { fetchBranches, fetchInventoryReport, fetchReportSalesDetail, hasSupabase } from '../../lib/api'
import { money, today } from '../../utils/format'

const REPORTS = [
  { id: 'inventory', title: 'Inventory Report', blurb: 'Current stock levels and Reseko thresholds' },
  { id: 'sales-invoice', title: 'Sales Per Invoice Report', blurb: 'Transaction-level totals' },
  { id: 'price-listing', title: 'Price Listing', blurb: 'Current product catalog with prices' },
  { id: 'pos-sales-detail', title: 'POS Sales Detail Report', blurb: 'Line-item sales with filters' },
  { id: 'order-status', title: 'Order Status Listing', blurb: 'Paid vs voided orders' },
  { id: 'salesman', title: 'Salesman Listing', blurb: 'Sales performance per staff' },
  { id: 'z-reading', title: 'POS Sales Z Reading', blurb: 'Compliance format — not yet accredited' },
  { id: 'x-reading', title: 'POS Sales X Reading', blurb: 'Compliance format — not yet accredited' },
  { id: 'bir-summary', title: 'POS BIR Sales Summary', blurb: 'Compliance format — not yet accredited' },
]

function exportRows(rows, name) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Report')
  XLSX.writeFile(book, `${name}.csv`)
}

function ManagerReports() {
  const [selected, setSelected] = useState('inventory')
  const [branches, setBranches] = useState([])
  const [filters, setFilters] = useState({ start: today(), end: today(), branchId: '', category: '' })
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (!hasSupabase) return
    fetchBranches().then(setBranches).catch((err) => setError(err.message))
  }, [])

  const run = async () => {
    setError('')
    try {
      if (!hasSupabase) {
        setRows([{ note: 'Connect Supabase and seed data to generate live reports.' }])
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
      const detail = await fetchReportSalesDetail(filters)
      if (selected === 'pos-sales-detail') {
        setRows(
          detail.map((row) => ({
            date: row.transactions?.created_at?.slice(0, 10),
            invoice: row.transactions?.id,
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
              invoice: id,
              date: row.transactions?.created_at?.slice(0, 10),
              cashier: row.transactions?.staff?.full_name,
              status: row.transactions?.status,
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
          const name = row.transactions?.staff?.full_name || 'Unknown'
          if (!byStaff[name]) byStaff[name] = { cashier: name, invoices: new Set(), sales: 0 }
          byStaff[name].invoices.add(row.transactions?.id)
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
      setRows([{ note: 'Compliance report scaffold only — format not accredited yet.' }])
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
              <PrimaryButton compact type="button" onClick={run}>Run report</PrimaryButton>
              <PrimaryButton
                compact
                type="button"
                disabled={!rows.length}
                onClick={() => exportRows(rows, selected)}
              >
                Export CSV
              </PrimaryButton>
            </div>
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
                            {typeof value === 'number' && key.includes('price') || key === 'sales' || key === 'total' || key === 'line_total'
                              ? money(value)
                              : String(value)}
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
