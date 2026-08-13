import { useEffect, useState } from 'react'

/** True for phone/tablet-style UIs (coarse pointer, no hover) — not desktop. */
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

export function readTouchUi() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return true
  // Fallback: narrow viewport with touch points (some tablets report hybrid pointers)
  const narrow = window.matchMedia('(max-width: 1050px)').matches
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0
  return narrow && touchPoints > 0
}
