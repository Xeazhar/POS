/**
 * App version, for display and for audit records.
 *
 * Sourced from package.json at build time (see the `define` block in vite.config.js), so
 * the number on screen, the number written to audit_events, and the shipped bundle can
 * never drift apart. Bump it in package.json — nowhere else.
 *
 * `VITE_APP_VERSION` still overrides, for the rare case of tagging a build without cutting
 * a package.json change (a hotfix rebuild, say).
 *
 * Versioning: MAJOR.MINOR.PATCH
 *   MAJOR — a change staff must be retrained on, or one that alters fiscal output
 *           (receipt format, tax computation, OR numbering)
 *   MINOR — new capability that doesn't change existing behaviour
 *   PATCH — bug fix, copy change, styling
 *
 * Not the same as the deploy-staleness token in /version.json, which is per-build: two
 * deploys of the same release are still different bundles and an open tab must notice.
 */

/* global __APP_VERSION__, __BUILD_TIME__ */

export const APP_VERSION =
  import.meta.env?.VITE_APP_VERSION ||
  (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev')

export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : null

/** "v1.2.0" — the form shown in the UI. */
export const APP_VERSION_LABEL = `v${APP_VERSION}`

/** "v1.2.0 · built 8 Aug 2026, 14:03" — for the About/support tooltip. */
export function buildStamp() {
  if (!BUILD_TIME) return APP_VERSION_LABEL
  const d = new Date(BUILD_TIME)
  if (Number.isNaN(d.getTime())) return APP_VERSION_LABEL
  return `${APP_VERSION_LABEL} · built ${d.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`
}
