import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

import { readActingCookie } from '@/lib/acting-company'
import { can, toRole, type Permission, type Role } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'
import { tenantClient } from '@/lib/supabase/tenant'

export type Profile = {
  id: number
  first_name: string | null
  last_name: string | null
  email: string
  role: Role
  company_id: number
  is_super_admin: boolean
}

export type SessionCompany = {
  id: number
  name: string
  plan: string | null
  status: string | null
}

export type Session = {
  authUser: User
  profile: Profile
  /**
   * The company that scopes every query in the app.
   *
   * Normally this is the caller's own company. For a verified super admin who
   * has entered a tenant it is THAT tenant — which is the whole mechanism of
   * the company switcher: `profile.company_id` is read in exactly one place
   * (the resolution below), and everything else in the codebase already scopes
   * on `session.company.id`.
   */
  company: SessionCompany
  /**
   * Non-null only while a verified super admin is switched into a tenant.
   * Drives the persistent banner and the acting marker on audit rows.
   *
   * The switch never changes WHO the caller is: `authUser` and `profile` —
   * including `profile.id`, `profile.role` and `profile.company_id` — are
   * untouched, so logging still records their own user id and their
   * permissions still come from super_admin.
   */
  actingAs: SessionCompany | null
  /** The caller's own company. Equal to `company` when not switched. */
  homeCompany: SessionCompany
}

/**
 * supabase/migrations/0002_roles.sql has been applied, so `users.is_super_admin`
 * exists and is the source of truth for platform-level access.
 *
 * The role is no longer consulted for this: a row can hold role 'super_admin'
 * with the flag off, and the flag is what gates /superadmin.
 */
const HAS_SUPER_ADMIN_COLUMN = true

const BASE_COLUMNS = 'id, first_name, last_name, email, role, company_id'

/**
 * Resolves the signed-in Supabase auth account to its application profile and
 * company. Call this at the top of every server component page.
 *
 * Wrapped in React `cache` so a layout and the page beneath it share a single
 * round trip per request.
 *
 * Redirects to /login when there is no session, and to /login?error=no_profile
 * when the auth account has no matching `users` row.
 */
export const getSession = cache(async (): Promise<Session> => {
  // [perf] TEMPORARY instrumentation
  const tSess = Date.now()
  const supabase = await createClient()

  // getUser() revalidates the token with Supabase. Never make an authorization
  // decision from getSession() alone.
  const tAuth = Date.now()
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser()
  console.log('[perf]     getSession: auth.getUser           %dms', Date.now() - tAuth)

  if (!authUser?.email) redirect('/login')

  // Reads go through the tenant client because RLS has no policies yet — see
  // lib/supabase/tenant.ts. Scoped to the verified session's own email.
  const db = tenantClient()

  const columns = HAS_SUPER_ADMIN_COLUMN
    ? BASE_COLUMNS + ', is_super_admin'
    : BASE_COLUMNS

  const tUser = Date.now()
  const { data: row, error } = await db
    .from('users')
    .select(columns)
    .eq('email', authUser.email)
    .maybeSingle()
  console.log('[perf]     getSession: users select           %dms', Date.now() - tUser)

  if (error) throw new Error('Failed to load user profile: ' + error.message)
  if (!row) redirect('/login?error=no_profile')

  const raw = row as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
    email: string
    role: string | null
    company_id: number
    is_super_admin?: boolean | null
  }

  const role = toRole(raw.role)

  const profile: Profile = {
    id: raw.id,
    first_name: raw.first_name,
    last_name: raw.last_name,
    email: raw.email,
    role,
    company_id: raw.company_id,
    is_super_admin: HAS_SUPER_ADMIN_COLUMN
      ? Boolean(raw.is_super_admin)
      : role === 'super_admin',
  }

  // -------------------------------------------------------------------------
  // Acting company (super admin "enter company" switch)
  //
  // THIS IS THE AUTHORIZATION BOUNDARY FOR CROSS-TENANT ACCESS, and it runs on
  // every request rather than only when the switch is set, because every page,
  // server action and route handler in the app resolves its company through
  // getSession().
  //
  // The cookie is only ever a POINTER at a company. It is honoured when, and
  // only when, ALL of the following hold:
  //
  //   1. `is_super_admin` is true on the `users` row just read above, by the
  //      email on a token that auth.getUser() revalidated with Supabase. The
  //      flag comes from the database on this request — never from the cookie,
  //      never from the JWT, never from the role string.
  //   2. The cookie names the user who set it, and that is this user. A cookie
  //      left behind by another account is dead on arrival.
  //   3. The company it names actually exists.
  //
  // Anything else falls through to the caller's own company. A non-super-admin
  // who forges this cookie by any means simply stays in their own tenant.
  //
  // A stale cookie is ignored rather than deleted: a Server Component cannot
  // write cookies. exitCompany() and signOut() clear it.
  // -------------------------------------------------------------------------
  const actingCookie = profile.is_super_admin ? await readActingCookie() : null

  const requestedCompanyId =
    actingCookie && actingCookie.userId === profile.id ? actingCookie.companyId : null

  // Both companies in one round trip — the tenant being acted in, and the
  // caller's own, which the banner's Exit path returns to.
  const wantedIds =
    requestedCompanyId === null || requestedCompanyId === profile.company_id
      ? [profile.company_id]
      : [profile.company_id, requestedCompanyId]

  const tCo = Date.now()
  const { data: companyRows, error: companyError } = await db
    .from('companies')
    .select('id, name, plan, status')
    .in('id', wantedIds)
  console.log('[perf]     getSession: companies select       %dms', Date.now() - tCo)
  console.log('[perf]     getSession: TOTAL                  %dms', Date.now() - tSess)

  if (companyError) throw new Error('Failed to load company: ' + companyError.message)

  const rows = (companyRows ?? []) as unknown as SessionCompany[]
  const homeCompany = rows.find((c) => c.id === profile.company_id)

  if (!homeCompany) throw new Error('User ' + profile.id + ' references a missing company.')

  // Resolves to null when the switch is not set, was refused above, or names a
  // company that has since been deleted.
  const actingAs =
    requestedCompanyId === null
      ? null
      : rows.find((c) => c.id === requestedCompanyId) ?? null

  return {
    authUser,
    profile,
    company: actingAs ?? homeCompany,
    actingAs,
    homeCompany,
  }
})

/**
 * Guard for a page that requires one permission.
 *
 * Sends the user back to their dashboard with a flag the dashboard renders as
 * an "access denied" banner, rather than showing a bare error page.
 */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await getSession()
  if (!can(session.profile.role, permission)) {
    redirect('/dashboard?denied=' + permission)
  }
  return session
}

export function displayName(profile: Pick<Profile, 'first_name' | 'last_name' | 'email'>) {
  return [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email
}
