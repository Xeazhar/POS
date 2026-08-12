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
 *
 *  - NEVER purge caches while a service worker is still controlling the page without
 *    unregistering it first. `/assets/*` is CacheFirst — after an empty purge the SW
 *    answers JS/CSS requests from a dead cache and the POS paints a blank/crashed page.
 *    Sequence: prove network → unregister SW → purge → reload (SW re-registers on boot).
 */

import { markIntentionalReload } from '../offline/sessionLifecycle'

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

async function unregisterServiceWorkers() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister().catch(() => {})))
}

/** Confirm the deploy origin can still serve the app shell (CDN up, not just Wi‑Fi). */
async function probeAppShell() {
  const url = `${window.location.origin}/index.html?_hard=${Date.now()}`
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
  if (!res.ok) throw new Error(`App shell unreachable (${res.status})`)
}

/**
 * @param {object}  options
 * @param {boolean} options.online  when false, skips the cache purge (see SAFETY above)
 */
export async function hardReload({ online = true } = {}) {
  // MUST come first, and must happen even if the cache work below throws: without it the
  // reload is mistaken for "the browser was closed and reopened", which signs the user out,
  // clears their offline unlock verifier, and strands an open shift. See
  // offline/sessionLifecycle.js consumeBrowserClosedFlag.
  markIntentionalReload()

  try {
    if (online) {
      // Prove network before wiping. navigator.onLine alone is not enough — Wi‑Fi with a
      // dead CDN used to purge caches and then crash the till on reload.
      await probeAppShell()
      // Drop the controller before emptying Cache Storage so CacheFirst asset routes
      // cannot serve empty-cache failures on the next load.
      await unregisterServiceWorkers()
      await purgeAssetCaches()
    } else {
      await refreshServiceWorkers()
    }
  } catch (err) {
    // Whatever happens, still reload — but leave existing caches alone if the probe failed.
    console.warn('[hardReload] cache/SW refresh failed, reloading with existing cache', err)
  }

  // location.reload(), not replace() with a cache-busting query. Two reasons:
  //   - it reports navigation type 'reload', which is the session-lifecycle check's own
  //     second line of defence if the flag above ever fails to stick;
  //   - it leaves the URL clean instead of accumulating ?_r= on every refresh.
  // The freshness the query param bought is already covered: the service worker is what
  // serves stale assets here, and its caches were just purged (when online + probe ok).
  window.location.reload()
}

export default hardReload
