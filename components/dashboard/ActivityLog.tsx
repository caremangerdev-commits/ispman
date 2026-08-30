import {
  Activity, DollarSign, MessageSquare, WifiOff, Wifi, type LucideIcon,
} from 'lucide-react'

import { EmptyState, Panel } from '@/components/dashboard/Panel'
import { humaniseLogDetail, timeAgo } from '@/lib/format'
import type { LogRow } from '@/lib/types'

const TYPES: Record<string, { icon: LucideIcon; cls: string }> = {
  payment: { icon: DollarSign, cls: 'bg-green-500/10 text-green-400' },
  connect: { icon: Wifi, cls: 'bg-blue-500/10 text-blue-400' },
  disconnect: { icon: WifiOff, cls: 'bg-red-500/10 text-red-400' },
  ticket: { icon: MessageSquare, cls: 'bg-amber-500/10 text-amber-400' },
}

export function ActivityLog({ entries }: { entries: LogRow[] }) {
  return (
    // No footer link: there is no full audit-log page yet.
    <Panel title="Recent Activity" subtitle="Audit log">
      {entries.length === 0 ? (
        <EmptyState message="No activity recorded yet." />
      ) : (
        <ul className="divide-y divide-gray-800">
          {entries.map((e) => {
            const meta = TYPES[e.type ?? ''] ?? {
              icon: Activity,
              cls: 'bg-gray-700/40 text-gray-400',
            }
            return (
              <li key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                <span
                  className={
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-full ' + meta.cls
                  }
                >
                  <meta.icon className="h-3.5 w-3.5" aria-hidden />
                </span>
                {/* Audit rows are stored in a structured, machine-readable
                    form; they are rewritten for people here. */}
                <p className="min-w-0 flex-1 truncate text-sm text-gray-300">
                  {humaniseLogDetail(e.details)}
                </p>
                <span className="shrink-0 text-xs text-gray-500">{timeAgo(e.created_at)}</span>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
