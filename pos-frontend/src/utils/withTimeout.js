/**
 * Reject a promise if it does not settle within `ms`.
 * Prevents lie-fi / hung Supabase calls from blocking the UI forever.
 */
export function withTimeout(promise, ms = 15000, label = 'Request') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
