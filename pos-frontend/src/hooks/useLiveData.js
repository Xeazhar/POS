import { useEffect, useRef } from 'react'
import { debounce, subscribeMany } from '../offline/realtime'

/**
 * Keep one piece of server data fresh in an open tab, using every signal available
 * instead of trusting any single one.
 *
 * A POS runs for a whole shift without a reload, so "fetch on mount" is not enough —
 * a manager's price/promo/discount edit has to reach the counter *now*. Each layer
 * below covers a different way the layer above fails:
 *
 *   1. realtime subscription  — the fast path (sub-second), but silently dead if the
 *      table isn't in the `supabase_realtime` publication, or if the socket dropped
 *      while the laptop was asleep.
 *   2. visibility / online    — refetch the moment the tab is looked at again or the
 *      network returns. Covers everything realtime missed while disconnected, since
 *      postgres_changes does not replay events from the gap.
 *   3. interval poll          — last-resort safety net (minutes, not seconds). Only
 *      matters when 1 and 2 have both failed.
 *
 * Not a data store: the caller owns where the fetched data goes. This only decides
 * *when* to call `fetch`.
 *
 * @param {object}   options
 * @param {Function} options.fetch     async () => void — does the refetch + state write
 * @param {Array}    options.tables    [{ table, filter }] to subscribe to
 * @param {boolean}  options.enabled   skip everything when false (no branch/session yet)
 * @param {number}   options.pollMs    fallback interval; 0 disables
 * @param {number}   options.debounceMs coalesce bursts (a promo + its rules insert together)
 */
export function useLiveData({
  fetch,
  tables = [],
  enabled = true,
  pollMs = 5 * 60_000,
  debounceMs = 400,
}) {
  // Keep the latest fetch in a ref so an inline arrow from the caller doesn't tear
  // down and rebuild the subscription on every render.
  const fetchRef = useRef(fetch)
  useEffect(() => {
    fetchRef.current = fetch
  }, [fetch])

  // Subscriptions are keyed off table+filter only: re-subscribing is expensive
  // (new websocket channel + re-auth) and must not happen just because a parent
  // re-rendered with a fresh array literal.
  const tableKey = JSON.stringify(tables.map((t) => [t?.table, t?.filter || '']))

  useEffect(() => {
    if (!enabled) return undefined
    const subs = JSON.parse(tableKey).map(([table, filter]) => ({
      table,
      filter: filter || undefined,
    }))

    let disposed = false
    const run = async () => {
      if (disposed) return
      try {
        await fetchRef.current()
      } catch (err) {
        console.warn('[useLiveData] refetch failed', err)
      }
    }

    void run()

    const debouncedRun = debounce(run, debounceMs)
    const unsubscribe = subscribeMany(
      subs.map((sub) => ({
        ...sub,
        onChange: debouncedRun,
        // A reconnect means we were deaf for a while — pull once immediately rather
        // than waiting for the next change event, which may never come.
        onStatus: (status) => {
          if (status === 'SUBSCRIBED') debouncedRun()
        },
      })),
    )

    const onVisible = () => {
      if (document.visibilityState === 'visible') void run()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    window.addEventListener('online', run)

    const timer = pollMs > 0 ? window.setInterval(run, pollMs) : null

    return () => {
      disposed = true
      if (timer) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      window.removeEventListener('online', run)
      debouncedRun.cancel()
      unsubscribe()
    }
  }, [enabled, tableKey, pollMs, debounceMs])
}

export default useLiveData
