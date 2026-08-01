import { useEffect, useState } from 'react'

function Clock() {
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="text-center leading-tight">
      <strong className="block text-[15px]">
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </strong>
      <small className="mt-1 block text-[10px] text-brand-soft">
        {now.toLocaleDateString([], {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}
      </small>
    </div>
  )
}

export default Clock
