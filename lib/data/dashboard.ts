import { batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { lastNetworkEvents } from '@/lib/data/network-events'
import { withBillingDefaults } from '@/lib/data/customers'
import {
  CUSTOMER_STATUSES, resolveStatus, STATUS_LABELS, type CustomerStatus,
} from '@/lib/status'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { percentChange, withExpiry } from '@/lib/domain'
import type {
  Customer,
  CustomerWithExpiry,
  LogRow,
  NotificationRow,
  PaymentRow,
  TicketRow,
} from '@/lib/types'

export type Trend = { direction: 'up' | 'down' | 'flat'; percent: number } | null

export type Stats = {
  totalCustomers: number
  totalCustomersTrend: Trend
  /** Every count below is derived from the network registry, not from Postgres. */
  activeCustomers: number
  activeCustomersTrend: Trend
  expiredCustomers: number
  inactiveCustomers: number
  unprovisionedCustomers: number
  disconnectedCustomers: number
  /** False when the registry could not be consulted; counts read 'unknown'. */
  radiusKnown: boolean
  revenueThisMonth: number
  revenueTrend: Trend
  outstandingBalance: number
  accountsInArrears: number
}

export type RevenuePoint = {
  month: string
  /**
   * The recurring monthly value of the book of business at the end of this
   * month — NOT what was billed.
   *
   * Named `recurring` rather than `billed` on purpose. It is the sum of every
   * onboarded customer's CURRENT monthly_rate, so it is cumulative, monotonic,
   * and retroactively restated whenever a rate changes. Nothing about an actual
   * bill run reaches it: Bill All writes carried_balance and last_billed_date,
   * and neither is read here.
   *
   * Attributing real bills to the periods they cover needs per-bill history,
   * which the schema does not have yet — see supabase/migrations/0014_bills.sql.
   */
  recurring: number
  collected: number
}
export type StatusSlice = { bucket: CustomerStatus; label: string; count: number }

export type DashboardData = {
  stats: Stats
  revenue: RevenuePoint[]
  statusBreakdown: StatusSlice[]
  recentPayments: PaymentRow[]
  urgentCustomers: CustomerWithExpiry[]
  recentTickets: TicketRow[]
  activity: LogRow[]
}

function toTrend(pct: number | null): Trend {
  if (pct === null) return null
  if (Math.abs(pct) < 0.5) return { direction: 'flat', percent: 0 }
  return { direction: pct > 0 ? 'up' : 'down', percent: Math.abs(pct) }
}

const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)
const num = (v: unknown) => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * What one customer owes, from whichever column is authoritative for them.
 *
 * Postpaid debt lives in `carried_balance`: the bill run adds the monthly rate
 * there and never touches `balance`. Prepaid debt lives in `balance`, which is
 * also the only column adjustBalance() moves when a payment is corrected.
 *
 * NOT the sum of the two. A prepaid payment writes the same shortfall to BOTH
 * columns (app/actions/payments.ts, the else branch of the settle step), so
 * adding them reports every prepaid arrear twice.
 *
 * Before migration 0011 every row reads as prepaid — withBillingDefaults makes
 * sure of that — so this is exactly the old `balance` behaviour until it lands.
 */
function amountOwed(c: Customer): number {
  return c.billing_type === 'postpaid' ? num(c.carried_balance) : num(c.balance)
}

