import { useEffect, useState } from 'react'

/**
 * Determines whether the current UI is touch-oriented.
 * @returns {boolean} `true` for a UI with no hover capability and a coarse pointer, `false` otherwise.
 */
export function useIsTouchUi() {
  const [touchUi, setTouchUi] = useState(() => readTouchUi())

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    const query = window.matchMedia('(hover: none) and (pointer: coarse)')
    const sync = () => setTouchUi(readTouchUi())
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])

  return touchUi
}

/**
 * Determines whether the current environment has a touch-oriented UI.
 * @returns {boolean} `true` if the environment matches touch-oriented UI criteria, `false` otherwise.
 */
export function readTouchUi() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true
  // Fallback: narrow viewport with touch points (some tablets report hybrid pointers)
  const narrow = window.matchMedia('(max-width: 1050px)').matches
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0
  return narrow && touchPoints > 0
}
