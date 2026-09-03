'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { logEvent } from '@/lib/audit'
import { CURRENCIES, TIMEZONES } from '@/lib/data/company'
import { getSchemaCapabilities } from '@/lib/schema'
import { createAdminClient } from '@/lib/supabase/admin'
import { supabaseUrl } from '@/lib/supabase/env'
import { getSession } from '@/lib/session'

/**
 * Super-admin-only mutations.
 *
 * Gated on the profile flag rather than a permission, because these cross
 * tenant boundaries entirely — no company-scoped role should ever reach them.
 */
async function authorizeSuperAdmin() {
  const session = await getSession()
  if (!session.profile.is_super_admin) {
    throw new Error('Forbidden: super admin only.')
  }
  return session
}

async function setCompanyStatus(formData: FormData, status: 'active' | 'suspended') {
  await authorizeSuperAdmin()

  const raw = formData.get('id')
  const id = Number(typeof raw === 'string' ? raw : NaN)
  if (!Number.isInteger(id)) return

  const db = createAdminClient()
  const { error } = await db.from('companies').update({ status }).eq('id', id)
  if (error) throw new Error('Could not update company: ' + error.message)

  revalidatePath('/superadmin')
}

export async function suspendCompany(formData: FormData) {
  await setCompanyStatus(formData, 'suspended')
}

export async function activateCompany(formData: FormData) {
  await setCompanyStatus(formData, 'active')
}

// ---------------------------------------------------------------------------
// Cross-tenant password reset
// ---------------------------------------------------------------------------

