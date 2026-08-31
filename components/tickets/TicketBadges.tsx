import {
  ticketPriorityLabel, ticketPriorityStyle, ticketStatusLabel, ticketStatusStyle,
} from '@/lib/tickets'

const base =
  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide '

/**
 * Status and priority badges.
 *
 * Both fall back to a neutral grey for a value outside the vocabulary, because
 * neither column is constrained in Postgres — a row written before this list
 * existed, or by hand, must still render.
 */
export function TicketStatusBadge({ status }: { status: string | null }) {
  return <span className={base + ticketStatusStyle(status)}>{ticketStatusLabel(status)}</span>
}

export function TicketPriorityBadge({ priority }: { priority: string | null }) {
  return (
    <span className={base + ticketPriorityStyle(priority)}>{ticketPriorityLabel(priority)}</span>
  )
}
