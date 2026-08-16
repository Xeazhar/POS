import { formatSyncError } from './errors'

/** Shared sync-status copy/tone — used by Shell's sidebar chip and CashierDashboard's
 *  Sync status card so the two never describe the same state differently. */
export function syncCopy({ online, backendReachable, pending, status, lastError }) {
  const syncing = status === 'syncing' || status === 'pushing'
  if (!online) {
    return {
      label: pending ? `Offline · ${pending}` : 'Offline',
      detail: pending ? `${pending} saved locally` : 'No network',
      tone: 'off',
      isError: false,
    }
  }
  if (online && backendReachable === false && pending) {
    return {
      label: `${pending} queued`,
      detail: 'Server unreachable — will retry',
      tone: 'warn',
      isError: false,
    }
  }
  if (syncing) {
    return {
      label: 'Syncing…',
      detail: pending ? `${pending} queued` : 'Updating',
      tone: 'sync',
      isError: false,
    }
  }
  if (status === 'error' || lastError) {
    const formatted = formatSyncError(lastError)
    return {
      label: formatted.title,
      detail: formatted.body,
      hint: formatted.hint || '',
      tone: 'warn',
      isError: true,
    }
  }
  if (pending) {
    return {
      label: `${pending} queued`,
      detail: 'Waiting to sync',
      tone: 'warn',
      isError: false,
    }
  }
  return {
    label: 'Synced',
    detail: 'Up to date',
    tone: 'ok',
    isError: false,
  }
}

export const syncToneDot = {
  ok: 'bg-brand-sync-ok',
  sync: 'bg-brand-sync-busy animate-pulse',
  warn: 'bg-brand-sync-warn',
  off: 'bg-brand-sync-off',
}

export const syncToneText = {
  ok: 'text-brand-sync-ok',
  sync: 'text-brand-sync-busy-ink',
  warn: 'text-brand-sync-warn-ink',
  off: 'text-brand-sync-off-ink',
}
