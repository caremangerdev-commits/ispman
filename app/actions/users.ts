'use server'

import { revalidatePath } from 'next/cache'

import { ASSIGNABLE_ROLES } from '@/lib/data/users'
import { can, type Role } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { supabaseUrl } from '@/lib/supabase/env'
import { tenantClient } from '@/lib/supabase/tenant'

export type UserResult = { ok: true } | { ok: false; error: string }

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
