import { useState } from 'react'
import { Eyebrow, Field, Modal, PrimaryButton } from '../ui'
import { money } from '../../utils/format'

function WeightModal({ product, close, add }) {
  const [weight, setWeight] = useState('1')

  return (
    <Modal onClose={close}>
      <Eyebrow>WEIGHTED PRODUCT</Eyebrow>
      <h2 className="mb-[5px] text-[22px]">{product.name}</h2>
      <p className="text-[13px] text-brand-muted">{money(product.price)} per kilogram</p>
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
            className="rounded-[5px] border border-brand-border bg-white px-[11px] py-2 text-xs text-[#606662]"
            onClick={() => setWeight(String(value))}
          >
            {value} kg
          </button>
        ))}
      </div>
      <PrimaryButton className="mt-2" onClick={() => add(Number(weight))}>
        Add to cart · {money(product.price * Number(weight))}
      </PrimaryButton>
    </Modal>
  )
}

export default WeightModal
