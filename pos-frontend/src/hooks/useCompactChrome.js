import { useEffect } from 'react'
import { readTouchUi } from './useIsTouchUi'

/** Phones in “Desktop site” mode report a wide viewport but still need mobile chrome. */
export function isCompactChrome() {
  if (typeof window === 'undefined') return false
  return readTouchUi() || window.innerWidth <= 700
}

/**
 * Toggle `compact-chrome` on `<html>` so Tailwind `compact:` variants match touch/narrow UIs
 * even when the browser lies about viewport width (mobile desktop mode).
 */
export function useCompactChrome() {
  useEffect(() => {
    const sync = () => {
      document.documentElement.classList.toggle('compact-chrome', isCompactChrome())
    }
    sync()
    const narrow = window.matchMedia('(max-width: 700px)')
    narrow.addEventListener('change', sync)
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    return () => {
      narrow.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
      document.documentElement.classList.remove('compact-chrome')
    }
  }, [])
}

export default useCompactChrome
