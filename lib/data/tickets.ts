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

/** Customers for the create form's picker. */
export type TicketCustomerOption = {
  id: number
  first_name: string | null
  last_name: string | null
}

export async function listTicketCustomers(companyId: number): Promise<TicketCustomerOption[]> {
  const { data, error } = await tenantClient()
    .from('customers')
    .select('id, first_name, last_name')
    .eq('company_id', companyId)
    .order('first_name', { ascending: true })

  if (error) throw new Error('Failed to load customers: ' + error.message)
  return (data ?? []) as unknown as TicketCustomerOption[]
}

export type { TicketPriority, TicketStatus }
