import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import type { AdditionalService, MiscCategory, ServicePlan } from '@/lib/types'

export type WithCount<T> = T & { customerCount: number }

/**
 * Catalogue reads for the settings section and the customer forms.
 *
 * Every function returns an empty list when migration 0005 has not been
 * applied, so callers can render a "migration required" state instead of
 * failing (see lib/schema.ts).
 */

async function tallyCustomers(companyId: number, column: 'service_plan_id' | 'misc_category_id') {
  const db = tenantClient()
  const { data, error } = await db
    .from('customers')
    .select(column)
    .eq('company_id', companyId)

  if (error) throw new Error('Failed to count customers: ' + error.message)

  const counts = new Map<number, number>()
  for (const row of (data ?? []) as unknown as Record<string, number | null>[]) {
    const id = row[column]
    if (id === null || id === undefined) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

export async function listServicePlans(companyId: number): Promise<ServicePlan[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('service_plans')
    .select('id, name, speed_down_mbps, speed_up_mbps, monthly_price, description, status')
    .eq('company_id', companyId)
    .order('monthly_price', { ascending: true })

  if (error) throw new Error('Failed to load service plans: ' + error.message)
  return (data ?? []) as unknown as ServicePlan[]
}

export async function listServicePlansWithCounts(
  companyId: number
): Promise<WithCount<ServicePlan>[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) return []

  const [plans, counts] = await Promise.all([
    listServicePlans(companyId),
    tallyCustomers(companyId, 'service_plan_id'),
  ])
  return plans.map((p) => ({ ...p, customerCount: counts.get(p.id) ?? 0 }))
}

export async function listAdditionalServices(companyId: number): Promise<AdditionalService[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('additional_services')
    .select('id, name, monthly_price, description, status')
    .eq('company_id', companyId)
    .order('monthly_price', { ascending: true })

  if (error) throw new Error('Failed to load additional services: ' + error.message)
  return (data ?? []) as unknown as AdditionalService[]
}

export async function listAdditionalServicesWithCounts(
  companyId: number
): Promise<WithCount<AdditionalService>[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) return []

  const db = tenantClient()
  const [services, linkRes] = await Promise.all([
    listAdditionalServices(companyId),
    db
      .from('customer_additional_services')
      .select('additional_service_id')
      .eq('company_id', companyId),
  ])

  if (linkRes.error) {
    throw new Error('Failed to count subscribers: ' + linkRes.error.message)
  }

  const counts = new Map<number, number>()
  for (const row of (linkRes.data ?? []) as unknown as { additional_service_id: number }[]) {
    counts.set(row.additional_service_id, (counts.get(row.additional_service_id) ?? 0) + 1)
  }

  return services.map((s) => ({ ...s, customerCount: counts.get(s.id) ?? 0 }))
}

export async function listMiscCategories(companyId: number): Promise<MiscCategory[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('misc_categories')
    .select('id, name')
    .eq('company_id', companyId)
    .order('name', { ascending: true })

  if (error) throw new Error('Failed to load misc categories: ' + error.message)
  return (data ?? []) as unknown as MiscCategory[]
}

export async function listMiscCategoriesWithCounts(
  companyId: number
): Promise<WithCount<MiscCategory>[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) return []

  const [cats, counts] = await Promise.all([
    listMiscCategories(companyId),
    tallyCustomers(companyId, 'misc_category_id'),
  ])
  return cats.map((c) => ({ ...c, customerCount: counts.get(c.id) ?? 0 }))
}

/** The additional-service ids a single customer currently subscribes to. */
export async function getCustomerAddonIds(
  companyId: number,
  customerId: number
): Promise<number[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.catalog) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('customer_additional_services')
    .select('additional_service_id')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)

  if (error) throw new Error('Failed to load customer add-ons: ' + error.message)
  return ((data ?? []) as unknown as { additional_service_id: number }[]).map(
    (r) => r.additional_service_id
  )
}
