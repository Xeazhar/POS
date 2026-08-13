/**
 * Per-staff sidebar order on this till.
 *
 * Stored in localStorage (not the server): it is a display preference, it must work
 * offline, and two people sharing a terminal should not inherit each other's layout.
 * `staffHomePath` still uses the role default — rearranging the menu does not change
 * where login lands.
 */

const PREFIX = 'cale-nav-order:'

export function navOrderStorageKey(userId) {
  return `${PREFIX}${userId || 'anon'}`
}

export function loadNavOrder(userId) {
  if (!userId || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(navOrderStorageKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) return null
    return parsed
  } catch {
    return null
  }
}

export function saveNavOrder(userId, paths) {
  if (!userId || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(navOrderStorageKey(userId), JSON.stringify(paths))
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearNavOrder(userId) {
  if (!userId || typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(navOrderStorageKey(userId))
  } catch {
    /* ignore */
  }
}

/** Apply a saved path list. Unknown/new modules keep their default relative order at the end. */
export function applyNavOrder(links, orderPaths) {
  if (!orderPaths?.length) return links
  const remaining = new Map(links.map((link) => [link[0], link]))
  const ordered = []
  for (const path of orderPaths) {
    const link = remaining.get(path)
    if (!link) continue
    ordered.push(link)
    remaining.delete(path)
  }
  for (const link of links) {
    if (remaining.has(link[0])) ordered.push(link)
  }
  return ordered
}

export function moveNavPath(paths, from, to) {
  if (from === to || from < 0 || to < 0 || from >= paths.length || to >= paths.length) return paths
  const next = paths.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}
