import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FiTrash2 } from 'react-icons/fi'
import { Eyebrow, PrimaryButton } from '../ui'
import { useCartStore, useInventoryStore } from '../../stores/posStore'
import { money, qty, today } from '../../utils/format'
import CashConfirm from './CashConfirm'

function Cart() {
  const { items, removeItem, clear, total } = useCartStore()
  const addTransaction = useInventoryStore((state) => state.addTransaction)
  const [tendered, setTendered] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const subtotal = total()

  const complete = async () => {
    setError('')
    try {
      await addTransaction({
        id: `TX-${items.length}-${Math.round(subtotal * 100)}`,
        time: 'Just now',
        cashier: 'Staff',
        total: subtotal,
        tendered: Number(tendered),
        status: 'Paid',
        items: items.length,
        itemsList: items,
        date: today(),
      })
      clear()
      setTendered('')
      setConfirming(false)
      navigate('/transactions')
    } catch (err) {
      setError(err.message || 'Sale failed — stock was not updated.')
      setConfirming(false)
    }
  }

  const groups = items.reduce((result, item, index) => {
    if (!result[item.id]) result[item.id] = []
    result[item.id].push({ item, index })
    return result
  }, {})

  return (
    <>
      {confirming && (
        <CashConfirm
          items={items}
          total={subtotal}
          tendered={Number(tendered)}
          cancel={() => setConfirming(false)}
          confirm={complete}
        />
      )}
      <section className="flex h-[calc(100vh-150px)] min-h-0 min-w-0 flex-col rounded-[10px] border border-brand-line bg-brand-panel p-[18px] text-white max-[1050px]:h-auto max-[1050px]:min-h-[390px] max-[700px]:p-3.5">
        <div className="flex items-start justify-between border-b border-brand-cart-line pb-5">
          <div>
            <Eyebrow className="text-[#a8aeaa]">CURRENT SALE</Eyebrow>
            <h2 className="m-0 text-lg capitalize">Receipt / cart</h2>
          </div>
          <span className="text-xs text-[#797e7b]">{items.length} items</span>
        </div>
        {error && <p className="mt-2 text-xs text-[#ffb4b4]">{error}</p>}
        <div className="min-h-0 flex-1 overflow-auto max-[1050px]:min-h-[170px]">
          {items.length ? (
            Object.values(groups).flatMap((group) => [
              <div
                className="border-b border-brand-cart-row pt-3 pb-[3px] text-[10px] font-bold tracking-[0.5px] text-brand-gold"
                key={`${group[0].item.id}-group`}
              >
                {group[0].item.name}
              </div>,
              ...group.map(({ item, index }) => (
                <div
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-2 border-b border-brand-cart-row py-3.5"
                  key={`${item.id}-${index}`}
                >
                  <div>
                    <strong className="block text-xs">
                      {item.pricingMode === 'kg'
                        ? 'Weigh-in'
                        : `${item.name} × ${Number(item.quantity).toFixed(0)} pc`}
                    </strong>
                    <small className="mt-1 block text-[10px] text-brand-cart-muted">
                      {item.pricingMode === 'kg'
                        ? `${qty(item.weight, 'kg')} × ${money(item.price)}/kg`
                        : `${money(item.price)}/pc`}
                    </small>
                  </div>
                  <b className="text-xs">
                    {money(item.price * (item.pricingMode === 'kg' ? item.weight : item.quantity))}
                  </b>
                  <button type="button" className="border-0 bg-transparent text-brand-cart-muted" onClick={() => removeItem(index)}>
                    <FiTrash2 />
                  </button>
                </div>
              )),
            ])
          ) : (
            <div className="mt-[150px] text-center text-[13px] leading-[1.8] text-[#bbc0bd]">
              Your cart is ready.
              <br />
              <span className="text-[11px] text-[#7f8782]">Select a product to begin.</span>
            </div>
          )}
        </div>
        <div className="border-t border-brand-cart-line pt-[18px]">
          <div className="mb-[15px] flex justify-between text-[13px]">
            <span>Subtotal</span>
            <strong>{money(subtotal)}</strong>
          </div>
          <label className="mb-3.5 flex items-center justify-between text-xs text-[#aab0ac]">
            Cash tendered
            <input
              className="w-[100px] rounded border border-brand-cart-border bg-brand-cart-input p-2 text-right text-white outline-none"
              value={tendered}
              onChange={(event) => setTendered(event.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))}
              inputMode="decimal"
              placeholder="0.00"
            />
          </label>
          <div className="mb-[15px] flex justify-between text-[13px] text-brand-gold">
            <span>Change</span>
            <strong>{money(Math.max(0, Number(tendered || 0) - subtotal))}</strong>
          </div>
          <PrimaryButton
            disabled={!items.length || Number(tendered) < subtotal}
            onClick={() => setConfirming(true)}
          >
            Pay cash <span>→</span>
          </PrimaryButton>
        </div>
      </section>
    </>
  )
}

export default Cart
