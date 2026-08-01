import { Eyebrow, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import { money, qty } from '../../utils/format'

function CashConfirm({ items = [], total, tendered, cancel, confirm }) {
  return (
    <Modal wide onClose={cancel}>
      <Eyebrow>CONFIRM CASH PAYMENT</Eyebrow>
      <h2 className="mb-3 text-[22px]">Complete sale?</h2>
      <div className="mb-3 max-h-[180px] overflow-auto rounded-md border border-[#e1e3dd] px-3 py-2">
        {items.map((item, index) => {
          const amount = item.pricingMode === 'kg' ? item.weight : item.quantity
          const lineTotal = item.price * amount
          return (
            <div
              className="flex items-start justify-between gap-3 border-t border-[#eceee9] py-2 text-xs first:border-t-0"
              key={`${item.id}-${index}`}
            >
              <div>
                <strong className="block">{item.name}</strong>
                <small className="mt-[3px] block text-[10px] text-brand-subtle">
                  {item.pricingMode === 'kg'
                    ? `${qty(item.weight, 'kg')} × ${money(item.price)}/kg`
                    : `${qty(item.quantity, 'pc')} × ${money(item.price)}/pc`}
                </small>
              </div>
              <b className="whitespace-nowrap">{money(lineTotal)}</b>
            </div>
          )
        })}
      </div>
      <div className="my-3 grid grid-cols-[1fr_auto] gap-x-[18px] gap-y-2.5 border-y border-[#e1e3dd] py-3.5 text-[13px]">
        <span>Subtotal</span>
        <strong className="text-right">{money(total)}</strong>
        <span>Cash tendered</span>
        <strong className="text-right">{money(tendered)}</strong>
        <span>Change</span>
        <strong className="text-right text-lg text-brand-success">{money(tendered - total)}</strong>
      </div>
      <p className="text-[13px] text-brand-muted">The sale will be recorded and inventory will be updated.</p>
      <ModalActions>
        <SecondaryButton compact type="button" onClick={cancel}>
          Back to cart
        </SecondaryButton>
        <PrimaryButton compact type="button" onClick={confirm}>
          Confirm payment
        </PrimaryButton>
      </ModalActions>
    </Modal>
  )
}

export default CashConfirm