/** Looks up an auth account by email; GoTrue has no direct get-by-email. */
async function findAuthUserByEmail(email: string): Promise<{ id: string } | null> {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const res = await fetch(supabaseUrl() + '/auth/v1/admin/users?page=1&per_page=200', {
    headers: { apikey: key, Authorization: 'Bearer ' + key },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error('Could not list auth users: ' + res.status)

  const { users = [] } = (await res.json()) as { users: { id: string; email: string }[] }
  const found = users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase())
  return found ? { id: found.id } : null
}

/**
 * Resets any user's password, in any company.
 *
 * SEPARATE FROM resetUserPassword ON PURPOSE. That one is correctly scoped to
 * the caller's own tenant and must stay that way; widening it would hand every
 * company_admin and manager a cross-tenant reach they should never have. This
 * one is gated on the platform flag alone and is reachable only from
 * /superadmin, which the layout already guards.
 *
 * It exists for one situation: a tenant whose only admin cannot sign in. The
 * company switcher does not replace it — entering a tenant lets an operator
 * work inside it, but it cannot hand the tenant's own admin their account back.
 *
 * Behaviour is unchanged by the switcher. Only the audit write moved to
 * lib/audit.ts#logEvent, which files the row against the same company as
 * before.
 *
 * The target's own company_id is read from the row and used for the audit entry,
 * so the log lands in the tenant the change actually affected rather than in the
 * operator's.
 */
export async function resetPasswordAsSuperAdmin(
  _prev: CompanyResult | null,
  formData: FormData
): Promise<CompanyResult> {
  const { profile } = await authorizeSuperAdmin()

  const rawId = formData.get('user_id')
  const userId = Number(typeof rawId === 'string' ? rawId : NaN)
  if (!Number.isInteger(userId)) return { ok: false, error: 'Missing user id.' }

  const password = str(formData, 'password')
  if (password.length < 8) {
    return { ok: false, error: 'Temporary password must be at least 8 characters.' }
  }

  // Your own password goes through Change Password in the account menu, which
  // verifies the current one first. Same rule the tenant-scoped actions apply.
  if (userId === profile.id) {
    return {
      ok: false,
      error: 'Use Change Password in your account menu for your own account.',
    }
  }

  const db = createAdminClient()

  // No company filter — that is the point — but the row is still read back so
  // the audit entry records the tenant this actually affected.
  const { data } = await db
    .from('users')
    .select('id, email, company_id, role')
    .eq('id', userId)
    .maybeSingle()

  const target = data as unknown as {
    id: number; email: string; company_id: number; role: string | null
  } | null

  if (!target) return { ok: false, error: 'That user no longer exists.' }

  const authUser = await findAuthUserByEmail(target.email)
  if (!authUser) {
    return { ok: false, error: 'No sign-in account exists for ' + target.email + '.' }
  }

  const { error } = await db.auth.admin.updateUserById(authUser.id, { password })
  if (error) return { ok: false, error: 'Could not reset the password: ' + error.message }

  // Same shape as the tenant-scoped user_password_reset entry, filed against the
  // target's company so it shows in that tenant's own audit trail.
  //
  // companyId is passed explicitly because this reaches into a tenant from the
  // platform section WITHOUT entering it, so the acting company is not that
  // tenant. logEvent still marks the row as a platform operator action — it
  // marks any write a super admin makes outside their own company, switched or
  // not.
  await logEvent({
    companyId: target.company_id,
    customerId: null,
    type: 'user_password_reset',
    details:
      'Password for ' + target.email + ' (user #' + target.id + ', role ' +
      (target.role ?? 'unknown') + ') was reset by super admin ' +
      (profile.first_name ?? 'operator'),
    tag: '[platform]',
  })

  revalidatePath('/superadmin/companies/' + target.company_id)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Create company
// ---------------------------------------------------------------------------

export type CompanyResult =
  | { ok: true }
  | { ok: false; error: string; values?: Record<string, string> }

const KEEP_FIELDS = [
  'name', 'email', 'phone', 'address', 'currency', 'timezone',
  'admin_first_name', 'admin_last_name', 'admin_email',
]

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Stands up a whole tenant: company, settings, sign-in account, first admin.
 *
 * FOUR WRITES ACROSS TWO STORES, AND THEY ARE NOT TRANSACTIONAL. The auth
 * account is created before the profile row for the same reason createUser
 * does it that way (app/actions/users.ts): an auth account with no profile
 * fails closed at login with a clear message, whereas a profile with no auth
 * account is a user nobody can ever sign in as.
 *
 * There is deliberately no rollback. Deleting a half-built tenant is a
 * judgement call — the rows may already be useful — so each failure says
 * exactly what exists and what does not, and leaves the decision to the
 * operator. Every message names the company id so the leftovers can be found.
 */
export async function createCompany(
  _prev: CompanyResult | null,
  formData: FormData
): Promise<CompanyResult> {
  await authorizeSuperAdmin()

  const values: Record<string, string> = {}
  for (const k of KEEP_FIELDS) values[k] = str(formData, k)

  const fail = (error: string): CompanyResult => ({ ok: false, error, values })

  const name = str(formData, 'name')
  const email = str(formData, 'email')
  const currency = str(formData, 'currency')
  const timezone = str(formData, 'timezone')

  const adminFirst = str(formData, 'admin_first_name')
  const adminLast = str(formData, 'admin_last_name')
  const adminEmail = str(formData, 'admin_email').toLowerCase()
  const password = str(formData, 'admin_password')

  if (!name) return fail('Company name is required.')
  if (email && !EMAIL_RE.test(email)) return fail('Enter a valid company email address.')
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    return fail('Choose a currency.')
  }
  if (!TIMEZONES.some((t) => t.value === timezone)) {
    return fail('Choose a timezone.')
  }

  if (!adminFirst || !adminLast) return fail('The first admin needs a first and last name.')
  if (!EMAIL_RE.test(adminEmail)) return fail('Enter a valid email for the first admin.')
  if (password.length < 8) {
    return fail('Temporary password must be at least 8 characters.')
  }

  const db = createAdminClient()

  // Cross-tenant on purpose: the users table is joined to auth by email alone,
  // so an address already in use anywhere would collide at sign-in.
  const { data: clash } = await db
    .from('users')
    .select('id')
    .eq('email', adminEmail)
    .maybeSingle()

  if (clash) return fail('A user with the email ' + adminEmail + ' already exists.')

  // --- 1. company -----------------------------------------------------------
  // ddns_hostname and nas_secret are deliberately not written: those columns on
  // `companies` are dead. The network fields on the form are disabled and post
  // nothing; their live home is `settings`.
  const { data: created, error: companyError } = await db
    .from('companies')
    .insert({
      name,
      email: email || null,
      phone: str(formData, 'phone') || null,
      address: str(formData, 'address') || null,
      plan: 'starter',
      status: 'active',
    })
    .select('id')
    .single()

  if (companyError) return fail('Could not create the company: ' + companyError.message)

  const companyId = (created as { id: number } | null)?.id
  if (!companyId) return fail('The company was created but returned no id.')

  const leftBehind = ' Company #' + companyId + ' now exists'

  // --- 2. settings ----------------------------------------------------------
  // Same defaults the seed uses, with the operator's locale choices applied.
  // Everything not named here takes its column DEFAULT.
  const caps = await getSchemaCapabilities()

  const { error: settingsError } = await db.from('settings').insert({
    company_id: companyId,
    ...(caps.expiryMode ? { default_expiry_mode: 'from_expiry' } : {}),
    cut_off_date: 5,
    bill_date: 1,
    currency,
    timezone,
    // Off, not on: nothing in this app delivers a message yet, and a new tenant
    // should not start out queueing notifications that cannot be sent.
    sms_enabled: false,
    email_enabled: false,
  })

  if (settingsError) {
    return fail(
      'Step 2 of 4 failed — settings: ' + settingsError.message + '.' + leftBehind +
      ' with no settings row, so it will fall back to app defaults. Add a settings' +
      ' row for company #' + companyId + ', or delete the company and start again.'
    )
  }

  // --- 3. auth account ------------------------------------------------------
  const { error: authError } = await db.auth.admin.createUser({
    email: adminEmail,
    password,
    email_confirm: true,
  })

  if (authError) {
    return fail(
      'Step 3 of 4 failed — sign-in account: ' + authError.message + '.' + leftBehind +
      ' with its settings, but no one can sign in to it yet. Create the sign-in' +
      ' account and the users row by hand, or delete company #' + companyId + '.'
    )
  }

  // --- 4. first admin profile ----------------------------------------------
  const { error: userError } = await db.from('users').insert({
    company_id: companyId,
    first_name: adminFirst,
    last_name: adminLast,
    email: adminEmail,
    role: 'company_admin',
    is_super_admin: false,
  })

  if (userError) {
    return fail(
      'Step 4 of 4 failed — admin profile: ' + userError.message + '.' + leftBehind +
      ' with its settings, and a sign-in account for ' + adminEmail + ' was created,' +
      ' but it has no profile — signing in will fail with "no profile". Remove that' +
      ' auth user in Supabase and add the users row by hand, or delete company #' +
      companyId + '.'
    )
  }

  revalidatePath('/superadmin')
  redirect('/superadmin?toast=' + encodeURIComponent(name + ' created.'))
}
