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
import { clearLocalSession, clearRequireFreshLogin, loadLocalSession, markRequireFreshLogin, needsFreshLogin, saveLocalSession } from '../offline/session'
import { appError } from '../utils/errors'
import { isTillClosed, today } from '../utils/format'
import { detectUlamCombo, effectiveUnitPrice, hasBudgetTier, lineTotal, normalizeMenuKind } from '../utils/ulam'
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
  pendingClockIn: false,
  login: async (emailOrCode, passwordOrPin, { mode = 'email', captchaToken } = {}) => {
    set({ error: '', booting: true })
    try {
      if (!api.hasSupabase) {
        if (!api.allowDemoMode) {
          throw appError('AUTH05')
        }
        const user = {
          id: 'local-staff',
          name: emailOrCode || 'Demo Cashier',
          role: mode === 'pin' ? 'cashier' : 'admin',
          branchId: 'demo-main-branch',
          branchName: 'Bayombong Branch #001',
          branchType: 'retail',
          dayOpenHour: 7,
          deviceSettings: {
            barcode_scanner: false,
            receipt_printer: false,
            cash_drawer: false,
          },
          permissions: null,
          vatRate: 0.12,
        }
        set({ user, booting: false })
        useCartStore.getState().clear()
        await clearRequireFreshLogin()
        await saveLocalSession(user)
        return user
      }
      if (!isOnline()) {
        if (await needsFreshLogin()) {
          throw appError('AUTH04')
        }
        const cached = await loadLocalSession()
        if (cached) {
          useCartStore.getState().clear()
          set({ user: cached, booting: false })
          setSyncBranchId(cached.branchId)
          return cached
        }
        throw appError('AUTH03')
      }
      const user =
        mode === 'pin'
          ? await api.signInWithPin(emailOrCode, passwordOrPin, { captchaToken })
          : await api.signIn(emailOrCode, passwordOrPin, { captchaToken })
      if (!user) throw appError('AUTH02')
      useCartStore.getState().clear()
      set({ user, booting: false })
      await clearRequireFreshLogin()
      await saveLocalSession(user)
      setSyncBranchId(user.branchId)
      api.logAuditEvent({
        branchId: user.branchId,
        staffId: user.id,
        eventType: 'login',
        detail: `Signed in as ${user.name}`,
        meta: { role: user.role, branchType: user.branchType, mode },
      })
      return user
    } catch (error) {
      set({ error: error?.message || String(error), booting: false, user: null })
      throw error
    }
  },
  restoreSession: async () => {
    if (!api.hasSupabase) return get().user
    set({ booting: true })
    try {
      if (await needsFreshLogin()) {
        if (isOnline()) await api.signOut().catch(() => {})
        await clearLocalSession()
        set({ user: null, booting: false })
        return null
      }
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
      if (await needsFreshLogin()) {
        set({ user: null, booting: false })
        return null
      }
      const cached = await loadLocalSession()
      set({ user: cached, booting: false })
      if (cached?.branchId) setSyncBranchId(cached.branchId)
      return cached
    }
  },
  /** Secure lockout after day-end — clears session so next open needs password. */
  lockAfterDayEnd: async () => {
    const user = get().user
    useCartStore.getState().clear()
    if (api.hasSupabase && user) {
      api.logAuditEvent({
        branchId: user.branchId,
        staffId: user.id,
        eventType: 'day_end_lock',
        detail: 'Day closed — session locked until next login',
      })
    }
    await markRequireFreshLogin()
    if (api.hasSupabase && isOnline()) await api.signOut().catch(() => {})
    await clearLocalSession()
    setSyncBranchId(null)
    set({ user: null, pendingClockIn: false })
  },
  logout: async () => {
    const user = get().user
    useCartStore.getState().clear()
    if (api.hasSupabase && user) {
      api.logAuditEvent({
        branchId: user.branchId,
        staffId: user.id,
        eventType: 'logout',
        detail: `Signed out ${user.name}`,
      })
    }
    if (api.hasSupabase && isOnline()) await api.signOut()
    await clearLocalSession()
    setSyncBranchId(null)
    set({ user: null, pendingClockIn: false })
  },
}), { name: 'cale-pos-auth-v4', partialize: (state) => ({ user: api.hasSupabase ? null : state.user }) }))

