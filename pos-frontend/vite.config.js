import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// package.json is the single source of truth for the app version. Deriving it here rather
// than duplicating it in an env var means the number shown in the UI, the number reported
// to audit_events, and the number in the shipped bundle can never disagree.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
)
const APP_VERSION = pkg.version

/**
 * Emit /version.json holding this build's identity, and serve the same shape in dev.
 *
 * An already-open tab has no way to know a new bundle was deployed — the PWA service
 * worker only swaps assets on the *next* navigation, so a POS left open on the counter
 * can keep running week-old code (and keep missing fixes) indefinitely. The client polls
 * this file and prompts a refresh when the value changes; see src/hooks/useAppVersion.js.
 *
 * Deliberately NOT in public/: a checked-in static file would have to be bumped by hand
 * and would silently go stale the one time someone forgets.
 */
function versionJsonPlugin() {
  // Two different things, deliberately:
  //   appVersion — the human-facing release number (package.json), shown in the UI.
  //   version    — the staleness token, unique per BUILD. It must be the build timestamp,
  //                not the semver: two deploys off the same version are still different
  //                bundles, and an open tab has to notice the second one.
  const buildId = new Date().toISOString()
  const body = { version: buildId, appVersion: APP_VERSION, builtAt: buildId }
  return {
    name: 'calepos-version-json',
    configureServer(server) {
      // Dev: same endpoint so the watchdog code path is exercised locally too.
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ ...body, dev: true }))
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(body),
      })
    },
  }
}

export default defineConfig({
  define: {
    // Baked into the bundle at build time — see src/utils/version.js.
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    tailwindcss(),
    versionJsonPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons.svg', 'pwa-192.png', 'pwa-512.png'],
      manifest: {
        name: 'CalePOS',
        short_name: 'CalePOS',
        description: 'Offline-first multi-branch point of sale',
        theme_color: '#202426',
        background_color: '#f7f7f5',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/pwa-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/pwa-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,svg,png,woff2}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            // The staleness probe itself must never be served from cache, or the tab
            // would compare its own build against a cached copy of its own build.
            urlPattern: ({ url }) => url.pathname === '/version.json',
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'calepos-pages',
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 },
              plugins: [
                {
                  // This route matches every navigation, so it always wins over the
                  // `navigateFallback` route below (Workbox uses the first matching
                  // route and never falls through to a later one on failure) — meaning
                  // navigateFallback never actually fires. Without this, a network miss
                  // on a URL not yet in `calepos-pages` (first-ever offline visit, or a
                  // route never opened before) fell through to the browser's own
                  // offline page (the dino) instead of the precached app shell.
                  handlerDidError: async () => (await caches.match('/index.html')) || Response.error(),
                },
              ],
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/assets/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'calepos-assets',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('xlsx')) return 'vendor-xlsx'
          if (id.includes('@supabase')) return 'vendor-supabase'
          if (id.includes('dexie')) return 'vendor-dexie'
          if (id.includes('react-icons')) return 'vendor-icons'
          if (id.includes('react-router')) return 'vendor-router'
          if (id.includes('zustand')) return 'vendor-zustand'
          if (id.includes('react-dom') || id.includes('/react/')) return 'vendor-react'
          return undefined
        },
      },
    },
  },
})
