import { withExpiry } from '@/lib/domain'
import { searchClauses } from '@/lib/search'
import { fetchAllRows } from '@/lib/supabase/paging'
import { tenantClient } from '@/lib/supabase/tenant'
import type { Customer, CustomerWithExpiry } from '@/lib/types'

export type MyTicket = {
  id: number
  title: string
  status: string | null
  priority: string | null
  created_at: string
  customers: { first_name: string | null; last_name: string | null } | null
}

export type MyPayment = {
  id: number
  amount: number | string
  payment_type: string | null
  payment_date: string
  customers: { first_name: string | null; last_name: string | null } | null
}

function startOfTodayIso() {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).toISOString()
}

const OPEN_STATES = ['open', 'in_progress']

/** Tickets assigned to one user, newest first. */
async function ticketsAssignedTo(companyId: number, userId: number, limit = 8) {
  const db = tenantClient()
  const { data, error } = await db
    .from('support_tickets')
    .select('id, title, status, priority, created_at, customers(first_name, last_name)')
    .eq('company_id', companyId)
    .eq('assigned_to', userId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error('Failed to load assigned tickets: ' + error.message)
  return (data ?? []) as unknown as MyTicket[]
}

export type CustomerHit = {
  id: number
  name: string
  phone: string | null
  /** Shown on a hit, because the search matches on it. */
  address: string | null
  mac_address: string | null
  /** carried_balance — the only column that carries real debt. */
  balance: number | string | null
}

/**
 * Lightweight customer lookup for roles that have no customer-list page.
 *
 * Cashier and technician both lack `view_customer_list`, so their dashboards
 * search inline instead of linking to /dashboard/customers. Returns only
 * identifying fields; callers decide whether to show the balance.
 *
 * Matches on the same fields as everywhere else — see lib/search.ts. This was
 * a THIRD hand-rolled field list, and the one belonging to the role that needs
 * it most: a cashier with no customer-list page has this box and nothing else,
 * and it was the one search that could not find anybody by address.
 */
export async function searchCustomersLite(
  companyId: number,
  query: string,
  limit = 8
): Promise<CustomerHit[]> {
  const clauses = searchClauses(query)
  if (clauses.length === 0) return []

  const db = tenantClient()
  let lookup = db
    .from('customers')
    .select('id, first_name, last_name, phone, address, mac_address, carried_balance')
    .eq('company_id', companyId)
  for (const clause of clauses) lookup = lookup.or(clause)

  const { data, error } = await lookup.limit(limit)

  if (error) throw new Error('Customer search failed: ' + error.message)

  type Row = {
    id: number
    first_name: string | null
    last_name: string | null
    phone: string | null
    address: string | null
    mac_address: string | null
    carried_balance: number | string | null
  }

  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: r.phone,
    address: r.address,
    mac_address: r.mac_address,
    // carried_balance, not balance: see lib/billing.ts. `balance` reads 0 for
    // everybody who actually owes, so a cashier looking a customer up at the
    // till was told they owed nothing.
    balance: r.carried_balance,
  }))
}

export type CsrDashboard = {
  myTickets: MyTicket[]
  addedToday: CustomerWithExpiry[]
  openTicketCount: number
}

export async function getCsrDashboard(
  companyId: number,
  userId: number
): Promise<CsrDashboard> {
  const db = tenantClient()
  const today = new Date().toISOString().slice(0, 10)

  const [myTickets, added, openRes] = await Promise.all([
    ticketsAssignedTo(companyId, userId),
    // One day's signups, so this is nowhere near the 1000-row ceiling on an
    // ordinary day. A bulk import is not an ordinary day: it stamps every row
    // it creates with today's date, and this company has 977 customers — one
    // import of the book would put the whole of it in here. Paged for that
    // day rather than for the average one.
    fetchAllRows(
      (from, to) =>
        db
          .from('customers')
          .select('id, first_name, last_name, email, phone, mac_address, monthly_rate, balance, last_bill_date, date_added')
          .eq('company_id', companyId)
          .eq('date_added', today)
          .order('id', { ascending: false })
          .range(from, to),
      'new customers'
    ),
    db
      .from('support_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', OPEN_STATES),
  ])

  return {
    myTickets,
    addedToday: (added as Customer[]).map(withExpiry),
    openTicketCount: openRes.count ?? 0,
  }
}

