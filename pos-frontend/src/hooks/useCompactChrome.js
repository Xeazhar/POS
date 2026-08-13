import { useEffect } from 'react'
import { readTouchUi } from './useIsTouchUi'

/**
 * Determines whether the interface should use compact chrome.
 * @returns {boolean} `true` for touch-enabled interfaces or viewports 700 pixels wide or less, `false` during server-side rendering or otherwise.
 */
export function isCompactChrome() {
  if (typeof window === 'undefined') return false
  return readTouchUi() || window.innerWidth <= 700
}

/**
 * Synchronize the `compact-chrome` class on the document root with touch-enabled or narrow UI conditions.
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
