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

  // Periodic retry — respects per-item backoff inside listPending
  window.setInterval(() => {
    if (currentBranchId && isDeviceOnline()) {
      drainQueueInBackground(currentBranchId).catch(() => {})
    }
  }, 30_000)
}
