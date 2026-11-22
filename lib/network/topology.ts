import 'server-only'

import type { PollTarget } from '@/lib/data/router-logins'
import { makerFromMac } from '@/lib/network/oui'
import { readBridgeHosts, readNeighbours, readPorts, withRouter } from '@/lib/routeros/api'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * How the network is wired, learned from the routers (migration 0062).
 *
 * WHAT A ROUTER KNOWS ABOUT EACH OF ITS PORTS:
 *
 *   - who is at the other end, when that is a MikroTik (or anything else that
 *     announces itself): its name, model, and the port of its own facing back.
 *     The CCR's port 6 hears "Retrive16pSwich, CRS318, port 13 - Uplink".
 *   - every MAC address behind it, from the bridge. Everyone reached through
 *     the Retrieve backhaul is listed against port 6.
 *
 * So the only thing a person tells ISPMan is which site each port leads to —
 * usually obvious from what answers at the other end — and the rest follows:
 * equipment behind that port is placed at that site, and customers behind it
 * are counted as served from it.
 *
 * A PERSON'S CHOICE IS NEVER UNDONE. A device someone put at a site by hand is
 * left there. Backhaul radios are never placed automatically: the two radios
 * of a link sit behind the same port, one at each end, and nothing in a MAC
 * table says which is which.
 */

const NOT_READY = new Set(['PGRST205', 'PGRST204', '42P01', '42703'])

