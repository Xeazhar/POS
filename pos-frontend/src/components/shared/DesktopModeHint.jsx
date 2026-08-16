import { useEffect, useState } from 'react'
import { readTouchUi } from '../../hooks/useIsTouchUi'

const DISMISS_KEY = 'calepos_dismiss_desktop_hint'

/**
 * Warns touch-capable users when the browser is using a wide layout that may indicate “Desktop site” mode.
 */
export default function DesktopModeHint() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const sync = () => {
      try {
        if (sessionStorage.getItem(DISMISS_KEY) === '1') {
          setVisible(false)
          return
        }
      } catch {
        /* ignore */
      }
      const touch = readTouchUi()
      const wideLayout = window.innerWidth > 750
      setVisible(touch && wideLayout)
    }
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('orientationchange', sync)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('orientationchange', sync)
    }
  }, [])

  if (!visible) return null

  return (
    <div
      role="status"
      className="border-b border-brand-warn/40 bg-brand-warn/15 px-4 py-2 text-center text-xs text-brand-dark"
    >
      <span>
        <strong>Desktop site mode</strong> is on, layout may be hard to use. Turn it off in your
        browser menu (⋮ → uncheck “Desktop site”).
      </span>
      <button
        type="button"
        className="ml-2 border-0 bg-transparent p-0 font-semibold text-brand-dark underline"
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISS_KEY, '1')
          } catch {
            /* ignore */
          }
          setVisible(false)
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
