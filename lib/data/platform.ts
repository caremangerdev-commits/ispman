import { createAdminClient } from '@/lib/supabase/admin'

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

  const [companiesRes, customersRes, paymentsRes] = await Promise.all([
    db.from('companies').select('id, name, plan, status, created_at').order('id'),
    db.from('customers').select('id, company_id'),
    db.from('payments').select('amount').gte('payment_date', startOfMonth),
  ])

  if (companiesRes.error) throw new Error('Failed to load companies: ' + companiesRes.error.message)
  if (customersRes.error) throw new Error('Failed to load customers: ' + customersRes.error.message)
  if (paymentsRes.error) throw new Error('Failed to load payments: ' + paymentsRes.error.message)

  const customers = (customersRes.data ?? []) as unknown as { id: number; company_id: number }[]

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

  const revenueThisMonth = ((paymentsRes.data ?? []) as unknown as { amount: number | string }[])
    .reduce((sum, p) => sum + Number(p.amount ?? 0), 0)

  return {
    companyCount: companies.length,
    customerCount: customers.length,
    revenueThisMonth,
    companies,
  }
}
