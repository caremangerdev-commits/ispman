/**
 * The support ticket vocabulary — statuses, priorities, and how each renders.
 *
 * Single source of truth. Before this existed the status lookup was copied into
 * RecentTickets.tsx and the customer detail page, which is how the two drifted:
 * both defined a fourth status, 'closed', that no row has ever used and that
 * nothing could set.
 *
 * Pure module with no `server-only`, because the ticket forms are client
 * components and need the same labels the server validates against.
 *
 * Neither column is constrained in Postgres — both are free text — so
 * toTicketStatus/toTicketPriority narrow whatever comes back, and every render
 * site keeps a fallback for a value from outside this list.
 */

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved'] as const
export type TicketStatus = (typeof TICKET_STATUSES)[number]

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  resolved: 'Resolved',
}

/** Badge classes, carried over verbatim from the two maps this replaced. */
export const TICKET_STATUS_STYLES: Record<TicketStatus, string> = {
  open: 'bg-blue-500/15 text-blue-400',
  in_progress: 'bg-amber-500/15 text-amber-400',
  resolved: 'bg-green-500/15 text-green-400',
}

/** The styling every call site falls back to for an unrecognised value. */
export const TICKET_UNKNOWN_STYLE = 'bg-gray-700/40 text-gray-400'

/** The statuses a ticket list shows unless asked otherwise. */
export const TICKET_OPEN_STATUSES: TicketStatus[] = ['open', 'in_progress']

export const TICKET_PRIORITIES = ['low', 'medium', 'high'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

export const TICKET_PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export const TICKET_PRIORITY_STYLES: Record<TicketPriority, string> = {
  low: 'bg-green-500/15 text-green-400',
  medium: 'bg-amber-500/15 text-amber-400',
  high: 'bg-red-500/15 text-red-400',
}

export function toTicketStatus(value: string | null | undefined): TicketStatus {
  return TICKET_STATUSES.includes(value as TicketStatus) ? (value as TicketStatus) : 'open'
}

export function toTicketPriority(value: string | null | undefined): TicketPriority {
  return TICKET_PRIORITIES.includes(value as TicketPriority)
    ? (value as TicketPriority)
    : 'medium'
}

/** Label for a status that may be a legacy value this list no longer carries. */
export function ticketStatusLabel(value: string | null | undefined): string {
  return TICKET_STATUS_LABELS[value as TicketStatus] ?? value ?? 'Unknown'
}

export function ticketStatusStyle(value: string | null | undefined): string {
  return TICKET_STATUS_STYLES[value as TicketStatus] ?? TICKET_UNKNOWN_STYLE
}

export function ticketPriorityLabel(value: string | null | undefined): string {
  return TICKET_PRIORITY_LABELS[value as TicketPriority] ?? value ?? 'none'
}

export function ticketPriorityStyle(value: string | null | undefined): string {
  return TICKET_PRIORITY_STYLES[value as TicketPriority] ?? TICKET_UNKNOWN_STYLE
}
