import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

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
  // Build timestamp, not package.json version — the version field rarely changes, and a
  // deploy that didn't bump it would go undetected by every open tab.
  const version = new Date().toISOString()
  return {
    name: 'calepos-version-json',
    configureServer(server) {
      // Dev: same endpoint so the watchdog code path is exercised locally too.
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ version, dev: true }))
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ version, builtAt: new Date().toISOString() }),
      })
    },
  }
}

export default defineConfig({
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
        background_color: '#f4f5f2',
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
