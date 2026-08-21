import fs from 'node:fs'
import path from 'node:path'
import { app, screen } from 'electron'

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json')

const DEFAULT_STATE = { width: 1280, height: 800, x: undefined, y: undefined, isMaximized: false }

// How much of a saved window rect must land on some real display before we trust it.
const MIN_VISIBLE_PX = 100

// Sanity range for a saved width/height. Guards against a corrupted or hand-tampered
// window-state.json (e.g. a negative or absurdly large value) reaching BrowserWindow
// unguarded — mirrors the x/y validation done by fitsOnADisplay below.
const MIN_DIMENSION = 400
const MAX_DIMENSION = 10000

function readState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
      return { ...DEFAULT_STATE }
    }
    if (
      parsed.width < MIN_DIMENSION || parsed.width > MAX_DIMENSION ||
      parsed.height < MIN_DIMENSION || parsed.height > MAX_DIMENSION
    ) {
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
