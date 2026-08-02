import { useState } from 'react'
import { useIsTouchUi } from '../../hooks/useIsTouchUi'
import { Eyebrow, Field, Modal, PrimaryButton } from '../ui'
import { money } from '../../utils/format'
import NumPad from './NumPad'

function WeightModal({ product, close, add }) {
  const [weight, setWeight] = useState('1')
  const touchUi = useIsTouchUi()
  const amount = Number(weight) || 0

  return (
    <Modal onClose={close}>
      <Eyebrow>WEIGHTED PRODUCT</Eyebrow>
      <h2 className="mb-[5px] text-[22px]">{product.name}</h2>
      <p className="text-[13px] text-brand-muted">{money(product.price)} per kilogram</p>

      {touchUi ? (
        <>
          <div className="mt-5 mb-3 flex items-end justify-between rounded-[8px] border border-brand-input bg-[#f7f7f4] px-3.5 py-3">
            <span className="text-[11px] font-bold text-[#646a66]">Weight (kg)</span>
            <strong className="font-mono text-[28px] tracking-tight tabular-nums text-brand-ink">
              {weight === '' ? '0' : weight}
            </strong>
          </div>
          <div className="mb-3 flex flex-wrap gap-2">
            {[1, 1.5, 5, 10].map((value) => (
              <button
                type="button"
                key={value}
                className="rounded-[5px] border border-brand-border bg-white px-[11px] py-2 text-xs font-bold text-[#606662] touch-manipulation transition-[transform,background-color,filter] duration-100 hover:bg-[#f4f5f1] active:scale-[0.97] active:bg-[#eceee9]"
                onClick={() => setWeight(String(value))}
              >
                {value} kg
              </button>
            ))}
          </div>
          <NumPad value={weight} onChange={setWeight} allowDecimal maxDecimals={3} className="mb-4" />
        </>
      ) : (
        <>
          <Field
            label="Weight in kg"
            className="mt-6"
            autoFocus
            inputMode="decimal"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
          <div className="my-3 mb-6 flex gap-2">
            {[1, 1.5, 5, 10].map((value) => (
              <button
                type="button"
                key={value}
                className="rounded-[5px] border border-brand-border bg-white px-[11px] py-2 text-xs text-[#606662] transition-[transform,background-color] duration-100 hover:bg-[#f4f5f1] active:scale-[0.97] active:bg-[#eceee9]"
                onClick={() => setWeight(String(value))}
              >
                {value} kg
              </button>
            ))}
          </div>
        </>
      )}

      <PrimaryButton className="mt-2" disabled={amount <= 0} onClick={() => add(amount)}>
        Add to cart · {money(product.price * amount)}
      </PrimaryButton>
    </Modal>
  )
}

export default WeightModal
