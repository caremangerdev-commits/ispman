import { cache } from 'react'
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'

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
  company: SessionCompany
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

  const tCo = Date.now()
  const { data: companyRow, error: companyError } = await db
    .from('companies')
    .select('id, name, plan, status')
    .eq('id', profile.company_id)
    .maybeSingle()
  console.log('[perf]     getSession: companies select       %dms', Date.now() - tCo)
  console.log('[perf]     getSession: TOTAL                  %dms', Date.now() - tSess)

  if (companyError) throw new Error('Failed to load company: ' + companyError.message)
  if (!companyRow) throw new Error('User ' + profile.id + ' references a missing company.')

  return {
    authUser,
    profile,
    company: companyRow as unknown as SessionCompany,
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
