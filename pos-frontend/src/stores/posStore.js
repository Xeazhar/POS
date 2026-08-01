import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as api from '../lib/api'
import {
  enqueue,
  isOnline,
  newClientId,
  QUEUE_TYPES,
  readBranchSnapshot,
  setSyncBranchId,
  syncBranch,
  upsertLocalSale,
} from '../offline'
import { clearLocalSession, loadLocalSession, saveLocalSession } from '../offline/session'
import { isTillClosed, today } from '../utils/format'
import { useSyncStore } from './syncStore'

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
          dayOpenHour: 7,
        }
        set({ user, booting: false })
        await saveLocalSession(user)
        return user
      }
      if (!isOnline()) {
        const cached = await loadLocalSession()
        if (cached) {
          set({ user: cached, booting: false })
          setSyncBranchId(cached.branchId)
          return cached
        }
        throw new Error('You are offline and no saved session was found. Connect once to sign in.')
      }
      const user = await api.signIn(email, password)
      if (!user) throw new Error('No staff profile linked to this account.')
      set({ user, booting: false })
      await saveLocalSession(user)
      setSyncBranchId(user.branchId)
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
      let user = null
      if (isOnline()) {
        user = await api.fetchSessionStaff()
      }
      if (!user) {
        user = await loadLocalSession()
      } else {
        await saveLocalSession(user)
      }
      set({ user, booting: false })
      if (user?.branchId) setSyncBranchId(user.branchId)
      return user
    } catch {
      const cached = await loadLocalSession()
      set({ user: cached, booting: false })
      if (cached?.branchId) setSyncBranchId(cached.branchId)
      return cached
    }
  },
  logout: async () => {
    if (api.hasSupabase && isOnline()) await api.signOut()
    await clearLocalSession()
    setSyncBranchId(null)
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
    setSyncBranchId(branchId)
    // Serve IndexedDB immediately, then sync in background when online
    let data = await readBranchSnapshot(branchId)
    if (data.products.length) {
      set({ products: data.products, loading: false })
      useInventoryStore.getState().hydrate(data)
    }
    data = (await syncBranch(branchId)) || data
    set({ products: data.products || [], loading: false })
    useSyncStore.getState().refresh(branchId)
    return data
  },
  addProduct: async (values) => {
    const user = useAuthStore.getState().user
    if (api.hasSupabase && user?.branchId) {
      if (isOnline()) {
        const product = await api.createProduct({
          branchId: user.branchId,
          staffId: user.id,
          values,
        })
        set((state) => ({ products: [...state.products, product] }))
        await syncBranch(user.branchId)
        return product.id
      }
      const id = newClientId('prod')
      const product = {
        ...values,
        id,
        branchId: user.branchId,
        createdAt: today(),
        updatedAt: today(),
        lastMovementAt: today(),
      }
      set((state) => ({ products: [...state.products, product] }))
      await enqueue(QUEUE_TYPES.CREATE_PRODUCT, {
        branchId: user.branchId,
        staffId: user.id,
        values,
        localId: id,
      }, { branchId: user.branchId })
      useSyncStore.getState().refresh(user.branchId)
      return id
    }
    const id = `${values.name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}`
    set((state) => ({ products: [...state.products, { ...values, id }] }))
    return id
  },
  updateProduct: async (id, changes) => {
    const user = useAuthStore.getState().user
    const previous = get().products.find((item) => item.id === id)
    if (api.hasSupabase && user?.branchId) {
      const mapped = { ...previous, ...changes }
      const priceChanged =
        previous && changes.price != null && Number(changes.price) !== Number(previous.price)

      set((state) => ({
        products: state.products.map((product) => (product.id === id ? mapped : product)),
      }))

      if (isOnline()) {
        const row = await api.updateProductRow(id, mapped, {
          branchId: user.branchId,
          staffId: user.id,
          previousPrice: previous?.price,
        })
        const next = api.mapProduct(row, changes.stock ?? previous.stock)
        if (previous && changes.stock != null && Number(changes.stock) !== Number(previous.stock)) {
          await api.setInventoryStock({
            branchId: user.branchId,
            productId: id,
            staffId: user.id,
            stock: Number(changes.stock),
            previousStock: Number(previous.stock),
            productName: next.name,
          })
        }
        set((state) => ({
          products: state.products.map((product) => (product.id === id ? next : product)),
        }))
        await syncBranch(user.branchId)
        return
      }

      if (priceChanged) {
        const priceMove = {
          id: newClientId('move'),
          date: today(),
          createdAt: new Date().toISOString(),
          productId: id,
          product: mapped.name,
          type: 'Price change',
          movementType: 'price_change',
          quantityChange: 0,
          resultingStock: Number(mapped.stock ?? previous.stock),
          oldPrice: Number(previous.price),
          newPrice: Number(changes.price),
          detail: mapped.name,
          branchId: user.branchId,
          syncStatus: 'pending',
        }
        useInventoryStore.setState((state) => ({
          movements: [priceMove, ...state.movements],
        }))
      }

      const inventory =
        previous && changes.stock != null && Number(changes.stock) !== Number(previous.stock)
          ? {
              branchId: user.branchId,
              productId: id,
              staffId: user.id,
              stock: Number(changes.stock),
              previousStock: Number(previous.stock),
              productName: mapped.name,
            }
          : null
      await enqueue(
        QUEUE_TYPES.UPDATE_PRODUCT,
        {
          id,
          values: mapped,
          inventory,
          previousPrice: previous?.price,
          branchId: user.branchId,
          staffId: user.id,
        },
        { branchId: user.branchId },
      )
      useSyncStore.getState().refresh(user.branchId)
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
      const data = await syncBranch(user.branchId)
      if (data) set({ products: data.products })
    }

    return { created, updated, skipped }
  },
}))

