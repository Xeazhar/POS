import { useCallback, useEffect, useRef, useState } from 'react'
import { hardReload } from '../utils/hardReload'

/**
 * Detect that a newer build has been deployed while this tab stayed open, and make sure
 * the new bundle is actually on the device before we reload onto it.
 *
 * WHY THIS IS NOT AUTOMATIC
 * -------------------------
 * CalePOS installs as a PWA, so a terminal runs whatever bundle it loaded when the app
 * was opened — potentially days ago. Three separate things each fail to fix that on
 * their own:
 *
 *   1. The service worker's `skipWaiting` swaps assets on the NEXT navigation. A
 *      single-page app that never navigates never gets one, so "next navigation" is never.
 *   2. `registration.update()` is only called by the browser on navigation or roughly
 *      every 24h. Neither is good enough for a shop that needs today's fix today.
 *   3. A plain `location.reload()` is served by the service worker from cache, so it can
 *      hand back the identical bundle. (utils/hardReload.js exists for this reason.)
 *
 * So we poll /version.json — emitted fresh per build, see versionJsonPlugin in
 * vite.config.js — and on a change do BOTH halves:
 *
 *   a. tell the service worker to fetch and precache the new build, THEN
 *   b. hard-reload onto it.
 *
 * Doing (a) first matters on a POS specifically: it means the new assets are already on
 * the device when the reload happens, so a terminal on flaky shop wifi cannot get caught
 * halfway — reloading into a half-downloaded app on a counter mid-trade is worse than
 * running yesterday's build.
 *
 * Refresh is never forced while work is in progress — reloading mid-sale would drop the
 * cashier's cart. The caller passes `safeToReload`; when that's false we only show the
 * banner and wait for a tap.
 */
const POLL_MS = 60_000

const PRIME_TIMEOUT_MS = 15_000

/**
 * Ask the service worker to go fetch the new build now, rather than on its own schedule.
 *
 * Returns a promise the reload path AWAITS. Firing this and reloading on a fixed timer
 * regardless is what the precache step was meant to prevent: on the flaky shop wifi this
 * design exists for, a precache still in flight when the caches are purged lands the
 * terminal in a half-downloaded app mid-trade. Bounded by a timeout so a worker that never
 * settles cannot wedge the update permanently — after that we reload anyway, which is the
 * old behaviour and still better than staying stuck.
 */
function primeServiceWorker() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return Promise.resolve()
  const update = navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => Promise.all(registrations.map((r) => r.update())))
    .catch(() => {
      // A worker that refuses to update must not stop the banner appearing — the hard
      // reload purges caches anyway and will still land on the new build.
    })
  const timeout = new Promise((resolve) => setTimeout(resolve, PRIME_TIMEOUT_MS))
  return Promise.race([update, timeout])
}

export function useAppVersion({ safeToReload = true, autoReload = true } = {}) {
  const [updateReady, setUpdateReady] = useState(false)
  const loadedVersion = useRef(null)
  const primingRef = useRef(null)
  const safeRef = useRef(safeToReload)
  useEffect(() => {
    safeRef.current = safeToReload
  }, [safeToReload])

  const readVersion = useCallback(async () => {
    // Cache-busted + no-store: a cached response would compare the build to itself.
    // public/_headers sends no-store for this path too, so neither the browser nor the
    // CDN edge can defeat the check.
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
      if (version !== loadedVersion.current) {
        // Start the download before announcing the update, so that by the time anyone
        // taps Refresh the new build is usually already cached and the reload is instant.
        // The auto-reload path awaits this same promise rather than racing it.
        if (!primingRef.current) primingRef.current = primeServiceWorker()
        setUpdateReady(true)
      }
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
    // `focus` as well as `visibilitychange`: an installed PWA brought back from the app
    // switcher does not always fire a visibility change on every platform, and resuming
    // the app is exactly the moment we most want to check.
    window.addEventListener('focus', onVisible)
    // Coming back online after an outage — the poll during the outage failed silently, so
    // this is the first chance to learn about anything deployed while the shop was dark.
    window.addEventListener('online', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('online', onVisible)
    }
  }, [check])

  // Must be a HARD reload: the service worker would otherwise serve the same cached
  // bundle back and the banner would reappear forever. See utils/hardReload.js.
  // Waits for the precache first so we never reload onto a half-downloaded build.
  const reload = useCallback(async () => {
    await primingRef.current
    await hardReload({ online: typeof navigator === 'undefined' ? true : navigator.onLine })
  }, [])

  // Auto-reload only when nothing would be lost — otherwise the banner waits for a tap.
  useEffect(() => {
    if (!updateReady || !autoReload || !safeRef.current) return undefined
    let cancelled = false
    const t = window.setTimeout(async () => {
      // Await the precache rather than assuming 3s was enough for it.
      await primingRef.current
      // Re-checked after the await: the wait can be seconds, and a cashier may have
      // started ringing something up in the meantime. Reloading then would drop it.
      if (!cancelled && safeRef.current) void hardReload({ online: navigator.onLine })
    }, 3000)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [updateReady, autoReload, safeToReload])

  return { updateReady, reload }
}

export default useAppVersion
