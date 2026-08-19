import { useEffect, useRef } from 'react'
import { fetchBranchDeviceSettings, heartbeatBranch, hasSupabase, reportBranchDevices } from '../lib/api'
import { getAllDeviceStatuses, normalizeDeviceSettings } from '../devices'
import { isOnline } from '../offline'
import { useAuthStore } from '../stores/posStore'
import { isManagerRole } from '../utils/roles'

const HEARTBEAT_MS = 45_000

/**
 * Cashiers and supervisors report branch network presence + device stub status while
 * the app is open. Also refreshes manager device on/off flags so tills pick up changes
 * without re-login. Managers/masters do not heartbeat (avoids marking a shop online from HQ).
 */
export function useBranchHeartbeat(user) {
  const timerRef = useRef(null)

  useEffect(() => {
    if (!hasSupabase || !user?.branchId || isManagerRole(user.role)) return undefined

    let cancelled = false

    const tick = async () => {
      if (cancelled || !isOnline()) return
      try {
        await heartbeatBranch({ branchId: user.branchId, staffId: user.id })
      } catch {
        // navigator.onLine can read true on dead wifi — an unreachable backend here must
        // not throw past this tick, or it becomes an unhandled rejection on every retry.
        return
      }
      try {
        const remoteSettings = await fetchBranchDeviceSettings(user.branchId)
        const settings = normalizeDeviceSettings(remoteSettings ?? user.deviceSettings)
        if (remoteSettings != null && !cancelled) {
          const current = useAuthStore.getState().user
          if (current?.branchId === user.branchId) {
            useAuthStore.setState({
              user: { ...current, deviceSettings: settings },
            })
          }
        }
        const devices = await getAllDeviceStatuses(settings)
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
