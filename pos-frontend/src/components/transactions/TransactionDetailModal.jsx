import { Eyebrow, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import { money, qty } from '../../utils/format'

function TransactionDetailModal({ detail, loading, onClose, onVoid }) {
  return (
    <Modal wide onClose={onClose}>
      {loading || !detail ? (
        <p className="text-xs text-brand-subtle">Loading…</p>
      ) : (
        <>
          <Eyebrow>TRANSACTION DETAIL</Eyebrow>
          <h2 className="mb-1 text-[22px]">{String(detail.id).slice(0, 8)}</h2>
          <p className="m-0 text-xs text-brand-muted">
            {detail.time || detail.date || '—'} · {detail.cashier || 'Staff'} · {detail.status}
            {detail.syncStatus === 'pending' || detail.syncStatus === 'local' ? ' · Pending sync' : ''}
          </p>
          <div className="mt-4 max-h-[240px] overflow-auto rounded-md border border-brand-softline">
            <div className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr] gap-2 bg-[#f7f7f4] px-3 py-2 text-[9px] font-bold tracking-[1px] text-[#989e99] uppercase">
              <span>Item</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Price</span>
              <span className="text-right">Total</span>
            </div>
            {(detail.lines || []).map((line) => (
              <div
                key={line.id}
                className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr] gap-2 border-t border-brand-softline px-3 py-2.5 text-xs"
              >
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
            {(!detail.lines || detail.lines.length === 0) && (
              <div className="px-3 py-4 text-xs text-brand-subtle">No line items found.</div>
            )}
          </div>
          <div className="mt-3 grid gap-1 text-xs">
            <div className="flex justify-between">
              <span>Total</span>
              <strong>{money(detail.total)}</strong>
            </div>
            {detail.tendered != null && (
              <div className="flex justify-between">
                <span>Cash tendered</span>
                <strong>{money(detail.tendered)}</strong>
              </div>
            )}
            {detail.change != null && (
              <div className="flex justify-between">
                <span>Change</span>
                <strong>{money(detail.change)}</strong>
              </div>
            )}
          </div>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={onClose}>
              Close
            </SecondaryButton>
            {onVoid && detail.status !== 'Voided' && (
              <PrimaryButton compact type="button" onClick={() => onVoid(detail)}>
                Void
              </PrimaryButton>
            )}
          </ModalActions>
        </>
      )}
    </Modal>
  )
}

export default TransactionDetailModal
