import { Radio, Wifi, WifiOff, type LucideIcon } from 'lucide-react'

import { timeAgo } from '@/lib/format'
import { NETWORK_EVENT_LABELS, type NetworkEventType } from '@/lib/status'
import type { LogRow } from '@/lib/types'

/**
 * What has been done to this customer's network access, most recent first.
 *
 * Reads the same `log` rows the four network buttons write, so the card and the
 * status badge are looking at one record rather than two — the most recent
 * 'Disconnected' entry here is literally what makes the badge say Disconnected
 * (lib/status.ts#resolveStatus).
 *
 * Failed writes are not shown. They are logged under `radius_*_failed` and the
 * operator was told at the time; this card answers "what happened to their
 * access", and an attempt that never reached the NAS did not change it.
 */

const EVENTS: Record<NetworkEventType, { icon: LucideIcon; cls: string }> = {
  network_provision: { icon: Wifi, cls: 'bg-amber-500/10 text-amber-400' },
  network_reconnect: { icon: Wifi, cls: 'bg-green-500/10 text-green-400' },
  network_extend: { icon: Radio, cls: 'bg-blue-500/10 text-blue-400' },
  network_disconnect: { icon: WifiOff, cls: 'bg-red-500/10 text-red-400' },
}

export function NetworkHistory({ entries }: { entries: LogRow[] }) {
  return (
    <section className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900">
      <header className="flex items-baseline justify-between gap-3 border-b border-gray-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-white">Network History</h2>
        <p className="text-xs text-gray-500">
          {entries.length === 0
            ? 'No events'
            : 'Last ' + entries.length + (entries.length === 1 ? ' event' : ' events')}
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-gray-600">
          Nothing has changed this customer&rsquo;s network access yet.
        </p>
      ) : (
        <ul className="divide-y divide-gray-800">
          {entries.map((e) => {
            const meta = EVENTS[e.type as NetworkEventType] ?? {
              icon: Radio,
              cls: 'bg-gray-700/40 text-gray-400',
            }
            const label = NETWORK_EVENT_LABELS[e.type as NetworkEventType] ?? e.type ?? 'Event'

            return (
              <li key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                <span
                  className={
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full ' + meta.cls
                  }
                >
                  <meta.icon className="h-3.5 w-3.5" aria-hidden />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {label}
                  </p>
                  {/* Written for a person at insert time
                      (lib/radius/operations.ts#networkEventDetails), so it is
                      shown as stored rather than re-parsed here. */}
                  <p className="truncate text-sm text-gray-300">{e.details}</p>
                </div>

                <span className="shrink-0 text-xs text-gray-500">{timeAgo(e.created_at)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
