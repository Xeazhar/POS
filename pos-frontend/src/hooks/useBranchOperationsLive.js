import { useCallback } from 'react'
import { bootstrapBranchActivity, hasSupabase } from '../lib/api'
import { putDayEnds, putMovements, putTransactions } from '../offline/repository'
import { isOnline } from '../offline/syncEngine'
import { useInventoryStore } from '../stores/posStore'
import { useLiveData } from './useLiveData'

/**
 * Keep branch activity (day_ends, transactions, movements) fresh on staff terminals.
 *
 * Manager reopen / day-end submit / refunds emit OPERATIONS_CHANGED — but POS and
 * ShiftGate read `useInventoryStore.dayEnds`, which only refreshed on login/sync before.
 * Without this, cashiers stayed on "day closed" until a full reload.
 */
export async function refreshBranchActivity(branchId) {
  if (!hasSupabase || !branchId || !isOnline()) return null
  const activity = await bootstrapBranchActivity(branchId).catch(() => null)
  if (!activity) return null

  useInventoryStore.getState().hydrate({
    transactions: activity.transactions,
    movements: activity.movements,
    dayEnds: activity.dayEnds,
  })

  await Promise.all([
    putTransactions(branchId, activity.transactions),
    putMovements(branchId, activity.movements),
    putDayEnds(branchId, activity.dayEnds),
  ]).catch(() => {})

  return activity
}

export function useBranchOperationsLive(branchId) {
  const fetch = useCallback(async () => {
    await refreshBranchActivity(branchId)
  }, [branchId])

  useLiveData({
    enabled: hasSupabase && Boolean(branchId),
    fetch,
    broadcasts: branchId
      ? [
          {
            topic: `pos:branch:${branchId}:operations`,
            events: ['OPERATIONS_CHANGED'],
          },
        ]
      : [],
    pollMs: 15_000,
  })
}
