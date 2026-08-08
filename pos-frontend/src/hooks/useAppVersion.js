import { useCallback, useEffect, useRef, useState } from 'react'
import { hardReload } from '../utils/hardReload'

/**
 * Detect that a newer build has been deployed while this tab stayed open.
 *
 * A terminal on the counter can go days without a reload, so it keeps running whatever
 * bundle it loaded on open — including bundles that predate a fix someone is actively
 * testing against. The service worker alone doesn't solve this: `skipWaiting` swaps
 * assets for the *next* navigation, which for a never-navigated SPA tab is never.
 *
 * /version.json is emitted per build (see versionJsonPlugin in vite.config.js). We read
 * it once on load to learn "which build am I", then re-read it periodically and whenever
 * the tab is looked at again. A difference means a deploy happened under us.
 *
 * Refresh is never forced while work is in progress — reloading mid-sale would drop the
 * cashier's cart. The caller passes `safeToReload`; when that's false we only show the
 * banner and wait for a tap.
 */
const POLL_MS = 60_000

export function useAppVersion({ safeToReload = true, autoReload = true } = {}) {
  const [updateReady, setUpdateReady] = useState(false)
  const loadedVersion = useRef(null)
  const safeRef = useRef(safeToReload)
  useEffect(() => {
    safeRef.current = safeToReload
  }, [safeToReload])

  const readVersion = useCallback(async () => {
    // Cache-busted + no-store: a cached response would compare the build to itself.
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`version.json ${res.status}`)
    const body = await res.json()
    return body?.version || null
  }, [])

  const check = useCallback(async () => {
    try {
      const version = await readVersion()
      if (!version) return
      if (loadedVersion.current == null) {
        loadedVersion.current = version
        return
      }
      if (version !== loadedVersion.current) setUpdateReady(true)
    } catch {
      // Offline or dev without the endpoint — staying on the current build is correct.
    }
  }, [readVersion])

  useEffect(() => {
    // Async: the setState lands in a later tick, not synchronously during the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const timer = window.setInterval(check, POLL_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [check])

  // Must be a HARD reload: the service worker would otherwise serve the same cached
  // bundle back and the banner would reappear forever. See utils/hardReload.js.
  const reload = useCallback(() => {
    void hardReload({ online: typeof navigator === 'undefined' ? true : navigator.onLine })
  }, [])

  // Auto-reload only when nothing would be lost — otherwise the banner waits for a tap.
  useEffect(() => {
    if (!updateReady || !autoReload || !safeRef.current) return undefined
    const t = window.setTimeout(() => {
      if (safeRef.current) void hardReload({ online: navigator.onLine })
    }, 3000)
    return () => window.clearTimeout(t)
  }, [updateReady, autoReload, safeToReload])

  return { updateReady, reload }
}

export default useAppVersion
