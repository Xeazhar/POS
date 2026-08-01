import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const seedProducts = [
  { id: 'beef-rump', name: 'Beef Rump Steak', sku: 'BEEF-RUMP', barcode: '480100000001', category: 'Meat', pricingMode: 'kg', price: 18.5, stock: 34.6, lowStockAt: 10, initialWeight: 42 },
  { id: 'chicken-breast', name: 'Chicken Breast', sku: 'CHICK-BRST', barcode: '480100000002', category: 'Meat', pricingMode: 'kg', price: 11.9, stock: 18.2, lowStockAt: 8, initialWeight: 25 },
  { id: 'pork-chops', name: 'Pork Chops', sku: 'PORK-CHOPS', barcode: '480100000003', category: 'Meat', pricingMode: 'kg', price: 14.75, stock: 7.4, lowStockAt: 8, initialWeight: 12 },
  { id: 'lamb-mince', name: 'Lamb Mince', sku: 'LAMB-MINCE', barcode: '480100000004', category: 'Meat', pricingMode: 'kg', price: 16.2, stock: 11.8, lowStockAt: 6, initialWeight: 15 },
  { id: 'bread', name: 'Farmhouse Bread', sku: 'BREAD-001', barcode: '480100000005', category: 'Bakery', pricingMode: 'unit', price: 3.5, stock: 24, lowStockAt: 8 },
  { id: 'eggs', name: 'Free Range Eggs', sku: 'EGGS-001', barcode: '480100000006', category: 'Groceries', pricingMode: 'unit', price: 5.2, stock: 18, lowStockAt: 6 },
  { id: 'milk', name: 'Fresh Milk 2L', sku: 'MILK-2L', barcode: '480100000007', category: 'Groceries', pricingMode: 'unit', price: 4.1, stock: 9, lowStockAt: 10 },
  { id: 'sauce', name: 'BBQ Sauce', sku: 'SAUCE-BBQ', barcode: '480100000008', category: 'Groceries', pricingMode: 'unit', price: 6.8, stock: 31, lowStockAt: 8 },
]

const demoBranch = { branchId: 'demo-main-branch', branchName: 'Bayombong Branch #001' }

const seedTransactions = [
  { id: 'TX-1048', time: 'Today, 10:42 AM', cashier: 'Alex Morgan', total: 54.25, status: 'Paid', items: 4, date: '2026-08-01' },
  { id: 'TX-1047', time: 'Today, 10:18 AM', cashier: 'Alex Morgan', total: 31.7, status: 'Paid', items: 3, date: '2026-08-01' },
  { id: 'TX-1046', time: 'Yesterday, 4:06 PM', cashier: 'Sam Lee', total: 87.1, status: 'Paid', items: 7, date: '2026-07-31' },
]

const seedMovements = seedProducts.flatMap((product) => [
  { id: `${product.id}-restock`, date: '2026-07-01', productId: product.id, product: product.name, type: 'Restock', quantityChange: product.initialWeight || product.stock, resultingStock: product.initialWeight || product.stock },
  ...(product.initialWeight ? [{ id: `${product.id}-shrink`, date: '2026-08-01', productId: product.id, product: product.name, type: 'Shrinkage', quantityChange: -(product.initialWeight - product.stock), resultingStock: product.stock }] : []),
])

export const useAuthStore = create(persist((set) => ({
  user: null,
  login: (username) => set({ user: { name: username || 'Cashier', role: 'Staff', ...demoBranch } }),
  setBranch: (branch) => set((state) => ({ user: state.user ? { ...state.user, ...branch } : state.user })),
  ensureBranch: () => set((state) => ({ user: state.user && !state.user.branchName ? { ...state.user, ...demoBranch } : state.user })),
  logout: () => set({ user: null }),
}), { name: 'cale-pos-auth' }))

export const useCartStore = create(persist((set, get) => ({
  items: [],
  addItem: (product, quantity = 1) => set((state) => {
    if (product.pricingMode === 'unit') {
      const matching = state.items.filter((item) => item.id === product.id)
      const otherItems = state.items.filter((item) => item.id !== product.id)
      const currentQuantity = matching.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      return { items: [...otherItems, { id: product.id, name: product.name, price: product.price, pricingMode: product.pricingMode, quantity: currentQuantity + quantity }] }
    }
    return { items: [...state.items, { id: product.id, name: product.name, price: product.price, pricingMode: product.pricingMode, quantity: product.pricingMode === 'kg' ? 1 : quantity, weight: product.pricingMode === 'kg' ? quantity : undefined }] }
  }),
  removeItem: (index) => set((state) => ({ items: state.items.filter((_, itemIndex) => itemIndex !== index) })),
  clear: () => set({ items: [] }),
  total: () => get().items.reduce((sum, item) => sum + item.price * (item.pricingMode === 'kg' ? item.weight : item.quantity), 0),
}), { name: 'cale-pos-cart' }))

export const useProductStore = create((set) => ({
  products: seedProducts,
  addProduct: (product) => set((state) => ({ products: [...state.products, { ...product, id: `${product.name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}` }] })),
  updateProduct: (id, changes) => set((state) => ({ products: state.products.map((product) => product.id === id ? { ...product, ...changes } : product) })),
  replaceProducts: (products) => set({ products }),
}))

export const useInventoryStore = create(persist((set) => ({
  transactions: seedTransactions,
  movements: seedMovements,
  addTransaction: (transaction) => set((state) => ({ transactions: [transaction, ...state.transactions] })),
  voidTransaction: (id, reason) => set((state) => ({ transactions: state.transactions.map((transaction) => transaction.id === id ? { ...transaction, status: 'Voided', voidReason: reason } : transaction) })),
  addMovement: (movement) => set((state) => ({ movements: [{ ...movement, id: `${movement.productId}-${Date.now()}` }, ...state.movements] })),
}), { name: 'cale-pos-inventory' }))