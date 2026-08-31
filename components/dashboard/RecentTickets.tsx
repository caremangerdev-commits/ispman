import { EmptyState, Panel } from '@/components/dashboard/Panel'
import { TicketPriorityBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges'
import { fullName, timeAgo } from '@/lib/format'
import type { TicketRow } from '@/lib/types'

export function RecentTickets({ tickets }: { tickets: TicketRow[] }) {
  return (
    // No footer link: there is no tickets page yet.
    <Panel title="Recent Support Tickets" subtitle={'Last ' + tickets.length}>
      {tickets.length === 0 ? (
        <EmptyState message="No support tickets yet." />
      ) : (
        <ul className="divide-y divide-gray-800">
          {tickets.map((t) => {
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
                  <TicketPriorityBadge priority={t.priority} />
                  <TicketStatusBadge status={t.status} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
