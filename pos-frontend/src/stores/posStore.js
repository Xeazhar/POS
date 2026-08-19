import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import * as api from '../lib/api'
import {
  drainQueueInBackground,
  enqueue,
  isOnline,
  isBackendReachable,
  newClientId,
  QUEUE_TYPES,
  readBranchSnapshot,
  setSyncBranchId,
  subscribeSync,
  syncBranch,
  upsertLocalSale,
  patchLocalTransaction,
  putLocalMovement,
  putLocalDayEnd,
  updateLocalProducts,
  ensureRealtimeAuth,
} from '../offline'
import { clearLocalSession, clearRequireFreshLogin, loadLocalSession, markRequireFreshLogin, needsFreshLogin, saveLocalSession } from '../offline/session'
import { clearAuthSessionStorage, consumeBrowserClosedFlag } from '../offline/sessionLifecycle'
import { appError } from '../utils/errors'
import { withTimeout } from '../utils/withTimeout'
import { dayEndForBusinessDate, isTillClosed, today } from '../utils/format'
import { isSupervisorOrAbove } from '../utils/roles'
import { detectUlamCombo, effectiveUnitPrice, hasBudgetTier, lineTotal, normalizeMenuKind } from '../utils/ulam'
import { useShiftStore } from './shiftStore'
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
  /** Set only on fresh sign-in (not session restore) — drives LoginIntro overlay in App. */
  loginIntroUser: null,
  booting: true,
  error: '',

  screenLocked: false,
  deviceSessionId: null,
  clearLoginIntro: () => set({ loginIntroUser: null }),
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
          role: mode === 'pin' ? 'cashier' : 'master',
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
        set({ user, booting: false, screenLocked: false, deviceSessionId: 'demo-session', loginIntroUser: user })
        useCartStore.getState().clear()
        await clearRequireFreshLogin()
        await saveLocalSession(user)
        return user
      }
      // `isOnline()` is just navigator.onLine — true on dead wifi/captive portals, which
      // used to send this straight into the real signIn call below, hang on a fetch that
      // can never complete, and surface a generic "could not reach the server" AUTH01
      // instead of the cached-session path this branch exists for. Check actual backend
      // reachability, same pattern as restoreSession.
      if (!isOnline() || !(await isBackendReachable())) {
        if (await needsFreshLogin()) {
          throw appError('AUTH04')
        }
        const cached = await loadLocalSession()
        if (cached) {
          useCartStore.getState().clear()
          set({ user: cached, booting: false, screenLocked: false, loginIntroUser: cached })
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

      if (mode === 'email') {
        await api.setManagerUnlockSecret(user.id, passwordOrPin)
      } else {
        await api.clearManagerUnlockSecret()
      }

      const sessionId = api.getOrCreateDeviceSessionId()
      let readyUser = user
      try {
        await api.claimStaffSession()
        // `branches` RLS gates on current_staff_branch(), which only resolves once
        // claim_staff_session() has stamped this session as this staff's active one — the
        // `user` above was fetched BEFORE that claim, so its branch-scoped fields
        // (branchName, dayOpenHour, deviceSettings, vatRate) silently came back as
        // fallback defaults, not the real branch. Refetch now that the claim has landed
        // so the nav bar and everything else gets the real branch, not "Branch" forever.
        readyUser = (await api.fetchSessionStaff().catch(() => null)) || user
      } catch (claimErr) {
        await api.signOut().catch(() => {})
        throw claimErr
      }

      useCartStore.getState().clear()
      set({ user: readyUser, booting: false, screenLocked: false, deviceSessionId: sessionId, loginIntroUser: readyUser })
      await clearRequireFreshLogin()
      await saveLocalSession({ ...readyUser, deviceSessionId: sessionId })
      setSyncBranchId(readyUser.branchId)
      void ensureRealtimeAuth()
      api.logAuditEvent({
        branchId: readyUser.branchId,
        staffId: readyUser.id,
        eventType: 'login',
        detail: `Signed in as ${readyUser.name}`,
        meta: { role: readyUser.role, branchType: readyUser.branchType, mode },
      })
      return readyUser
    } catch (error) {
      set({ error: error?.message || String(error), booting: false, user: null })
      throw error
    }
  },
  restoreSession: async () => {
    if (!api.hasSupabase) return get().user
    set({ booting: true })
    try {
      // Tab/browser was closed (or crashed with close mark) — never auto-login.
      //
      // Deliberately NOT calling api.clearDeviceSessionId() here: this device's id is also
      // used as the till/device fingerprint on sale and void-approval payloads
      // (Cart.jsx/CartRemoveApprove.jsx) — unrelated to session security, keep it stable.
      if (consumeBrowserClosedFlag()) {
        clearAuthSessionStorage()
        if (isOnline()) await api.signOut().catch(() => {})
        await clearLocalSession()
        await api.clearManagerUnlockSecret().catch(() => {})
        set({ user: null, booting: false, screenLocked: false, deviceSessionId: null })
        return null
      }

      // Same reasoning as above: keep the device id so the next login self-heals.
      if (await needsFreshLogin()) {
        if (isOnline()) await api.signOut().catch(() => {})
        await clearLocalSession()
        await api.clearManagerUnlockSecret().catch(() => {})
        set({ user: null, booting: false, screenLocked: false })
        return null
      }

      // Safety: never auto-login from IndexedDB/local cache.
      // Only continue if this browser tab still has an Auth session (sessionStorage).
      //
      // `isOnline()` is just navigator.onLine — true on dead wifi/captive portals. Check
      // actual reachability before attempting the network round trip, and bound the round
      // trip itself, so a stalled connection resumes the session from local cache (same
      // fallback already used when fully offline) instead of hanging the whole app on the
      // startup skeleton.
      let user = null
      if (isOnline() && (await isBackendReachable())) {
        try {
          user = await withTimeout(api.fetchSessionStaff(), 8000, 'Session check')
        } catch {
          if (await api.hasAuthSession()) user = await loadLocalSession()
        }
      } else if (await api.hasAuthSession()) {
        user = await loadLocalSession()
      }
      if (!user) {
        await clearLocalSession()
        api.clearDeviceSessionId()
        await api.clearManagerUnlockSecret().catch(() => {})
        set({ user: null, booting: false, screenLocked: false })
        return null
      }

      await saveLocalSession(user)
      if (user?.id && isOnline() && (await isBackendReachable())) {
        const sessionId = user.deviceSessionId || api.getOrCreateDeviceSessionId()
        try {
          // Verify-only: a plain reload keeps the same JWT session_id, so this succeeds for
          // a device that's still legitimately holding the claim. It must NOT re-steal the
          // session — that would let a mere page refresh silently take it back from whoever
          // holds it now, defeating eviction entirely.
          await api.heartbeatStaffSession()
          user = { ...user, deviceSessionId: sessionId }
          await saveLocalSession(user)
          set({ user, booting: false, deviceSessionId: sessionId })
        } catch (verifyErr) {
          // Only a definitive SESSION_REVOKED means this device actually lost the claim —
          // any other failure (network blip, backend hiccup right as reachability flipped)
          // must not sign the cashier out and wipe their cached session over it. This used
          // to force-logout on a plain "Failed to fetch", which then also broke the next
          // login attempt by deleting the very cached session offline login falls back to.
          if (!api.isSessionRevokedError(verifyErr)) {
            set({ user, booting: false, deviceSessionId: sessionId })
          } else {
            await api.signOut().catch(() => {})
            await clearLocalSession()
            await api.clearManagerUnlockSecret().catch(() => {})
            set({ user: null, booting: false, error: appError('AUTH11').message, screenLocked: false })
            return null
          }
        }
      } else {
        set({ user, booting: false })
      }
      if (user?.branchId) setSyncBranchId(user.branchId)
      if (user && isOnline()) void ensureRealtimeAuth()
      return user
    } catch {
      await clearLocalSession().catch(() => {})
      set({ user: null, booting: false, screenLocked: false })
      return null
    }
  },
  lockScreen: () => {
    void api.clearManagerUnlockSecret().catch(() => {})
    set({ screenLocked: true })
  },
  unlockScreen: () => set({ screenLocked: false }),
  /** Secure lockout after day-end — clears session so next open needs password. */
  lockAfterDayEnd: async () => {
    const user = get().user
    const sessionId = get().deviceSessionId || user?.deviceSessionId
    useCartStore.getState().clear()
    if (api.hasSupabase && user) {
      api.logAuditEvent({
        branchId: user.branchId,
        staffId: user.id,
        eventType: 'day_end_lock',
        detail: 'Day closed — session locked until next login',
      })
      if (sessionId) await api.releaseStaffSession(user.id, sessionId).catch(() => {})
    }
    await markRequireFreshLogin()
    if (api.hasSupabase && isOnline()) await api.signOut().catch(() => {})
    await clearLocalSession()
    api.clearDeviceSessionId()
    await api.clearManagerUnlockSecret()
    setSyncBranchId(null)
    // Drops the in-memory pointer only. The shift record in IndexedDB deliberately
    // survives sign-out — an open shift outlives the session, which is what stops a
    // re-login asking the cashier to count the change fund a second time.
    useShiftStore.getState().forget()
    set({ user: null, screenLocked: false, deviceSessionId: null, loginIntroUser: null })
  },
  logout: async () => {
    const user = get().user
    const sessionId = get().deviceSessionId || user?.deviceSessionId
    useCartStore.getState().clear()
    // Clear the in-memory user FIRST — App.jsx's route gate reads this reactively, so this
    // is what actually swaps the screen from whatever page was open (POS, Dashboard, ...)
    // to Login. The cleanup below is all network round-trips (releaseStaffSession, signOut,
    // clearLocalSession, clearManagerUnlockSecret); with `set` at the end of those awaits,
    // the app kept rendering the live authenticated page for however long they took,
    // fully visible and interactive, and only flipped to Login once they finished — the
    // "shows the old page briefly before sign-in" flash. Everything below already reads the
    // `user`/`sessionId` captured above, not `get().user()`, so clearing early changes
    // nothing about what gets cleaned up.
    set({ user: null, screenLocked: false, deviceSessionId: null, loginIntroUser: null })
    if (api.hasSupabase && user) {
      api.logAuditEvent({
        branchId: user.branchId,
        staffId: user.id,
        eventType: 'logout',
        detail: `Signed out ${user.name}`,
      })
      if (sessionId) await api.releaseStaffSession(user.id, sessionId).catch(() => {})
    }
    if (api.hasSupabase && isOnline()) await api.signOut()
    await clearLocalSession()
    api.clearDeviceSessionId()
    await api.clearManagerUnlockSecret()
    setSyncBranchId(null)
    // Drops the in-memory pointer only. The shift record in IndexedDB deliberately
    // survives sign-out — an open shift outlives the session, which is what stops a
    // re-login asking the cashier to count the change fund a second time.
    useShiftStore.getState().forget()
  },
  /** Forced kick: this device's session was evicted by a login elsewhere (heartbeat,
   *  realtime notice, or a rejected sync push all funnel here). Mirrors logout()'s cleanup
   *  but does NOT call releaseStaffSession — the session it would try to release already
   *  belongs to whoever evicted us, and release_staff_session() only clears a session that
   *  still matches the caller, so it would be a safe no-op anyway; skipped for clarity.
   *  Does not emit its own audit event — claim_staff_session() already recorded
   *  'session_replaced' server-side at the moment of eviction, which is the authoritative,
   *  tamper-resistant trail (this device may be offline or the tab may just be closed).
   */
  sessionRevoked: async () => {
    useCartStore.getState().clear()
    set({
      user: null,
      screenLocked: false,
      deviceSessionId: null,
      loginIntroUser: null,
      error: appError('AUTH11').message,
      booting: false,
    })
    if (api.hasSupabase && isOnline()) await api.signOut().catch(() => {})
    await clearLocalSession()
    api.clearDeviceSessionId()
    await api.clearManagerUnlockSecret().catch(() => {})
    setSyncBranchId(null)
    useShiftStore.getState().forget()
  },
}), { name: 'cale-pos-auth-v4', partialize: (state) => ({ user: api.hasSupabase ? null : state.user }) }))

