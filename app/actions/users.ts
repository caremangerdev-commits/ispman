'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import { ADMIN_ROLES, ASSIGNABLE_ROLES, seesAdminRows } from '@/lib/data/users'
import { can, type Role } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { supabaseUrl } from '@/lib/supabase/env'
import { tenantClient } from '@/lib/supabase/tenant'

export type UserResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

async function authorize() {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_users')) {
    throw new Error('Forbidden: role "' + session.profile.role + '" cannot manage users.')
  }
  return session
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

const idOf = (fd: FormData) => {
  const n = Number(str(fd, 'id'))
  return Number.isInteger(n) ? n : null
}

function assignable(role: string): role is Role {
  return (ASSIGNABLE_ROLES as string[]).includes(role)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MIN_PASSWORD = 8

/**
 * The target of a write, once it is confirmed the caller may act on it.
 *
 * Every guardrail that decides WHO may be acted on lives here, so the two new
 * actions cannot drift from each other:
 *
 *   1. Never yourself. Changing your own email or password from an admin screen
 *      belongs on the self-service screen, which verifies the current password.
 *   2. Never an admin target unless the caller is admin-level. This repeats the
 *      list filter in lib/data/users.ts on the WRITE path, because hiding a row
 *      from a manager does not stop them POSTing its id.
 *
 * The target's role is re-read from the database every time — never taken from
 * the form — so a stale or forged role cannot get past it.
 */
async function loadTarget(
  companyId: number,
  callerRole: Role,
  callerId: number,
  id: number
): Promise<
  | { ok: true; row: { id: number; email: string; role: string | null; is_super_admin: boolean } }
  | { ok: false; error: string }
> {
  if (id === callerId) {
    return { ok: false, error: 'Use Change Password in your account menu for your own account.' }
  }

  const { data } = await tenantClient()
    .from('users')
    .select('id, email, role, is_super_admin')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  const row = data as unknown as {
    id: number; email: string; role: string | null; is_super_admin: boolean
  } | null

  if (!row) return { ok: false, error: 'That user no longer exists.' }

  const targetIsAdmin =
    ADMIN_ROLES.includes(row.role ?? '') || Boolean(row.is_super_admin)

  if (targetIsAdmin && !seesAdminRows(callerRole)) {
    return { ok: false, error: 'Admin accounts can only be changed by a company admin.' }
  }

  return { ok: true, row: { ...row, is_super_admin: Boolean(row.is_super_admin) } }
}

/**
 * Audit row for the two actions that could be used to take over an account.
 *
 * Goes through lib/audit.ts#logEvent, which every log write in this app uses:
 * it owns the company id, the actor and the platform-operator marker, so a
 * super admin acting inside this tenant is recorded as such. customer_id is
 * null because a staff-account change has no customer — the column is nullable.
 * A failure is logged and swallowed there: the change already landed, and
 * undoing it to keep the log tidy would take away what the operator asked for.
 */
async function logUserEvent(opts: {
  companyId: number
  actorId: number
  type: 'user_email_changed' | 'user_password_reset'
  details: string
}) {
  await logEvent({
    companyId: opts.companyId,
    userId: opts.actorId,
    customerId: null,
    type: opts.type,
    details: opts.details,
    tag: '[users]',
  })
}

/**
 * Creates a staff account: a Supabase auth user plus the matching `users` row.
 *
 * The two stores are joined by email only, so both halves must exist before
 * the person can sign in and resolve a profile (see lib/session.ts).
 */
export async function createUser(
  _prev: UserResult | null,
  formData: FormData
): Promise<UserResult> {
  const { company } = await authorize()

  const first = str(formData, 'first_name')
  const last = str(formData, 'last_name')
  const email = str(formData, 'email').toLowerCase()
  const role = str(formData, 'role')
  const password = str(formData, 'password')

  if (!first || !last) return { ok: false, error: 'First and last name are required.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Enter a valid email address.' }
  }
  if (!assignable(role)) {
    return { ok: false, error: 'Choose one of: ' + ASSIGNABLE_ROLES.join(', ') + '.' }
  }
  if (password.length < 8) {
    return { ok: false, error: 'Temporary password must be at least 8 characters.' }
  }

  const db = tenantClient()

  const { data: clash } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (clash) return { ok: false, error: 'A user with that email already exists.' }

  // Create the auth account first: if the users row failed afterwards we would
  // rather have an auth account with no profile (which redirects to login with
  // a clear error) than a profile nobody can sign in as.
  const admin = createAdminClient()
  const { error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (authError) {
    return { ok: false, error: 'Could not create the sign-in account: ' + authError.message }
  }

  const { error } = await db.from('users').insert({
    company_id: company.id,
    first_name: first,
    last_name: last,
    email,
    role,
    is_super_admin: false,
  })

  if (error) {
    return {
      ok: false,
      error:
        'Sign-in account created but the profile failed: ' + error.message +
        ' — remove the auth user in Supabase and try again.',
    }
  }

  revalidatePath('/dashboard/settings/users')
  return { ok: true }
}

export async function updateUserRole(
  _prev: UserResult | null,
  formData: FormData
): Promise<UserResult> {
  const { company, profile } = await authorize()

  const id = idOf(formData)
  if (id === null) return { ok: false, error: 'Missing user id.' }
  if (id === profile.id) return { ok: false, error: 'You cannot change your own role.' }

  const role = str(formData, 'role')
  if (!assignable(role)) {
    return { ok: false, error: 'Choose one of: ' + ASSIGNABLE_ROLES.join(', ') + '.' }
  }

  const db = tenantClient()

  // Never let an admin demote or re-role another admin from this screen.
  const { data: target } = await db
    .from('users')
    .select('role')
    .eq('company_id', company.id)
    .eq('id', id)
    .maybeSingle()

  const current = (target as { role: string | null } | null)?.role ?? ''
  if (current === 'company_admin' || current === 'super_admin') {
    return { ok: false, error: 'Admin roles can only be changed by a super admin.' }
  }

  const { error } = await db
    .from('users')
    .update({ role })
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) return { ok: false, error: 'Could not update role: ' + error.message }

  revalidatePath('/dashboard/settings/users')
  return { ok: true }
}