export const useInventoryStore = create((set, get) => ({
  transactions: offlineDemo ? seedTransactions : [],
  movements: [],
  dayEnds: [],
  dayOpenHour: 7,
  hydrate: (data) => set({
    transactions: data.transactions,
    movements: data.movements,
    dayEnds: data.dayEnds,
    dayOpenHour: Number(data.dayOpenHour ?? 7),
  }),
  addTransaction: async (payload) => {
    const user = useAuthStore.getState().user
    const items = payload.itemsList || []
    if (isTillClosed(get().dayEnds, get().dayOpenHour)) {
      throw new Error('Till is closed for this business day. Ask a manager to reopen.')
    }

    // Local-first: apply sale to IndexedDB + memory, then queue / sync
    const productStore = useProductStore.getState()
    const saleMoves = []
    let nextProducts = productStore.products
    const bizDate = today(get().dayOpenHour)
    const localId = payload.id || newClientId('txn')

    for (const item of items) {
      const product = nextProducts.find((row) => row.id === item.id)
      if (!product) continue
      const sold = item.pricingMode === 'kg' ? item.weight : item.quantity
      const stock = Number((Number(product.stock) - sold).toFixed(2))
      nextProducts = nextProducts.map((row) =>
        row.id === item.id ? { ...row, stock, lastMovementAt: bizDate } : row,
      )
      saleMoves.push({
        id: newClientId('move'),
        date: bizDate,
        createdAt: new Date().toISOString(),
        productId: item.id,
        product: item.name,
        type: 'Sale',
        quantityChange: -sold,
        resultingStock: stock,
        branchId: user?.branchId,
        syncStatus: 'pending',
      })
    }

    const localTxn = {
      ...payload,
      id: localId,
      itemsList: items,
      date: payload.date || bizDate,
      branchId: user?.branchId,
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
      cashier: user?.name || payload.cashier || 'Staff',
    }

    productStore.setProducts(nextProducts)
    set((state) => ({
      transactions: [localTxn, ...state.transactions],
      movements: [...saleMoves, ...state.movements],
    }))

    if (api.hasSupabase && user?.branchId) {
      await upsertLocalSale({
        transaction: localTxn,
        movements: saleMoves,
        products: nextProducts.filter((p) => items.some((i) => i.id === p.id)),
      })
      await enqueue(
        QUEUE_TYPES.COMPLETE_SALE,
        {
          branchId: user.branchId,
          staffId: user.id,
          items,
          total: payload.total,
          tendered: payload.tendered,
          localTransactionId: localId,
        },
        { branchId: user.branchId, clientId: localId },
      )
      useSyncStore.getState().refresh(user.branchId)
      if (isOnline()) {
        const data = await syncBranch(user.branchId)
        if (data) {
          set({
            transactions: data.transactions,
            movements: data.movements,
            dayEnds: data.dayEnds,
            dayOpenHour: Number(data.dayOpenHour ?? 7),
          })
          useProductStore.getState().setProducts(data.products)
        }
      }
      return localTxn
    }

    return localTxn
  },
  voidTransaction: async (id, reason) => {
    const user = useAuthStore.getState().user
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id ? { ...transaction, status: 'Voided', voidReason: reason } : transaction,
      ),
    }))
    if (api.hasSupabase && user?.branchId) {
      if (isOnline() && !String(id).startsWith('txn_') && !String(id).startsWith('op_')) {
        await api.voidSale(id, reason)
      } else {
        await enqueue(QUEUE_TYPES.VOID_SALE, { id, reason }, { branchId: user.branchId })
      }
      useSyncStore.getState().refresh(user.branchId)
      if (isOnline()) await syncBranch(user.branchId)
    }
  },
  addMovement: async (movement) => {
    const user = useAuthStore.getState().user
    if (api.hasSupabase && user?.branchId && movement.action && movement.amount != null) {
      if (isOnline()) {
        const mapped = await api.adjustStock({
          branchId: user.branchId,
          productId: movement.productId,
          staffId: user.id,
          action: movement.action,
          amount: movement.amount,
          productName: movement.product,
        })
        const data = await syncBranch(user.branchId)
        if (data) {
          set({ movements: data.movements })
          useProductStore.getState().setProducts(data.products)
        }
        return mapped
      }
      // Offline adjust: update local stock + queue
      const productStore = useProductStore.getState()
      const product = productStore.products.find((p) => p.id === movement.productId)
      if (product) {
        const delta = movement.action === 'restock' ? Number(movement.amount) : -Number(movement.amount)
        const stock = Number((Number(product.stock) + delta).toFixed(2))
        productStore.setProducts(
          productStore.products.map((p) => (p.id === movement.productId ? { ...p, stock } : p)),
        )
        const localMove = {
          ...movement,
          id: newClientId('move'),
          quantityChange: delta,
          resultingStock: stock,
          branchId: user.branchId,
          syncStatus: 'pending',
          createdAt: new Date().toISOString(),
        }
        set((state) => ({ movements: [localMove, ...state.movements] }))
        await enqueue(
          QUEUE_TYPES.ADJUST_STOCK,
          {
            branchId: user.branchId,
            productId: movement.productId,
            staffId: user.id,
            action: movement.action,
            amount: movement.amount,
            productName: movement.product,
          },
          { branchId: user.branchId },
        )
        useSyncStore.getState().refresh(user.branchId)
        return localMove
      }
    }
    set((state) => ({
      movements: [{ ...movement, id: `${movement.productId}-${Date.now()}` }, ...state.movements],
    }))
  },
  closeDay: async (entry) => {
    const user = useAuthStore.getState().user
    const existing = get().dayEnds.find((item) => item.date === entry.date)
    if (existing?.status === 'closed') return existing

    const mapped = {
      ...entry,
      id: existing?.id || newClientId('day'),
      status: 'closed',
      cashier: user?.name || entry.cashier,
      reopenedAt: null,
      branchId: user?.branchId,
      syncStatus: api.hasSupabase ? 'pending' : 'local',
    }
    set((state) => ({
      dayEnds: [mapped, ...state.dayEnds.filter((item) => item.date !== entry.date)],
    }))

    if (api.hasSupabase && user?.branchId) {
      if (isOnline()) {
        const row = await api.closeDayEnd({
          branchId: user.branchId,
          staffId: user.id,
          entry: { ...entry, id: existing?.id },
        })
        const remote = {
          id: row.id,
          date: row.business_date,
          recordedCash: Number(row.recorded_cash),
          cashOnHand: Number(row.cash_on_hand),
          variance: Number(row.variance),
          note: row.note || '',
          status: row.status || 'closed',
          cashier: row.staff?.full_name || user?.name || entry.cashier,
          closedAt: new Date(row.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          reopenedAt: null,
          branchId: user.branchId,
          syncStatus: 'synced',
        }
        set((state) => ({
          dayEnds: [remote, ...state.dayEnds.filter((item) => item.id !== remote.id && item.date !== remote.date)],
        }))
        return remote
      }
      await enqueue(
        QUEUE_TYPES.CLOSE_DAY,
        {
          branchId: user.branchId,
          staffId: user.id,
          entry: { ...entry, id: existing?.id, localId: mapped.id },
        },
        { branchId: user.branchId },
      )
      useSyncStore.getState().refresh(user.branchId)
    }
    return mapped
  },
  reopenDay: async (id) => {
    const user = useAuthStore.getState().user
    set((state) => ({
      dayEnds: state.dayEnds.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'reopened',
              reopenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }
          : item,
      ),
    }))
    if (api.hasSupabase && user) {
      if (isOnline()) {
        const row = await api.reopenDayEnd({ id, staffId: user.id })
        const mapped = {
          id: row.id,
          date: row.business_date,
          recordedCash: Number(row.recorded_cash),
          cashOnHand: Number(row.cash_on_hand),
          variance: Number(row.variance),
          note: row.note || '',
          status: 'reopened',
          cashier: row.staff?.full_name || '',
          closedAt: new Date(row.closed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          reopenedAt: row.reopened_at
            ? new Date(row.reopened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : null,
        }
        set((state) => ({
          dayEnds: state.dayEnds.map((item) => (item.id === id ? mapped : item)),
        }))
        return mapped
      }
      await enqueue(QUEUE_TYPES.REOPEN_DAY, { id, staffId: user.id }, { branchId: user.branchId })
      useSyncStore.getState().refresh(user.branchId)
    }
  },
}))
