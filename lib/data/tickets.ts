import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import type { TicketPriority, TicketStatus } from '@/lib/tickets'

/** A row of the tickets list, with the customer and assignee names resolved. */
export type TicketListRow = {
  id: number
  title: string
  status: string | null
  priority: string | null
  created_at: string
  customer_id: number | null
  customers: { first_name: string | null; last_name: string | null } | null
  assigned_to: number | null
  assignee: { first_name: string | null; last_name: string | null; email: string } | null
}

/**
 * Everything on one ticket, including the three columns nothing used to read.
 *
 * The customer join is WIDER here than on the list: the detail page links the
 * customer's coordinates onto a map, and offers to capture them when a ticket
 * is resolved for a customer who has none. The list has no use for either, so
 * it does not pay for the column.
 */
export type TicketDetail = Omit<TicketListRow, 'customers'> & {
  description: string | null
  resolution_notes: string | null
  resolved_at: string | null
  customers:
    | { first_name: string | null; last_name: string | null; gps: string | null }
    | null
}

/**
 * The select shared by both reads.
 *
 * `assigned_to` is a plain integer column with no declared foreign key, so the
 * assignee cannot be joined through PostgREST's relationship syntax the way
 * `customers` can. It is resolved in a second pass instead — see attachAssignees.
 */
const BASE_COLUMNS =
  'id, title, status, priority, created_at, customer_id, assigned_to'

const LIST_COLUMNS = BASE_COLUMNS + ', customers(first_name, last_name)'

const DETAIL_COLUMNS =
  BASE_COLUMNS + ', description, resolution_notes, resolved_at, ' +
  'customers(first_name, last_name, gps)'

type RawTicket = Omit<TicketListRow, 'assignee'>

/**
 * Fills in the assignee for a set of tickets with one extra query.
 *
 * Deliberately not one lookup per ticket: the list page would otherwise issue a
 * query per row.
 */
async function attachAssignees<T extends RawTicket>(
  companyId: number,
  rows: T[]
): Promise<(T & { assignee: TicketListRow['assignee'] })[]> {
  const ids = [...new Set(rows.map((r) => r.assigned_to).filter((id): id is number => id !== null))]
  if (ids.length === 0) return rows.map((r) => ({ ...r, assignee: null }))

  const { data } = await tenantClient()
    .from('users')
    .select('id, first_name, last_name, email')
    .eq('company_id', companyId)
    .in('id', ids)

  const byId = new Map(
    ((data ?? []) as unknown as {
      id: number; first_name: string | null; last_name: string | null; email: string
    }[]).map((u) => [u.id, u])
  )

  return rows.map((r) => ({
    ...r,
    assignee: r.assigned_to !== null ? byId.get(r.assigned_to) ?? null : null,
  }))
}

export type TicketFilters = {
  companyId: number
  /** Empty means every status. */
  statuses: TicketStatus[]
  /** A user id, 'unassigned', or '' for anyone. */
  assignee: string
}

/** The tickets list, newest first. */
export async function listTickets(filters: TicketFilters): Promise<TicketListRow[]> {
  let q = tenantClient()
    .from('support_tickets')
    .select(LIST_COLUMNS)
    .eq('company_id', filters.companyId)

  if (filters.statuses.length > 0) q = q.in('status', filters.statuses)

  if (filters.assignee === 'unassigned') q = q.is('assigned_to', null)
  else if (filters.assignee) q = q.eq('assigned_to', Number(filters.assignee))

  const { data, error } = await q.order('created_at', { ascending: false })
  if (error) throw new Error('Failed to load tickets: ' + error.message)

  return attachAssignees(filters.companyId, (data ?? []) as unknown as RawTicket[])
}

