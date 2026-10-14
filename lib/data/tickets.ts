import { fetchAllRows } from '@/lib/supabase/paging'
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

/**
 * Every customer in the company, alphabetically, for the New Ticket picker.
 *
 * PAGED. This used to be one unranged select, which PostgREST silently cut at
 * 1000 rows — ordered by first name, so at any company past 1000 customers
 * everyone late in the alphabet was missing. A ticket started from such a
 * customer's record (?customer=<id>) found no option to pre-select and came up
 * blank, and they could not be picked by hand either: Ezmze's YANESHA YONIQUE
 * WALTERS, 14 Oct 2026, with Vernon and Smartcomm Bogue past 1000 as well.
 *
 * Paged by id (fetchAllRows needs a stable order), then sorted by name here.
 */
export async function listTicketCustomers(companyId: number): Promise<TicketCustomerOption[]> {
  const db = tenantClient()
  const rows = (await fetchAllRows(
    (from, to) =>
      db
        .from('customers')
        .select('id, first_name, last_name')
        .eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(from, to),
    'customers'
  )) as TicketCustomerOption[]

  const key = (c: TicketCustomerOption) =>
    ((c.first_name ?? '') + ' ' + (c.last_name ?? '')).trim().toLowerCase()
  return rows.sort((a, b) => key(a).localeCompare(key(b)) || a.id - b.id)
}

export type { TicketPriority, TicketStatus }
