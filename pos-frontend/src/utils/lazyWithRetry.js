import { lazy } from 'react'

const CHUNK_RELOAD_KEY = 'calepos_chunk_reload'

/** Stale PWA tabs often fail lazy imports after a deploy — recover once via hard reload. */
export function isChunkLoadError(err) {
  const msg = String(err?.message || err || '')
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk [\d]+ failed|error loading dynamically imported module/i.test(
    msg,
  )
}

export function clearChunkReloadFlag() {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * React.lazy wrapper: on chunk load failure, hard-reload once per tab session then retry.
 * If reload does not happen (offline probe fail), the error propagates to AppErrorBoundary.
 */
export function lazyWithRetry(importFn) {
  return lazy(async () => {
    try {
      return await importFn()
    } catch (err) {
      if (!isChunkLoadError(err)) throw err
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
