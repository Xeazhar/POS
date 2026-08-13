import { useCallback } from 'react'
import { bootstrapBranchActivity, hasSupabase } from '../lib/api'
import { putDayEnds, putMovements, putTransactions } from '../offline/repository'
import { isOnline } from '../offline/syncEngine'
import { useInventoryStore } from '../stores/posStore'
import { useLiveData } from './useLiveData'

/**
 * Refreshes branch transactions, movements, and day-end records for the current device.
 * @param {string} branchId - The branch whose activity should be refreshed.
 * @return {Object|null} The refreshed activity data, or `null` when the refresh is unavailable or fails.
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

/**
 * Keeps branch operational data synchronized through live updates and periodic polling.
 * @param {string} branchId - The identifier of the branch to synchronize.
 */
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
