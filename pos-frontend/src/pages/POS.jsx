import { useState } from 'react'
import { FiSearch } from 'react-icons/fi'
import Cart from '../components/pos/Cart'
import WeightModal from '../components/pos/WeightModal'
import { PageHeader, SearchBox } from '../components/ui'
import { useCartStore, useProductStore } from '../stores/posStore'
import { money } from '../utils/format'

function POS() {
  const products = useProductStore((state) => state.products)
  const addItem = useCartStore((state) => state.addItem)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [weighted, setWeighted] = useState(null)
  const categories = ['All', ...new Set(products.map((product) => product.category))]
  const visible = products.filter(
    (product) =>
      (category === 'All' || product.category === category) &&
      [product.name, product.sku, product.barcode].some((value) =>
        value.toLowerCase().includes(search.toLowerCase()),
      ),
  )

  const select = (product) => (product.pricingMode === 'kg' ? setWeighted(product) : addItem(product))

  return (
    <div>
      <PageHeader eyebrow="SALES FLOOR" title="New sale">
        <span className="text-xs font-bold text-brand-success">● Till online</span>
      </PageHeader>
      <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-6 max-[1050px]:grid-cols-1 max-[1050px]:gap-4">
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border border-brand-line bg-white p-[18px] max-[700px]:p-3.5 max-[1050px]:min-h-[390px]">
          <div className="mb-3.5 flex min-w-0 flex-col gap-3">
            <SearchBox
              className="w-full min-w-0"
              icon={<FiSearch />}
              autoFocus
              placeholder="Search, scan barcode or enter SKU"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && visible[0]) select(visible[0])
              }}
            />
            <div className="-mx-1 flex gap-[7px] overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
              {categories.map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`shrink-0 rounded-[5px] border px-[11px] py-2 text-xs whitespace-nowrap ${
                    category === item
                      ? 'border-brand-dark bg-brand-dark text-white'
                      : 'border-brand-border bg-white text-[#606662]'
                  }`}
                  onClick={() => setCategory(item)}
                >
                  {item}
                </button>
              ))}
            </div>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(132px,1fr))] content-start gap-2.5 overflow-auto pr-1 max-[700px]:grid-cols-[repeat(auto-fill,minmax(118px,1fr))] max-[1050px]:max-h-[52vh]">
            {visible.map((product) => (
              <button
                key={product.id}
                type="button"
                className="flex min-h-[124px] flex-col items-start rounded-[7px] border border-[#e8e9e3] bg-[#fbfbf9] p-[11px] text-left transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-brand-gold"
                onClick={() => select(product)}
              >
                <div
                  className={`grid h-12 w-12 place-items-center rounded-lg text-[11px] font-bold ${
                    product.category === 'Meat'
                      ? 'bg-brand-meat text-brand-meat-text'
                      : 'bg-brand-success-bg text-brand-success-text'
                  }`}
                >
                  {product.category === 'Meat' ? 'KG' : 'PC'}
                </div>
                <strong className="mt-auto line-clamp-2 text-[13px]">{product.name}</strong>
                <span className="mt-[5px] text-[11px] text-[#808581]">
                  {money(product.price)} / {product.pricingMode === 'kg' ? 'kg' : 'pc'}
                </span>
              </button>
            ))}
            {visible.length === 0 && (
              <p className="col-span-full py-10 text-center text-xs text-brand-subtle">No products match this search.</p>
            )}
          </div>
        </div>
        <Cart />
      </div>
      {weighted && (
        <WeightModal
          product={weighted}
          close={() => setWeighted(null)}
          add={(weight) => {
            addItem(weighted, weight)
            setWeighted(null)
          }}
        />
      )}
    </div>
  )
}

export default POS
