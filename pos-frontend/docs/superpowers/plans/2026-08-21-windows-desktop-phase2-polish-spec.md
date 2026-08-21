# Windows Desktop Phase 2 — Polish (Spec)

Condensed from the user's Phase 2 roadmap message, 2026-08-21. Phase 1 (Electron wrapper,
NSIS installer, loopback-HTTP renderer, single-instance lock) is complete and unmodified by
this phase except where explicitly noted below.

## Scope

**Still online-only.** Do NOT touch: offline functionality, SQLite, offline auth/transactions,
sync, hardware integration (printer/scanner/scale), USB update mechanism. Those are later
phases.

## Requirements

1. **Identity** — Product name `CalePOS`, executable `CalePOS.exe`, installer
   `CalePOS-Setup.exe`, appId `com.calepos.desktop` (stable, don't change post-release).
2. **Icon** — Use `resources/icon.png` (existing branding, 2732×2732 PNG, already used for
   Capacitor/Android). Wire it into electron-builder so it shows on: desktop shortcut, Start
   Menu, taskbar, installer, installed app, `CalePOS.exe` itself. Do not redesign the artwork.
3. **Shortcuts** — NSIS installer creates Start Menu + Desktop shortcuts labeled `CalePOS`,
   correct uninstall entry.
4. **Single instance** — Already implemented (`requestSingleInstanceLock`). Review only:
   second launch must focus the existing window, never spawn a second one.
5. **Window-state persistence** — Remember width/height/position across launches. Must
   recover to a safe default if the saved position no longer corresponds to a real display
   (monitor removed/resized/rearranged). No sensitive app data in the persisted file. Must not
   affect the React app's own layout.
6. **Native window / security** — Preserve `contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true`, `webSecurity: true`, restricted navigation, minimal preload surface. No new
   IPC channels, no Node exposure to renderer, no DevTools in production builds beyond the
   existing dev-only toggle, no application menu (POS terminal, not a document app).
7. **Taskbar identity** — Correct icon/name, no duplicate taskbar entries, focus-not-duplicate
   on second launch.
8. **Versioning** — Single source of truth stays `package.json` version (already the case).
   No new/conflicting version sources. Do not implement auto-update in this phase.
9. **Code signing (prep only)** — No certificate purchase/config now. Document what a future
   signed build will require; make sure current packaging config doesn't obstruct it.
10. **Auto-update (prep only)** — Do not build a full update system now (no update server
    exists). Document the safest path and exactly what infra/deps are still missing.
11. **Security** — No weakening of any Phase 1 security default. No Turnstile changes of any
    kind (that's a separate, already-tracked issue — document as a known blocker only).
12. **Web app** — `npm run build` and `npm run deploy` must keep working unchanged; PWA
    behavior for the web build stays intact.
13. **Turnstile** — Do not touch. If desktop login is still blocked on the known
    Hostname-Management allow-list step, that's a pre-existing, separately-tracked blocker —
    just re-confirm/document it, don't work around it.
14. **Testing** — Manual verification checklist (no automated test suite exists in this repo):
    app launches with correct name/icon, installer/shortcuts/uninstall work, single-instance
    behavior holds, window position/size persist and recover from an invalid saved position,
    app closes/reopens cleanly. Confirm web build still succeeds and Android/Capacitor files
    are untouched.
15. **Scope control** — No POS business logic, Supabase API layer, auth logic, stores, DB
    schema, offline system, hardware system, or Capacitor changes.

## Current state (as investigated 2026-08-21)

- `pos-frontend/package.json` `build` block already sets `appId: com.calepos.desktop`,
  `productName: CalePOS`, `artifactName: CalePOS-Setup.${ext}`, NSIS
  `createDesktopShortcut`/`createStartMenuShortcut: true`. **Missing: no `icon` field anywhere**
  — electron-builder has no `build/icon.ico` (no `build/` dir exists) and nothing points it at
  `resources/icon.png`, so the current package would ship with Electron's default icon.
- `electron/main.js`: single-instance lock present and functional (focuses + restores on
  second launch, but doesn't call `.show()` — a window hidden rather than minimized wouldn't
  reappear). No `app.setAppUserModelId()` call — on Windows this risks the app grouping under
  a generic/Electron taskbar identity, especially in unpackaged dev runs. No window-state
  persistence at all (hardcoded `width: 1280, height: 800`, no `x`/`y`, so every launch centers
  fresh). Security defaults (`contextIsolation`, `nodeIntegration: false`, `sandbox`,
  `webSecurity`, `will-navigate`/`setWindowOpenHandler` guards) are already correct — Phase 2
  must not touch these.
- `electron/preload.cjs`: exposes only `window.calepos.isDesktop`. No changes needed.
- No `electron-updater`/`electron-log` or similar deps installed. No `build.publish` config.
  No code-signing config (`certificateFile`/`CSC_LINK`) present — build.win  is currently
  `{ target: 'nsis' }` only.
- `docs/CODEMAP.md` has an existing "Windows desktop packaging (Electron)" section
  (~line 149–224) that must be kept in sync with whatever this phase changes.
