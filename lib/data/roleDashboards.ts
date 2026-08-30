import { withExpiry } from '@/lib/domain'
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
  mac_address: string | null
  balance: number | string | null
}

/**
 * Lightweight customer lookup for roles that have no customer-list page.
 *
 * Cashier and technician both lack `view_customer_list`, so their dashboards
 * search inline instead of linking to /dashboard/customers. Returns only
 * identifying fields; callers decide whether to show the balance.
 */
export async function searchCustomersLite(
  companyId: number,
  query: string,
  limit = 8
): Promise<CustomerHit[]> {
  const needle = query.trim()
  if (!needle) return []

  const db = tenantClient()
  const escaped = needle.replace(/[%,()]/g, '')
  const pattern = '%' + escaped + '%'

  const { data, error } = await db
    .from('customers')
    .select('id, first_name, last_name, phone, mac_address, balance')
    .eq('company_id', companyId)
    .or(
      [
        'first_name.ilike.' + pattern,
        'last_name.ilike.' + pattern,
        'phone.ilike.' + pattern,
        'mac_address.ilike.' + pattern,
      ].join(',')
    )
    .limit(limit)

  if (error) throw new Error('Customer search failed: ' + error.message)

  type Row = {
    id: number
    first_name: string | null
    last_name: string | null
    phone: string | null
    mac_address: string | null
    balance: number | string | null
    status: string | null
  }

  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown',
    phone: r.phone,
    mac_address: r.mac_address,
    balance: r.balance,
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

  const [myTickets, addedRes, openRes] = await Promise.all([
    ticketsAssignedTo(companyId, userId),
    db
      .from('customers')
      .select('id, first_name, last_name, email, phone, mac_address, monthly_rate, balance, last_bill_date, date_added')
      .eq('company_id', companyId)
      .eq('date_added', today)
      .order('id', { ascending: false }),
    db
      .from('support_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', OPEN_STATES),
  ])

  if (addedRes.error) throw new Error('Failed to load new customers: ' + addedRes.error.message)

  return {
    myTickets,
    addedToday: ((addedRes.data ?? []) as unknown as Customer[]).map(withExpiry),
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

  const [todayRes, recentRes] = await Promise.all([
    db
      .from('payments')
      .select('amount')
      .eq('company_id', companyId)
      .eq('agent', agentName)
      .gte('payment_date', since),
    db
      .from('payments')
      .select('id, amount, payment_type, payment_date, customers(first_name, last_name)')
      .eq('company_id', companyId)
      .eq('agent', agentName)
      .gte('payment_date', since)
      .order('payment_date', { ascending: false })
      .limit(10),
  ])

  if (todayRes.error) throw new Error('Failed to load collections: ' + todayRes.error.message)
  if (recentRes.error) throw new Error('Failed to load payments: ' + recentRes.error.message)

  const rows = (todayRes.data ?? []) as { amount: number | string }[]

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

  const [myTickets, openRes] = await Promise.all([
    ticketsAssignedTo(companyId, userId),
    db
      .from('support_tickets')
      .select('customer_id, customers(id, first_name, last_name, mac_address)')
      .eq('company_id', companyId)
      .in('status', OPEN_STATES),
  ])

  if (openRes.error) throw new Error('Failed to load open tickets: ' + openRes.error.message)

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
  for (const row of (openRes.data ?? []) as unknown as Row[]) {
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
