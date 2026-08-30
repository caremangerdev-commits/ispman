'use server'

import { revalidatePath } from 'next/cache'

import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

export type CatalogResult = { ok: true } | { ok: false; error: string }

async function authorize() {
  const session = await getSession()
  if (!can(session.profile.role, 'manage_company_settings')) {
    throw new Error('Forbidden: role "' + session.profile.role + '" cannot manage the catalogue.')
  }
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) {
    throw new Error('Catalogue tables are missing. Run supabase/migrations/0005_customer_fields.sql.')
  }
  return session
}

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

const numOf = (fd: FormData, k: string) => {
  const v = str(fd, k)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const idOf = (fd: FormData) => {
  const n = Number(str(fd, 'id'))
  return Number.isInteger(n) ? n : null
}

function friendly(error: { code?: string; message: string }, what: string) {
  if (error.code === '23505') return 'A ' + what + ' with that name already exists.'
  return 'Could not save ' + what + ': ' + error.message
}

// ---------------------------------------------------------------------------
// Service plans
// ---------------------------------------------------------------------------

export async function saveServicePlan(
  _prev: CatalogResult | null,
  formData: FormData
): Promise<CatalogResult> {
  const { company } = await authorize()

  const name = str(formData, 'name')
  const down = numOf(formData, 'speed_down_mbps')
  const up = numOf(formData, 'speed_up_mbps')
  const price = numOf(formData, 'monthly_price')

  if (!name) return { ok: false, error: 'Plan name is required.' }
  if (down === null || down <= 0) return { ok: false, error: 'Download speed must be greater than zero.' }
  if (up === null || up <= 0) return { ok: false, error: 'Upload speed must be greater than zero.' }
  if (price === null || price < 0) return { ok: false, error: 'Monthly price must be zero or more.' }

  const db = tenantClient()
  const row = {
    name,
    speed_down_mbps: down,
    speed_up_mbps: up,
    monthly_price: price,
    description: str(formData, 'description') || null,
  }

  const id = idOf(formData)
  const { error } = id
    ? await db.from('service_plans').update(row).eq('company_id', company.id).eq('id', id)
    : await db.from('service_plans').insert({ ...row, company_id: company.id, status: 'active' })

  if (error) return { ok: false, error: friendly(error, 'plan') }

  revalidatePath('/dashboard/settings/service-plans')
  return { ok: true }
}

export async function toggleServicePlan(formData: FormData) {
  const { company } = await authorize()
  const id = idOf(formData)
  if (id === null) return

  const next = str(formData, 'status') === 'active' ? 'inactive' : 'active'
  const db = tenantClient()
  await db.from('service_plans').update({ status: next }).eq('company_id', company.id).eq('id', id)

  revalidatePath('/dashboard/settings/service-plans')
}

export async function deleteServicePlan(formData: FormData) {
  const { company } = await authorize()
  const id = idOf(formData)
  if (id === null) return

  const db = tenantClient()
  // 0006 sets this FK to ON DELETE SET NULL, but clear it explicitly so the
  // delete also works on a database where 0006 has not been applied.
  await db
    .from('customers')
    .update({ service_plan_id: null })
    .eq('company_id', company.id)
    .eq('service_plan_id', id)

  const { error } = await db
    .from('service_plans')
    .delete()
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) throw new Error('Could not delete plan: ' + error.message)

  revalidatePath('/dashboard/settings/service-plans')
  revalidatePath('/dashboard/customers')
}

// ---------------------------------------------------------------------------
// Additional services
// ---------------------------------------------------------------------------

export async function saveAdditionalService(
  _prev: CatalogResult | null,
  formData: FormData
): Promise<CatalogResult> {
  const { company } = await authorize()

  const name = str(formData, 'name')
  const price = numOf(formData, 'monthly_price')

  if (!name) return { ok: false, error: 'Service name is required.' }
  if (price === null || price < 0) return { ok: false, error: 'Monthly price must be zero or more.' }

  const db = tenantClient()
  const row = {
    name,
    monthly_price: price,
    description: str(formData, 'description') || null,
  }

  const id = idOf(formData)
  const { error } = id
    ? await db.from('additional_services').update(row).eq('company_id', company.id).eq('id', id)
    : await db
        .from('additional_services')
        .insert({ ...row, company_id: company.id, status: 'active' })

  if (error) return { ok: false, error: friendly(error, 'service') }

  revalidatePath('/dashboard/settings/additional-services')
  return { ok: true }
}

export async function toggleAdditionalService(formData: FormData) {
  const { company } = await authorize()
  const id = idOf(formData)
  if (id === null) return

  const next = str(formData, 'status') === 'active' ? 'inactive' : 'active'
  const db = tenantClient()
  await db
    .from('additional_services')
    .update({ status: next })
    .eq('company_id', company.id)
    .eq('id', id)

  revalidatePath('/dashboard/settings/additional-services')
}

export async function deleteAdditionalService(formData: FormData) {
  const { company } = await authorize()
  const id = idOf(formData)
  if (id === null) return

  const db = tenantClient()
  // Drop subscriptions first; without 0006 this FK has no cascade.
  await db
    .from('customer_additional_services')
    .delete()
    .eq('company_id', company.id)
    .eq('additional_service_id', id)

  const { error } = await db
    .from('additional_services')
    .delete()
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) throw new Error('Could not delete service: ' + error.message)

  revalidatePath('/dashboard/settings/additional-services')
}

// ---------------------------------------------------------------------------
// Misc categories
// ---------------------------------------------------------------------------

export async function saveMiscCategory(
  _prev: CatalogResult | null,
  formData: FormData
): Promise<CatalogResult> {
  const { company } = await authorize()

  const name = str(formData, 'name')
  if (!name) return { ok: false, error: 'Category name is required.' }

  const db = tenantClient()
  const id = idOf(formData)
  const { error } = id
    ? await db.from('misc_categories').update({ name }).eq('company_id', company.id).eq('id', id)
    : await db.from('misc_categories').insert({ name, company_id: company.id })

  if (error) return { ok: false, error: friendly(error, 'category') }

  revalidatePath('/dashboard/settings/misc-categories')
  return { ok: true }
}

export async function deleteMiscCategory(formData: FormData) {
  const { company } = await authorize()
  const id = idOf(formData)
  if (id === null) return

  const db = tenantClient()
  // Unassign before deleting so customers survive the removal.
  await db
    .from('customers')
    .update({ misc_category_id: null })
    .eq('company_id', company.id)
    .eq('misc_category_id', id)

  const { error } = await db
    .from('misc_categories')
    .delete()
    .eq('company_id', company.id)
    .eq('id', id)

  if (error) throw new Error('Could not delete category: ' + error.message)

  revalidatePath('/dashboard/settings/misc-categories')
  revalidatePath('/dashboard/customers')
}
