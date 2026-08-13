/**
 * Map items asynchronously while limiting concurrent mapper calls.
 * @param {Array} items - The items to process.
 * @param {number} limit - The maximum number of concurrent mapper calls.
 * @param {Function} mapper - The function applied to each item and its index.
 * @return {Array} The mapped results in input order.
 */
export async function mapLimit(items, limit, mapper) {
  const list = items || []
  if (!list.length) return []
  const cap = Math.max(1, Number(limit) || 1)
  const results = new Array(list.length)
  let next = 0

  /**
   * Processes assigned items and stores their mapped results in input order.
   */
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