/**
 * Enables or disables sign-in for a staff member.
 *
 * There is no `status` column on `users`, so this works at the auth layer: a
 * banned auth user keeps their profile and history but cannot obtain a token.
 */
export async function toggleUserActive(formData: FormData) {
  const { company, profile } = await authorize()

  const id = idOf(formData)
  if (id === null) return
  if (id === profile.id) throw new Error('You cannot deactivate your own account.')

  const db = tenantClient()
  const { data: target } = await db
    .from('users')
    .select('email, role')
    .eq('company_id', company.id)
    .eq('id', id)
    .maybeSingle()

  const row = target as { email: string; role: string | null } | null
  if (!row) return
  if (row.role === 'company_admin' || row.role === 'super_admin') {
    throw new Error('Admin accounts can only be deactivated by a super admin.')
  }

  const admin = createAdminClient()
  const authUser = await findAuthUser(row.email)
  if (!authUser) throw new Error('No sign-in account exists for ' + row.email + '.')

  const deactivating = str(formData, 'active') === 'true'
  const { error } = await admin.auth.admin.updateUserById(authUser.id, {
    // 'none' lifts a ban; a long duration is how GoTrue expresses "disabled".
    ban_duration: deactivating ? '876000h' : 'none',
  })

  if (error) throw new Error('Could not update the account: ' + error.message)

  revalidatePath('/dashboard/settings/users')
}

// ---------------------------------------------------------------------------
// Edit details
// ---------------------------------------------------------------------------

/**
 * Edits a staff member's name, email and phone. Role is NOT changed here —
 * updateUserRole owns that, with its own stricter guardrail.
 *
 * THE EMAIL IS THE JOIN KEY. `users` and the Supabase auth store are separate,
 * matched on email alone (lib/session.ts), so changing one and not the other
 * locks the person out: they would sign in against the old auth address and
 * then fail to resolve a profile.
 *
 * The auth account is therefore updated FIRST and the users row only if that
 * succeeded. This is the opposite order to createUser, and deliberately so —
 * createUser is building something new, where an orphaned auth account is the
 * harmless half. Here both halves already exist and work, so the rule is not
 * "which orphan is safer" but "do not break what is currently working". A
 * failed auth update leaves both stores untouched and consistent.
 */
