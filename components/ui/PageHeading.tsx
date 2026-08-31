'use client'

import { useEffect, useState } from 'react'

/**
 * The standing header at the top of every dashboard page's content area.
 *
 * Three lines: the company-local clock in small muted type, then the company
 * and the signed-in role in large type, then the greeting. The page's own
 * title lives in the header bar (see PageTitle), so nothing route-derived is
 * needed here.
 */
export function PageHeading({
  companyName,
  userName,
  roleLabel,
  timezone,
}: {
  companyName: string
  userName: string
  roleLabel: string
  timezone: string
}) {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    const tick = () => setNow(new Date())
    // Scheduled rather than called inline — setting state synchronously in an
    // effect body triggers a cascading render.
    const first = setTimeout(tick, 0)
    const id = setInterval(tick, 1000)
    return () => {
      clearTimeout(first)
      clearInterval(id)
    }
  }, [])

  const fmt = (opts: Intl.DateTimeFormatOptions) =>
    now ? new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts }).format(now) : ''

  const greeting = (() => {
    if (!now) return null
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false })
        .format(now)
    ) % 24
    return hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening'
  })()

  return (
    <header className="mb-5">
      <p className="min-h-5 text-sm text-gray-500">
        {now ? (
          <>
            {fmt({ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
            <span className="mx-2" />
            <span className="tabular-nums">
              {fmt({ hour: '2-digit', minute: '2-digit', hour12: true })}
            </span>
          </>
        ) : null}
      </p>

      <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
        {companyName}
        <span className="mx-2 font-normal text-gray-600">·</span>
        <span className="text-blue-400">{roleLabel}</span>
      </h1>

      <h2 className="mt-1 text-lg font-semibold text-gray-400">
        {greeting ? greeting + ', ' : ''}
        <span className="text-gray-300">{userName}</span>
      </h2>
    </header>
  )
}
