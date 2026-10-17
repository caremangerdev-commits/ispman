import 'server-only'

import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Outage / maintenance incidents (migration 0037). Staff open and close them;
 * the portal shows a banner to customers inside the scope; SMS goes out on open
 * and restore. Scope is company-wide or one access point (customers.access_point),
 * the only location the schema stores — scoping is the whole point of the feature.
 */

const MISSING = new Set(['PGRST205', '42P01', '42703'])
const COLS =
  'id, title, message, scope, scope_value, status, opened_at, restored_at, next_update_at, updated_at'

export type IncidentScope = 'company' | 'access_point'

export type Incident = {
  id: number
  title: string
  message: string | null
  scope: IncidentScope
  scopeValue: string | null
  status: 'open' | 'restored'
  openedAt: string
  restoredAt: string | null
  nextUpdateAt: string | null
  updatedAt: string
}

type Row = {
  id: number
  title: string
  message: string | null
  scope: string
  scope_value: string | null
  status: string
  opened_at: string
  restored_at: string | null
  next_update_at: string | null
  updated_at: string
}

function toIncident(r: Row): Incident {
  return {
    id: r.id,
    title: r.title,
    message: r.message,
    scope: r.scope === 'access_point' ? 'access_point' : 'company',
    scopeValue: r.scope_value,
    status: r.status === 'restored' ? 'restored' : 'open',
    openedAt: r.opened_at,
    restoredAt: r.restored_at,
    nextUpdateAt: r.next_update_at,
    updatedAt: r.updated_at,
  }
}

export async function listIncidents(companyId: number): Promise<Incident[]> {
  const { data, error } = await tenantClient()
    .from('incidents')
    .select(COLS)
    .eq('company_id', companyId)
    .order('opened_at', { ascending: false })
    .limit(100)
  if (error) {
    if (MISSING.has(error.code ?? '')) return []
    throw new Error('Failed to load incidents: ' + error.message)
  }
  return ((data ?? []) as unknown as Row[]).map(toIncident)
}

export async function getIncident(companyId: number, id: number): Promise<Incident | null> {
  const { data, error } = await tenantClient()
    .from('incidents').select(COLS).eq('company_id', companyId).eq('id', id).maybeSingle()
  if (error) {
    if (MISSING.has(error.code ?? '')) return null
    throw new Error('Failed to load incident: ' + error.message)
  }
  return data ? toIncident(data as unknown as Row) : null
}

export async function createIncident(
  companyId: number,
  input: {
    title: string
    message: string | null
    scope: IncidentScope
    scopeValue: string | null
    nextUpdateAt: string | null
  },
  by: { id: number; name: string }
): Promise<number> {
  const { data, error } = await tenantClient()
    .from('incidents')
    .insert({
      company_id: companyId,
      title: input.title,
      message: input.message,
      scope: input.scope,
      scope_value: input.scope === 'access_point' ? input.scopeValue : null,
      next_update_at: input.nextUpdateAt,
      created_by: by.id,
      created_by_name: by.name,
    })
    .select('id')
    .single()
  if (error) throw new Error('Could not open incident: ' + error.message)
  return (data as { id: number }).id
}

/** Posts an update: a new next-update-by time and/or message, touching updated_at. */
export async function updateIncident(
  companyId: number,
  id: number,
  patch: { message?: string | null; nextUpdateAt?: string | null }
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (patch.message !== undefined) row.message = patch.message
  if (patch.nextUpdateAt !== undefined) row.next_update_at = patch.nextUpdateAt
  const { error } = await tenantClient()
    .from('incidents').update(row).eq('company_id', companyId).eq('id', id)
  if (error) throw new Error('Could not update incident: ' + error.message)
}

export async function closeIncident(companyId: number, id: number): Promise<void> {
  const { error } = await tenantClient()
    .from('incidents')
    .update({ status: 'restored', restored_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('id', id)
  if (error) throw new Error('Could not close incident: ' + error.message)
}

/**
 * The open incident a customer at `accessPoint` should see, or null. A
 * company-wide incident covers everyone; an access-point one covers only its
 * own. Newest wins if somehow two apply.
 */
export async function activeIncidentForCustomer(
  companyId: number,
  accessPoint: string | null
): Promise<Incident | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('incidents')
    .select(COLS)
    .eq('company_id', companyId)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(20)
  if (error) {
    if (MISSING.has(error.code ?? '')) return null
    throw new Error('Failed to check incidents: ' + error.message)
  }
  const rows = ((data ?? []) as unknown as Row[]).map(toIncident)
  return (
    rows.find(
      (i) => i.scope === 'company' || (i.scope === 'access_point' && i.scopeValue === accessPoint)
    ) ?? null
  )
}

export type AffectedCustomer = {
  id: number
  phone: string | null
  email: string | null
  sms_opted_out: boolean | null
  email_opted_out: boolean | null
}

/** The customers an incident affects, for the open/restore SMS. */
export async function affectedCustomers(companyId: number, incident: Incident): Promise<AffectedCustomer[]> {
  const db = tenantClient()
  let q = db
    .from('customers')
    .select('id, phone, email, sms_opted_out, email_opted_out')
    .eq('company_id', companyId)
  if (incident.scope === 'access_point') {
    if (!incident.scopeValue) return []
    q = q.eq('access_point', incident.scopeValue)
  }
  const { data, error } = await q
  if (error) {
    if (MISSING.has(error.code ?? '')) return []
    throw new Error('Failed to load affected customers: ' + error.message)
  }
  return (data ?? []) as unknown as AffectedCustomer[]
}

/** Distinct access_point values on a company's customers, for the open form's picker. */
export async function listAccessPoints(companyId: number): Promise<string[]> {
  const { data, error } = await tenantClient()
    .from('customers')
    .select('access_point')
    .eq('company_id', companyId)
    .not('access_point', 'is', null)
    .limit(2000)
  if (error) {
    if (MISSING.has(error.code ?? '')) return []
    throw new Error('Failed to load access points: ' + error.message)
  }
  const set = new Set(
    ((data ?? []) as { access_point: string | null }[])
      .map((r) => (r.access_point ?? '').trim())
      .filter(Boolean)
  )
  return [...set].sort()
}