export async function updateUser(
  _prev: UserResult | null,
  formData: FormData
): Promise<UserResult> {
  const { company, profile } = await authorize()

  const id = idOf(formData)
  if (id === null) return { ok: false, error: 'Missing user id.' }

  const target = await loadTarget(company.id, profile.role, profile.id, id)
  if (!target.ok) return { ok: false, error: target.error }

  const first = str(formData, 'first_name')
  const last = str(formData, 'last_name')
  const email = str(formData, 'email').toLowerCase()
  const phone = str(formData, 'phone')

  const fieldErrors: Record<string, string> = {}
  if (!first) fieldErrors.first_name = 'First name is required.'
  if (!last) fieldErrors.last_name = 'Last name is required.'
  if (!EMAIL_RE.test(email)) fieldErrors.email = 'Enter a valid email address.'

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  const db = tenantClient()
  const emailChanged = email !== (target.row.email ?? '').toLowerCase()

  if (emailChanged) {
    // Same check createUser makes, minus this user's own row.
    const { data: clash } = await db
      .from('users')
      .select('id')
      .eq('email', email)
      .neq('id', id)
      .maybeSingle()

    if (clash) {
      return {
        ok: false,
        error: 'Please correct the highlighted fields.',
        fieldErrors: { email: 'Another user already uses that email address.' },
      }
    }

    const authUser = await findAuthUser(target.row.email)
    if (!authUser) {
      return {
        ok: false,
        error:
          'No sign-in account exists for ' + target.row.email + ', so the email cannot be ' +
          'changed safely. Nothing was changed.',
      }
    }

    const admin = createAdminClient()
    const { error: authError } = await admin.auth.admin.updateUserById(authUser.id, {
      email,
      email_confirm: true,
    })

    // Nothing has been written yet, so both stores are still consistent.
    if (authError) {
      return {
        ok: false,
        error:
          'Could not update the sign-in account: ' + authError.message +
          ' — nothing was changed.',
      }
    }
  }

  const { error } = await db
    .from('users')
    .update({ first_name: first, last_name: last, email, phone: phone || null })
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) {
    // The auth side may already carry the new address. Say so plainly rather
    // than let someone discover it at the login screen.
    return {
      ok: false,
      error: emailChanged
        ? 'The sign-in email was changed to ' + email + ' but the profile update failed: ' +
          error.message + ' — this user cannot sign in until the profile row matches. ' +
          'Set their email to ' + email + ' and try again.'
        : 'Could not save the user: ' + error.message,
    }
  }

  if (emailChanged) {
    await logUserEvent({
      companyId: company.id,
      actorId: profile.id,
      type: 'user_email_changed',
      details:
        'Sign-in email for user #' + id + ' changed from ' + target.row.email + ' to ' +
        email + ' by ' + (profile.first_name ?? 'an operator'),
    })
  }

  revalidatePath('/dashboard/settings/users')
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Reset another user's password
// ---------------------------------------------------------------------------

/**
 * Sets a new temporary password on someone else's account.
 *
 * Requires manage_users. A user without it cannot reach this at all and can
 * only change their OWN password, through the self-service screen in the
 * account menu — which verifies the current password first. This one does not,
 * because an admin resetting a forgotten password does not know it; that is
 * exactly why it is logged.
 */
export async function resetUserPassword(
  _prev: UserResult | null,
  formData: FormData
): Promise<UserResult> {
  const { company, profile } = await authorize()

  const id = idOf(formData)
  if (id === null) return { ok: false, error: 'Missing user id.' }

  const target = await loadTarget(company.id, profile.role, profile.id, id)
  if (!target.ok) return { ok: false, error: target.error }

  const password = str(formData, 'password')
  if (password.length < MIN_PASSWORD) {
    return {
      ok: false,
      error: 'Please correct the highlighted fields.',
      fieldErrors: {
        password: 'Temporary password must be at least ' + MIN_PASSWORD + ' characters.',
      },
    }
  }

  const authUser = await findAuthUser(target.row.email)
  if (!authUser) {
    return { ok: false, error: 'No sign-in account exists for ' + target.row.email + '.' }
  }

  const admin = createAdminClient()
  const { error } = await admin.auth.admin.updateUserById(authUser.id, { password })

  if (error) return { ok: false, error: 'Could not reset the password: ' + error.message }

  await logUserEvent({
    companyId: company.id,
    actorId: profile.id,
    type: 'user_password_reset',
    details:
      'Password for ' + target.row.email + ' (user #' + id + ') was reset by ' +
      (profile.first_name ?? 'an operator'),
  })

  revalidatePath('/dashboard/settings/users')
  return { ok: true }
}

/** Looks up an auth account by email; GoTrue has no direct get-by-email. */
async function findAuthUser(email: string): Promise<{ id: string; banned: boolean } | null> {
  const res = await fetch(supabaseUrl() + '/auth/v1/admin/users?page=1&per_page=200', {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      Authorization: 'Bearer ' + (process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''),
    },
  })
  if (!res.ok) throw new Error('Could not list auth users: ' + res.status)

  const { users = [] } = (await res.json()) as {
    users: { id: string; email: string; banned_until?: string | null }[]
  }

  const found = users.find((u) => (u.email ?? '').toLowerCase() === email.toLowerCase())
  if (!found) return null

  return {
    id: found.id,
    banned: Boolean(found.banned_until && new Date(found.banned_until) > new Date()),
  }
}
