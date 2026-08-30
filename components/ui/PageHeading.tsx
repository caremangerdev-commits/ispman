'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

import { sectionForPath } from '@/lib/navigation'

/**
 * The standing header on every dashboard page.
 *
 * Company and department lead in large type; who is signed in, and the
 * company-local clock, sit beneath in small type. The department is derived
 * from the route rather than passed in, so a new page picks up the right label
 * from lib/navigation.ts without touching this.
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
  const pathname = usePathname()
  const department = sectionForPath(pathname)

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
      <h1 className="text-2xl font-bold tracking-tight text-white">
        {companyName}
        {department ? (
          <>
            <span className="mx-2 font-normal text-gray-600">·</span>
            <span className="text-blue-400">{department}</span>
          </>
        ) : null}
      </h1>

      <p className="mt-1 text-sm text-gray-500">
        {greeting ? greeting + ', ' : ''}
        <span className="font-medium text-gray-400">{userName}</span>
        <span className="mx-1.5 text-gray-700">·</span>
        {roleLabel}
        {now ? (
          <>
            <span className="mx-1.5 text-gray-700">·</span>
            {fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
            <span className="mx-1.5 text-gray-700">·</span>
            <span className="tabular-nums">
              {fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}
            </span>
          </>
        ) : null}
      </p>
    </header>
  )
}
