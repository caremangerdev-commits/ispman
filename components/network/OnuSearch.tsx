'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { searchOnus, type OnuHit } from '@/app/actions/olts'
import { SignalBars } from '@/components/network/SignalBars'

/**
 * Find an ONU on any OLT: by serial number, the MAC of the router behind it,
 * or the customer's name, phone or account. Instant, because it reads the
 * list the background check saves rather than asking every OLT.
 */

const portName = (p: string) => 'PON ' + (p.split(/[^0-9]+/).filter(Boolean).pop() ?? p)
const MATCH: Record<OnuHit['matched'], string> = { serial: 'serial', mac: 'MAC', customer: 'customer' }

export function OnuSearch() {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<OnuHit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef('')

  useEffect(() => {
    const term = q.trim()
    latest.current = term
    if (term.length < 3) return
    const t = window.setTimeout(async () => {
      setBusy(true)
      const res = await searchOnus(term)
      // A slower answer to an older query must not replace a newer one.
      if (latest.current !== term) return
      setBusy(false)
      setHits(res.ok ? res.hits : [])
    }, 250)
    return () => window.clearTimeout(t)
  }, [q])

  const shown = q.trim().length >= 3 ? hits : null

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <label htmlFor="onu-search" className="mb-2 block text-sm font-semibold text-white">
        Find an ONU
      </label>
      <input
        id="onu-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Serial, MAC, customer name or phone"
        autoComplete="off"
        className="w-full max-w-xl rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none"
      />
      {busy && !shown ? <p className="mt-3 text-xs text-gray-500">Searching…</p> : null}
      {shown ? (
        shown.length === 0 ? (
          <p className="mt-3 text-xs text-gray-500">No ONU matches “{q.trim()}”.</p>
        ) : (
          <ul className="mt-3 divide-y divide-gray-800 rounded-lg border border-gray-800">
            {shown.map((h) => (
              <li key={h.oltId + ':' + h.serial}>
                <Link
                  href={
                    '/dashboard/network/olts/' + h.oltId + '?port=' + encodeURIComponent(h.port) +
                    '&onu=' + encodeURIComponent(h.serial)
                  }
                  className="grid items-center gap-x-4 gap-y-1 px-3 py-2 text-xs hover:bg-gray-800/50 sm:grid-cols-[1.2fr_1fr_1.4fr_auto]"
                >
                  <span>
                    <span className="block font-mono text-gray-100">{h.serial}</span>
                    <span className="block text-[11px] text-gray-500">
                      {h.oltName} · {portName(h.port)} · matched {MATCH[h.matched]}
                    </span>
                  </span>
                  <span className="font-mono text-[11px] text-gray-400">{h.macs[0] ?? '—'}</span>
                  <span>
                    {h.customer ? (
                      <>
                        <span className="block text-gray-100">{h.customer.name}</span>
                        <span className="block text-[11px] text-gray-500">{h.customer.phone ?? ''}</span>
                      </>
                    ) : (
                      <span className="text-gray-500">Not linked</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className={h.online ? 'text-green-400' : 'text-red-400'}>{h.online ? 'Online' : 'Offline'}</span>
                    <SignalBars label="RX" dbm={h.rx} side="onu" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}
