# Windows Desktop Phase 2 — Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing CalePOS Electron/Windows wrapper look and behave like a real
Windows desktop app — correct icon/identity everywhere, working shortcuts/uninstall, hardened
single-instance focus behavior, and window-state persistence — while staying strictly
online-only and touching nothing outside `electron/`, the `build`/`nsis` block of
`package.json`, and the Electron section of `docs/CODEMAP.md`.

**Architecture:** No new subsystems. `electron/main.js` gains two small, self-contained
additions (an `app.setAppUserModelId()` call, a `electron/windowState.js` module it imports)
and one one-line hardening fix. `package.json`'s `build.win`/`build.nsis` blocks gain an
`icon` path and explicit shortcut/uninstall naming. Everything else in the existing Phase 1
wrapper (loopback HTTP renderer server, security `webPreferences`, navigation guards, preload
surface) is unmodified.

**Tech Stack:** Electron 43, electron-builder 26 (NSIS target), no new dependencies.

**Spec:** `docs/superpowers/plans/2026-08-21-windows-desktop-phase2-polish-spec.md`

## Global Constraints

- Online-only. No offline/SQLite/sync/hardware/USB-update work of any kind.
- Preserve exactly: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, the `will-navigate`/`setWindowOpenHandler` guards, the single
  `window.calepos.isDesktop` preload surface. No new IPC channels. No Node exposure to the
  renderer. No DevTools in production builds.
- No Turnstile changes of any kind — document as a known blocker only, never work around it.
- No new npm dependencies (icon conversion and window-state tracking are both hand-rolled;
  electron-builder's built-in PNG→ICO conversion covers the icon).
- Do not touch: `src/` business logic, `src/lib/api.js`, stores, Supabase schema/migrations,
  `android/`/Capacitor config, `wrangler.jsonc`, the web build's `VitePWA` config.
- Version stays single-sourced from `package.json`. Per `CLAUDE.md`, do not bump the version
  number without the user explicitly accepting/prompting for it in this session — Task 7 is
  gated on that and must not run unattended.
- No automated test suite exists in this repo (`CLAUDE.md` confirms). Verification throughout
  is `npm run build` / `npm run build:desktop` plus manual exercise of the built app, matching
  how this repo is verified elsewhere.

---

### Task 1: Windows packaging identity — icon + shortcut/uninstall naming

**Files:**
- Modify: `pos-frontend/package.json:58-82` (the `build` block)

**Interfaces:**
- Consumes: `resources/icon.png` (existing file, 2732×2732 PNG, confirmed present — no new
  asset needed).
- Produces: `release/CalePOS-Setup.exe` with the CalePOS icon baked in, used by Task 6's
  verification pass.

- [ ] **Step 1: Add `icon` and `executableName` to `build.win`, and shortcut/uninstall naming to `build.nsis`**

Replace the current `win` and `nsis` blocks in `pos-frontend/package.json`:

```json
    "win": {
      "target": "nsis"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
```

with:

```json
    "win": {
      "target": "nsis",
      "icon": "resources/icon.png",
      "executableName": "CalePOS"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "CalePOS",
      "uninstallDisplayName": "CalePOS ${version}"
    }
```

`appId`, `productName`, and `artifactName` above this block are already correct
(`com.calepos.desktop` / `CalePOS` / `CalePOS-Setup.${ext}`) — do not change them.
electron-builder generates the multi-resolution `.ico` from the single PNG automatically at
build time (no ImageMagick or extra tooling needed); a 2732×2732 square source is well above
its 256×256 minimum.

- [ ] **Step 2: Build the desktop installer and confirm electron-builder accepts the icon config**

Run: `npm run build:desktop` (from `pos-frontend/`)

Expected: build completes with no icon-related error/warning, and produces
`release/CalePOS-Setup.exe` plus an unpacked `release/win-unpacked/CalePOS.exe`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build(desktop): wire CalePOS icon into electron-builder packaging"
```

---

### Task 2: AppUserModelId + dev-mode window icon

**Files:**
- Modify: `pos-frontend/electron/main.js:76` (right after `const isDev = !app.isPackaged`)
- Modify: `pos-frontend/electron/main.js:78-93` (the `createWindow` `BrowserWindow` options)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — this is a self-contained taskbar-identity fix.

- [ ] **Step 1: Set the AppUserModelId early, before any window is created**

In `electron/main.js`, immediately after:

```js
  const isDev = !app.isPackaged
```

add:

```js

  // Without an explicit AppUserModelId, Windows can group/taskbar-identify the app as
  // "Electron" instead of "CalePOS" — most visible when running unpackaged in dev, but
  // cheap insurance for packaged installs too. Must match electron-builder's `appId`.
  app.setAppUserModelId('com.calepos.desktop')
```

- [ ] **Step 2: Give the window an explicit icon in dev mode**

`resources/icon.png` is not bundled into the packaged app (it's not listed in `build.files`,
and doesn't need to be — the packaged `.exe` already carries the icon electron-builder baked
in via Task 1). In an unpackaged dev run there is no such `.exe` resource, so `BrowserWindow`
falls back to Electron's default icon unless told otherwise. In `createWindow`, change:

```js
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#f7f7f5',
      webPreferences: {
```

to:

```js
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
```

(Task 3 replaces `width`/`height` here with window-state values — this step's `icon` line is
what survives into the final file.)

- [ ] **Step 3: Verify in dev mode**

Run: `cross-env VITE_DESKTOP_BUILD=true npm run build && npm run electron:start` (from
`pos-frontend/`)

Expected: window opens with the CalePOS icon (bear-and-monitor artwork) in its taskbar
entry/title bar, not Electron's default icon.

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "fix(desktop): set AppUserModelId and dev-mode window icon for correct taskbar identity"
```

---

### Task 3: Window-state persistence

**Files:**
- Create: `pos-frontend/electron/windowState.js`
- Modify: `pos-frontend/electron/main.js:78-93` (the `createWindow` function, building on
  Task 2's edit)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadWindowState(): { width: number, height: number, x: number|undefined,
  y: number|undefined, isMaximized: boolean }` and `trackWindowState(win: BrowserWindow): void`
  — both imported by `main.js`, not used anywhere else.

- [ ] **Step 1: Create `electron/windowState.js`**

```js
import fs from 'node:fs'
import path from 'node:path'
import { app, screen } from 'electron'

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

const DEFAULT_STATE = { width: 1280, height: 800, x: undefined, y: undefined, isMaximized: false }

// How much of a saved window rect must land on some real display before we trust it.
const MIN_VISIBLE_PX = 100

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
      return { ...DEFAULT_STATE }
    }
    return { ...DEFAULT_STATE, ...parsed }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

// A saved x/y is worthless once the monitor it was on has been unplugged, resized, or
// rearranged. Trust it only if a meaningful chunk of the saved rect still overlaps some
// display's work area today.
function fitsOnADisplay(state) {
  if (typeof state.x !== 'number' || typeof state.y !== 'number') return false
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height }
  return screen.getAllDisplays().some((display) => {
    const d = display.workArea
    const overlapWidth = Math.min(rect.x + rect.width, d.x + d.width) - Math.max(rect.x, d.x)
    const overlapHeight = Math.min(rect.y + rect.height, d.y + d.height) - Math.max(rect.y, d.y)
    return overlapWidth >= MIN_VISIBLE_PX && overlapHeight >= MIN_VISIBLE_PX
  })
}

