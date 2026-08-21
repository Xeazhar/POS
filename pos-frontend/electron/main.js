import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, Menu, shell } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RENDERER_DIR = path.join(__dirname, '..', 'dist-desktop')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serves the built renderer (dist-desktop/) over a real http://127.0.0.1 loopback origin
 * instead of a custom app:// scheme. Cloudflare Turnstile validates the *top-level* page's
 * origin even when the widget itself is hosted elsewhere, and it flatly doesn't support
 * custom URL schemes as an allowed domain (confirmed via error 110200 when app://calepos
 * was tried) — 127.0.0.1 is a real hostname that can be added to Turnstile's Hostname
 * Management for the sitekey. Bound to loopback only, never 0.0.0.0, so it's not reachable
 * from the network. Falls back to index.html for any path that isn't a real file, giving
 * react-router-dom's BrowserRouter (History API) the same SPA-fallback semantics
 * wrangler.jsonc's `not_found_handling: single-page-application` gives the web deploy.
 */
function startRendererServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let reqPath = decodeURIComponent(req.url.split('?')[0])
      if (reqPath === '/') reqPath = '/index.html'

      const resolved = path.normalize(path.join(RENDERER_DIR, reqPath))
      const filePath = resolved.startsWith(RENDERER_DIR) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
        ? resolved
        : path.join(RENDERER_DIR, 'index.html')

      const ext = path.extname(filePath).toLowerCase()
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
      fs.createReadStream(filePath).pipe(res)
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// Two windows against the same session risk double-submitting a sale / consuming a
// second sequential invoice number for one transaction — keep this a single instance.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  const isDev = !app.isPackaged

  // Without an explicit AppUserModelId, Windows can group/taskbar-identify the app as
  // "Electron" instead of "CalePOS" — most visible when running unpackaged in dev, but
  // cheap insurance for packaged installs too. Must match electron-builder's `appId`.
  app.setAppUserModelId('com.calepos.desktop')

  const createWindow = (origin) => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#f7f7f5',
      // Packaged builds get their icon from the .exe resource electron-builder embeds
      // (Task 1); this only matters for `npm run electron:start`'s unpackaged dev run.
      icon: isDev ? path.join(__dirname, '..', 'resources', 'icon.png') : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })

    if (isDev) win.webContents.openDevTools({ mode: 'detach' })

    // No legitimate use of window.open()/target=_blank today; deny it, and hand any
    // real https link (e.g. a future "view invoice" style feature) to the OS browser
    // rather than opening a second Electron window.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })

    // Keep top-level navigation inside the packaged app's own origin.
    const appOrigin = new URL(origin)
    win.webContents.on('will-navigate', (event, url) => {
      let target
      try {
        target = new URL(url)
      } catch {
        event.preventDefault()
        return
      }
      const sameOrigin =
        target.protocol === appOrigin.protocol &&
        target.hostname === appOrigin.hostname &&
        target.port === appOrigin.port
      if (!sameOrigin) {
        event.preventDefault()
        if (target.protocol === 'http:' || target.protocol === 'https:') shell.openExternal(target.href)
      }
    })

    win.loadURL(origin)

    return win
  }

  app.whenReady().then(async () => {
    const { port } = await startRendererServer()
    const origin = `http://127.0.0.1:${port}`

    // POS terminal, not a document editor — no File/Edit/View menu bar.
    Menu.setApplicationMenu(null)
    createWindow(origin)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(origin)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