export type CashierDashboard = {
  collectedToday: number
  paymentCount: number
  recentPayments: MyPayment[]
}

/**
 * Cashier view, scoped to what this operator personally collected.
 *
 * `payments.agent` is a free-text name rather than a FK to users, so "mine"
 * can only be matched by display name. A rename would orphan history — worth
 * migrating to an agent_id column.
 */
export async function getCashierDashboard(
  companyId: number,
  agentName: string
): Promise<CashierDashboard> {
  const db = tenantClient()
  const since = startOfTodayIso()

  const [collected, recentRes] = await Promise.all([
    // Both numbers on this card are read off these rows — what the cashier
    // collected today and how many payments that was. Neither would look wrong
    // if the read stopped short.
    fetchAllRows(
      (from, to) =>
        db
          .from('payments')
          .select('amount')
          .eq('company_id', companyId)
          .eq('agent', agentName)
          .gte('payment_date', since)
          .order('id', { ascending: true })
          .range(from, to),
      'collections'
    ),
    db
      .from('payments')
      .select('id, amount, payment_type, payment_date, customers(first_name, last_name)')
      .eq('company_id', companyId)
      .eq('agent', agentName)
      .gte('payment_date', since)
      .order('payment_date', { ascending: false })
      .limit(10),
  ])

  if (recentRes.error) throw new Error('Failed to load payments: ' + recentRes.error.message)

  const rows = collected as { amount: number | string }[]

  return {
    collectedToday: rows.reduce((sum, r) => sum + Number(r.amount ?? 0), 0),
    paymentCount: rows.length,
    recentPayments: (recentRes.data ?? []) as unknown as MyPayment[],
  }
}

export type TechnicianDashboard = {
  myTickets: MyTicket[]
  customersWithOpenTickets: {
    customerId: number
    name: string
    macAddress: string | null
    openTickets: number
  }[]
}

export async function getTechnicianDashboard(
  companyId: number,
  userId: number
): Promise<TechnicianDashboard> {
  const db = tenantClient()

  const [myTickets, openTickets] = await Promise.all([
    ticketsAssignedTo(companyId, userId),
    // Tallied per customer below, so this read decides an open-ticket count
    // shown against each one — the same reason as everywhere else in this file.
    fetchAllRows(
      (from, to) =>
        db
          .from('support_tickets')
          .select('customer_id, customers(id, first_name, last_name, mac_address)')
          .eq('company_id', companyId)
          .in('status', OPEN_STATES)
          .order('id', { ascending: true })
          .range(from, to),
      'open tickets'
    ),
  ])

  type Row = {
    customer_id: number | null
    customers: {
      id: number
      first_name: string | null
      last_name: string | null
      mac_address: string | null
    } | null
  }

  // Collapse many open tickets per customer into one row with a count.
  const byCustomer = new Map<number, TechnicianDashboard['customersWithOpenTickets'][number]>()
  for (const row of openTickets as Row[]) {
    const c = row.customers
    if (!c) continue
    const existing = byCustomer.get(c.id)
    if (existing) {
      existing.openTickets++
    } else {
      byCustomer.set(c.id, {
        customerId: c.id,
        name: [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Unknown',
        macAddress: c.mac_address,
        openTickets: 1,
      })
    }
  }

  return {
    myTickets,
    customersWithOpenTickets: [...byCustomer.values()].sort(
      (a, b) => b.openTickets - a.openTickets
    ),
  }
}
