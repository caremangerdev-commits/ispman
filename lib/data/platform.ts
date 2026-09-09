import { bannedEmails } from '@/lib/data/users'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchAllRows } from '@/lib/supabase/paging'

/**
 * Platform-wide queries for the super admin section.
 *
 * These deliberately use the service-role client with NO company_id filter —
 * a super admin is cross-tenant by definition. Every other data module in the
 * app must stay scoped; this is the one exception, and only reachable behind
 * the is_super_admin check in app/superadmin/layout.tsx.
 */

export type PlatformCompany = {
  id: number
  name: string
  plan: string | null
  status: string | null
  created_at: string | null
  customerCount: number
}

export type PlatformStats = {
  companyCount: number
  customerCount: number
  revenueThisMonth: number
  companies: PlatformCompany[]
}

export async function getPlatformStats(): Promise<PlatformStats> {
  const db = createAdminClient()

  const startOfMonth = (() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1).toISOString()
  })()

  // These two are PLATFORM-WIDE — no company filter — so they cross the
  // 1000-row ceiling sooner than anything scoped to one company, and they did.
  // This page reported 682 customers for a company with 977 and 301 for one
  // with 317: a 30% undercount rendered as a plain number with nothing to
  // suggest it was short. See lib/supabase/paging.ts.
  const [companiesRes, customers, payments] = await Promise.all([
    db.from('companies').select('id, name, plan, status, created_at').order('id'),
    fetchAllRows(
      (from, to) =>
        db.from('customers').select('id, company_id').order('id').range(from, to),
      'customers'
    ) as Promise<{ id: number; company_id: number }[]>,
    fetchAllRows(
      (from, to) =>
        db
          .from('payments')
          .select('amount')
          .gte('payment_date', startOfMonth)
          .order('id')
          .range(from, to),
      'payments'
    ) as Promise<{ amount: number | string }[]>,
  ])

  if (companiesRes.error) throw new Error('Failed to load companies: ' + companiesRes.error.message)

  const perCompany = new Map<number, number>()
  for (const c of customers) {
    perCompany.set(c.company_id, (perCompany.get(c.company_id) ?? 0) + 1)
  }

  type CompanyRow = {
    id: number
    name: string
    plan: string | null
    status: string | null
    created_at: string | null
  }

  const companies = ((companiesRes.data ?? []) as unknown as CompanyRow[]).map((c) => ({
    ...c,
    customerCount: perCompany.get(c.id) ?? 0,
  }))

  const revenueThisMonth = payments
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0)

  return {
    companyCount: companies.length,
    customerCount: customers.length,
    revenueThisMonth,
    companies,
  }
}

// ---------------------------------------------------------------------------
// One company, for the platform operator's detail page
// ---------------------------------------------------------------------------

export type CompanyDetailUser = {
  id: number
  first_name: string | null
  last_name: string | null
  email: string
  role: string | null
  created_at: string | null
  is_super_admin: boolean
  /** Derived from the auth account, not a column on `users`. */
  active: boolean
}

export type CompanyDetail = {
  company: {
    id: number
    name: string
    email: string | null
    phone: string | null
    address: string | null
    plan: string | null
    status: string | null
    created_at: string | null
  }
  /** Null when the company has no settings row — worth showing, not hiding. */
  settings: {
    currency: string | null
    timezone: string | null
    cut_off_date: number | null
    bill_date: number | null
    grace_period_days: number | null
    sms_enabled: boolean | null
    email_enabled: boolean | null
  } | null
  counts: {
    customers: number
    users: number
    paymentsThisMonth: number
    revenueThisMonth: number
  }
  users: CompanyDetailUser[]
}

/**
 * Everything the super admin's per-company page shows.
 *
 * DELIBERATELY UNFILTERED BY ROLE. listCompanyUsers hides company_admin and
 * super_admin rows from a non-admin caller inside a tenant; this is the
 * platform operator's view of a tenant from outside it, so every account shows,
 * including the ones that tenant's own managers cannot see. That is the whole
 * point of the page — an unreachable admin is exactly what it exists to recover.
 *
 * Returns null when the company does not exist, so the page can 404.
 */
export async function getCompanyDetail(companyId: number): Promise<CompanyDetail | null> {
  const db = createAdminClient()

  const startOfMonth = (() => {
    const n = new Date()
    return new Date(n.getFullYear(), n.getMonth(), 1).toISOString()
  })()

  const [companyRes, settingsRes, usersRes, customerRes, payments] = await Promise.all([
    db
      .from('companies')
      .select('id, name, email, phone, address, plan, status, created_at')
      .eq('id', companyId)
      .maybeSingle(),
    db
      .from('settings')
      .select('currency, timezone, cut_off_date, bill_date, grace_period_days, sms_enabled, email_enabled')
      .eq('company_id', companyId)
      .maybeSingle(),
    db
      .from('users')
      .select('id, first_name, last_name, email, role, created_at, is_super_admin')
      .eq('company_id', companyId)
      .order('id', { ascending: true }),
    db.from('customers').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    // Paged: this drives both paymentsThisMonth and revenueThisMonth, and a
    // truncated read would understate the money a tenant took without saying
    // so. The customer count above is a head request, which PostgREST answers
    // with the real total and no rows, so the ceiling does not reach it.
    fetchAllRows(
      (from, to) =>
        db
          .from('payments')
          .select('amount')
          .eq('company_id', companyId)
          .gte('payment_date', startOfMonth)
          .order('id')
          .range(from, to),
      'payments'
    ) as Promise<{ amount: number | string }[]>,
  ])

  if (companyRes.error) {
    throw new Error('Failed to load company: ' + companyRes.error.message)
  }
  if (!companyRes.data) return null

  if (usersRes.error) throw new Error('Failed to load users: ' + usersRes.error.message)

  // A missing settings row is a real state the page should surface, not an
  // error — step 2 of company creation can fail on its own.
  const settings = settingsRes.error ? null : settingsRes.data

  const rows = (usersRes.data ?? []) as unknown as Omit<CompanyDetailUser, 'active'>[]
  const banned = await bannedEmails()

  return {
    company: companyRes.data as unknown as CompanyDetail['company'],
    settings: (settings ?? null) as unknown as CompanyDetail['settings'],
    counts: {
      customers: customerRes.count ?? 0,
      users: rows.length,
      paymentsThisMonth: payments.length,
      revenueThisMonth: payments.reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
    },
    users: rows.map((r) => ({
      ...r,
      is_super_admin: Boolean(r.is_super_admin),
      active: !banned.has((r.email ?? '').toLowerCase()),
    })),
  }
}