let sessionRevokedWatcherBound = false
/** Wires the offline sync engine's sessionRevoked signal (Task 5, syncEngine.js) to the
 *  forced-logout action above. Call once from App.jsx, alongside bindSyncStore(). */
export function bindSessionRevokedWatcher() {
  if (sessionRevokedWatcherBound) return
  sessionRevokedWatcherBound = true
  subscribeSync((state) => {
    if (state.sessionRevoked) void useAuthStore.getState().sessionRevoked()
  })
}

export const useCartStore = create(persist((set, get) => ({
  items: [],
  orderType: 'dine_in',
  cartId: null,
  ensureCartId: () => {
    if (get().cartId) return get().cartId
    const cartId = newClientId('cart')
    set({ cartId })
    return cartId
  },
  addItem: (product, quantity = 1, opts = {}) => set((state) => {
    const cartId = state.cartId || newClientId('cart')
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
    const promoGroupId = opts.promoGroup?.id ?? null
    const promoGroupType = opts.promoGroup?.type ?? null
    const promoGroupName = opts.promoGroup?.name ?? null

    if (product.pricingMode !== 'kg') {
      const matching = state.items.filter(
        (item) =>
          item.id === product.id &&
          (item.priceTier || 'regular') === priceTier &&
          (item.promoGroupId ?? null) === promoGroupId,
      )
      const otherItems = state.items.filter(
        (item) =>
          !(
            item.id === product.id &&
            (item.priceTier || 'regular') === priceTier &&
            (item.promoGroupId ?? null) === promoGroupId
          ),
      )
      const currentQuantity = matching.reduce((sum, item) => sum + Number(item.quantity || 0), 0)
      return {
        cartId,
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
            promoGroupId,
            promoGroupType,
            promoGroupName,
          },
        ],
      }
    }
    return {
      cartId: state.cartId || cartId,
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
          promoGroupId,
          promoGroupType,
          promoGroupName,
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
  removePromoEntries: (entries = []) =>
    set((state) => {
      if (!entries.length) return state
      let items = [...state.items]
      const sorted = [...entries].sort((a, b) => b.lineIndex - a.lineIndex)
      for (const { lineIndex, units } of sorted) {
        const item = items[lineIndex]
        if (!item) continue
        const current =
          item.pricingMode === 'kg' ? Number(item.weight || 0) : Number(item.quantity || 0)
        const take = Number(units || 0)
        if (!(take > 0)) continue
        if (current <= take + 0.0001) {
          items = items.filter((_, i) => i !== lineIndex)
        } else if (item.pricingMode === 'kg') {
          items = items.map((row, i) =>
            i === lineIndex
              ? { ...row, weight: Number((Number(row.weight || 0) - take).toFixed(3)) }
              : row,
          )
        } else {
          items = items.map((row, i) =>
            i === lineIndex ? { ...row, quantity: Number(row.quantity || 0) - take } : row,
          )
        }
      }
      return { items }
    }),
  clear: () => set({ items: [], orderType: 'dine_in', cartId: newClientId('cart') }),
  total: () => get().items.reduce((sum, item) => sum + lineTotal(item), 0),
  ulamCombo: () => detectUlamCombo(get().items),
}), { name: 'cale-pos-cart-v8' }))

export const useProductStore = create((set, get) => ({
  products: offlineDemo ? seedProducts : [],
  loading: false,
  setProducts: (products) => set({ products }),
  // Live-refresh merge (see src/offline/realtime.js): replaces the set with fresh
  // server data, but keeps display-only fields the lighter refetch doesn't carry
  // (e.g. lastMovementAt) by borrowing them from the previous entry.
  mergeProducts: (freshProducts) =>
    set((state) => {
      const prevById = new Map(state.products.map((p) => [p.id, p]))
      return {
        products: freshProducts.map((p) => {
          const prev = prevById.get(p.id)
          return prev ? { ...p, lastMovementAt: p.lastMovementAt ?? prev.lastMovementAt } : p
        }),
      }
    }),
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
    setSyncBranchId(branchId)
    // Always paint from IndexedDB first — never block the UI on network.
    let data = await readBranchSnapshot(branchId)
    set({ products: data.products || [], loading: false })
    useInventoryStore.getState().hydrate(data)

    if (!(await isBackendReachable())) {
      useSyncStore.getState().refresh(branchId)
      return data
    }

    try {
      const catalog = await withTimeout(api.bootstrapPosCatalog(branchId), 15000, 'Catalog sync')
      if (catalog?.products?.length) {
        // Catalog bootstrap is products-only — never spread its placeholder activity fields.
        data = {
          ...data,
          products: catalog.products,
          categories: catalog.categories ?? data.categories,
          dayOpenHour: catalog.dayOpenHour ?? data.dayOpenHour,
        }
        set({ products: catalog.products })
        if (catalog.dayOpenHour != null) {
          useInventoryStore.setState({ dayOpenHour: Number(catalog.dayOpenHour) })
        }
      }
      if (catalog?.fiscalHeader) {
        const { saveBranchFiscalHeader } = await import('../offline/repository')
        await saveBranchFiscalHeader(branchId, catalog.fiscalHeader)
      }
      try {
        const verifiers = await api.fetchSupervisorPinVerifiers(branchId)
        if (verifiers?.length) {
          const { putSupervisorVerifiers } = await import('../offline/supervisorPin')
          await putSupervisorVerifiers(branchId, verifiers)
        }
      } catch {
        /* migration may not be applied yet */
      }
    } catch {
      /* keep local snapshot */
    }

    try {
      const synced = await withTimeout(syncBranch(branchId), 30000, 'Branch sync')
      if (synced) {
        data = synced
        set({ products: synced.products || [] })
        useInventoryStore.getState().hydrate(synced)
      }
    } catch {
      /* keep last good snapshot */
    }

    // Day-end status gates ShiftGate immediately on login — always refetch it when
    // online, even if syncBranch skipped a full pull due to a pending outbox.
    if (await isBackendReachable()) {
      try {
        const { refreshBranchActivity } = await import('../hooks/useBranchOperationsLive')
        const activity = await refreshBranchActivity(branchId)
        if (activity) {
          data = {
            ...data,
            transactions: activity.transactions,
            movements: activity.movements,
            dayEnds: activity.dayEnds,
          }
        }
      } catch {
        /* keep last good snapshot */
      }
    }

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
  hydrate: (data) => set((state) => ({
    transactions: data.transactions ?? state.transactions,
    movements: data.movements ?? state.movements,
    dayEnds: data.dayEnds ?? state.dayEnds,
    dayOpenHour: Number(data.dayOpenHour ?? state.dayOpenHour ?? 7),
  })),
  addTransaction: async (payload) => {
    const user = useAuthStore.getState().user
    const items = payload.itemsList || []
    if (isTillClosed(get().dayEnds, get().dayOpenHour)) {
      throw appError('TILL01')
    }

    // Master never goes through ShiftGate (Shell's worksShifts is cashier/supervisor only),
    // so a master ringing a sale needs its shift created right here, on first use — see
    // ensureMasterShift's doc comment. No-op for every other role.
    if (user?.role === 'master' && !useShiftStore.getState().shift) {
      await useShiftStore.getState().ensureMasterShift(user)
    }

    // Which shift is answerable for this cash. Recorded on the local row too, so an
    // offline cash-out can total the drawer before the sale has a server id.
    const activeShift = useShiftStore.getState().shift

    // Local-first: apply sale to IndexedDB + memory, then queue / sync
    const productStore = useProductStore.getState()
    const isRestaurant = user?.branchType === 'restaurant'
    const saleMoves = []
    let nextProducts = productStore.products
    const bizDate = today(get().dayOpenHour)
    const localId = payload.id || newClientId('txn')

    // The official invoice number is never generated on-device. A client-computed
    // number is only atomic within this one browser's IndexedDB, not across the other
    // devices selling at the same branch, so two tills checking out at once (or two
    // offline devices with the same last-synced counter) could each print the same
    // number. The receipt prints with `localId` as its reference instead (buildReceipt's
    // PENDING branch); the server assigns the real invoice number atomically
    // (`allocate_invoice_number`, row-locked per branch) once this sale's COMPLETE_SALE
    // queue item pushes, and the authoritative row — with its real invoice number —
    // replaces this local one on the next pull.
    const invoiceNumber = null

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
      invoiceNumber,
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
      vatExemptSales: payload.vatExemptSales || 0,
      zeroRatedSales: payload.zeroRatedSales || 0,
      scPwdDiscount: payload.scPwdDiscount || 0,
      vatRateApplied: payload.vatRateApplied ?? 0.12,
      discountAmount: payload.discountAmount || 0,
      discountType: payload.discountType || null,
      discountIdNote: payload.discountIdNote || null,
      shiftClientId: activeShift?.clientId || null,
      shiftId: activeShift?.serverId || null,
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
            vatCategory: item.vatCategory || 'vatable',
            promoName: item.promoName || null,
            promoGroupId: item.promoGroupId || null,
            promoGroupType: item.promoGroupType || null,
          })),
          total: payload.total,
          tendered: payload.tendered,
          orderType,
          ulamCombo,
          paymentMethod,
          paymentReference,
          vatAmount: payload.vatAmount || 0,
          vatableSales: payload.vatableSales || 0,
          vatExemptSales: payload.vatExemptSales || 0,
          zeroRatedSales: payload.zeroRatedSales || 0,
          scPwdDiscount: payload.scPwdDiscount || 0,
          vatRateApplied: payload.vatRateApplied ?? 0.12,
          discountAmount: payload.discountAmount || 0,
          discountType: payload.discountType || null,
          discountIdNote: payload.discountIdNote || null,
          shiftClientId: activeShift?.clientId || null,
          shiftId: activeShift?.serverId || null,
          invoiceNumber,
          localTransactionId: localId,
          clientId: localId,
        },
        { branchId: user.branchId, clientId: localId },
      )
      useSyncStore.getState().refresh(user.branchId)
      void drainQueueInBackground(user.branchId).catch(() => {})
      return localTxn
    }

    return localTxn
  },
  // `approver` is display metadata only ({ name, role }) — the id in `approvedBy` is what
  // gets persisted. It exists so the row names its approver straight away instead of
  // waiting for the next server read to resolve the uuid.
  voidTransaction: async (id, reason, approvedBy = null, approver = null) => {
    const user = useAuthStore.getState().user
    const voidPatch = {
      status: 'Voided',
      voidReason: reason,
      voidedAt: new Date().toISOString(),
      voidApprovedBy: approvedBy || user?.id || null,
      voidApprovedByName: approver?.name || (approvedBy ? null : user?.name || null),
      voidApprovedByRole: approver?.role || (approvedBy ? null : user?.role || null),
    }
    set((state) => ({
      transactions: state.transactions.map((transaction) =>
        transaction.id === id ? { ...transaction, ...voidPatch } : transaction,
      ),
    }))
    if (api.hasSupabase && user?.branchId) {
      await patchLocalTransaction(id, voidPatch).catch(() => {})
      if ((await isBackendReachable()) && !String(id).startsWith('txn_') && !String(id).startsWith('op_')) {
        await api.voidSale(id, reason, user.id, approvedBy)
      } else {
        await enqueue(
          QUEUE_TYPES.VOID_SALE,
          { id, reason, staffId: user.id, approvedBy },
          { branchId: user.branchId },
        )
      }
      useSyncStore.getState().refresh(user.branchId)
      if (await isBackendReachable()) await syncBranch(user.branchId)
    }
  },
  refundTransactionItems: async (id, { reason, items, approvedBy = null, approver = null }) => {
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
                voidApprovedByName: approver?.name || (approvedBy ? null : user?.name || null),
                voidApprovedByRole: approver?.role || (approvedBy ? null : user?.role || null),
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
        await putLocalMovement(localMove)
        await updateLocalProducts(
          productStore.products.filter((p) => p.id === movement.productId),
        )
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
  submitDay: async (entry) => {
    const user = useAuthStore.getState().user
    const existing = dayEndForBusinessDate(get().dayEnds, entry.date)
    if (existing?.status === 'closed') return existing

    // submit_day_end auto-closes on the server when the caller is supervisor+ (see
    // migrate_day_end_supervisor_autoclose.sql) — the only screen that calls this is
    // already gated to supervisor+, so the local optimistic state should say 'closed'
    // too, not sit on 'submitted' until the round trip / sync catches up.
    const autoCloses = isSupervisorOrAbove(user?.role)
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const mapped = {
      ...entry,
      id: existing?.id || newClientId('day'),
      status: autoCloses ? 'closed' : 'submitted',
      cashier: user?.name || entry.cashier,
      submittedAt: now,
      approvedAt: autoCloses ? now : null,
      reopenedAt: null,
      branchId: user?.branchId,
      dayReport: entry.dayReport || null,
      syncStatus: api.hasSupabase ? 'pending' : 'local',
    }
    set((state) => ({
      dayEnds: [mapped, ...state.dayEnds.filter((item) => item.date !== entry.date)],
    }))
    useCartStore.getState().clear()

    if (api.hasSupabase && user?.branchId) {
      await putLocalDayEnd(mapped)
      if (await isBackendReachable()) {
        const row = await api.submitDayEnd({
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
        QUEUE_TYPES.SUBMIT_DAY,
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
  /**
   * Cashier-triggered "Request day end" — no cash figures, just a flag that someone
   * (a supervisor, or a manager when `requestManager` is set) needs to count the drawer
   * and close the day from the normal Day End screen.
   */
  requestDay: async (requestManager = false) => {
    const user = useAuthStore.getState().user
    const dayOpenHour = get().dayOpenHour
    const date = today(dayOpenHour)
    const existing = dayEndForBusinessDate(get().dayEnds, date)
    if (existing?.status === 'submitted' || existing?.status === 'closed') return existing

    const mapped = {
      id: existing?.id || newClientId('day'),
      date,
      status: 'requested',
      requestedAt: new Date().toISOString(),
      requestedBy: user?.id || null,
      requestManager: Boolean(requestManager),
      cashier: user?.name || '',
      branchId: user?.branchId,
      syncStatus: api.hasSupabase ? 'pending' : 'local',
    }

    // Online with a real backend: wait for the server to actually confirm the request
    // before showing "Requested" — setting the optimistic state first and letting a
    // thrown error land after would leave the screen saying "Requested" even when the
    // RPC failed (e.g. migration missing) and nothing reached the database.
    if (api.hasSupabase && user?.branchId && isOnline()) {
      const row = await api.requestDayEnd({
        branchId: user.branchId,
        staffId: user.id,
        businessDate: date,
        requestManager: Boolean(requestManager),
      })
      const remote = api.mapDayEndRow(row)
      remote.syncStatus = 'synced'
      remote.branchId = user.branchId
      set((state) => ({
        dayEnds: [remote, ...state.dayEnds.filter((item) => item.id !== remote.id && item.date !== remote.date)],
      }))
      return remote
    }

    // Offline (or no backend at all): nothing to confirm against right now, so the
    // optimistic state IS the only answer — queue it for syncEngine to replay later.
    set((state) => ({
      dayEnds: [mapped, ...state.dayEnds.filter((item) => item.date !== date)],
    }))
    if (api.hasSupabase && user?.branchId) {
      await enqueue(
        QUEUE_TYPES.REQUEST_DAY_END,
        {
          branchId: user.branchId,
          staffId: user.id,
          businessDate: date,
          requestManager: Boolean(requestManager),
          localId: mapped.id,
        },
        { branchId: user.branchId },
      )
      useSyncStore.getState().refresh(user.branchId)
    }
    return mapped
  },
  /** @deprecated use submitDay */
  closeDay: async (entry) => get().submitDay(entry),
  approveDay: async (id) => {
    const user = useAuthStore.getState().user
    set((state) => ({
      dayEnds: state.dayEnds.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'closed',
              approvedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            }
          : item,
      ),
    }))
    if (api.hasSupabase && user) {
      if (isOnline()) {
        const row = await api.approveDayEnd({ id, staffId: user.id })
        const mapped = api.mapDayEndRow(row)
        set((state) => ({
          dayEnds: state.dayEnds.map((item) => (item.id === id ? mapped : item)),
        }))
        return mapped
      }
      await enqueue(QUEUE_TYPES.APPROVE_DAY, { id, staffId: user.id }, { branchId: user.branchId })
      useSyncStore.getState().refresh(user.branchId)
    }
  },
  reopenDay: async (id, reason) => {
    const user = useAuthStore.getState().user
    set((state) => ({
      dayEnds: state.dayEnds.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'reopened',
              reopenedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              reopenReason: reason || item.reopenReason,
            }
          : item,
      ),
    }))
    if (api.hasSupabase && user) {
      if (isOnline()) {
        const row = await api.reopenDayEnd({ id, staffId: user.id, reason })
        const mapped = api.mapDayEndRow(row)
        set((state) => ({
          dayEnds: state.dayEnds.map((item) => (item.id === id ? mapped : item)),
        }))
        if (user.branchId) {
          const { refreshBranchActivity } = await import('../hooks/useBranchOperationsLive')
          await refreshBranchActivity(user.branchId).catch(() => {})
        }
        return mapped
      }
      await enqueue(
        QUEUE_TYPES.REOPEN_DAY,
        { id, staffId: user.id, reason },
        { branchId: user.branchId },
      )
      useSyncStore.getState().refresh(user.branchId)
    }
  },
  /**
   * A cashier blocked by a closed business day (ShiftGate's "Day closed" screen) asks a
   * manager to reopen it. Online-only, deliberately not queued: the whole point is to
   * notify a manager *now*, and the till is already blocked either way — there is nothing
   * useful for an offline queue to defer here.
   */
  requestDayReopen: async (id, reason) => {
    const user = useAuthStore.getState().user
    if (!api.hasSupabase || !user) return null
    if (!isOnline()) throw appError('SYNC01')
    const row = await api.requestDayReopen({ id, staffId: user.id, reason })
    const mapped = api.mapDayEndRow(row)
    set((state) => ({
      dayEnds: state.dayEnds.map((item) => (item.id === id ? mapped : item)),
    }))
    return mapped
  },
  /**
   * Supervisor/manager declines a cashier's "Request day end" made by mistake. Keeps the
   * row (status 'rejected') rather than deleting it, for the audit trail — the cashier's
   * screen falls back to the normal "Request day end" form on its own once status is no
   * longer 'requested'.
   */
  rejectDayRequest: async (id, reason) => {
    const user = useAuthStore.getState().user
    set((state) => ({
      dayEnds: state.dayEnds.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'rejected',
              rejectedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              rejectReason: reason || '',
            }
          : item,
      ),
    }))
    if (api.hasSupabase && user) {
      if (isOnline()) {
        const row = await api.rejectDayEndRequest({ id, staffId: user.id, reason })
        const mapped = api.mapDayEndRow(row)
        set((state) => ({
          dayEnds: state.dayEnds.map((item) => (item.id === id ? mapped : item)),
        }))
        return mapped
      }
      await enqueue(
        QUEUE_TYPES.REJECT_DAY_REQUEST,
        { id, staffId: user.id, reason },
        { branchId: user.branchId },
      )
      useSyncStore.getState().refresh(user.branchId)
    }
  },
}))
