'use server'

import { revalidatePath } from 'next/cache'

import { createAdminClient } from '@/lib/supabase/admin'
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
