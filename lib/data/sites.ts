import 'server-only'

import { tenantClient } from '@/lib/supabase/tenant'

/** Places the network is built at (migration 0061). */

import { isSiteKind, type SiteKind } from '@/lib/network/site-kinds'

export { isSiteKind, type SiteKind }

export type Site = { id: number; name: string; kind: SiteKind; notes: string | null }

/** Which table a piece of equipment lives in: routers and OLTs have their own. */
export type SiteTable = 'device' | 'olt' | 'router'

const TABLE: Record<SiteTable, string> = { device: 'network_devices', olt: 'olts', router: 'router_tunnels' }

const NOT_READY = new Set(['PGRST205', 'PGRST204', '42P01', '42703'])

/** Null before migration 0061. */
export async function listSites(companyId: number): Promise<Site[] | null> {
  const { data, error } = await tenantClient()
    .from('network_sites')
    .select('id, name, kind, notes')
    .eq('company_id', companyId)
    .order('name')
  if (error) {
    if (NOT_READY.has(error.code ?? '')) return null
    throw new Error('Could not load sites: ' + error.message)
  }
  return ((data ?? []) as { id: number; name: string; kind: string; notes: string | null }[]).map((r) => ({
    id: r.id,
    name: r.name,
    kind: isSiteKind(r.kind) ? r.kind : 'other',
    notes: r.notes,
  }))
}

export type SitePlacement = {
  routers: Map<number, number>
  olts: Map<number, number>
  devices: Map<number, number>
  /** Backhaul device id → the site at its far end. */
  linksTo: Map<number, number>
}

/** Where everything is. Empty maps before migration 0061. */
export async function sitePlacement(companyId: number): Promise<SitePlacement> {
  const out: SitePlacement = { routers: new Map(), olts: new Map(), devices: new Map(), linksTo: new Map() }
  const db = tenantClient()
  const [r, o, d] = await Promise.all([
    db.from('router_tunnels').select('id, site_id').eq('company_id', companyId).not('site_id', 'is', null),
    db.from('olts').select('id, site_id').eq('company_id', companyId).not('site_id', 'is', null),
    db
      .from('network_devices')
      .select('id, site_id, links_to_site_id')
      .eq('company_id', companyId)
      .or('site_id.not.is.null,links_to_site_id.not.is.null')
      .limit(5000),
  ])
  for (const x of (r.data ?? []) as { id: number; site_id: number }[]) out.routers.set(x.id, x.site_id)
  for (const x of (o.data ?? []) as { id: number; site_id: number }[]) out.olts.set(x.id, x.site_id)
  for (const x of (d.data ?? []) as { id: number; site_id: number | null; links_to_site_id: number | null }[]) {
    if (x.site_id) out.devices.set(x.id, x.site_id)
    if (x.links_to_site_id) out.linksTo.set(x.id, x.links_to_site_id)
  }
  return out
}

export async function createSite(
  companyId: number,
  createdBy: number | null,
  site: { name: string; kind: SiteKind; notes: string | null }
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const { data, error } = await tenantClient()
    .from('network_sites')
    .insert({ company_id: companyId, name: site.name, kind: site.kind, notes: site.notes, created_by: createdBy })
    .select('id')
    .single()
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'There is already a site with that name.' }
    return { ok: false, error: 'Could not save: ' + error.message }
  }
  return { ok: true, id: (data as { id: number }).id }
}

export async function updateSite(
  companyId: number,
  id: number,
  site: { name: string; kind: SiteKind; notes: string | null }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await tenantClient()
    .from('network_sites')
    .update({ name: site.name, kind: site.kind, notes: site.notes })
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id')
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'There is already a site with that name.' }
    return { ok: false, error: 'Could not save: ' + error.message }
  }
  return data && data.length ? { ok: true } : { ok: false, error: 'That site was not found.' }
}

/** Everything at the site stays listed, just no longer at a site. */
export async function deleteSite(companyId: number, id: number): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('network_sites')
    .delete()
    .eq('company_id', companyId)
    .eq('id', id)
    .select('id')
  return !error && Boolean(data && data.length)
}

/** Put equipment at a site, or take it off any site with null. */
export async function placeAtSite(
  companyId: number,
  items: { table: SiteTable; id: number }[],
  siteId: number | null
): Promise<number> {
  const db = tenantClient()
  let moved = 0
  for (const table of Object.keys(TABLE) as SiteTable[]) {
    const ids = items.filter((i) => i.table === table).map((i) => i.id)
    if (ids.length === 0) continue
    const { data, error } = await db
      .from(TABLE[table])
      .update({ site_id: siteId })
      .eq('company_id', companyId)
      .in('id', ids)
      .select('id')
    if (!error) moved += (data ?? []).length
  }
  return moved
}

/** The far end of a backhaul radio. */
export async function setLinkTarget(companyId: number, deviceId: number, siteId: number | null): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('network_devices')
    .update({ links_to_site_id: siteId })
    .eq('company_id', companyId)
    .eq('id', deviceId)
    .select('id')
  return !error && Boolean(data && data.length)
}

export async function siteExists(companyId: number, id: number): Promise<boolean> {
  const { data } = await tenantClient()
    .from('network_sites')
    .select('id')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  return Boolean(data)
}
