const { contextBridge } = require('electron')

/**
 * Phase 1 is online-only passthrough: no Node/IPC surface the renderer needs yet.
 * This bridge exists so later phases (hardware, local storage) have a place to add
 * channels without touching main.js's webPreferences again — contextIsolation stays
 * on, nodeIntegration stays off, nothing beyond this flag is exposed.
 *
 * CommonJS, not ESM: with `sandbox: true`, Electron's sandboxed preload loader does not
 * support `import`/`export` syntax regardless of the file's own or package.json's module
 * type — it errors with "Cannot use import statement outside a module" at load time.
 */
contextBridge.exposeInMainWorld('calepos', {
  isDesktop: true,
})
