/**
 * Distinguishes device network from backend reachability.
 * navigator.onLine alone is insufficient (Wi‑Fi without internet / API down).
 */
import * as api from '../lib/api'
import { withTimeout } from '../utils/withTimeout'

const CACHE_MS = 15_000
const PING_TIMEOUT_MS = 8000

let cache = { at: 0, reachable: false }

export function isDeviceOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

/** Lightweight Supabase probe — cached to avoid hammering on every sync tick. */
export async function checkBackendReachable(force = false) {
  if (!isDeviceOnline() || !api.hasSupabase) {
    cache = { at: Date.now(), reachable: false }
    return false
  }
  const now = Date.now()
  if (!force && now - cache.at < CACHE_MS) return cache.reachable
  try {
    await withTimeout(api.pingBackend(), PING_TIMEOUT_MS, 'Backend ping')
    cache = { at: now, reachable: true }
    if (typeof console !== 'undefined' && import.meta.env?.DEV) {
      console.info('[SYNC] backend reachable')
    }
    return true
  } catch (err) {
    cache = { at: now, reachable: false }
    if (typeof console !== 'undefined' && import.meta.env?.DEV) {
      console.warn('[SYNC] backend unreachable', err?.message || err)
    }
    return false
  }
}

/** True when push/pull to Supabase is worth attempting. */
export async function canSyncWithBackend(force = false) {
  if (!isDeviceOnline()) return false
  return checkBackendReachable(force)
}

export function invalidateReachabilityCache() {
  cache = { at: 0, reachable: false }
}
