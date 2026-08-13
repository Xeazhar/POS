/**
 * Run an async mapper over items with bounded concurrency — avoids stampeding
 * Supabase when a page fans out many parallel queries (promo stats, branch summaries).
 */
export async function mapLimit(items, limit, mapper) {
  const list = items || []
  if (!list.length) return []
  const cap = Math.max(1, Number(limit) || 1)
  const results = new Array(list.length)
  let next = 0

  async function worker() {
    while (next < list.length) {
      const i = next
      next += 1
      results[i] = await mapper(list[i], i)
    }
  }

  await Promise.all(Array.from({ length: Math.min(cap, list.length) }, () => worker()))
  return results
}

export default mapLimit
