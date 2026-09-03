'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'

import {
  ACTING_COMPANY_COOKIE,
  ACTING_COOKIE_OPTIONS,
  formatActingCookie,
} from '@/lib/acting-company'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The super admin company switcher.
 *
 * Setting the acting company is the largest privilege expansion in this app, so
 * the check here is the same one app/actions/platform.ts uses for its
 * cross-tenant writes: the `is_super_admin` flag on the row loaded for the
 * verified session, not a permission and not the role string. A company_admin
 * is the top of their own tenant and must never reach this.
 *
 * This is the WRITE half of the guard. The read half — which is what actually
 * decides whether the cookie means anything — lives in lib/session.ts and runs
 * on every request. Neither one trusts the other: even if this action were
 * somehow reached, the cookie it writes is inert for a caller whose database
 * row does not say super admin.
 */
async function authorizeSuperAdmin() {
  const session = await getSession()
  if (!session.profile.is_super_admin) {
    throw new Error('Forbidden: super admin only.')
  }
  return session
}

export async function enterCompany(formData: FormData) {
  const { profile } = await authorizeSuperAdmin()

  const raw = formData.get('company_id')
  const companyId = Number(typeof raw === 'string' ? raw : NaN)
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new Error('Invalid company.')
  }

  // Confirm the tenant exists before pointing a session at it, so a mistyped id
  // fails here rather than silently resolving back to their own company on the
  // next request.
  const { data, error } = await tenantClient()
    .from('companies')
    .select('id')
    .eq('id', companyId)
    .maybeSingle()

  if (error) throw new Error('Could not load that company: ' + error.message)
  if (!data) throw new Error('That company no longer exists.')

  const store = await cookies()
  store.set(
    ACTING_COMPANY_COOKIE,
    formatActingCookie(companyId, profile.id),
    ACTING_COOKIE_OPTIONS
  )

  // Every layout and page resolves its company through getSession(), so the
  // whole tree is now stale — including the client-side Router Cache, which
  // would otherwise serve a pre-switch /dashboard on a back navigation.
  revalidatePath('/', 'layout')

  redirect('/dashboard')
}

/**
 * Returns the operator to their own company.
 *
 * Deliberately NOT gated: clearing the switch only ever narrows access, and a
 * caller who somehow holds a stale cookie should always be able to drop it.
 */
export async function exitCompany() {
  const store = await cookies()
  store.delete(ACTING_COMPANY_COOKIE)

  revalidatePath('/', 'layout')

  redirect('/superadmin')
}
