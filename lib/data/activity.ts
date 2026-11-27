import 'server-only'

import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The company-wide activity log: every row of `log` for one company, newest
 * first, with who did it and which customer it was about. The rows are the same
 * ones each customer's Change History reads; this is the view across all of
 * them, for an owner asking "who changed what today".
 */

export const ACTIVITY_GROUPS = [
  { key: 'money', label: 'Money' },
  { key: 'customers', label: 'Customers' },
  { key: 'network', label: 'Network' },
  { key: 'staff', label: 'Staff and logins' },
  { key: 'messages', label: 'Messages' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'settings', label: 'Settings' },
] as const
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number]['key']

/** Which group a log type belongs to, by its name. Anything new lands in Settings. */
export function groupOf(type: string): ActivityGroup {
  if (/^(payment|balance_|credit_|charge_|checkoff|month_settle|reconnection_fee|legacy_payment|billing_run|bulk_bill)/.test(type)) return 'money'
  if (/^(customer_|connection_month|access_already)/.test(type)) return 'customers'
  if (/^(radius_|network_|onu_|olt_|router_tunnel|device|site_)/.test(type)) return 'network'
  if (/^user_/.test(type)) return 'staff'
  if (/^(sms_|email_)/.test(type)) return 'messages'
  if (/^ticket_/.test(type)) return 'tickets'
  return 'settings'
}

/** "balance_adjusted" → "Balance adjusted". */
export function typeLabel(type: string): string {
  const words = type.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export type ActivityRow = {
  id: number
  at: string
  type: string
  group: ActivityGroup
  details: string
  userName: string | null
  customer: { id: number; name: string } | null
}

export type ActivityFilter = {
  userId: number | null
  group: ActivityGroup | null
  /** "YYYY-MM-DD", inclusive, in UTC. */
  from: string | null
  to: string | null
  q: string
  page: number
}

export const ACTIVITY_PAGE = 50

/** Types of each group, for filtering in the database rather than after. */
async function typesIn(companyId: number, group: ActivityGroup): Promise<string[]> {
  const { data } = await tenantClient()
    .from('log')
    .select('type')
    .eq('company_id', companyId)
    .order('id', { ascending: false })
    .limit(5000)
  const seen = new Set(((data ?? []) as { type: string }[]).map((r) => r.type))
  return [...seen].filter((t) => groupOf(t) === group)
}

export async function listActivity(
  companyId: number,
  f: ActivityFilter
): Promise<{ rows: ActivityRow[]; more: boolean; staff: { id: number; name: string }[] }> {
  const db = tenantClient()

  const { data: staffRows } = await db
    .from('users')
    .select('id, first_name, last_name, email')
    .eq('company_id', companyId)
    .order('first_name')
  const staff = ((staffRows ?? []) as { id: number; first_name: string | null; last_name: string | null; email: string }[])
    .map((u) => ({ id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email }))
  const nameOf = new Map(staff.map((s) => [s.id, s.name]))

  let q = db
    .from('log')
    .select('id, created_at, type, details, user_id, customer_id')
    .eq('company_id', companyId)
    .order('id', { ascending: false })
    .range(f.page * ACTIVITY_PAGE, f.page * ACTIVITY_PAGE + ACTIVITY_PAGE) // one extra, to know if there is more
  if (f.userId) q = q.eq('user_id', f.userId)
  if (f.from) q = q.gte('created_at', f.from + 'T00:00:00Z')
  if (f.to) q = q.lte('created_at', f.to + 'T23:59:59.999Z')
  if (f.q) q = q.ilike('details', '%' + f.q.replace(/[%_,()]/g, ' ').trim() + '%')
  if (f.group) {
    const types = await typesIn(companyId, f.group)
    if (types.length === 0) return { rows: [], more: false, staff }
    q = q.in('type', types)
  }
  const { data, error } = await q
  if (error) throw new Error('Could not load the activity log: ' + error.message)
  const raw = (data ?? []) as { id: number; created_at: string; type: string; details: string | null; user_id: number | null; customer_id: number | null }[]
  const more = raw.length > ACTIVITY_PAGE
  const page = raw.slice(0, ACTIVITY_PAGE)

  const customerIds = [...new Set(page.map((r) => r.customer_id).filter((v): v is number => v !== null))]
  const customers = new Map<number, string>()
  if (customerIds.length) {
    const { data: cs } = await db
      .from('customers')
      .select('id, first_name, last_name')
      .eq('company_id', companyId)
      .in('id', customerIds)
    for (const c of (cs ?? []) as { id: number; first_name: string | null; last_name: string | null }[]) {
      customers.set(c.id, [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + c.id)
    }
  }

  return {
    rows: page.map((r) => ({
      id: r.id,
      at: r.created_at,
      type: r.type,
      group: groupOf(r.type),
      details: r.details ?? '',
      userName: r.user_id !== null ? (nameOf.get(r.user_id) ?? 'User #' + r.user_id) : null,
      customer: r.customer_id !== null
        ? { id: r.customer_id, name: customers.get(r.customer_id) ?? 'Customer #' + r.customer_id + ' (deleted)' }
        : null,
    })),
    more,
    staff,
  }
}

/** How many changes in the last 7 days, for the Settings card. */
export async function recentActivityCount(companyId: number): Promise<number | null> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { count, error } = await tenantClient()
    .from('log')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('created_at', since)
  return error ? null : (count ?? 0)
}
