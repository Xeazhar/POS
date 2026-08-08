import { Eyebrow, Modal, ModalActions, PageSkeleton, PrimaryButton, SecondaryButton, moneyClass } from '../ui'
import { money, qty } from '../../utils/format'

function TransactionDetailModal({
  detail,
  loading,
  onClose,
  onRefund,
  onPrint,
  refundSummary = null,
  layer = false,
}) {
  const qtyByItem = refundSummary?.qtyByItem || {}
  const amountByItem = refundSummary?.amountByItem || {}
  const refundTotal = Number(
    refundSummary?.totalAmount ?? detail?.refundedAmount ?? 0,
  )
  const originalTotal = Number(detail?.total || 0)
  const netTotal =
    detail?.netTotal != null && !refundSummary
      ? Number(detail.netTotal)
      : Math.max(0, Number((originalTotal - refundTotal).toFixed(2)))
  const hasRefunds = refundTotal > 0
  const refundLines = refundSummary?.lines || []

  return (
    <Modal wide layer={layer} onClose={onClose}>
      {loading || !detail ? (
        <PageSkeleton variant="detail" />
      ) : (
        <>
          <Eyebrow>TRANSACTION DETAIL</Eyebrow>
          <h2 className="mb-1 text-[22px]">{detail.orNumber || String(detail.id).slice(0, 8)}</h2>
          <p className="m-0 text-xs text-brand-muted">
            {detail.time || detail.date || '—'} · {detail.cashier || 'Staff'} · {detail.status}
            {detail.syncStatus === 'pending' || detail.syncStatus === 'local' ? ' · Pending sync' : ''}
            {hasRefunds && detail.status !== 'Voided' ? ' · Partial refund' : ''}
          </p>
          {detail.voidReason && (
            <p className="mt-1 text-xs text-brand-danger">
              {detail.status === 'Voided' ? 'Full refund' : 'Note'}: {detail.voidReason}
            </p>
          )}
          <div className="mt-4 max-h-[240px] overflow-auto rounded-md border border-brand-softline">
            <div className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr] gap-2 bg-brand-dark px-3 py-2 text-[9px] font-bold tracking-[1px] text-brand-ondark uppercase">
              <span>Item</span>
              <span className="text-right">Qty</span>
              <span className="text-right">Price</span>
              <span className="text-right">Total</span>
            </div>
            {(detail.lines || []).map((line) => {
              const refundedQty = Number(qtyByItem[line.id] || 0)
              const refundedAmt = Number(amountByItem[line.id] || 0)
              const remaining = Math.max(0, Number(line.quantity || 0) - refundedQty)
              const netLine = Math.max(0, Number((Number(line.lineTotal || 0) - refundedAmt).toFixed(2)))
              return (
                <div
                  key={line.id}
                  className="grid grid-cols-[1.4fr_0.6fr_0.7fr_0.7fr] gap-2 border-t border-brand-softline px-3 py-2.5 text-xs"
                >
                  <div>
                    <strong className="block text-brand-ink">{line.name}</strong>
                    {line.sku && <small className="text-[10px] text-brand-subtle">{line.sku}</small>}
                    {Number(line.discountAmount || 0) > 0 && (
                      <small className="block text-[10px] text-brand-danger">
                        {detail.discountType
                          ? `${detail.discountType} −${money(Number(line.discountAmount || 0))}`
                          : `Discounted item −${money(Number(line.discountAmount || 0))}`}
                      </small>
                    )}
                    {refundedQty > 0 && (
                      <small className="block text-[10px] text-brand-danger">
                        Refunded {qty(refundedQty, line.pricingMode === 'kg' ? 'kg' : 'pc')} (−
                        {money(refundedAmt)})
                        {remaining > 0
                          ? ` · left ${qty(remaining, line.pricingMode === 'kg' ? 'kg' : 'pc')}`
                          : ' · fully refunded'}
                      </small>
                    )}
                  </div>
                  <span className={`text-right ${moneyClass}`}>
                    {qty(line.quantity, line.pricingMode === 'kg' ? 'kg' : 'pc')}
                  </span>
                  <span className={`text-right ${moneyClass}`}>{money(line.unitPrice)}</span>
                  <strong className={`text-right ${moneyClass}`}>
                    {refundedAmt > 0 ? money(netLine) : money(line.lineTotal)}
                  </strong>
                </div>
              )
            })}
            {(!detail.lines || detail.lines.length === 0) && (
              <div className="px-3 py-4 text-xs text-brand-subtle">No line items found.</div>
            )}
          </div>

          {hasRefunds && refundLines.length > 0 && (
            <div className="mt-3 rounded-md border border-brand-softline bg-brand-n50 px-3 py-2">
              <p className="m-0 mb-1 text-[10px] font-bold tracking-wide text-brand-label uppercase">
                Refund history
              </p>
              {refundLines.map((row) => (
                <div
                  key={row.id}
                  className="flex justify-between gap-2 border-t border-brand-softline py-1.5 text-[11px] first:border-t-0"
                >
                  <span className="text-brand-muted">
                    {row.productName || 'Item'}
                    {row.quantity ? ` × ${row.quantity}` : ''}
                    {row.created_at
                      ? ` · ${new Date(row.created_at).toLocaleString()}`
                      : ''}
                    {row.reason ? ` · ${row.reason}` : ''}
                  </span>
                  <strong className={`shrink-0 text-brand-danger ${moneyClass}`}>−{money(row.amount)}</strong>
                </div>
              ))}
            </div>
          )}

          <div className={`mt-3 grid gap-1 text-xs ${moneyClass}`}>
            <div className="flex justify-between">
              <span>Payment</span>
              <strong>
                {detail.paymentMethod === 'card'
                  ? 'Card'
                  : detail.paymentMethod === 'ewallet'
                    ? `E-wallet${detail.paymentReference ? ` (${detail.paymentReference})` : ''}`
                    : 'Cash'}
              </strong>
            </div>
            {detail.discountAmount > 0 && (
              <div className="flex justify-between">
                <span>Discount{detail.discountType ? ` (${detail.discountType})` : ''}</span>
                <strong>−{money(detail.discountAmount)}</strong>
              </div>
            )}
            {detail.discountIdNote && (
              <div className="flex justify-between">
                <span>SC/PWD ID No.</span>
                <strong>{detail.discountIdNote}</strong>
              </div>
            )}
            {(detail.vatableSales > 0 || detail.vatExemptSales > 0 || detail.zeroRatedSales > 0) && (
              <div className="mt-1 mb-1 rounded-md bg-brand-n50 px-2.5 py-2 text-[11px]">
                {detail.vatableSales > 0 && (
                  <div className="flex justify-between">
                    <span className="text-brand-subtle">VATable Sales</span>
                    <span>{money(detail.vatableSales)}</span>
                  </div>
                )}
                {detail.vatAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-brand-subtle">VAT (12%)</span>
                    <span>{money(detail.vatAmount)}</span>
                  </div>
                )}
                {detail.vatExemptSales > 0 && (
                  <div className="flex justify-between">
                    <span className="text-brand-subtle">VAT-Exempt Sales (SC/PWD)</span>
                    <span>{money(detail.vatExemptSales)}</span>
                  </div>
                )}
                {detail.zeroRatedSales > 0 && (
                  <div className="flex justify-between">
                    <span className="text-brand-subtle">Zero-Rated Sales</span>
                    <span>{money(detail.zeroRatedSales)}</span>
                  </div>
                )}
                {detail.scPwdDiscount > 0 && (
                  <div className="flex justify-between text-brand-danger">
                    <span>Less: SC/PWD Discount</span>
                    <span>−{money(detail.scPwdDiscount)}</span>
                  </div>
                )}
              </div>
            )}
            <div className="flex justify-between">
              <span>Original total</span>
              <strong>{money(originalTotal)}</strong>
            </div>
            {hasRefunds && (
              <div className="flex justify-between text-brand-danger">
                <span>Refunded</span>
                <strong>−{money(refundTotal)}</strong>
              </div>
            )}
            <div className="flex justify-between border-t border-brand-softline pt-1.5 text-sm">
              <span>Net total</span>
              <strong>{money(netTotal)}</strong>
            </div>
            {detail.tendered != null && (detail.paymentMethod || 'cash') === 'cash' && (
              <div className="flex justify-between">
                <span>Cash tendered</span>
                <strong>{money(detail.tendered)}</strong>
              </div>
            )}
            {detail.change != null && (detail.paymentMethod || 'cash') === 'cash' && (
              <div className="flex justify-between">
                <span>Change given</span>
                <strong>{money(detail.change)}</strong>
              </div>
            )}
            {hasRefunds && (detail.paymentMethod || 'cash') === 'cash' && (
              <div className="flex justify-between text-brand-danger">
                <span>Cash to return (refund)</span>
                <strong>{money(refundTotal)}</strong>
              </div>
            )}
          </div>
          <p className="mt-3 text-[10px] text-brand-subtle">
            Original sale stays on record. Refunds reduce the net total and are logged for audit.
          </p>
          <ModalActions>
            <SecondaryButton compact type="button" onClick={onClose}>
              Close
            </SecondaryButton>
            {onPrint && (
              <SecondaryButton compact type="button" onClick={() => onPrint(detail)}>
                Print receipt
              </SecondaryButton>
            )}
            {onRefund && detail.status !== 'Voided' && (
              <PrimaryButton compact type="button" onClick={() => onRefund(detail)}>
                Refund
              </PrimaryButton>
            )}
          </ModalActions>
        </>
      )}
    </Modal>
  )
}

export default TransactionDetailModal
