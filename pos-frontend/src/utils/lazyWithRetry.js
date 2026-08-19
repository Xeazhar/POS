import { lazy } from 'react'

const CHUNK_RELOAD_KEY = 'calepos_chunk_reload'

/**
 * Determines whether an error indicates a dynamic module or chunk-loading failure.
 * @param {*} err - The error to inspect.
 * @return {boolean} `true` if the error matches a known chunk-loading failure, `false` otherwise.
 */
export function isChunkLoadError(err) {
  const msg = String(err?.message || err || '')
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk [\d]+ failed|error loading dynamically imported module/i.test(
    msg,
  )
}

/**
 * Clears the session marker that tracks attempted chunk-error reloads.
 */
export function clearChunkReloadFlag() {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Creates a lazy-loaded React component that handles chunk-loading failures with one hard reload per session.
 * @param {Function} importFn - Function that loads the component module.
 * @returns {React.LazyExoticComponent} A lazy React component backed by the import function.
 */
export function lazyWithRetry(importFn) {
  return lazy(async () => {
    try {
      return await importFn()
    } catch (err) {
      if (!isChunkLoadError(err)) throw err
      // A chunk fetch fails with this same "failed to fetch" wording whether the deploy
      // moved on (needs a reload) or the device is simply offline and never cached this
      // page's chunk yet. Reloading cannot fix the offline case — it can only trigger an
      // unload/reload cycle that risks landing on the browser's own offline page instead
      // of the app. Let AppErrorBoundary show its offline-aware message instead; the
      // "Try again" button there covers the case where connectivity returns.
      if (typeof navigator !== 'undefined' && !navigator.onLine) throw err
      let tried = false
      try {
        tried = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1'
      } catch {
        /* ignore */
      }
      if (!tried) {
        try {
          sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
        } catch {
          /* ignore */
        }
        const { hardReload } = await import('./hardReload')
        await hardReload({ online: typeof navigator !== 'undefined' ? navigator.onLine : true })
      }
      throw err
    }
  })
}

export default lazyWithRetry