/** Read one router's wiring and save it. Throws if the router cannot be read. */
export async function learnWiring(router: PollTarget): Promise<void> {
  const login = { host: router.tunnelIp, port: router.login.port, user: router.login.user, password: router.login.password }
  const [neighbours, hosts, ports] = await withRouter(login, async (s) => [
    await readNeighbours(s),
    await readBridgeHosts(s).catch(() => []),
    await readPorts(s).catch(() => [] as string[]),
  ] as const)

  const db = tenantClient()
  const now = new Date().toISOString()
  const portOf = (raw: string | null) => (raw ? raw.split(',')[0].trim() : '')

  // Who answers on each port. A MikroTik wins over anything else on the same
  // port: it is the link to the next site; a radio beside it is just a radio.
  const answer = new Map<string, (typeof neighbours)[number]>()
  for (const n of neighbours) {
    const p = portOf(n.heardOn)
    if (!p || !n.identity) continue
    const had = answer.get(p)
    const mikrotik = /mikrotik/i.test(n.platform ?? '') || makerFromMac(n.mac) === 'MikroTik'
    const hadMikrotik = had && (/mikrotik/i.test(had.platform ?? '') || makerFromMac(had.mac) === 'MikroTik')
    if (!had || (mikrotik && !hadMikrotik)) answer.set(p, n)
  }
  const behind = new Map<string, number>()
  for (const h of hosts) behind.set(h.port, (behind.get(h.port) ?? 0) + 1)

  const names = new Set([...ports, ...answer.keys(), ...behind.keys()])
  const rows = [...names].map((port) => {
    const n = answer.get(port)
    return {
      company_id: router.companyId,
      tunnel_id: router.tunnelId,
      port,
      neighbour_name: n?.identity ?? null,
      neighbour_port: n?.theirPort ?? null,
      neighbour_board: n?.board ?? n?.platform ?? null,
      neighbour_ip: n?.address ?? null,
      neighbour_mac: n?.mac ?? null,
      macs_behind: behind.get(port) ?? 0,
      seen_at: now,
    }
  })
  if (rows.length) {
    const { error } = await db.from('network_ports').upsert(rows, { onConflict: 'tunnel_id,port' })
    if (error) {
      if (NOT_READY.has(error.code ?? '')) return
      throw new Error('Could not save the ports: ' + error.message)
    }
  }

  // Where every address is now. Rows not seen for a day are dropped: the
  // device is gone or moved, and an old answer is worse than none.
  for (let i = 0; i < hosts.length; i += 500) {
    await db.from('mac_locations').upsert(
      hosts.slice(i, i + 500).map((h) => ({
        company_id: router.companyId, tunnel_id: router.tunnelId, mac: h.mac, port: h.port, seen_at: now,
      })),
      { onConflict: 'tunnel_id,mac' }
    )
  }
  await db
    .from('mac_locations')
    .delete()
    .eq('tunnel_id', router.tunnelId)
    .lt('seen_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString())
}

type PortRow = {
  id: number
  tunnel_id: number
  port: string
  leads_to_site_id: number | null
  neighbour_name: string | null
  neighbour_port: string | null
  neighbour_board: string | null
  neighbour_ip: string | null
  macs_behind: number
  seen_at: string | null
}

async function ports(companyId: number): Promise<PortRow[] | null> {
  const { data, error } = await tenantClient()
    .from('network_ports')
    .select('id, tunnel_id, port, leads_to_site_id, neighbour_name, neighbour_port, neighbour_board, neighbour_ip, macs_behind, seen_at')
    .eq('company_id', companyId)
    .order('port')
  if (error) return NOT_READY.has(error.code ?? '') ? null : []
  return (data ?? []) as PortRow[]
}

/** MAC → the site the port it sits behind leads to. */
async function macSites(companyId: number, portRows: PortRow[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const site = new Map<string, number>()
  for (const p of portRows) if (p.leads_to_site_id) site.set(p.tunnel_id + '|' + p.port, p.leads_to_site_id)
  if (site.size === 0) return out
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tenantClient()
      .from('mac_locations')
      .select('tunnel_id, mac, port')
      .eq('company_id', companyId)
      .range(from, from + 999)
    if (error) break
    const rows = (data ?? []) as { tunnel_id: number; mac: string; port: string }[]
    for (const r of rows) {
      const s = site.get(r.tunnel_id + '|' + r.port)
      if (s) out.set(r.mac.toUpperCase(), s)
    }
    if (rows.length < 1000) break
  }
  return out
}

/**
 * Put equipment at the site its port leads to: anything not placed by a
 * person, and never a backhaul or customer equipment. Returns how many moved.
 */
export async function autoPlace(companyId: number): Promise<number> {
  const portRows = await ports(companyId)
  if (!portRows) return 0
  const sites = await macSites(companyId, portRows)
  if (sites.size === 0) return 0
  const db = tenantClient()
  const { data, error } = await db
    .from('network_devices')
    .select('id, kind, mac, site_id, site_source')
    .eq('company_id', companyId)
    .not('mac', 'is', null)
    .not('kind', 'in', '(onu,cpe,backhaul)')
    .limit(5000)
  if (error) return 0
  let moved = 0
  for (const d of (data ?? []) as { id: number; kind: string; mac: string; site_id: number | null; site_source: string | null }[]) {
    if (d.site_source === 'manual') continue
    const target = sites.get(d.mac.toUpperCase())
    if (!target || target === d.site_id) continue
    const res = await db.from('network_devices').update({ site_id: target, site_source: 'auto' }).eq('id', d.id)
    if (!res.error) moved += 1
  }
  return moved
}

export type MapPort = {
  id: number
  port: string
  leadsToSiteId: number | null
  neighbour: { name: string; port: string | null; board: string | null; ip: string | null } | null
  macsBehind: number
  customers: number
}

export type MapRouter = { tunnelId: number; ports: MapPort[] }

export type NetworkMap = {
  ready: boolean
  routers: MapRouter[]
  /** Site id → customers served from it. */
  customersBySite: Record<number, number>
}

/**
 * The wiring as the Sites page shows it, and how many customers each site and
 * each port serves.
 *
 * A customer is placed by any MAC of theirs ISPMan can find behind a port:
 * the one their login uses, or a radio linked to them. A fiber customer is
 * served from the site of the OLT their ONU is on.
 */
export async function networkMap(companyId: number): Promise<NetworkMap> {
  const portRows = await ports(companyId)
  if (!portRows) return { ready: false, routers: [], customersBySite: {} }
  const db = tenantClient()

  // Every MAC that belongs to a customer.
  const macOwner = new Map<string, number>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('customers')
      .select('id, mac_address')
      .eq('company_id', companyId)
      .not('mac_address', 'is', null)
      .range(from, from + 999)
    if (error) break
    const rows = (data ?? []) as { id: number; mac_address: string }[]
    for (const r of rows) if (r.mac_address) macOwner.set(r.mac_address.toUpperCase(), r.id)
    if (rows.length < 1000) break
  }
  const { data: linked } = await db
    .from('network_devices')
    .select('customer_id, mac, kind, olt_id')
    .eq('company_id', companyId)
    .not('customer_id', 'is', null)
    .limit(10000)
  const onuOlt = new Map<number, number>()
  for (const d of (linked ?? []) as { customer_id: number; mac: string | null; kind: string; olt_id: number | null }[]) {
    if (d.mac) macOwner.set(d.mac.toUpperCase(), d.customer_id)
    if (d.kind === 'onu' && d.olt_id) onuOlt.set(d.customer_id, d.olt_id)
  }

  // Customers behind each port, and the site each customer is served from.
  const perPort = new Map<string, Set<number>>()
  const siteOf = new Map<number, number>()
  const portSite = new Map(portRows.filter((p) => p.leads_to_site_id).map((p) => [p.tunnel_id + '|' + p.port, p.leads_to_site_id as number]))
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('mac_locations')
      .select('tunnel_id, mac, port')
      .eq('company_id', companyId)
      .range(from, from + 999)
    if (error) break
    const rows = (data ?? []) as { tunnel_id: number; mac: string; port: string }[]
    for (const r of rows) {
      const owner = macOwner.get(r.mac.toUpperCase())
      if (!owner) continue
      const key = r.tunnel_id + '|' + r.port
      perPort.set(key, (perPort.get(key) ?? new Set()).add(owner))
      const s = portSite.get(key)
      if (s) siteOf.set(owner, s)
    }
    if (rows.length < 1000) break
  }
  // Fiber customers: the OLT's site, which is where their service comes from.
  if (onuOlt.size) {
    const { data: olts } = await db.from('olts').select('id, site_id').eq('company_id', companyId).not('site_id', 'is', null)
    const oltSite = new Map(((olts ?? []) as { id: number; site_id: number }[]).map((o) => [o.id, o.site_id]))
    for (const [customer, olt] of onuOlt) {
      const s = oltSite.get(olt)
      if (s) siteOf.set(customer, s)
    }
  }
  const customersBySite: Record<number, number> = {}
  for (const s of siteOf.values()) customersBySite[s] = (customersBySite[s] ?? 0) + 1

  const byRouter = new Map<number, MapPort[]>()
  for (const p of portRows) {
    // A port with nothing behind it and nobody answering is an empty socket.
    if (!p.macs_behind && !p.neighbour_name && !p.leads_to_site_id) continue
    const list = byRouter.get(p.tunnel_id) ?? []
    list.push({
      id: p.id,
      port: p.port,
      leadsToSiteId: p.leads_to_site_id,
      neighbour: p.neighbour_name
        ? { name: p.neighbour_name, port: p.neighbour_port, board: p.neighbour_board, ip: p.neighbour_ip }
        : null,
      macsBehind: p.macs_behind,
      customers: perPort.get(p.tunnel_id + '|' + p.port)?.size ?? 0,
    })
    byRouter.set(p.tunnel_id, list)
  }
  const routers = [...byRouter].map(([tunnelId, list]) => ({
    tunnelId,
    ports: list.sort((a, b) => b.macsBehind - a.macsBehind || a.port.localeCompare(b.port, undefined, { numeric: true })),
  }))
  return { ready: true, routers, customersBySite }
}

/** Which site a port leads to. */
export async function setPortSite(companyId: number, portId: number, siteId: number | null): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('network_ports')
    .update({ leads_to_site_id: siteId })
    .eq('company_id', companyId)
    .eq('id', portId)
    .select('id')
  return !error && Boolean(data && data.length)
}
