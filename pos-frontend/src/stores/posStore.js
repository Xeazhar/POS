import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as api from '../lib/api'
import { today } from '../utils/format'

const seedProducts = [
  { id: 'beef-rump', branchId: 'demo-main-branch', name: 'Beef Rump Steak', sku: 'BEEF-RUMP', barcode: '480100000001', category: 'Meat', pricingMode: 'kg', price: 18.5, stock: 34.6, lowStockAt: 10, createdAt: today(), updatedAt: today(), lastMovementAt: today() },
  { id: 'chicken-breast', branchId: 'demo-main-branch', name: 'Chicken Breast', sku: 'CHICK-BRST', barcode: '480100000002', category: 'Meat', pricingMode: 'kg', price: 11.9, stock: 18.2, lowStockAt: 8, createdAt: today(), updatedAt: today(), lastMovementAt: today() },
  { id: 'pork-chops', branchId: 'demo-main-branch', name: 'Pork Chops', sku: 'PORK-CHOPS', barcode: '480100000003', category: 'Meat', pricingMode: 'kg', price: 14.75, stock: 7.4, lowStockAt: 8, createdAt: today(), updatedAt: today(), lastMovementAt: today() },
  { id: 'bread', branchId: 'demo-main-branch', name: 'Farmhouse Bread', sku: 'BREAD-001', barcode: '480100000005', category: 'Bakery', pricingMode: 'pc', price: 3.5, stock: 24, lowStockAt: 8, createdAt: today(), updatedAt: today(), lastMovementAt: today() },
  { id: 'eggs', branchId: 'demo-main-branch', name: 'Free Range Eggs', sku: 'EGGS-001', barcode: '480100000006', category: 'Groceries', pricingMode: 'pc', price: 5.2, stock: 18, lowStockAt: 6, createdAt: today(), updatedAt: today(), lastMovementAt: today() },
  { id: 'milk', branchId: 'demo-main-branch', name: 'Fresh Milk 2L', sku: 'MILK-2L', barcode: '480100000007', category: 'Groceries', pricingMode: 'pc', price: 4.1, stock: 9, lowStockAt: 10, createdAt: today(), updatedAt: today(), lastMovementAt: today() },
]

const seedTransactions = [
  { id: 'TX-1048', time: 'Today, 10:42 AM', cashier: 'Alex Morgan', total: 54.25, status: 'Paid', items: 4, date: today() },
  { id: 'TX-1047', time: 'Today, 10:18 AM', cashier: 'Alex Morgan', total: 31.7, status: 'Paid', items: 3, date: today() },
]

const offlineDemo = !api.hasSupabase


export const useAuthStore = create(persist((set, get) => ({
  user: null,
  booting: false,
  error: '',
  login: async (email, password) => {
    set({ error: '', booting: true })
    try {
      if (!api.hasSupabase) {
        const user = {
          id: 'local-staff',
          name: email || 'Demo Cashier',
          role: 'admin',
          branchId: 'demo-main-branch',
          branchName: 'Bayombong Branch #001',
        }
        set({ user, booting: false })
        return user
      }
      const user = await api.signIn(email, password)
      if (!user) throw new Error('No staff profile linked to this account.')
      set({ user, booting: false })
      return user
    } catch (error) {
      set({ error: error.message || 'Login failed', booting: false, user: null })
      throw error
    }
  },
  restoreSession: async () => {
    if (!api.hasSupabase) return get().user
    set({ booting: true })
    try {
      const user = await api.fetchSessionStaff()
      set({ user, booting: false })
      return user
    } catch {
      set({ user: null, booting: false })
      return null
    }
  },
  logout: async () => {
    if (api.hasSupabase) await api.signOut()
    set({ user: null })
  },
}), { name: 'cale-pos-auth-v4', partialize: (state) => ({ user: api.hasSupabase ? null : state.user }) }))

