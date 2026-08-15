import { useEffect, useMemo, useState } from 'react'
import { FiDownload, FiRefreshCw, FiSearch } from 'react-icons/fi'
import {
  Field,
  Pager,
  SearchBox,
  SecondaryButton,
  SelectField,
  SkeletonRows,
  TableCard,
  moneyClass,
  tableRowDenseClass,
} from '../ui'
import { MOVEMENT_TYPES, fetchStockMovements, hasSupabase } from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { money, qty } from '../../utils/format'

const PAGE_SIZE = 15

import { loadXlsx } from '../../lib/xlsxLoader'

/** Local YYYY-MM-DD. Not toISOString — that is UTC and shifts the day in UTC+8. */
function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function presetRange(preset) {
  const now = new Date()
  const today = dayKey(now)
  if (preset === 'today') return { start: today, end: today }
  if (preset === 'week') {
    const d = new Date(now)
    // Monday-start week: getDay() is 0 for Sunday, which would otherwise jump forward.
    const dow = (d.getDay() + 6) % 7
    d.setDate(d.getDate() - dow)
    return { start: dayKey(d), end: today }
  }
  if (preset === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1)
    return { start: dayKey(d), end: today }
  }
  return null
}

/**
 * Column widths follow how much text each field actually carries, not equal shares.
 *
 * Change and Balance are both short right-aligned numbers and are kept deliberately narrow
 * so they sit next to each other and read as one pair — "moved this much, left this much".
 * A wide Balance column pushed its figure far from the change that produced it. Type is one
 * word, so it takes the least. The freed space goes to By / note, which is the only column
 * holding sentences.
 *
 * Written out in full, twice-referenced by one constant: Tailwind only generates classes it
 * can see as literal text, so an interpolated width would silently produce no grid at all,
 * and a second hand-copied string would drift from the header.
 */
const MOVEMENT_GRID =
  'grid-cols-[minmax(0,0.8fr)_minmax(0,1.5fr)_minmax(0,0.5fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,1.9fr)]'
const MOVEMENT_GRID_NARROW = 'max-[900px]:grid-cols-[minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,0.7fr)]'

/**
 * Movement type as coloured text, matching the per-product movement table in the product
 * detail drawer (`Products.jsx`). Same log, two places — a badge here and plain text there
 * made them look like two different reports.
 */
const TYPE_TEXT = {
  restock: 'text-brand-success',
  sale: 'text-brand-slate',
  adjustment: 'text-brand-warn',
  shrinkage: 'text-brand-danger',
  price_change: 'font-bold text-brand-ink',
  update: 'text-brand-slate',
}

/**
 * A void's restock detail already spells out the OR ("Void restock OR-00000071") — showing
 * `reference` again next to it would just repeat the same OR number.
 */
function noteReference(row) {
  if (!row.reference) return ''
  return row.detail && row.detail.includes(row.reference) ? '' : row.reference
}

/**
 * Inventory → Movement history.
 *
 * The chronological answer to "why is the count what it is": what moved, how much, which
 * kind of movement, who did it, when. Movement TYPE stays labelled here on purpose — this
 * is the log where restock vs sale vs adjustment vs waste is the whole point, unlike the
 * sold-quantity list where those words were noise.
 */
