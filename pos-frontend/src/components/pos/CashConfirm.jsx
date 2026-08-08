import { Eyebrow, Modal, ModalActions, PrimaryButton, SecondaryButton, moneyClass } from '../ui'
import { money, qty } from '../../utils/format'
import { lineTotal as calcLineTotal } from '../../utils/ulam'

const METHOD_LABEL = { cash: 'Cash', card: 'Card', ewallet: 'E-wallet' }

function CashConfirm({
  items = [],
  total,
  tendered,
  paymentMethod = 'cash',
  paymentReference = '',
  discountAmount = 0,
  vatAmount = 0,
  cancel,
  confirm,
  isRestaurant = false,
}) {
  const method = METHOD_LABEL[paymentMethod] || 'Cash'
  return (
    <Modal wide onClose={cancel}>
      <Eyebrow>CONFIRM {method.toUpperCase()} PAYMENT</Eyebrow>
      <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Complete sale?</h2>
      <div className="mb-3 max-h-[180px] overflow-auto rounded-md border border-brand-n300 px-3 py-2">
        {items.map((item, index) => {
          const line = calcLineTotal(item)
          return (
            <div
              className="flex items-start justify-between gap-3 border-t border-brand-n200 py-2 text-xs first:border-t-0"
              key={`${item.id}-${index}`}
            >
              <div className="min-w-0">
                <strong className="block truncate">{item.name}</strong>
                <small className={`mt-[3px] block text-[10px] text-brand-subtle ${moneyClass}`}>
                  {item.pricingMode === 'kg'
                    ? `${qty(item.weight, 'kg')} × ${money(item.price)}/kg`
                    : `${qty(item.quantity, 'pc')} × ${money(item.price)}/pc${
                        item.priceTier === 'budget' ? ' · budget' : ''
                      }`}
                </small>
              </div>
              <b className={`shrink-0 whitespace-nowrap ${moneyClass}`}>{money(line)}</b>
            </div>
          )
        })}
      </div>
      <div className={`my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-brand-n300 py-3.5 text-[13px] ${moneyClass}`}>
        {discountAmount > 0 && (
          <>
            <span>Discount</span>
            <strong className="text-right">−{money(discountAmount)}</strong>
          </>
        )}
        {vatAmount > 0 && (
          <>
            <span>VAT (incl.)</span>
            <strong className="text-right">{money(vatAmount)}</strong>
          </>
        )}
        <span>Total</span>
        <strong className="text-right">{money(total)}</strong>
        <span>Payment</span>
        <strong className="text-right">{method}</strong>
        {paymentMethod === 'ewallet' && paymentReference && (
          <>
            <span>Reference</span>
            <strong className="text-right">{paymentReference}</strong>
          </>
        )}
        {paymentMethod === 'cash' && (
          <>
            <span>Cash tendered</span>
            <strong className="text-right">{money(tendered)}</strong>
            <span>Change</span>
            <strong className="text-right text-lg text-brand-success">{money(tendered - total)}</strong>
          </>
        )}
      </div>
      <p className="text-[13px] text-brand-muted max-[700px]:text-xs">
        {isRestaurant
          ? 'The sale will be recorded (menu sale — no stock deduction).'
          : 'The sale will be recorded and inventory will be updated.'}
      </p>
      <ModalActions>
        <SecondaryButton compact type="button" onClick={cancel}>
          Back
        </SecondaryButton>
        <PrimaryButton compact type="button" onClick={confirm}>
          Confirm
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}

export default CashConfirm