export const useCartStore = create(persist((set, get) => ({
  items: [],
  addItem: (product, quantity = 1) => set((state) => {
    if (product.pricingMode !== 'kg') {
      const matching = state.items.filter((item) => item.id === product.id)
      const otherItems = state.items.filter((item) => item.id !== product.id)
      const currentQuantity = matching.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      return {
        items: [
          ...otherItems,
          {
            id: product.id,
            name: product.name,
            price: product.price,
            pricingMode: product.pricingMode,
            quantity: currentQuantity + quantity,
          },
        ],
      }
    }
    return {
      items: [
        ...state.items,
        {
          id: product.id,
          name: product.name,
          price: product.price,
          pricingMode: product.pricingMode,
          quantity: 1,
          weight: quantity,
        },
      ],
    }
  }),
  removeItem: (index) => set((state) => ({ items: state.items.filter((_, i) => i !== index) })),
  clear: () => set({ items: [] }),
  total: () => get().items.reduce((sum, item) => sum + item.price * (item.pricingMode === 'kg' ? item.weight : item.quantity), 0),
}), { name: 'cale-pos-cart-v4' }))

export const useProductStore = create((set, get) => ({
  products: offlineDemo ? seedProducts : [],
  loading: false,
  setProducts: (products) => set({ products }),
  loadBranch: async (branchId) => {
    if (!api.hasSupabase || !branchId) return
    set({ loading: true })
    const data = await api.bootstrapBranchData(branchId)
    set({ products: data.products, loading: false })
    return data
  },
  addProduct: async (values) => {
    const user = useAuthStore.getState().user
    if (api.hasSupabase && user?.branchId) {
      const product = await api.createProduct({
        branchId: user.branchId,
        staffId: user.id,
        values,
      })
      set((state) => ({ products: [...state.products, product] }))
      return product.id
    }
    const id = `${values.name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}`
    set((state) => ({ products: [...state.products, { ...values, id }] }))
    return id
  },
  updateProduct: async (id, changes) => {
    const user = useAuthStore.getState().user
    const previous = get().products.find((item) => item.id === id)
    if (api.hasSupabase && user?.branchId) {
      const row = await api.updateProductRow(id, { ...previous, ...changes })
      const mapped = api.mapProduct(row, changes.stock ?? previous.stock)
      if (previous && changes.stock != null && Number(changes.stock) !== Number(previous.stock)) {
        await api.setInventoryStock({
          branchId: user.branchId,
          productId: id,
          staffId: user.id,
          stock: Number(changes.stock),
          previousStock: Number(previous.stock),
          productName: mapped.name,
        })
      }
      set((state) => ({
        products: state.products.map((product) => (product.id === id ? mapped : product)),
      }))
      return
    }
    set((state) => ({
      products: state.products.map((product) => (product.id === id ? { ...product, ...changes } : product)),
    }))
  },
  replaceProducts: (products) => set({ products }),
  importInventoryRows: async (rows) => {
    const user = useAuthStore.getState().user
    const current = get().products
    const seen = new Set()
    let created = 0
    let updated = 0
    let skipped = 0

    for (const raw of rows) {
      const name = String(raw.name || '').trim()
      const sku = String(raw.sku || '').trim()
      const barcode = String(raw.barcode || '').replace(/\D/g, '')
      if (!name || !sku || !barcode) {
        skipped += 1
        continue
      }
      const key = `${sku.toLowerCase()}|${barcode}`
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)

      const values = {
        name,
        sku,
        barcode,
        category: raw.category || 'Groceries',
        pricingMode: raw.pricingMode === 'kg' || raw.pricingMode === 'per_kg' ? 'kg' : 'pc',
        price: Number(raw.price || 0),
        stock: Number(raw.stock || 0),
        lowStockAt: Number(raw.lowStockAt || 5),
      }

      const existing = current.find(
        (item) =>
          item.sku.toLowerCase() === sku.toLowerCase() || String(item.barcode) === barcode,
      )

      if (existing) {
        const nextStock = Number((Number(existing.stock) + values.stock).toFixed(2))
        await get().updateProduct(existing.id, {
          ...existing,
          name: values.name,
          price: values.price,
          category: values.category,
          pricingMode: values.pricingMode,
          stock: nextStock,
        })
        updated += 1
      } else {
        await get().addProduct(values)
        created += 1
      }
    }

    if (api.hasSupabase && user?.branchId) {
      const data = await api.bootstrapBranchData(user.branchId)
      set({ products: data.products })
    }

    return { created, updated, skipped }
  },
}))

