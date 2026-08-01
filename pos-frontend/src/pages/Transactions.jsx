import { useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import { Eyebrow, Modal, ModalActions, PageHeader, PrimaryButton, SearchBox, SecondaryButton, TableCard } from '../components/ui'
import { fetchTransactionDetail, hasSupabase } from '../lib/api'
import { useInventoryStore } from '../stores/posStore'
import { money, qty } from '../utils/format'

function Transactions() {
  const transactions = useInventoryStore((state) => state.transactions)
  const voidTransaction = useInventoryStore((state) => state.voidTransaction)
  const [query, setQuery] = useState('')
  const [voiding, setVoiding] = useState(null)
  const [detail, setDetail] = useState(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState('')

  const list = transactions.filter(
    (item) =>
      item.id.toLowerCase().includes(query.toLowerCase()) ||
      item.cashier.toLowerCase().includes(query.toLowerCase()),
  )

  const openDetail = async (item) => {
    setError('')
    setLoadingDetail(true)
    try {
      if (hasSupabase) {
        setDetail(await fetchTransactionDetail(item.id))
      } else {
        setDetail({
          ...item,
          lines: (item.itemsList || []).map((line, index) => ({
            id: `${item.id}-${index}`,
            name: line.name,
            sku: '',
            pricingMode: line.pricingMode,
            quantity: line.pricingMode === 'kg' ? line.weight : line.quantity,
            unitPrice: line.price,
            lineTotal: line.price * (line.pricingMode === 'kg' ? line.weight : line.quantity),
          })),
        })
      }
    } catch (err) {
      setError(err.message || 'Could not load transaction')
    } finally {
      setLoadingDetail(false)
    }
  }

  return (
    <div>
      <PageHeader eyebrow="AUDIT TRAIL" title="Transactions">
        <span className="text-xs text-[#797e7b]">{transactions.length} orders</span>
      </PageHeader>
      {error && <p className="mb-3 text-xs text-brand-danger">{error}</p>}
      <div className="mb-[18px]">
        <SearchBox
          className="w-full max-w-[330px]"
          icon={<FiSearch />}
          placeholder="Search order or cashier"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <TableCard>
        <div className="grid grid-cols-[1.2fr_1.4fr_1.3fr_0.6fr_0.9fr_0.8fr_0.6fr] gap-3 border-0 bg-[#f7f7f4] px-5 py-[17px] text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase max-[700px]:grid-cols-[1.3fr_0.8fr_0.8fr]">
          <span>Order</span>
          <span>Time</span>
          <span>Cashier</span>
          <span className="text-right tabular-nums max-[700px]:hidden">Items</span>
          <span className="text-right tabular-nums max-[700px]:hidden">Total</span>
          <span className="text-center max-[700px]:hidden">Status</span>
          <span className="max-[700px]:hidden">Action</span>
        </div>
        {list.map((item) => (
          <div
            key={item.id}
            role="button"
            tabIndex={0}
            className="grid cursor-pointer grid-cols-[1.2fr_1.4fr_1.3fr_0.6fr_0.9fr_0.8fr_0.6fr] items-center gap-3 border-t border-brand-softline px-5 py-[17px] text-xs text-brand-slate hover:bg-[#fafaf7] max-[700px]:grid-cols-[1.3fr_0.8fr_0.8fr]"
            onClick={() => openDetail(item)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') openDetail(item)
            }}
          >
            <strong className="text-brand-ink">{item.id.slice(0, 8)}</strong>
            <span>{item.time}</span>
            <span>{item.cashier}</span>
            <span className="text-right tabular-nums max-[700px]:hidden">{Number(item.items).toFixed(0)}</span>
            <strong className="text-right tabular-nums text-brand-ink max-[700px]:hidden">{money(item.total)}</strong>
            <span className="justify-self-center max-[700px]:hidden">
              <span
                className={`inline-block min-w-[62px] rounded-[20px] px-2 py-[5px] text-center text-[10px] ${
                  item.status === 'Voided'
                    ? 'bg-brand-danger-bg text-brand-danger'
                    : 'bg-brand-success-bg text-brand-success-text'
                }`}
              >
                {item.status}
              </span>
            </span>
            <button
              type="button"
              className="border-0 bg-transparent text-[11px] text-brand-danger-soft disabled:text-[#b8bcba] max-[700px]:hidden"
              disabled={item.status === 'Voided'}
              onClick={(event) => {
                event.stopPropagation()
                setVoiding(item)
              }}
            >
              Void
            </button>
          </div>
        ))}
      </TableCard>

      {(detail || loadingDetail) && (
        <Modal wide onClose={() => setDetail(null)}>
          {loadingDetail || !detail ? (
            <p className="text-xs text-brand-subtle">Loading…</p>
          ) : (
            <>
              <Eyebrow>TRANSACTION DETAIL</Eyebrow>
              <h2 className="mb-1 text-[22px]">{detail.id.slice(0, 8)}</h2>
              <p className="m-0 text-xs text-brand-muted">
                {detail.time} · {detail.cashier} · {detail.status}
              </p>
              <div className="mt-4 max-h-[240px] overflow-auto rounded-md border border-brand-softline">
                <div className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr] gap-2 bg-[#f7f7f4] px-3 py-2 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase">
                  <span>Item</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Price</span>
                  <span className="text-right">Total</span>
                </div>
                {detail.lines.map((line) => (
                  <div key={line.id} className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr] gap-2 border-t border-brand-softline px-3 py-2.5 text-xs">
                    <div>
                      <strong className="block text-brand-ink">{line.name}</strong>
                      {line.sku && <small className="text-[10px] text-brand-subtle">{line.sku}</small>}
                    </div>
                    <span className="text-right tabular-nums">
                      {qty(line.quantity, line.pricingMode === 'kg' ? 'kg' : 'pc')}
                    </span>
                    <span className="text-right tabular-nums">{money(line.unitPrice)}</span>
                    <strong className="text-right tabular-nums">{money(line.lineTotal)}</strong>
                  </div>
                ))}
                {detail.lines.length === 0 && (
                  <div className="px-3 py-4 text-xs text-brand-subtle">No line items found.</div>
                )}
              </div>
              <div className="mt-3 grid gap-1 text-xs">
                <div className="flex justify-between"><span>Total</span><strong>{money(detail.total)}</strong></div>
                {detail.tendered != null && (
                  <div className="flex justify-between"><span>Cash tendered</span><strong>{money(detail.tendered)}</strong></div>
                )}
                {detail.change != null && (
                  <div className="flex justify-between"><span>Change</span><strong>{money(detail.change)}</strong></div>
                )}
              </div>
              <ModalActions>
                <SecondaryButton compact type="button" onClick={() => setDetail(null)}>Close</SecondaryButton>
                {detail.status !== 'Voided' && (
                  <PrimaryButton
                    compact
                    type="button"
                    onClick={() => {
                      setVoiding(detail)
                      setDetail(null)
                    }}
                  >
                    Void
                  </PrimaryButton>
                )}
              </ModalActions>
            </>
          )}
        </Modal>
      )}

      {voiding && (
        <Modal onClose={() => setVoiding(null)}>
          <Eyebrow>VOID TRANSACTION</Eyebrow>
          <h2 className="mb-[5px] text-[22px]">{voiding.id.slice(0, 8)}</h2>
          <p className="text-[13px] text-brand-muted">Choose a reason for this void.</p>
          <div className="mt-5 grid gap-2">
            {['Wrong item', 'Customer changed mind', 'Damaged', 'Other'].map((reason) => (
              <button
                key={reason}
                type="button"
                className="rounded-[5px] border border-brand-border bg-[#f8f8f5] p-[11px] text-left text-[#4d534f]"
                onClick={() => {
                  voidTransaction(voiding.id, reason)
                  setVoiding(null)
                }}
              >
                {reason}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}

export default Transactions