export function loadWindowState() {
  const state = readState()
  if (!fitsOnADisplay(state)) {
    state.x = undefined
    state.y = undefined
  }
  return state
}

// Window position/size is a convenience, never sensitive app data — nothing here is a
// session token, sale record, or credential, so a failed read/write must never interrupt
// the POS session, only silently fall back to defaults.
export function trackWindowState(win) {
  let saveTimer = null

  const save = () => {
    if (win.isDestroyed()) return
    const isMaximized = win.isMaximized()
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds()
    const state = { ...bounds, isMaximized }
    try {
      fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
      fs.writeFileSync(stateFile(), JSON.stringify(state))
    } catch {
      // Best-effort only — see comment above.
    }
  }

  const scheduleSave = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 500)
  }

  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('close', () => {
    clearTimeout(saveTimer)
    save()
  })
}
```

- [ ] **Step 2: Wire it into `createWindow` in `electron/main.js`**

Add the import near the top, with the other imports:

```js
import { loadWindowState, trackWindowState } from './windowState.js'
```

Change the `createWindow` function (building on Task 2's `icon` addition) from:

```js
  const createWindow = (origin) => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#f7f7f5',
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
```

to:

```js
  const createWindow = (origin) => {
    const state = loadWindowState()

    const win = new BrowserWindow({
      width: state.width,
      height: state.height,
      x: state.x,
      y: state.y,
      minWidth: 1024,
      minHeight: 640,
      backgroundColor: '#f7f7f5',
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

    if (state.isMaximized) win.maximize()
    trackWindowState(win)

    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
```

Nothing else in `createWindow` (the window-open handler, `will-navigate` guard, `loadURL`
call) changes.

- [ ] **Step 3: Verify persistence manually**

Run: `cross-env VITE_DESKTOP_BUILD=true npm run build && npm run electron:start`

Steps: resize and move the window, close it, relaunch with the same command.

Expected: window reopens at the same size/position as when it was closed.

- [ ] **Step 4: Verify invalid-position fallback**

With the app closed, open `%APPDATA%/calepos/window-state.json` (or the printed
`app.getPath('userData')` path) and edit `x`/`y` to something absurd, e.g. `-50000`. Relaunch.

Expected: window opens at the default centered position/size (1280×800), not off-screen.

- [ ] **Step 5: Commit**

```bash
git add electron/windowState.js electron/main.js
git commit -m "feat(desktop): persist window size/position with invalid-display fallback"
```

---

### Task 4: Single-instance focus hardening

**Files:**
- Modify: `pos-frontend/electron/main.js:68-74`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add an explicit `show()` alongside `restore()`/`focus()`**

The existing handler only handles a *minimized* window; a window that's merely hidden
(`win.hide()` was never called anywhere today, but this closes the gap defensively and costs
nothing) wouldn't otherwise reappear on `focus()` alone. Change:

```js
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
```

to:

```js
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
```

- [ ] **Step 2: Verify**

Run: `npm run build:desktop`, then launch `release/win-unpacked/CalePOS.exe` twice in a row
(double-click it, wait for the window, double-click it again).

Expected: the second launch does not open a new window — the existing CalePOS window comes to
the foreground and gets focus. Only one `CalePOS.exe` entry in Task Manager's Details tab.

- [ ] **Step 3: Commit**

```bash
git add electron/main.js
git commit -m "fix(desktop): explicitly show() the existing window on second-instance launch"
```

---

### Task 5: Documentation sync — `docs/CODEMAP.md`

**Files:**
- Modify: `pos-frontend/docs/CODEMAP.md` (extends the existing "Windows desktop packaging
  (Electron)" section, currently ~lines 149–224)

**Interfaces:**
- Consumes: the final state of Tasks 1–4 (write this after they're done, so the doc describes
  what actually landed, not what was planned).
- Produces: nothing — this is the terminal documentation task for this plan's code changes.

- [ ] **Step 1: Add a row to the file table and new subsections**

In the `| Piece | File |` table (~line 156-161), add a row:

```
| Window-state persistence | `electron/windowState.js` |
```

After the existing "Turnstile" subsection and before the `---` (~line 224), add:

```markdown
**Identity & icon**: `build.win.icon` (`package.json`) points electron-builder at
`resources/icon.png` (the same 2732×2732 branding PNG Capacitor/Android already uses);
electron-builder generates the multi-resolution `.ico` from it at build time — no separate
`.ico` asset is checked in. `build.win.executableName` and `build.nsis.shortcutName` are
pinned to `CalePOS` explicitly (electron-builder would default to `productName` anyway, but
this makes it non-accidental). `app.setAppUserModelId('com.calepos.desktop')` in `main.js`
keeps Windows' taskbar grouping/identity as "CalePOS" rather than "Electron", which matters
most for unpackaged dev runs (`npm run electron:start`) since a packaged `.exe` already carries
its own icon/identity resource. `resources/icon.png` itself is *not* bundled into the packaged
app (not listed in `build.files`) — it's only read by electron-builder at package time and by
`main.js` for the dev-mode `BrowserWindow` `icon` option.

**Window-state persistence** (`electron/windowState.js`): remembers width/height/x/y (and
maximized state) across launches in `<userData>/window-state.json` — never anything
sale/session/credential-related. On load, a saved `x`/`y` is discarded (falling back to
Electron's default centered placement) unless it still overlaps some currently-connected
display's work area by at least 100px in both axes — covers a removed/resized/rearranged
monitor. Saves are debounced 500ms on `resize`/`move`, plus an unconditional save on `close`.

**Code signing (not yet configured)**: the current build is intentionally unsigned —
`build.win` has no `certificateFile`/`certificatePassword`, and nothing sets
`forceCodeSigning`, so `electron-builder` skips signing with a warning rather than failing.
Nothing in the packaging config blocks adding it later: electron-builder reads a certificate
either from `build.win.certificateFile` + `certificatePassword` or from the `CSC_LINK` /
`CSC_KEY_PASSWORD` environment variables at build time, with no other config changes needed.
Before a real production distribution, this needs: an OV or EV code-signing certificate
(EV avoids Windows SmartScreen's "unknown publisher" warning on first run; OV is cheaper but
takes longer to build reputation), and either committing the cert path/env-var wiring to CI or
documenting the manual signing step for local builds.

**Auto-update (not yet implemented)**: no `electron-updater` dependency and no
`build.publish` config exist yet — updates today are "download and run a new
`CalePOS-Setup.exe`" only. Before building real auto-update: (1) pick and configure a publish
provider (`generic` HTTP feed, GitHub Releases, or S3/R2 — whichever CalePOS's existing hosting
already supports is the natural choice; there is no update-feed hosting decided yet), (2) add
`electron-updater` and wire its `checkForUpdatesAndNotify()`/download/install flow into
`main.js`, (3) get code signing in place first — Windows' `electron-updater` NSIS differential
updates are meaningfully more trustworthy (and avoid repeat SmartScreen prompts) when signed.
None of this is started; this phase only documents the path.
```

- [ ] **Step 2: Commit**

```bash
git add docs/CODEMAP.md
git commit -m "docs: sync CODEMAP with Phase 2 desktop polish (icon, window-state, signing/update prep)"
```

---

### Task 6: Full manual verification pass

**Files:** none (verification only).

**Interfaces:**
- Consumes: the finished state of Tasks 1–5.
- Produces: the pass/fail evidence needed before Task 7 (or before telling the user Phase 2 is
  done).

- [ ] **Step 1: Web build unaffected**

Run: `npm run build` (the plain web build, not `build:desktop`)

Expected: succeeds, produces `dist/` as before, no references to `dist-desktop`.

- [ ] **Step 2: Desktop build + installer**

Run: `npm run build:desktop`

Expected: succeeds, produces `release/CalePOS-Setup.exe`.

- [ ] **Step 3: Install and inspect identity/icon**

Run the produced `CalePOS-Setup.exe` installer manually.

Expected, check each: installer window/icon shows CalePOS branding; Start Menu entry named
`CalePOS` with the CalePOS icon; Desktop shortcut named `CalePOS` with the CalePOS icon;
installed `CalePOS.exe` shows the CalePOS icon in Explorer; launched app shows the CalePOS icon
in the taskbar; Windows Settings → Apps (or Add/Remove Programs) shows an uninstall entry named
`CalePOS` (not "Electron" or the raw appId).

- [ ] **Step 4: Single instance**

Launch `CalePOS.exe` twice.

Expected: second launch focuses the existing window; only one taskbar entry; only one
`CalePOS.exe` process in Task Manager.

- [ ] **Step 5: Window-state persistence**

Resize/move the window, close it, relaunch.

Expected: same size/position. Then corrupt `<userData>/window-state.json` (invalid JSON) and
relaunch.

Expected: falls back cleanly to the default 1280×800 centered window (no crash).

- [ ] **Step 6: Close/reopen**

Close the app fully (not minimize), reopen it.

Expected: launches cleanly, no leftover process, no error dialog.

- [ ] **Step 7: Confirm no unintended Android/Capacitor changes**

Run: `git status` (from repo root)

Expected: no files under `pos-frontend/android/` or `pos-frontend/capacitor.config.*` show as
modified.

- [ ] **Step 8: Note any blockers**

If desktop login is still blocked on the known Turnstile Hostname-Management allow-list step
(see spec §13 / `CODEMAP.md`'s Turnstile subsection), record that as a known blocker in the
final report — do not attempt to work around it.

No commit for this task — it's a verification checkpoint, not a code change.

---

### Task 7: Version bump + changelog entry (gated on explicit user confirmation)

**Files:**
- Modify: `pos-frontend/package.json` (`version` field)
- Modify: `pos-frontend/CHANGELOG.md`

**Interfaces:**
- Consumes: the completed, verified state of Tasks 1–6.
- Produces: nothing further downstream.

**Do not run this task's steps until the user has explicitly confirmed the version bump in
this session** — `CLAUDE.md` requires the user to accept/prompt for the version number change,
this plan cannot pre-approve it. Ask before executing Step 1.

- [ ] **Step 1: Confirm with the user, then bump version**

This is a MINOR bump (new capability — icon/identity/window-state/shortcuts — existing
behavior unchanged; nothing fiscal, no retraining needed). Once confirmed, in
`pos-frontend/package.json` change:

```json
  "version": "0.28.0",
```

to:

```json
  "version": "0.29.0",
```

- [ ] **Step 2: Add the changelog entry**

At the top of the version list in `pos-frontend/CHANGELOG.md` (right after the header/legend,
before `## 0.28.0`), add:

```markdown
## 0.29.0 — 2026-08-21

**MINOR** — Windows desktop polish (Phase 2). CalePOS's branding icon now shows on the
installer, Start Menu/Desktop shortcuts, taskbar, and installed `.exe`; installer/uninstall
entries are correctly labeled `CalePOS`. Window size and position now persist across launches
and recover safely if the saved position no longer matches a connected display. Hardened
single-instance focus so a second launch always brings the existing window forward instead of
risking a duplicate. Still online-only — no offline, hardware, or auto-update functionality
added.
```

- [ ] **Step 3: Commit**

```bash
git add package.json CHANGELOG.md
git commit -m "chore(desktop): bump version to 0.29.0 for Phase 2 desktop polish"
```