export const useInventoryStore = create((set, get) => ({
  transactions: offlineDemo ? seedTransactions : [],
  movements: [],
  dayEnds: [],
  hydrate: (data) => set({
    transactions: data.transactions,
    movements: data.movements,
    dayEnds: data.dayEnds,
  }),
  addTransaction: async (payload) => {
    const user = useAuthStore.getState().user
    const items = payload.itemsList || []
    if (api.hasSupabase && user?.branchId) {
      const txn = await api.completeSale({
        branchId: user.branchId,
        staffId: user.id,
        items,
        total: payload.total,
        tendered: payload.tendered,
      })
      const branchData = await api.bootstrapBranchData(user.branchId)
      set({
        transactions: branchData.transactions,
        movements: branchData.movements,
        dayEnds: branchData.dayEnds,
      })
      useProductStore.getState().setProducts(branchData.products)
      return txn
    }
    // Offline: deduct stock + record sale movements
    const productStore = useProductStore.getState()
    const saleMoves = []
    let nextProducts = productStore.products
    for (const item of items) {
      const product = nextProducts.find((row) => row.id === item.id)
      if (!product) continue
      const sold = item.pricingMode === 'kg' ? item.weight : item.quantity
      const stock = Number((Number(product.stock) - sold).toFixed(2))
      nextProducts = nextProducts.map((row) =>
        row.id === item.id ? { ...row, stock, lastMovementAt: today() } : row,
      )
      saleMoves.push({
        id: `${item.id}-${Date.now()}-${sold}`,
        date: today(),
        productId: item.id,
        product: item.name,
        type: 'Sale',
        quantityChange: -sold,
        resultingStock: stock,
      })
    }
    productStore.setProducts(nextProducts)
    set((state) => ({
      transactions: [{ ...payload, itemsList: items }, ...state.transactions],
      movements: [...saleMoves, ...state.movements],
    }))
    return payload
  },
  voidTransaction: async (id, reason) => {
    if (api.hasSupabase) await api.voidSale(id, reason)
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id ? { ...transaction, status: 'Voided', voidReason: reason } : transaction,
      ),
    }))
  },
  addMovement: async (movement) => {
    const user = useAuthStore.getState().user
    if (api.hasSupabase && user?.branchId && movement.action && movement.amount != null) {
      const mapped = await api.adjustStock({
        branchId: user.branchId,
        productId: movement.productId,
        staffId: user.id,
        action: movement.action,
        amount: movement.amount,
        productName: movement.product,
      })
      const branchData = await api.bootstrapBranchData(user.branchId)
      set({ movements: branchData.movements })
      useProductStore.getState().setProducts(branchData.products)
      return mapped
    }
    set((state) => ({
      movements: [{ ...movement, id: `${movement.productId}-${Date.now()}` }, ...state.movements],
    }))
  },
  closeDay: async (entry) => {
    const user = useAuthStore.getState().user
    if (get().dayEnds.some((item) => item.date === entry.date)) return
    if (api.hasSupabase && user?.branchId) {
      await api.closeDayEnd({ branchId: user.branchId, staffId: user.id, entry })
    }
    set((state) => ({
      dayEnds: [{ ...entry, id: `day-${entry.date}`, cashier: user?.name || entry.cashier }, ...state.dayEnds],
    }))
  },
}))
