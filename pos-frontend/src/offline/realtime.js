import { supabase, isConfigured } from '../lib/supabase'

/**
 * Live-update transport (Supabase Realtime), separate from the offline sync
 * queue in this folder. This is one-way (server → open tab): "something
 * changed, go refetch" — it does not replace the queue/pull logic that keeps
 * IndexedDB and Postgres reconciled while offline.
 *
 * Primary path: private Broadcast on branch-scoped topics (see
 * migrate_realtime_broadcast_v1.sql). Payloads are notifications only —
 * authoritative state always comes from a subsequent secured fetch/RPC.
 *
 * Secondary path: postgres_changes (migrate_enable_realtime.sql) still used
 * where Broadcast triggers are not wired (e.g. promo rule child tables).
 *
 * Channel names are NOT a security boundary — Realtime Authorization +
 * realtime.messages RLS (staff_can_subscribe_branch / is_manager) gate delivery.
 */

/** Reconnect backoff, in ms. Capped — a dead channel must keep retrying cheaply forever. */
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000]

const debugEnabled =
  typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

function log(...args) {
  if (debugEnabled) console.info('[realtime]', ...args)
}

/** Ensure the Realtime socket carries the current JWT (required for private channels). */
export async function ensureRealtimeAuth() {
  if (!isConfigured || !supabase) return
  try {
    await supabase.realtime.setAuth()
  } catch (err) {
    log('setAuth failed', err)
  }
}

/**
 * Subscribe to postgres_changes on one table. Returns an unsubscribe function.
 *
 * Prefer subscribeBroadcast for inventory/ops. Keep this for tables without
 * Broadcast triggers or as an explicit fallback.
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

/**
 * Private Broadcast subscription. Topic must match server-side realtime.send
 * topics (e.g. pos:branch:<uuid>:inventory). Authorization is enforced by
 * RLS on realtime.messages — a forged topic name yields CHANNEL_ERROR / no events.
 *
 * @param {object} options
 * @param {string} options.topic
 * @param {string[]} [options.events] broadcast event names; default listens to common POS events
 * @param {Function} options.onEvent  (payload) => void — treat as "refetch signal" only
 * @param {Function} [options.onStatus]
 */
export function subscribeBroadcast({ topic, events, onEvent, onStatus }) {
  if (!isConfigured || !supabase || !topic || !onEvent) return () => {}

  const eventList =
    Array.isArray(events) && events.length > 0
      ? events
      : ['INVENTORY_CHANGED', 'CATALOG_CHANGED', 'OPERATIONS_CHANGED']

  const label = `bc:${topic}`
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
      void connect()
    }, delay)
  }

  const connect = async () => {
    if (disposed) return
    await ensureRealtimeAuth()
    if (disposed) return

    let builder = supabase.channel(topic, {
      config: { private: true },
    })
    for (const event of eventList) {
      builder = builder.on('broadcast', { event }, (message) => {
        // Never trust payload as authoritative inventory/finance state.
        onEvent(message?.payload ?? message)
      })
    }
    channel = builder.subscribe((status) => {
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

  void connect()

  return () => {
    disposed = true
    teardown()
  }
}

/** Branch inventory channel topic. */
export function branchInventoryTopic(branchId) {
  if (!branchId) return null
  return `pos:branch:${branchId}:inventory`
}

/** Branch operations channel topic. */
export function branchOperationsTopic(branchId) {
  if (!branchId) return null
  return `pos:branch:${branchId}:operations`
}

/** Manager network-wide operations inbox (RLS: is_manager only). */
export const NETWORK_OPERATIONS_TOPIC = 'pos:network:operations'

/** Subscribe to several postgres_changes tables; returns one combined unsubscribe. */
export function subscribeMany(subs = []) {
  const unsubs = subs.filter(Boolean).map((sub) => subscribeTable(sub))
  return () => unsubs.forEach((fn) => fn())
}

/** Subscribe to several private Broadcast topics. */
export function subscribeBroadcastMany(subs = []) {
  const unsubs = subs.filter(Boolean).map((sub) => subscribeBroadcast(sub))
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
