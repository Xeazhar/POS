import { Eyebrow, Modal, ModalActions, PrimaryButton, SecondaryButton } from '../ui'
import { money, qty } from '../../utils/format'
import { lineTotal as calcLineTotal } from '../../utils/ulam'

function CashConfirm({ items = [], total, tendered, cancel, confirm, isRestaurant = false }) {
  return (
    <Modal wide onClose={cancel} className="max-[700px]:p-4">
      <Eyebrow>CONFIRM CASH PAYMENT</Eyebrow>
      <h2 className="mb-3 text-[22px] max-[700px]:text-lg">Complete sale?</h2>
      <div className="mb-3 max-h-[180px] overflow-auto rounded-md border border-[#e1e3dd] px-3 py-2">
        {items.map((item, index) => {
          const line = calcLineTotal(item)
          return (
            <div
              className="flex items-start justify-between gap-3 border-t border-[#eceee9] py-2 text-xs first:border-t-0"
              key={`${item.id}-${index}`}
            >
              <div className="min-w-0">
                <strong className="block truncate">{item.name}</strong>
                <small className="mt-[3px] block text-[10px] text-brand-subtle">
                  {item.pricingMode === 'kg'
                    ? `${qty(item.weight, 'kg')} × ${money(item.price)}/kg`
                    : `${qty(item.quantity, 'pc')} × ${money(item.price)}/pc${
                        item.priceTier === 'budget' ? ' · budget' : ''
                      }`}
                </small>
              </div>
              <b className="shrink-0 whitespace-nowrap">{money(line)}</b>
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