function MovementHistoryPanel({ branchId, products = [], compact = false }) {
  const [preset, setPreset] = useState(compact ? 'today' : 'week')
  const [start, setStart] = useState(() => presetRange(compact ? 'today' : 'week').start)
  const [end, setEnd] = useState(() => presetRange(compact ? 'today' : 'week').end)
  const [productId, setProductId] = useState('')
  const [movementType, setMovementType] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)
  const [exporting, setExporting] = useState(false)
  const pageSize = compact ? 10 : PAGE_SIZE

  const applyPreset = (id) => {
    setPreset(id)
    const range = presetRange(id)
    if (range) {
      setStart(range.start)
      setEnd(range.end)
    }
  }

  const load = async () => {
    if (!hasSupabase || !branchId) {
      setRows([])
      return
    }
    setLoading(true)
    setError('')
    try {
      setRows(
        await fetchStockMovements({
          branchId,
          start: start || null,
          end: end || null,
          productId: productId || null,
          movementType: movementType || null,
        }),
      )
    } catch (err) {
      setError(formatSupportError(err, 'INV05'))
      setRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchId, start, end, productId, movementType])

  useEffect(() => {
    setPage(0)
  }, [query, start, end, productId, movementType])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) =>
      `${row.product || ''} ${row.detail || ''} ${row.reference || ''} ${row.staffName || ''}`
        .toLowerCase()
        .includes(q),
    )
  }, [rows, query])

  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = visible.slice(pageIndex * pageSize, pageIndex * pageSize + pageSize)

  const sortedProducts = useMemo(
    () => [...products].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    [products],
  )

  // Quantities carry their unit, same as the per-product table. "53.00" alone is ambiguous
  // on a branch that sells both by piece and by kilo.
  const unitById = useMemo(() => {
    const map = new Map()
    products.forEach((p) => map.set(p.id, p.pricingMode === 'kg' ? 'kg' : 'pc'))
    return map
  }, [products])

  // Exports every filtered row, not just the current page — a manager pulling this for
  // month-end wants the whole range, not 15 rows at a time.
  const handleExport = async () => {
    if (!visible.length || exporting) return
    setExporting(true)
    setError('')
    try {
      const XLSX = await loadXlsx()
      const sheetRows = visible.map((row) => {
        const isPrice = row.movementType === 'price_change'
        const unit = unitById.get(row.productId) || ''
        return {
          Date: row.createdAt
            ? new Date(row.createdAt).toLocaleString([], {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })
            : row.date || '',
          Product: row.product || '',
          Type: row.type || '',
          Change: isPrice
            ? `${money(row.oldPrice)} -> ${money(row.newPrice)}`
            : qty(row.quantityChange, unit),
          Balance: isPrice ? '' : qty(row.resultingStock, unit),
          By: row.staffName || 'System',
          Note: row.detail || '',
          Reference: row.reference || '',
        }
      })
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(sheetRows), 'Movements')
      XLSX.writeFile(book, `movement-history_${start || 'all'}_to_${end || 'all'}.csv`)
    } catch (err) {
      setError(formatSupportError(err, 'INV06'))
    } finally {
      setExporting(false)
    }
  }

  return (
    <>
      <TableCard className="mb-3.5 max-h-none rounded-t-none p-4">
        <div className="flex flex-wrap items-end gap-3">
          <SearchBox
            label="Search"
            className="min-w-[200px] flex-1"
            icon={<FiSearch />}
            placeholder="Product, note, OR number or staff"
            value={query}
            onChange={(e) => setQuery(e.target.value.replace(/[<>]/g, ''))}
          />
          <SelectField
            label="Product"
            className="min-w-[170px]"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">All products</option>
            {sortedProducts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          <SelectField
            label="Movement type"
            className="min-w-[160px]"
            value={movementType}
            onChange={(e) => setMovementType(e.target.value)}
          >
            <option value="">All types</option>
            {MOVEMENT_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </SelectField>
          <Field
            label="From"
            type="date"
            className="min-w-[140px]"
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              setPreset('custom')
            }}
          />
          <Field
            label="To"
            type="date"
            className="min-w-[140px]"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value)
              setPreset('custom')
            }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {[
            { id: 'today', label: 'Today' },
            { id: 'week', label: 'This week' },
            { id: 'month', label: 'This month' },
          ].map((p) => (
            <button
              key={p.id}
              type="button"
              className={`rounded-full border px-3 py-1 text-[11px] font-bold ${
                preset === p.id
                  ? 'border-brand-gold bg-brand-gold text-brand-on-gold'
                  : 'border-brand-line bg-brand-card text-brand-n700 hover:bg-brand-n50'
              }`}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          <SecondaryButton
            compact
            type="button"
            className="px-2.5"
            disabled={loading}
            aria-label={loading ? 'Loading movements' : 'Refresh movements'}
            title={loading ? 'Loading…' : 'Refresh'}
            onClick={() => void load()}
          >
            <FiRefreshCw className={`text-[14px] ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          </SecondaryButton>
          {!compact && (
            <SecondaryButton
              compact
              type="button"
              className="px-2.5"
              disabled={exporting || !visible.length}
              aria-label={exporting ? 'Exporting movements' : 'Export movements to CSV'}
              title={exporting ? 'Exporting…' : 'Export to CSV'}
              onClick={() => void handleExport()}
            >
              <FiDownload className="text-[14px]" aria-hidden="true" />
            </SecondaryButton>
          )}
          <span className="text-[11px] text-brand-subtle">
            {visible.length} movement{visible.length === 1 ? '' : 's'}
          </span>
        </div>
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
      </TableCard>

      <TableCard className="max-h-none">
        {/* Dark header, same as the Inventory list and Catalog tables — and the per-product
            movement table in the product detail drawer. It is the same ledger everywhere;
            it should not read as a different report just because it is on a different screen. */}
        <div
          className={`grid ${MOVEMENT_GRID} ${MOVEMENT_GRID_NARROW} items-center gap-2 bg-brand-dark px-4 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase`}
        >
          <span>Date</span>
          <span>Product</span>
          <span className="max-[900px]:hidden">Type</span>
          <span className="text-right">Change</span>
          <span className={`text-right whitespace-nowrap max-[900px]:hidden ${moneyClass}`}>Balance</span>
          <span className="max-[900px]:hidden">By / note</span>
        </div>

        {loading ? (
          <SkeletonRows rows={10} cols={6} />
        ) : pageRows.length === 0 ? (
          <div className="px-4 py-8 text-xs text-brand-subtle">
            No stock movements match these filters.
          </div>
        ) : (
          pageRows.map((row) => {
            const isPrice = row.movementType === 'price_change'
            const unit = unitById.get(row.productId) || ''
            return (
              <div
                key={row.id}
                className={`grid ${MOVEMENT_GRID} ${MOVEMENT_GRID_NARROW} items-center gap-2 text-[11px] ${tableRowDenseClass}`}
              >
                <span className="text-brand-slate">
                  {/* Date AND time, unlike the per-product table: this is every product at
                      once, so two movements on the same day need to be tellable apart. */}
                  {row.createdAt
                    ? new Date(row.createdAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : row.date || '—'}
                </span>
                <div className="min-w-0">
                  <strong className="block truncate text-brand-ink">{row.product || '—'}</strong>
                  <small className="mt-0.5 hidden text-[10px] text-brand-subtle max-[900px]:block">
                    {row.type}
                    {row.staffName ? ` · ${row.staffName}` : ''}
                  </small>
                </div>
                <span className={`truncate max-[900px]:hidden ${TYPE_TEXT[row.movementType] || 'text-brand-slate'}`}>
                  {row.type}
                </span>
                {/* A price change moves money, not stock — showing "0" in a quantity column
                    would read as a no-op adjustment. It is also the one long value in a
                    narrow column, hence truncate. */}
                <span className={`truncate text-right ${moneyClass} text-brand-slate`}>
                  {isPrice
                    ? `${money(row.oldPrice)} → ${money(row.newPrice)}`
                    : row.quantityChange > 0
                      ? `+${qty(row.quantityChange, unit)}`
                      : row.quantityChange < 0
                        ? `−${qty(Math.abs(row.quantityChange), unit)}`
                        : '—'}
                </span>
                {/* The running count — the reason this screen exists, so it is the only bold
                    figure in the row. Negative stock is impossible in theory and worth
                    shouting about when it happens. */}
                <strong
                  className={`text-right whitespace-nowrap max-[900px]:hidden ${moneyClass} ${
                    isPrice
                      ? 'text-brand-muted'
                      : row.resultingStock < 0
                        ? 'text-brand-danger'
                        : 'text-brand-ink'
                  }`}
                >
                  {isPrice ? '—' : qty(row.resultingStock, unit)}
                </strong>
                {/* `reference` has already been turned into an OR number or dropped by
                    fetchStockMovements — a raw transaction/batch id is a key the reader
                    cannot act on, so it never reaches this column. A void's restock detail
                    already spells out "Void restock OR-00000071" server-side, so showing
                    the same OR again as reference would just repeat it. */}
                <span className="min-w-0 truncate text-brand-slate max-[900px]:hidden">
                  {row.staffName || 'System'}
                  {row.detail ? ` · ${row.detail}` : ''}
                  {noteReference(row) ? ` · ${noteReference(row)}` : ''}
                </span>
              </div>
            )
          })
        )}

        {pageCount > 1 && (
          <Pager
            page={pageIndex + 1}
            pageCount={pageCount}
            total={visible.length}
            label="movements"
            onPrev={() => setPage((p) => Math.max(0, p - 1))}
            onNext={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          />
        )}
      </TableCard>
    </>
  )
}

export default MovementHistoryPanel