export async function getDashboardData(companyId: number): Promise<DashboardData> {
  // Reads go through the tenant client and are scoped by companyId — see the
  // RLS note in lib/supabase/tenant.ts.
  const supabase = tenantClient()
  // Revenue is reported on paid_on where it exists, so a back-dated payment
  // lands in the month it was taken rather than the month it was entered.
  const caps = await getSchemaCapabilities()

  const now = new Date()
  const sixMonthsAgo = monthStart(new Date(now.getFullYear(), now.getMonth() - 5, 1))
  // YYYY-MM-DD in local terms, for comparing against the paid_on DATE column.
  const asYmd = (d: Date) =>
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0')

  const [customersRes, paymentsRes, recentPaymentsRes, ticketsRes, logRes] =
    await Promise.all([
      // The customer set for an ISP branch is small enough to read whole, and
      // expiry is a derived value Postgres has no column for — so bucketing
      // happens here rather than in SQL. Revisit with a view if this grows.
      supabase
        .from('customers')
        .select(
          'id, first_name, last_name, email, phone, mac_address, monthly_rate, balance, last_bill_date, date_added' +
          // Only once 0011 exists: PostgREST rejects the whole query for one
          // unknown column. Without them every row reads as prepaid below,
          // which is how the app treated everybody before that migration.
          (caps.billing ? ', billing_type, carried_balance, account_credit, bill_date, last_billed_date' : '')
        )
        .eq('company_id', companyId),

      supabase
        .from('payments')
        .select('amount, payment_date' + (caps.otherPayments ? ', paid_on' : ''))
        .eq('company_id', companyId)
        .gte(
          caps.otherPayments ? 'paid_on' : 'payment_date',
          caps.otherPayments ? asYmd(sixMonthsAgo) : sixMonthsAgo.toISOString()
        ),

      supabase
        .from('payments')
        .select('id, amount, payment_type, payment_date, agent, customers(first_name, last_name)')
        .eq('company_id', companyId)
        .order('payment_date', { ascending: false })
        .limit(8),

      supabase
        .from('support_tickets')
        .select('id, title, status, priority, created_at, customers(first_name, last_name)')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(5),

      supabase
        .from('log')
        .select('id, type, details, created_at')
        .eq('company_id', companyId)
        .order('created_at', { ascending: false })
        .limit(8),
    ])

  for (const [name, res] of Object.entries({
    customers: customersRes,
    payments: paymentsRes,
    recentPayments: recentPaymentsRes,
    tickets: ticketsRes,
    log: logRes,
  })) {
    if (res.error) throw new Error('Failed to load ' + name + ': ' + res.error.message)
  }

  // Through withBillingDefaults rather than a bare cast: `Customer` declares
  // the 0011 columns as always present, and before that migration the select
  // above does not fetch them at all. The cast used to assert five fields onto
  // rows that did not carry them.
  const customers = ((customersRes.data ?? []) as unknown as Record<string, unknown>[])
    .map((row) => withBillingDefaults(row) as unknown as Customer)
    .map(withExpiry)
  const payments = (paymentsRes.data ?? []) as unknown as {
    amount: number | string
    payment_date: string
    paid_on?: string | null
  }[]

  // --- status, entirely from the network registry ---------------------------
  // There is no customers.status column any more. One batched lookup for the
  // whole company decides every count below.
  let radiusKnown = radiusConfigured()
  let registry = new Map<string, { status: CustomerStatus; expiry: Date | null }>()

  if (radiusKnown) {
    try {
      registry = await batchGetRadiusStatus(customers.map((c) => c.mac_address))
    } catch (err) {
      // A NAS we cannot reach means unknown, not absent. Without this the
      // dashboard would report every customer unregistered the moment the
      // MySQL box hiccups.
      console.error('[dashboard] network status lookup failed:', (err as Error).message)
      radiusKnown = false
    }
  }

  // radcheck cannot tell a deliberate cut-off from an ordinary lapse — both
  // are an expiry in the past — so the event log supplies the difference.
  const events = await lastNetworkEvents(companyId, customers.map((c) => c.id))

  for (const c of customers) {
    const key = c.mac_address ? c.mac_address.trim().toUpperCase() : null
    const hit = key ? registry.get(key) : undefined
    const base = hit ? hit.status : radiusKnown ? 'unprovisioned' : 'unknown'
    c.radiusStatus = resolveStatus(base, events.get(c.id))
    c.radiusExpiry = hit?.expiry ?? null
  }

  const countOf = (s: CustomerStatus) =>
    customers.filter((c) => c.radiusStatus === s).length

  // --- status breakdown, straight from the registry ------------------------
  const statusBreakdown: StatusSlice[] = CUSTOMER_STATUSES
    .map((k) => ({ bucket: k, label: STATUS_LABELS[k], count: countOf(k) }))
    .filter((slice) => slice.count > 0)

  // --- revenue series ------------------------------------------------------
  const months: RevenuePoint[] = []
  for (let i = 5; i >= 0; i--) {
    const start = monthStart(new Date(now.getFullYear(), now.getMonth() - i, 1))
    const end = monthStart(new Date(now.getFullYear(), now.getMonth() - i + 1, 1))

    const collected = payments
      .filter((p) => {
        // paid_on is a calendar date and is bucketed as a string, so a payment
        // is never moved between months by a timezone conversion. Rows written
        // before 0013 have none and fall back to the timestamp.
        if (p.paid_on) return p.paid_on >= asYmd(start) && p.paid_on < asYmd(end)
        const t = new Date(p.payment_date).getTime()
        return t >= start.getTime() && t < end.getTime()
      })
      .reduce((sum, p) => sum + num(p.amount), 0)

    // The recurring book of business, not billing. See RevenuePoint.recurring
    // for why this is not, and cannot yet be, "what was billed this month".
    const recurring = customers
      .filter((c) => c.date_added && new Date(c.date_added).getTime() < end.getTime())
      .reduce((sum, c) => sum + num(c.monthly_rate), 0)

    months.push({
      month: start.toLocaleDateString('en-US', { month: 'short' }),
      recurring,
      collected,
    })
  }

  // --- stats ---------------------------------------------------------------
  const thisMonth = months[months.length - 1]?.collected ?? 0
  const lastMonth = months[months.length - 2]?.collected ?? 0

  const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()).getTime()
  const existedLastMonth = customers.filter(
    (c) => c.date_added && new Date(c.date_added).getTime() <= oneMonthAgo
  )
  // Active means exactly one thing now: the registry says this customer can
  // get online. Compared against the same basis a month back — the registry
  // keeps no history, so today's state stands in for last month's, which is
  // the closest consistent basis available.
  const activeNow = customers.filter((c) => c.radiusStatus === 'active')
  const activeLastMonth = existedLastMonth.filter((c) => c.radiusStatus === 'active')

  const stats: Stats = {
    totalCustomers: customers.length,
    totalCustomersTrend: toTrend(percentChange(customers.length, existedLastMonth.length)),
    activeCustomers: activeNow.length,
    activeCustomersTrend: toTrend(percentChange(activeNow.length, activeLastMonth.length)),
    expiredCustomers: countOf('expired'),
    inactiveCustomers: countOf('inactive'),
    unprovisionedCustomers: countOf('unprovisioned'),
    disconnectedCustomers: countOf('disconnected'),
    radiusKnown,
    revenueThisMonth: thisMonth,
    revenueTrend: toTrend(percentChange(thisMonth, lastMonth)),
    // One rule for both, or the money and the head count describe different
    // sets of people.
    outstandingBalance: customers.reduce((s, c) => s + amountOwed(c), 0),
    accountsInArrears: customers.filter((c) => amountOwed(c) > 0).length,
  }

  // --- needs attention: whatever the registry says is not currently on ------
  const urgentCustomers = customers
    .filter((c) => c.radiusStatus && c.radiusStatus !== 'active')
    .sort((a, b) => (a.radiusExpiry?.getTime() ?? 0) - (b.radiusExpiry?.getTime() ?? 0))
    .slice(0, 6)

  return {
    stats,
    revenue: months,
    statusBreakdown,
    recentPayments: (recentPaymentsRes.data ?? []) as unknown as PaymentRow[],
    urgentCustomers,
    recentTickets: (ticketsRes.data ?? []) as unknown as TicketRow[],
    activity: (logRes.data ?? []) as LogRow[],
  }
}

/** Navbar bell: the 5 newest notifications plus the unread count. */
export async function getNotifications(
  companyId: number
): Promise<{ items: NotificationRow[]; unread: number }> {
  // Reads go through the tenant client and are scoped by companyId — see the
  // RLS note in lib/supabase/tenant.ts.
  const supabase = tenantClient()

  const [listRes, countRes] = await Promise.all([
    supabase
      .from('notifications_queue')
      .select('id, type, message, status, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('notifications_queue')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'pending'),
  ])

  if (listRes.error) throw new Error('Failed to load notifications: ' + listRes.error.message)

  return {
    items: (listRes.data ?? []) as NotificationRow[],
    unread: countRes.count ?? 0,
  }
}