export const useCartStore = create(persist((set, get) => ({
  items: [],
  orderType: 'dine_in',
  addItem: (product, quantity = 1, opts = {}) => set((state) => {
    const menuKind = normalizeMenuKind(product.menuKind, product.category)
    const regularPrice = Number(product.regularPrice ?? product.price ?? 0)
    const budgetPrice = product.budgetPrice != null ? Number(product.budgetPrice) : null
    const priceTier =
      opts.priceTier === 'budget' && hasBudgetTier(menuKind) && budgetPrice != null
        ? 'budget'
        : 'regular'
    const unit = effectiveUnitPrice({
      menuKind,
      regularPrice,
      budgetPrice,
      priceTier,
      price: regularPrice,
    })

    if (product.pricingMode !== 'kg') {
      const matching = state.items.filter(
        (item) => item.id === product.id && (item.priceTier || 'regular') === priceTier,
      )
      const otherItems = state.items.filter(
        (item) => !(item.id === product.id && (item.priceTier || 'regular') === priceTier),
      )
      const currentQuantity = matching.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      return {
        items: [
          ...otherItems,
          {
            id: product.id,
            name: product.name,
            sku: product.sku,
            price: unit,
            regularPrice,
            budgetPrice,
            priceTier,
            menuKind,
            pricingMode: product.pricingMode || 'pc',
            discountEligible: product.discountEligible === true,
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
          sku: product.sku,
          price: unit,
          regularPrice,
          budgetPrice,
          priceTier,
          menuKind,
          pricingMode: product.pricingMode,
          discountEligible: product.discountEligible === true,
          quantity: 1,
          weight: quantity,
        },
      ],
    }
  }),
  setPriceTier: (index, tier) => set((state) => ({
    items: state.items.map((item, i) => {
      if (i !== index) return item
      if (!hasBudgetTier(item.menuKind) || item.budgetPrice == null) return item
      const priceTier = tier === 'budget' ? 'budget' : 'regular'
      return {
        ...item,
        priceTier,
        price: effectiveUnitPrice({ ...item, priceTier }),
      }
    }),
  })),
  setOrderType: (orderType) => set({ orderType: orderType === 'takeout' ? 'takeout' : 'dine_in' }),
  adjustQuantity: (index, delta) => set((state) => {
    const item = state.items[index]
    if (!item) return state
    // kg lines: adjust weight by 0.1 kg steps
    if (item.pricingMode === 'kg') {
      const nextWeight = Number((Number(item.weight || 0) + Number(delta) * 0.1).toFixed(3))
      if (nextWeight <= 0) return state // removal handled separately (needs supervisor)
      return {
        items: state.items.map((row, i) => (i === index ? { ...row, weight: nextWeight } : row)),
      }
    }
    const nextQty = Number(item.quantity || 0) + Number(delta)
    if (nextQty <= 0) return state
    return {
      items: state.items.map((row, i) => (i === index ? { ...row, quantity: nextQty } : row)),
    }
  }),
  removeItem: (index) => set((state) => ({ items: state.items.filter((_, i) => i !== index) })),
  clear: () => set({ items: [], orderType: 'dine_in' }),
  total: () => get().items.reduce((sum, item) => sum + lineTotal(item), 0),
  ulamCombo: () => detectUlamCombo(get().items),
}), { name: 'cale-pos-cart-v7' }))

export const useProductStore = create((set, get) => ({
  products: offlineDemo ? seedProducts : [],
  loading: false,
  setProducts: (products) => set({ products }),
  setAvailableToday: (productId, availableToday) =>
    set((state) => ({
      products: state.products.map((p) =>
        p.id === productId ? { ...p, availableToday: Boolean(availableToday) } : p,
      ),
    })),
  toggleAvailableToday: async (productId) => {
    const product = get().products.find((p) => p.id === productId)
    if (!product) return
    const next = !product.availableToday
    set((state) => ({
      products: state.products.map((p) =>
        p.id === productId ? { ...p, availableToday: next } : p,
      ),
    }))
    if (api.hasSupabase) {
      try {
        await api.setMenuAvailableToday(productId, next)
      } catch (err) {
        set((state) => ({
          products: state.products.map((p) =>
            p.id === productId ? { ...p, availableToday: product.availableToday } : p,
          ),
        }))
        throw err
      }
    }
  },
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
    const branchId = values.branchId || user?.branchId
    const branchType =
      values._restaurant || values.branchType === 'restaurant' || user?.branchType === 'restaurant'
        ? 'restaurant'
        : 'retail'
    const sameBranch = branchId && user?.branchId && branchId === user.branchId
    if (api.hasSupabase && branchId && user?.id) {
      if (isOnline()) {
        const product = await api.createProduct({
          branchId,
          staffId: user.id,
          values,
          branchType,
        })
        if (values.availableToday === false && product?.id) {
          await api.setMenuAvailableToday(product.id, false).catch(() => {})
        }
        if (sameBranch) {
          set((state) => ({ products: [...state.products, product] }))
          void syncBranch(branchId)
        }
        return product
      }
      const id = newClientId('prod')
      const product = {
        ...values,
        id,
        branchId,
        createdAt: today(),
        updatedAt: today(),
        lastMovementAt: branchType === 'restaurant' ? null : today(),
        availableToday: values.availableToday !== false,
      }
      if (sameBranch) set((state) => ({ products: [...state.products, product] }))
      await enqueue(
        QUEUE_TYPES.CREATE_PRODUCT,
        {
          branchId,
          staffId: user.id,
          values,
          branchType,
          localId: id,
        },
        { branchId },
      )
      useSyncStore.getState().refresh(branchId)
      return product
    }
    const id = `${values.name.toLowerCase().replaceAll(' ', '-')}-${Date.now()}`
    const product = { ...values, id, branchId }
    if (sameBranch || !user?.branchId) set((state) => ({ products: [...state.products, product] }))
    return product
  },
  updateProduct: async (id, changes) => {
    const user = useAuthStore.getState().user
    const previous = get().products.find((item) => item.id === id)
    if (api.hasSupabase && user?.branchId) {
      const mapped = {
        ...previous,
        ...changes,
        regularPrice: changes.price != null ? Number(changes.price) : previous?.regularPrice ?? previous?.price,
        budgetPrice:
          changes.budgetPrice !== undefined
            ? changes.budgetPrice
            : previous?.budgetPrice,
        menuKind: changes.menuKind || previous?.menuKind,
      }
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
    const restaurant = user?.branchType === 'restaurant'
    // Prefer selected branch type from import rows context when manager imports for restaurant
    const current = get().products
    const seen = new Set()
    let created = 0
    let updated = 0
    let skipped = 0

    for (const raw of rows) {
      const name = String(raw.name || '').trim()
      const sku = String(raw.sku || '').trim()
      const barcode = String(raw.barcode || '').replace(/\D/g, '')
      const isRestaurantRow = restaurant || raw._restaurant === true
      if (!name || !sku || (!isRestaurantRow && !barcode)) {
        skipped += 1
        continue
      }
      const key = barcode ? `${sku.toLowerCase()}|${barcode}` : sku.toLowerCase()
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)

      const values = {
        name,
        sku,
        barcode: barcode || `MENU-${sku}`.replace(/\W+/g, '').slice(0, 32),
        category: raw.category || (isRestaurantRow ? 'Meat' : 'Groceries'),
        menuKind: isRestaurantRow
          ? (raw.menuKind || raw.menu_kind || undefined)
          : undefined,
        pricingMode: isRestaurantRow
          ? 'pc'
          : raw.pricingMode === 'kg' || raw.pricingMode === 'per_kg'
            ? 'kg'
            : 'pc',
        price: Number(raw.price || 0),
        budgetPrice:
          isRestaurantRow && raw.budgetPrice != null && raw.budgetPrice !== ''
            ? Number(raw.budgetPrice)
            : isRestaurantRow && raw.budget_price != null && raw.budget_price !== ''
              ? Number(raw.budget_price)
              : null,
        stock: isRestaurantRow ? 0 : Number(raw.stock || 0),
        lowStockAt: Number(raw.lowStockAt || 5),
        availableToday: raw.availableToday !== false,
      }

      const existing = current.find(
        (item) =>
          item.sku.toLowerCase() === sku.toLowerCase() ||
          (barcode && String(item.barcode) === barcode),
      )

      if (existing) {
        const nextStock = isRestaurantRow
          ? Number(existing.stock || 0)
          : Number((Number(existing.stock) + values.stock).toFixed(2))
        await get().updateProduct(existing.id, {
          ...existing,
          name: values.name,
          price: values.price,
          budgetPrice: values.budgetPrice,
          menuKind: values.menuKind,
          category: values.category,
          pricingMode: values.pricingMode,
          stock: nextStock,
          availableToday: values.availableToday,
        })
        if (api.hasSupabase && isRestaurantRow) {
          await api.setMenuAvailableToday(existing.id, values.availableToday).catch(() => {})
        }
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
      throw appError('TILL01')
    }

    // Local-first: apply sale to IndexedDB + memory, then queue / sync
    const productStore = useProductStore.getState()
    const isRestaurant = user?.branchType === 'restaurant'
    const saleMoves = []
    let nextProducts = productStore.products
    const bizDate = today(get().dayOpenHour)
    const localId = payload.id || newClientId('txn')

    if (!isRestaurant) {
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
      productStore.setProducts(nextProducts)
    }

    const orderType = payload.orderType === 'takeout' ? 'takeout' : 'dine_in'
    const ulamCombo = payload.ulamCombo || null
    const paymentMethod = payload.paymentMethod || 'cash'
    const paymentReference = payload.paymentReference || null
    const localTxn = {
      ...payload,
      id: localId,
      itemsList: items,
      date: payload.date || bizDate,
      branchId: user?.branchId,
      syncStatus: 'pending',
      createdAt: new Date().toISOString(),
      cashier: user?.name || payload.cashier || 'Staff',
      orderType,
      ulamCombo,
      paymentMethod,
      paymentReference,
      vatAmount: payload.vatAmount || 0,
      vatableSales: payload.vatableSales || 0,
      discountAmount: payload.discountAmount || 0,
      discountType: payload.discountType || null,
      discountIdNote: payload.discountIdNote || null,
    }

    set((state) => ({
      transactions: [localTxn, ...state.transactions],
      movements: [...saleMoves, ...state.movements],
    }))

    if (api.hasSupabase && user?.branchId) {
      await upsertLocalSale({
        transaction: localTxn,
        movements: saleMoves,
        products: isRestaurant
          ? []
          : nextProducts.filter((p) => items.some((i) => i.id === p.id)),
      })

      await enqueue(
        QUEUE_TYPES.COMPLETE_SALE,
        {
          branchId: user.branchId,
          staffId: user.id,
          branchType: user.branchType || 'retail',
          items: items.map((item) => ({
            ...item,
            unitPrice: item.unitPrice ?? item.price,
            priceTier: item.priceTier || 'regular',
            discountEligible: item.discountEligible === true,
            discountAmount: Number(item.discountAmount ?? 0),
          })),
          total: payload.total,
          tendered: payload.tendered,
          orderType,
          ulamCombo,
          paymentMethod,
          paymentReference,
          vatAmount: payload.vatAmount || 0,
          vatableSales: payload.vatableSales || 0,
          discountAmount: payload.discountAmount || 0,
          discountType: payload.discountType || null,
          discountIdNote: payload.discountIdNote || null,
          localTransactionId: localId,
          clientId: localId,
        },
        { branchId: user.branchId, clientId: localId },
      )
      useSyncStore.getState().refresh(user.branchId)
      // Don't block the cashier on full sync — push/pull in the background.
      if (isOnline()) {
        void syncBranch(user.branchId)
          .then((data) => {
            if (!data) return
            set({
              transactions: data.transactions,
              movements: data.movements,
              dayEnds: data.dayEnds,
              dayOpenHour: Number(data.dayOpenHour ?? 7),
            })
            useProductStore.getState().setProducts(data.products)
            useSyncStore.getState().refresh(user.branchId)
          })
          .catch(() => {})
      }
      return localTxn
    }

    return localTxn
  },
  voidTransaction: async (id, reason, approvedBy = null) => {
    const user = useAuthStore.getState().user
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id
          ? {
              ...transaction,
              status: 'Voided',
              voidReason: reason,
              voidedAt: new Date().toISOString(),
              voidApprovedBy: approvedBy || user?.id || null,
            }
          : transaction,
      ),
    }))
    if (api.hasSupabase && user?.branchId) {
      if (isOnline() && !String(id).startsWith('txn_') && !String(id).startsWith('op_')) {
        await api.voidSale(id, reason, user.id, approvedBy)
      } else {
        await enqueue(
          QUEUE_TYPES.VOID_SALE,
          { id, reason, staffId: user.id, approvedBy },
          { branchId: user.branchId },
        )
      }
      useSyncStore.getState().refresh(user.branchId)
      if (isOnline()) await syncBranch(user.branchId)
    }
  },
  refundTransactionItems: async (id, { reason, items, approvedBy = null }) => {
    const user = useAuthStore.getState().user
    if (!api.hasSupabase || !user?.branchId) {
      throw new Error('Connect Supabase to process refunds.')
    }
    if (!isOnline()) throw new Error('Refunds require an online connection.')
    const result = await api.refundSaleItems({
      transactionId: id,
      staffId: user.id,
      reason,
      items,
      approvedBy,
    })
    if (result?.fully_voided) {
      set((state) => ({
        transactions: state.transactions.map((transaction) =>
          transaction.id === id
            ? {
                ...transaction,
                status: 'Voided',
                voidReason: reason || 'Fully refunded',
                voidedAt: new Date().toISOString(),
                voidApprovedBy: approvedBy || user.id,
                refundedAmount: Number(transaction.total || 0),
                netTotal: 0,
              }
            : transaction,
        ),
      }))
    } else if (result?.refunded_amount != null) {
      const added = Number(result.refunded_amount || 0)
      set((state) => ({
        transactions: state.transactions.map((transaction) => {
          if (transaction.id !== id) return transaction
          const refundedAmount = Number((Number(transaction.refundedAmount || 0) + added).toFixed(2))
          const total = Number(transaction.total || 0)
          return {
            ...transaction,
            refundedAmount,
            netTotal: Math.max(0, Number((total - refundedAmount).toFixed(2))),
          }
        }),
      }))
    }
    useSyncStore.getState().refresh(user.branchId)
    if (isOnline()) await syncBranch(user.branchId)
    return result
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
      dayReport: entry.dayReport || null,
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
        const remote = api.mapDayEndRow(row)
        remote.syncStatus = 'synced'
        remote.branchId = user.branchId
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
        const mapped = api.mapDayEndRow(row)
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
