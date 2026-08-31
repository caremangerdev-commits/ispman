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
  /** Not shown in the table; seeds the edit dialog. */
  phone: string | null
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
 *
 * Exported because the super admin's per-company page needs the same derivation
 * (lib/data/platform.ts). Already platform-wide — it lists every auth account
 * regardless of tenant — so sharing it widens nothing.
 */
export async function bannedEmails(): Promise<Set<string>> {
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

/** Roles that only an admin-level caller may see or act on. */
export const ADMIN_ROLES = ['company_admin', 'super_admin']

/**
 * Whether a role may see and act on admin rows.
 *
 * The single definition of "admin-level caller", used by the list filter here
 * and by the target checks in app/actions/users.ts, so the rows a caller can
 * see and the rows they can write can never disagree.
 */
export function seesAdminRows(role: Role): boolean {
  return ADMIN_ROLES.includes(role)
}

/**
 * Staff for one company. Never returns another tenant's users.
 *
 * `viewerRole` filters admin rows out of the RESULT, not out of the render: a
 * manager's page payload must not contain a company_admin at all, so the row
 * cannot be read out of the HTML or the RSC stream. The server actions repeat
 * the same check against the target's stored role, because hiding a row only
 * removes the obvious path — a server action is still a public POST endpoint.
 */
export async function listCompanyUsers(
  companyId: number,
  viewerRole: Role
): Promise<CompanyUser[]> {
  const db = tenantClient()

  let query = db
    .from('users')
    .select('id, first_name, last_name, email, phone, role, created_at, is_super_admin')
    .eq('company_id', companyId)

  // Filtered in the query rather than afterwards, so the rows never travel.
  if (!seesAdminRows(viewerRole)) {
    query = query.not('role', 'in', '(' + ADMIN_ROLES.join(',') + ')')
  }

  const { data, error } = await query.order('id', { ascending: true })

  if (error) throw new Error('Failed to load users: ' + error.message)

  const rows = (data ?? []) as unknown as Omit<CompanyUser, 'active'>[]

  // Belt and braces: is_super_admin is a separate column from `role`, so a row
  // could in principle carry the flag without the role string. Drop those too
  // rather than let one through on a technicality.
  const visible = seesAdminRows(viewerRole)
    ? rows
    : rows.filter((r) => !r.is_super_admin)

  const banned = await bannedEmails()

  return visible.map((r) => ({
    ...r,
    is_super_admin: Boolean(r.is_super_admin),
    active: !banned.has((r.email ?? '').toLowerCase()),
  }))
}
