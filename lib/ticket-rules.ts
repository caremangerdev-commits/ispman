import { can, type Role } from '@/lib/permissions'
import { toTicketStatus } from '@/lib/tickets'

/**
 * What one person may do to one ticket.
 *
 * THE ONE DEFINITION, read by the server actions in app/actions/tickets.ts —
 * which refuse anything it says no to — and by the ticket page, which hides the
 * same controls so nobody is offered a button the server will refuse. Hiding a
 * control is the cosmetic half; the action re-asks this before it writes.
 *
 * The permissions say what a ROLE may do (lib/permissions.ts). This adds the
 * part that depends on the ticket: a technician resolves a ticket only when it
 * is assigned to them. Client-safe, like lib/permissions.ts.
 */
export type TicketRights = {
  /** Reply, add an internal note, attach a photo. */
  reply: boolean
  /** Change the title, description or priority. */
  edit: boolean
  /** Change who it is assigned to. */
  assign: boolean
  /** Mark it resolved. False once it already is. */
  resolve: boolean
  /** Put a resolved ticket back into play. */
  reopen: boolean
}

export function ticketRights(
  role: Role,
  userId: number,
  ticket: { assigned_to: number | null; status: string | null }
): TicketRights {
  const resolved = toTicketStatus(ticket.status) === 'resolved'
  const theirs = ticket.assigned_to !== null && ticket.assigned_to === userId
  return {
    reply: can(role, 'reply_ticket'),
    edit: can(role, 'edit_ticket'),
    assign: can(role, 'assign_ticket'),
    resolve:
      !resolved &&
      (can(role, 'resolve_any_ticket') || (theirs && can(role, 'resolve_ticket'))),
    reopen: resolved && can(role, 'reopen_ticket'),
  }
}

/**
 * Who a role may put on a ticket it is opening: anyone, or — without
 * assign_ticket — only themselves or nobody. Null means "anyone".
 */
export function assignableOnCreate(role: Role, userId: number): number[] | null {
  return can(role, 'assign_ticket') ? null : [userId]
}
