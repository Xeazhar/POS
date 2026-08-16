import { drainQueueInBackground } from './syncEngine'
import { canSyncWithBackend, invalidateReachabilityCache, isDeviceOnline } from './reachability'

let started = false
let currentBranchId = null
let syncDebounce = null

export function setSyncBranchId(branchId) {
  currentBranchId = branchId
}

export function startConnectivityWatcher() {
  if (started || typeof window === 'undefined') return
  started = true

  const run = () => {
    if (!currentBranchId || !isDeviceOnline()) return
    invalidateReachabilityCache()
    if (syncDebounce) window.clearTimeout(syncDebounce)
    syncDebounce = window.setTimeout(() => {
      syncDebounce = null
      drainQueueInBackground(currentBranchId).catch(() => {})
    }, 400)
  }

  window.addEventListener('online', run)
  window.addEventListener('offline', () => {
    invalidateReachabilityCache()
    if (syncDebounce) {
      window.clearTimeout(syncDebounce)
      syncDebounce = null
    }
  })

  // Counter terminals stay open for days with the tab backgrounded — no reason to keep
  // pinging the backend every 30s while nobody's looking. Resync immediately on refocus
  // instead so nothing goes stale longer than the time the tab was actually hidden.
  const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
  document.addEventListener?.('visibilitychange', () => {
    if (!isHidden() && currentBranchId && isDeviceOnline()) {
      drainQueueInBackground(currentBranchId).catch(() => {})
    }
  })

  // Periodic retry — respects per-item backoff inside listPending
  window.setInterval(() => {
    if (currentBranchId && isDeviceOnline() && !isHidden()) {
      drainQueueInBackground(currentBranchId).catch(() => {})
    }
  }, 30_000)
}
