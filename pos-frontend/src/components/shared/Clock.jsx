import { useEffect, useState } from 'react'

/** Compact clock for header — time + short date on one line. */
function Clock({ className = '' }) {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

  return (
    <span className={`tabular-nums ${className}`}>
      <strong className="font-semibold text-white">{time}</strong>
      <span className="mx-1.5 text-[#6d7470]">·</span>
      <span className="text-[#abb1ad]">{date}</span>
    </span>
  )
}

export default Clock
