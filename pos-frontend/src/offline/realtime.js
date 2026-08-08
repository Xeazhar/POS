import { supabase, isConfigured } from '../lib/supabase'

/**
 * Live-update transport (Supabase Realtime), separate from the offline sync
 * queue in this folder. This is one-way (server → open tab): "something on
 * this table changed, go refetch" — it does not replace the queue/pull logic
 * that keeps IndexedDB and Postgres reconciled while offline.
 *
 * RLS gates delivery the same way it gates a normal SELECT, so a subscribed
 * client only ever receives events for rows it could already read.
 *
 * Requires `migrate_enable_realtime.sql` to have been run — if a table isn't
 * in the `supabase_realtime` publication, its channel just never fires
 * (silent no-op, not an error), which is fine: callers should still do the
 * one immediate fetch they'd do anyway and treat this as a nice-to-have.
 */

/** Reconnect backoff, in ms. Capped — a dead channel must keep retrying cheaply forever. */
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000]

const debugEnabled =
  typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

function log(...args) {
  if (debugEnabled) console.info('[realtime]', ...args)
}

/**
 * Subscribe to postgres_changes on one table. Returns an unsubscribe function.
 *
 * A raw `.subscribe()` is fire-and-forget: if the socket drops (laptop sleeps, wifi
 * flaps, Supabase restarts) the channel goes CHANNEL_ERROR/TIMED_OUT/CLOSED and simply
 * stops delivering, with no error surfaced anywhere — the tab looks fine and silently
 * serves stale data. So watch the status callback and rebuild the channel on failure.
 *
 * `onStatus` (optional) is called with each raw status, so a caller can force a refetch
 * on reconnect — events that fired while disconnected are gone, not replayed.
 */
export function subscribeTable({ table, filter, onChange, onStatus }) {
  if (!isConfigured || !supabase || !table || !onChange) return () => {}

  const label = `${table}${filter ? `[${filter}]` : ''}`
  let channel = null
  let retryTimer = null
  let attempt = 0
  let disposed = false

  const teardown = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    if (channel) {
      supabase.removeChannel(channel)
      channel = null
    }
  }

  const scheduleRetry = () => {
    if (disposed || retryTimer) return
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)]
    attempt += 1
    log(`${label}: reconnecting in ${delay}ms (attempt ${attempt})`)
    retryTimer = setTimeout(() => {
      retryTimer = null
      teardown()
      connect()
    }, delay)
  }

  const connect = () => {
    if (disposed) return
    channel = supabase
      .channel(`rt:${table}:${filter || 'all'}:${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter }, onChange)
      .subscribe((status) => {
        if (disposed) return
        log(`${label}: ${status}`)
        onStatus?.(status)
        if (status === 'SUBSCRIBED') {
          attempt = 0
          return
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          scheduleRetry()
        }
      })
  }

  connect()

  return () => {
    disposed = true
    teardown()
  }
}

/** Subscribe to several tables at once; returns one combined unsubscribe function. */
export function subscribeMany(subs = []) {
  const unsubs = subs.filter(Boolean).map((sub) => subscribeTable(sub))
  return () => unsubs.forEach((fn) => fn())
}

/**
 * Coalesce a burst of events (e.g. a manager adding a promo + several rules
 * in a row) into one trailing refetch instead of one per row change.
 */
export function debounce(fn, wait = 400) {
  let timer = null
  const debounced = (...args) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), wait)
  }
  debounced.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return debounced
}
