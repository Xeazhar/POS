import { syncBranch } from './syncEngine'

let started = false
let currentBranchId = null

export function setSyncBranchId(branchId) {
  currentBranchId = branchId
}

export function startConnectivityWatcher() {
  if (started || typeof window === 'undefined') return
  started = true

  const run = () => {
    if (currentBranchId && navigator.onLine) {
      syncBranch(currentBranchId).catch(() => {})
    }
  }

  window.addEventListener('online', run)
  window.addEventListener('offline', () => {
    // UI listens via syncEngine subscribers / sync store
  })

  // Periodic retry for failed queue items
  window.setInterval(() => {
    if (currentBranchId && navigator.onLine) {
      syncBranch(currentBranchId).catch(() => {})
    }
  }, 60_000)
}
