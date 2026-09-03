'use server'

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

import { ACTING_COMPANY_COOKIE } from '@/lib/acting-company'
import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase/env'
import { createClient } from '@/lib/supabase/server'

export async function signOut() {
  const supabase = await createClient()
  await supabase.auth.signOut()

  // Drop any super admin company switch on the way out. Leaving it behind is
  // not an access hole — lib/session.ts re-checks is_super_admin and the owning
  // user id on every request, so it is already inert for whoever signs in next
  // — but a cookie that outlives its session has no reason to exist.
  const store = await cookies()
  store.delete(ACTING_COMPANY_COOKIE)

  redirect('/login')
}

export type PasswordResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

const MIN_LENGTH = 8

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v : ''
}

/**
 * Changes the signed-in user's own password.
 *
 * Needs no permission check: it acts only on the caller's own account, and the
 * account it acts on comes from the session cookie rather than from the form,
 * so there is no id to tamper with.
 *
 * NOT a forgot-password flow. There is no email and no recovery link — this
 * requires an active session and the current password.
 *
 * The current password is verified against a THROWAWAY client rather than the
 * request-bound one. signInWithPassword mints a fresh session, and on the
 * cookie-bound client that would rotate the caller's own cookies as a side
 * effect of what is only meant to be a validation step. `persistSession: false`
 * keeps that verification completely isolated.
 */
export async function changePassword(
  _prev: PasswordResult | null,
  formData: FormData
): Promise<PasswordResult> {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user?.email) redirect('/login')

  const current = str(formData, 'current_password')
  const next = str(formData, 'new_password')
  const confirm = str(formData, 'confirm_password')

  const fieldErrors: Record<string, string> = {}

  if (!current) fieldErrors.current_password = 'Enter your current password.'
  if (!next) fieldErrors.new_password = 'Enter a new password.'
  else if (next.length < MIN_LENGTH) {
    fieldErrors.new_password = 'Must be at least ' + MIN_LENGTH + ' characters.'
  }
  if (!confirm) fieldErrors.confirm_password = 'Confirm the new password.'
  else if (next && next !== confirm) {
    fieldErrors.confirm_password = 'The two passwords do not match.'
  }
  if (current && next && current === next) {
    fieldErrors.new_password = 'The new password must be different from the current one.'
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  const verifier = createSupabaseClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { error: verifyError } = await verifier.auth.signInWithPassword({
    email: user.email,
    password: current,
  })

  // A successful check leaves a token in this client's memory. It is
  // function-scoped and was never bound to the request's cookies, so it cannot
  // reach the caller's session — but drop it rather than rely on that.
  // Scope 'local' clears only this throwaway client; the default global scope
  // would revoke the user's real sessions and sign them out everywhere.
  await verifier.auth.signOut({ scope: 'local' })

  if (verifyError) {
    return {
      ok: false,
      error: 'Please correct the highlighted fields.',
      fieldErrors: { current_password: 'That is not your current password.' },
    }
  }

  // Through the caller's own session — the user acting on themselves, rather
  // than the admin client reaching in and overwriting an account.
  const { error } = await supabase.auth.updateUser({ password: next })

  if (error) return { ok: false, error: 'Could not change your password: ' + error.message }

  return { ok: true }
}
