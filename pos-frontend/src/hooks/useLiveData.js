import { useEffect, useRef } from 'react'
import {
  debounce,
  subscribeBroadcastMany,
  subscribeMany,
} from '../offline/realtime'

/**
 * Keep one piece of server data fresh in an open tab, using every signal available
 * instead of trusting any single one.
 *
 * A POS runs for a whole shift without a reload, so "fetch on mount" is not enough —
 * a manager's price/promo/discount edit has to reach the counter *now*. Each layer
 * below covers a different way the layer above fails:
 *
 *   1. private Broadcast     — preferred fast path (migrate_realtime_broadcast_v1.sql).
 *      Minimal payloads; always followed by a secured refetch. Not a source of truth.
 *   2. postgres_changes      — secondary path for tables without Broadcast triggers
 *      (e.g. promo_rules). Still RLS-gated.
 *   3. visibility / online   — refetch when the tab is looked at again or the network
 *      returns. Covers gaps: neither Broadcast nor postgres_changes replay missed events.
 *   4. interval poll         — last-resort safety net (minutes, not seconds).
 *
 * Not a data store: the caller owns where the fetched data goes. This only decides
 * *when* to call `fetch`.
 *
 * @param {object}   options
 * @param {Function} options.fetch     async () => void — does the refetch + state write
 * @param {Array}    [options.broadcasts] [{ topic, events? }] private Broadcast topics
 * @param {Array}    [options.tables]  [{ table, filter, match? }] postgres_changes (optional
 *   fallback). `match(payload)` is an optional client-side guard for tables that have no
 *   column to filter on server-side (e.g. child tables without branch_id) — return false to
 *   drop an irrelevant event instead of refetching. Read from a ref each event, so it can
 *   close over the latest component state without forcing a resubscribe.
 * @param {boolean}  options.enabled   skip everything when false (no branch/session yet)
 * @param {number}   options.pollMs    fallback interval; 0 disables
 * @param {number}   options.debounceMs coalesce bursts
 */
export function useLiveData({
  fetch,
  broadcasts = [],
  tables = [],
  enabled = true,
  pollMs = 5 * 60_000,
  debounceMs = 400,
}) {
  const fetchRef = useRef(fetch)
  useEffect(() => {
    fetchRef.current = fetch
  }, [fetch])

  const tablesRef = useRef(tables)
  useEffect(() => {
    tablesRef.current = tables
  }, [tables])

  const tableKey = JSON.stringify(tables.map((t) => [t?.table, t?.filter || '']))
  const broadcastKey = JSON.stringify(
    broadcasts.map((b) => [b?.topic || '', ...(b?.events || [])]),
  )

  useEffect(() => {
    if (!enabled) return undefined
    const subs = JSON.parse(tableKey).map(([table, filter]) => ({
      table,
      filter: filter || undefined,
    }))
    const bcSubs = JSON.parse(broadcastKey).map((entry) => {
      const [topic, ...events] = entry
      return {
        topic,
        events: events.length ? events : undefined,
      }
    }).filter((b) => b.topic)

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
    const onStatus = (status) => {
      if (status === 'SUBSCRIBED') debouncedRun()
    }

    const unsubTables = subscribeMany(
      subs.map((sub, i) => ({
        ...sub,
        onChange: (payload) => {
          const match = tablesRef.current[i]?.match
          if (match && !match(payload)) return
          debouncedRun(payload)
        },
        onStatus,
      })),
    )
    const unsubBroadcast = subscribeBroadcastMany(
      bcSubs.map((sub) => ({
        ...sub,
        onEvent: debouncedRun,
        onStatus,
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
      unsubTables()
      unsubBroadcast()
    }
  }, [enabled, tableKey, broadcastKey, pollMs, debounceMs])
}

export default useLiveData
