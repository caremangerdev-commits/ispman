import type { Role } from '@/lib/permissions'
import { supabaseUrl } from '@/lib/supabase/env'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Roles a company_admin may hand out.
 *
 * Deliberately excludes company_admin and super_admin: an admin must not be
 * able to mint a peer or escalate to platform level from this screen.
 */
export const ASSIGNABLE_ROLES: Role[] = ['manager', 'csr', 'cashier', 'technician']

export type CompanyUser = {
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

function serviceHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  return { apikey: key, Authorization: 'Bearer ' + key }
}

/**
 * Emails whose auth account is currently banned.
 *
 * `users` has no status column, so "active" is a property of the auth account.
 * GoTrue offers no get-by-email, hence the single list call.
 */
async function bannedEmails(): Promise<Set<string>> {
  const res = await fetch(supabaseUrl() + '/auth/v1/admin/users?page=1&per_page=200', {
    headers: serviceHeaders(),
    cache: 'no-store',
  })
  if (!res.ok) return new Set()

  const { users = [] } = (await res.json()) as {
    users: { email: string; banned_until?: string | null }[]
  }

  const banned = new Set<string>()
  for (const u of users) {
    if (u.banned_until && new Date(u.banned_until) > new Date()) {
      banned.add((u.email ?? '').toLowerCase())
    }
  }
  return banned
}

/** Staff for one company. Never returns another tenant's users. */
export async function listCompanyUsers(companyId: number): Promise<CompanyUser[]> {
  const db = tenantClient()
  const { data, error } = await db
    .from('users')
    .select('id, first_name, last_name, email, role, created_at, is_super_admin')
    .eq('company_id', companyId)
    .order('id', { ascending: true })

  if (error) throw new Error('Failed to load users: ' + error.message)

  const rows = (data ?? []) as unknown as Omit<CompanyUser, 'active'>[]
  const banned = await bannedEmails()

  return rows.map((r) => ({
    ...r,
    is_super_admin: Boolean(r.is_super_admin),
    active: !banned.has((r.email ?? '').toLowerCase()),
  }))
}
