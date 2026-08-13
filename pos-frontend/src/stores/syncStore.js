import { create } from 'zustand'
import { getSyncStatus, subscribeSync } from '../offline'

export const useSyncStore = create((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  backendReachable: false,
  status: 'idle',
  pending: 0,
  /** Ops quarantined after repeated push failures — real sales that never reached the server. */
  blocked: 0,
  lastError: null,
  lastPullAt: null,
  lastPushAt: null,
  refresh: async (branchId) => {
    const snap = await getSyncStatus(branchId)
    set({
      online: snap.online,
      backendReachable: snap.backendReachable ?? false,
      pending: snap.pending,
      blocked: snap.blocked || 0,
      lastPullAt: snap.lastPullAt || null,
      lastPushAt: snap.lastPushAt || null,
    })
  },
}))

let subscribed = false
export function bindSyncStore() {
  if (subscribed) return
  subscribed = true
  subscribeSync((state) => {
    useSyncStore.setState({
      online: state.online ?? useSyncStore.getState().online,
      backendReachable: state.backendReachable ?? useSyncStore.getState().backendReachable,
      status: state.status || 'idle',
      pending: state.pending ?? useSyncStore.getState().pending,
      blocked: state.blocked ?? useSyncStore.getState().blocked,
      lastError: state.lastError ?? null,
      lastPullAt: state.lastPullAt ?? useSyncStore.getState().lastPullAt,
      lastPushAt: state.lastPushAt ?? useSyncStore.getState().lastPushAt,
    })
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => useSyncStore.setState({ online: true }))
    window.addEventListener('offline', () => useSyncStore.setState({ online: false }))
  }
}
