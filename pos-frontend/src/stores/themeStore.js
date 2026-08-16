import { create } from 'zustand'

// Per-device Appearance preference. Plain localStorage rather than zustand's `persist`
// middleware — the flash-of-wrong-theme guard in index.html reads this key synchronously
// before React (and Zustand) exist, so the stored value has to be a raw string, not
// persist's JSON envelope. Not synced to the backend: this is a till setting, not an
// account setting.
const THEME_KEY = 'calepos_theme'

function readStoredTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light')
}

const initialTheme = readStoredTheme()
applyTheme(initialTheme)

export const useThemeStore = create((set) => ({
  theme: initialTheme,
  setDark: (dark) => {
    const theme = dark ? 'dark' : 'light'
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* ignore */
    }
    applyTheme(theme)
    set({ theme })
  },
}))
