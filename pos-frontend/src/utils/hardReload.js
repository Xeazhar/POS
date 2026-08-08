/**
 * Force the app to come back on the newest deployed build.
 *
 * `window.location.reload()` is not enough. This app ships a service worker that serves
 * precached assets, so a plain reload happily hands back the exact bundle already running —
 * which is why "Refresh" appeared to do nothing when an update was waiting. To actually
 * move to a new build we have to drop the caches the SW is serving from and make it check
 * for a new worker, then reload.
 *
 * SAFETY — read before changing:
 *
 *  - NEVER touch IndexedDB. It holds queued sales that have not reached Supabase yet
 *    (see src/offline/syncQueue.js). Clearing it destroys fiscal records. This function
 *    only clears Cache Storage, which holds nothing but re-downloadable assets.
 *
 *  - NEVER purge caches while offline. Cache Storage is the only copy of the app shell
 *    when there is no network — purging it offline would leave a blank screen on a till
 *    that is mid-shift. When offline we degrade to a plain reload, which still works
 *    because the SW serves the cached shell.
 */

/** Clear Cache Storage only. Returns how many caches were removed. */
async function purgeAssetCaches() {
  if (typeof caches === 'undefined') return 0
  const keys = await caches.keys()
  await Promise.all(keys.map((key) => caches.delete(key)))
  return keys.length
}

/** Ask every registered service worker to check for a newer version and take over. */
async function refreshServiceWorkers() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(
    registrations.map(async (registration) => {
      try {
        await registration.update()
        // The app builds with skipWaiting, but a worker that is already parked in
        // `waiting` needs a nudge to activate rather than sitting until every tab closes.
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' })
      } catch {
        /* a failed update must not block the reload */
      }
    }),
  )
}

/**
 * @param {object}  options
 * @param {boolean} options.online  when false, skips the cache purge (see SAFETY above)
 */
export async function hardReload({ online = true } = {}) {
  try {
    if (online) {
      await purgeAssetCaches()
      await refreshServiceWorkers()
    }
  } catch (err) {
    // Whatever happens, still reload — a stuck Refresh button is worse than a stale cache.
    console.warn('[hardReload] cache/SW refresh failed, reloading anyway', err)
  }
  // Cache-busted URL so even the HTML document itself is re-fetched rather than served
  // from the browser's own back/forward cache.
  const url = new URL(window.location.href)
  url.searchParams.set('_r', Date.now().toString(36))
  window.location.replace(url.toString())
}

export default hardReload
