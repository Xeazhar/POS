import { create } from 'zustand'
import { getSyncStatus, subscribeSync } from '../offline'

export const useSyncStore = create((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  status: 'idle',
  pending: 0,
  /** Ops quarantined after repeated push failures — real sales that never reached the server. */
  blocked: 0,
  lastError: null,
  refresh: async (branchId) => {
    const snap = await getSyncStatus(branchId)
    set({ online: snap.online, pending: snap.pending, blocked: snap.blocked || 0 })
  },
}))

let subscribed = false
export function bindSyncStore() {
  if (subscribed) return
  subscribed = true
  subscribeSync((state) => {
    useSyncStore.setState({
      online: state.online ?? useSyncStore.getState().online,
      status: state.status || 'idle',
      pending: state.pending ?? useSyncStore.getState().pending,
      blocked: state.blocked ?? useSyncStore.getState().blocked,
      lastError: state.lastError ?? null,
    })
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => useSyncStore.setState({ online: true }))
    window.addEventListener('offline', () => useSyncStore.setState({ online: false }))
  }
}
