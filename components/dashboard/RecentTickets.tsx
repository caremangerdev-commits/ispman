import { EmptyState, Panel } from '@/components/dashboard/Panel'
import { fullName, timeAgo } from '@/lib/format'
import type { TicketRow } from '@/lib/types'

const PRIORITY: Record<string, string> = {
  high: 'bg-red-500/15 text-red-400',
  medium: 'bg-amber-500/15 text-amber-400',
  low: 'bg-green-500/15 text-green-400',
}

const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-blue-500/15 text-blue-400' },
  in_progress: { label: 'In Progress', cls: 'bg-amber-500/15 text-amber-400' },
  resolved: { label: 'Resolved', cls: 'bg-green-500/15 text-green-400' },
  closed: { label: 'Closed', cls: 'bg-gray-700/40 text-gray-400' },
}

export function RecentTickets({ tickets }: { tickets: TicketRow[] }) {
  return (
    // No footer link: there is no tickets page yet.
    <Panel title="Recent Support Tickets" subtitle={'Last ' + tickets.length}>
      {tickets.length === 0 ? (
        <EmptyState message="No support tickets yet." />
      ) : (
        <ul className="divide-y divide-gray-800">
          {tickets.map((t) => {
            const status = STATUS[t.status ?? ''] ?? {
              label: t.status ?? 'Unknown',
              cls: 'bg-gray-700/40 text-gray-400',
            }
            return (
              <li key={t.id} className="px-5 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-gray-200">
                    {t.title}
                  </p>
                  <span className="shrink-0 text-xs text-gray-500">{timeAgo(t.created_at)}</span>
                </div>

                <div className="mt-1 flex items-center gap-2">
                  <span className="truncate text-xs text-gray-500">{fullName(t.customers)}</span>
                  <span
                    className={
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                      (PRIORITY[t.priority ?? ''] ?? 'bg-gray-700/40 text-gray-400')
                    }
                  >
                    {t.priority ?? 'none'}
                  </span>
                  <span
                    className={
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' +
                      status.cls
                    }
                  >
                    {status.label}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
