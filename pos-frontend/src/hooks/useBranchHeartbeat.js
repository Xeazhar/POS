import { useEffect, useRef } from 'react'
import { heartbeatBranch, hasSupabase, reportBranchDevices } from '../lib/api'
import { getAllDeviceStatuses } from '../devices'
import { isOnline } from '../offline'

const HEARTBEAT_MS = 45_000

/**
 * Cashiers report branch network presence + device stub status while the app is open.
 * Managers do not heartbeat (avoids marking a shop online from HQ).
 */
export function useBranchHeartbeat(user) {
  const timerRef = useRef(null)

  useEffect(() => {
    if (!hasSupabase || !user?.branchId || user.role !== 'cashier') return undefined

    let cancelled = false

    const tick = async () => {
      if (cancelled || !isOnline()) return
      await heartbeatBranch({ branchId: user.branchId, staffId: user.id })
      try {
        const devices = await getAllDeviceStatuses()
        if (!cancelled) await reportBranchDevices(user.branchId, devices)
      } catch {
        /* stubs only */
      }
    }

    tick()
    timerRef.current = window.setInterval(tick, HEARTBEAT_MS)

    const onOnline = () => tick()
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      if (timerRef.current) window.clearInterval(timerRef.current)
      window.removeEventListener('online', onOnline)
    }
  }, [user?.branchId, user?.id, user?.role])
}