/** One ticket, or null when it does not exist in this company. */
export async function getTicket(companyId: number, id: number): Promise<TicketDetail | null> {
  const { data, error } = await tenantClient()
    .from('support_tickets')
    .select(DETAIL_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error('Failed to load ticket: ' + error.message)
  if (!data) return null

  // Cast through the detail shape rather than RawTicket: this select asks for
  // the wider customer join, so the row genuinely carries gps.
  const [withAssignee] = await attachAssignees(companyId, [
    data as unknown as Omit<TicketDetail, 'assignee'>,
  ])
  return withAssignee
}

// The New Ticket picker used to be fed from here: every customer in the
// company, paged past PostgREST's 1000-row cut. That was the customer list by
// another door, open to every role including technician. The picker now
// searches (components/tickets/TicketCustomerPicker.tsx, through /api/search),
// and a preset customer is one row from lib/data/customer-search.ts#getSearchHit.

// ---------------------------------------------------------------------------
// Ticket messages — the conversation (migration 0037, ticket_messages).
// ---------------------------------------------------------------------------

export type TicketMessage = {
  id: number
  author: 'customer' | 'staff'
  authorName: string | null
  /** The staff user who wrote it; null for a customer's message. */
  authorUserId: number | null
  body: string | null
  photoPath: string | null
  /** A staff-only note (migration 0041). Never in a customer's thread. */
  internal: boolean
  createdAt: string
}

type MessageRow = {
  id: number
  author: string
  author_name: string | null
  author_user_id: number | null
  body: string | null
  photo_path: string | null
  internal?: boolean | null
  created_at: string
}

/**
 * Every message on a ticket, oldest first. Empty if 0037 is not applied.
 *
 * `audience` IS REQUIRED, so nobody reads a thread without saying who it is
 * for. 'customer' — the portal — never gets an internal note: they are
 * filtered in the query, not after it. Before 0041 there is no internal column
 * and no internal note can exist, so both audiences read the same thread.
 */
export async function listTicketMessages(
  companyId: number,
  ticketId: number,
  audience: 'staff' | 'customer'
): Promise<TicketMessage[]> {
  const caps = await getSchemaCapabilities()
  let query = tenantClient()
    .from('ticket_messages')
    .select(
      'id, author, author_name, author_user_id, body, photo_path, created_at' +
        (caps.ticketNotes ? ', internal' : '')
    )
    .eq('company_id', companyId)
    .eq('ticket_id', ticketId)
  if (caps.ticketNotes && audience === 'customer') query = query.eq('internal', false)

  const { data, error } = await query.order('created_at', { ascending: true })

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return []
    throw new Error('Failed to load ticket messages: ' + error.message)
  }
  return ((data ?? []) as unknown as MessageRow[]).map((m) => ({
    id: m.id,
    author: m.author === 'staff' ? 'staff' : 'customer',
    authorName: m.author_name,
    authorUserId: m.author_user_id,
    body: m.body,
    photoPath: m.photo_path,
    internal: Boolean(m.internal),
    createdAt: m.created_at,
  }))
}

/**
 * Whether a stored photo belongs to a message the customer can see — the
 * portal's photo route asks this, so a photo attached to an internal note is
 * not served to them even by its path.
 */
export async function photoIsCustomerVisible(companyId: number, path: string): Promise<boolean> {
  const caps = await getSchemaCapabilities()
  let query = tenantClient()
    .from('ticket_messages')
    .select('id')
    .eq('company_id', companyId)
    .eq('photo_path', path)
  if (caps.ticketNotes) query = query.eq('internal', false)
  const { data } = await query.limit(1)
  return (data ?? []).length > 0
}

/**
 * Appends one message to a ticket.
 *
 * An internal note is written with internal = true and fails outright before
 * 0041 rather than landing as an ordinary message — which the customer would
 * then read. Callers offer notes only when the capability says the column is
 * there.
 */
export async function addTicketMessage(input: {
  companyId: number
  ticketId: number
  author: 'customer' | 'staff'
  authorUserId: number | null
  authorName: string | null
  body: string | null
  photoPath: string | null
  internal?: boolean
}): Promise<void> {
  const row: Record<string, unknown> = {
    company_id: input.companyId,
    ticket_id: input.ticketId,
    author: input.author,
    author_user_id: input.authorUserId,
    author_name: input.authorName,
    body: input.body,
    photo_path: input.photoPath,
  }
  if (input.internal) row.internal = true
  const { error } = await tenantClient().from('ticket_messages').insert(row)
  if (error) throw new Error('Could not post ticket message: ' + error.message)
}

export type { TicketPriority, TicketStatus }
