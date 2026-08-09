import { useEffect, useMemo, useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import {
  Field,
  Pager,
  SearchBox,
  SecondaryButton,
  SelectField,
  SkeletonRows,
  StatusBadge,
  TableCard,
  moneyClass,
  tableRowClass,
} from '../ui'
import { MOVEMENT_TYPES, fetchStockMovements, hasSupabase } from '../../lib/api'
import { formatSupportError } from '../../utils/errors'
import { money, qty } from '../../utils/format'

const PAGE_SIZE = 15

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

const TYPE_TONE = {
  restock: 'success',
  sale: 'neutral',
  adjustment: 'warn',
  shrinkage: 'danger',
  price_change: 'warn',
  update: 'neutral',
}

/**
 * Inventory → Movement history.
 *
 * The chronological answer to "why is the count what it is": what moved, how much, which
 * kind of movement, who did it, when. Movement TYPE stays labelled here on purpose — this
 * is the log where restock vs sale vs adjustment vs waste is the whole point, unlike the
 * sold-quantity list where those words were noise.
 */
function MovementHistoryPanel({ branchId, products = [] }) {
  const [preset, setPreset] = useState('week')
  const [start, setStart] = useState(() => presetRange('week').start)
  const [end, setEnd] = useState(() => presetRange('week').end)
  const [productId, setProductId] = useState('')
  const [movementType, setMovementType] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(0)

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

  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const pageIndex = Math.min(page, pageCount - 1)
  const pageRows = visible.slice(pageIndex * PAGE_SIZE, pageIndex * PAGE_SIZE + PAGE_SIZE)

  const sortedProducts = useMemo(
    () => [...products].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''))),
    [products],
  )

  return (
    <>
      <TableCard className="mb-3.5 max-h-none rounded-t-none p-4">
        <div className="flex flex-wrap items-end gap-3">
          <SearchBox
            label="Search"
            className="min-w-[200px] flex-1"
            icon={<FiSearch />}
            placeholder="Product, note, reference or staff"
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
                  ? 'border-brand-ink bg-brand-ink text-white'
                  : 'border-brand-line bg-white text-brand-n700 hover:bg-brand-n50'
              }`}
              onClick={() => applyPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          <SecondaryButton compact type="button" disabled={loading} onClick={() => void load()}>
            {loading ? 'Loading…' : 'Refresh'}
          </SecondaryButton>
          <span className="text-[11px] text-brand-subtle">
            {visible.length} movement{visible.length === 1 ? '' : 's'}
          </span>
        </div>
        {error && <p className="mt-2 text-xs text-brand-danger">{error}</p>}
      </TableCard>

      <TableCard className="max-h-none">
        <div className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,1fr)] items-center gap-2 bg-brand-dark px-4 py-2.5 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase max-[900px]:grid-cols-[minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,0.7fr)]">
          <span>When</span>
          <span>Product</span>
          <span className="max-[900px]:hidden">Type</span>
          <span className="text-right">Change</span>
          <span className="text-right max-[900px]:hidden">On hand after</span>
          <span className="max-[900px]:hidden">By / note</span>
        </div>

        {loading ? (
          <SkeletonRows rows={10} cols={5} />
        ) : pageRows.length === 0 ? (
          <div className="px-4 py-8 text-xs text-brand-subtle">
            No stock movements match these filters.
          </div>
        ) : (
          pageRows.map((row) => {
            const isPrice = row.movementType === 'price_change'
            return (
              <div
                key={row.id}
                className={`grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,0.7fr)_minmax(0,0.7fr)_minmax(0,1fr)] items-center gap-2 px-4 py-2.5 text-xs max-[900px]:grid-cols-[minmax(0,1.2fr)_minmax(0,0.7fr)_minmax(0,0.7fr)] ${tableRowClass}`}
              >
                <span className="text-brand-slate">
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
                <span className="max-[900px]:hidden">
                  <StatusBadge compact tone={TYPE_TONE[row.movementType] || 'neutral'}>
                    {row.type}
                  </StatusBadge>
                </span>
                <strong
                  className={`text-right ${moneyClass} ${
                    isPrice
                      ? 'text-brand-muted'
                      : row.quantityChange > 0
                        ? 'text-brand-success'
                        : row.quantityChange < 0
                          ? 'text-brand-danger'
                          : 'text-brand-muted'
                  }`}
                >
                  {/* A price change moves money, not stock — showing "0" in a quantity
                      column would read as a no-op adjustment. */}
                  {isPrice
                    ? `${money(row.oldPrice)} → ${money(row.newPrice)}`
                    : `${row.quantityChange > 0 ? '+' : ''}${qty(row.quantityChange)}`}
                </strong>
                <span className={`text-right text-brand-muted max-[900px]:hidden ${moneyClass}`}>
                  {isPrice ? '—' : qty(row.resultingStock)}
                </span>
                <span className="min-w-0 truncate text-brand-slate max-[900px]:hidden">
                  {row.staffName || 'System'}
                  {row.detail ? ` · ${row.detail}` : ''}
                  {row.reference ? ` · ${row.reference}` : ''}
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
