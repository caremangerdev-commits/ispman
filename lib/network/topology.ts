import 'server-only'

import type { PollTarget } from '@/lib/data/router-logins'
import { sitePlacement, type SitePlacement } from '@/lib/data/sites'
import {
  addDiscoveredLinks, chainFrom, chainSite, endKey, listLinks, type ChainNode, type DeviceLink, type End,
} from '@/lib/network/links'
import { makerFromMac } from '@/lib/network/oui'
import { readArp, readBridgeHosts, readNeighbours, readPorts, withRouter } from '@/lib/routeros/api'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * How the network is wired, learned from the routers (migrations 0062, 0063).
 *
 * WHAT A ROUTER KNOWS ABOUT EACH OF ITS PORTS:
 *
 *   - who is at the other end, when that is a MikroTik (or anything else that
 *     announces itself): its name, model, and the port of its own facing back.
 *     The CCR's port 6 hears "Retrive16pSwich, CRS318, port 13 - Uplink".
 *   - every MAC address behind it, from the bridge. Everyone reached through
 *     the Retrieve backhaul is listed against port 6.
 *
 * FROM THAT, A CHAIN PER PORT. A MikroTik or OLT that is already in ISPMan and
 * answers on a port is linked to that port by itself. What sits silently in
 * between — an unmanaged switch, two bridge radios — cannot be heard, because
 * it passes the announcement straight through; a person slots it into the
 * chain, choosing from the devices the router sees out that port.
 *
 * SITES FOLLOW THE CHAIN. Each device on a chain is put at its site by a
 * person. Equipment out that port that is not on the chain is beyond its last
 * hop, so it is placed at the farthest site on the chain — automatically, and
 * never over a site someone chose by hand. Customers out that port are counted
 * as served from that site. Backhaul radios are never placed automatically:
 * the two ends of a link sit behind the same port.
 */

const NOT_READY = new Set(['PGRST205', 'PGRST204', '42P01', '42703'])

/** Read one router's wiring and save it. Throws if the router cannot be read. */
export async function learnWiring(router: PollTarget): Promise<void> {
  const login = { host: router.tunnelIp, port: router.login.port, user: router.login.user, password: router.login.password }
  const [neighbours, hosts, ports, arp] = await withRouter(login, async (s) => [
    await readNeighbours(s),
    await readBridgeHosts(s).catch(() => []),
    await readPorts(s).catch(() => [] as string[]),
    await readArp(s).catch(() => []),
  ] as const)

  const db = tenantClient()
  const now = new Date().toISOString()
  const portOf = (raw: string | null) => (raw ? raw.split(',')[0].trim() : '')

  // Who answers on each port. A MikroTik wins over anything else on the same
  // port: it is the link onward; a radio beside it is just a radio.
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

  // Links: what answered on each port, and which OLT is behind which port.
  const [{ data: tunnels }, { data: devices }, { data: olts }] = await Promise.all([
    db.from('router_tunnels').select('id, name').eq('company_id', router.companyId).is('revoked_at', null),
    db.from('network_devices').select('id, mac, ip').eq('company_id', router.companyId).limit(5000),
    db.from('olts').select('id, mgmt_ip').eq('company_id', router.companyId),
  ])
  const routerByName = new Map(((tunnels ?? []) as { id: number; name: string }[]).map((t) => [t.name.trim().toLowerCase(), t.id]))
  const deviceByMac = new Map<string, number>()
  const deviceByIp = new Map<string, number>()
  for (const d of (devices ?? []) as { id: number; mac: string | null; ip: string | null }[]) {
    if (d.mac) deviceByMac.set(d.mac.toUpperCase(), d.id)
    if (d.ip) deviceByIp.set(d.ip, d.id)
  }
  const hostPort = new Map(hosts.map((h) => [h.mac, h.port]))
  const found: { up: End; upPort: string; down: End; downPort: string | null }[] = []
  const up: End = { type: 'router', id: router.tunnelId }
  for (const [port, n] of answer) {
    const asRouter = n.identity ? routerByName.get(n.identity.trim().toLowerCase()) : undefined
    const asDevice = (n.mac && deviceByMac.get(n.mac)) || (n.address && deviceByIp.get(n.address)) || undefined
    const down: End | null =
      asRouter != null ? { type: 'router', id: asRouter } : asDevice != null ? { type: 'device', id: asDevice } : null
    if (down) found.push({ up, upPort: port, down, downPort: n.theirPort })
  }
  for (const o of (olts ?? []) as { id: number; mgmt_ip: string }[]) {
    const mac = arp.find((a) => a.address === o.mgmt_ip)?.mac
    const port = mac ? hostPort.get(mac) : undefined
    if (port) found.push({ up, upPort: port, down: { type: 'olt', id: o.id }, downPort: null })
  }
  try {
    await addDiscoveredLinks(router.companyId, found)
  } catch {
    // Links are an extra; the ports and addresses are saved either way.
  }
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
}

async function ports(companyId: number): Promise<PortRow[] | null> {
  const { data, error } = await tenantClient()
    .from('network_ports')
    .select('id, tunnel_id, port, leads_to_site_id, neighbour_name, neighbour_port, neighbour_board, neighbour_ip, macs_behind')
    .eq('company_id', companyId)
    .order('port')
  if (error) return NOT_READY.has(error.code ?? '') ? null : []
  return (data ?? []) as PortRow[]
}

async function locations(companyId: number): Promise<{ tunnel_id: number; mac: string; port: string }[]> {
  const out: { tunnel_id: number; mac: string; port: string }[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await tenantClient()
      .from('mac_locations')
      .select('tunnel_id, mac, port')
      .eq('company_id', companyId)
      .range(from, from + 999)
    if (error) break
    const rows = (data ?? []) as { tunnel_id: number; mac: string; port: string }[]
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

/** "tunnel|port" → the site that port serves, from its chain. */
function portSites(portRows: PortRow[], links: DeviceLink[], placed: SitePlacement): Map<string, number> {
  const out = new Map<string, number>()
  for (const p of portRows) {
    const s = chainSite(chainFrom(links, p.tunnel_id, p.port), placed) ?? p.leads_to_site_id
    if (s) out.set(p.tunnel_id + '|' + p.port, s)
  }
  return out
}

/** Every device that sits on some chain. */
function onChains(links: DeviceLink[]): Set<string> {
  return new Set(links.flatMap((l) => [endKey(l.up), endKey(l.down)]))
}

/**
 * Put equipment beyond each chain at the chain's farthest site: anything not
 * placed by a person, not on a chain itself, and never a backhaul or customer
 * equipment. Returns how many moved.
 */
export async function autoPlace(companyId: number): Promise<number> {
  const portRows = await ports(companyId)
  if (!portRows) return 0
  const [links, placed, locs] = await Promise.all([listLinks(companyId), sitePlacement(companyId), locations(companyId)])
  const sites = portSites(portRows, links ?? [], placed)
  if (sites.size === 0) return 0
  const macSite = new Map<string, number>()
  for (const r of locs) {
    const s = sites.get(r.tunnel_id + '|' + r.port)
    if (s) macSite.set(r.mac.toUpperCase(), s)
  }
  const chained = onChains(links ?? [])
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
    if (d.site_source === 'manual' || chained.has('device-' + d.id)) continue
    const target = macSite.get(d.mac.toUpperCase())
    if (!target || target === d.site_id) continue
    const res = await db.from('network_devices').update({ site_id: target, site_source: 'auto' }).eq('id', d.id)
    if (!res.error) moved += 1
  }
  return moved
}

export type MapPort = {
  id: number
  tunnelId: number
  port: string
  neighbour: { name: string; port: string | null; board: string | null; ip: string | null } | null
  macsBehind: number
  customers: number
  /** What is plugged in, as a tree. Empty until linked. */
  chain: ChainNode[]
  /** Network devices the router sees out this port that are not on the chain. */
  candidates: End[]
  /** The site this port serves, from its chain. */
  siteId: number | null
}

export type MapRouter = { tunnelId: number; ports: MapPort[] }

export type NetworkMap = {
  ready: boolean
  linksReady: boolean
  routers: MapRouter[]
  /** Site id → customers served from it. */
  customersBySite: Record<number, number>
}

/**
 * The wiring as the Sites page shows it.
 *
 * A customer is placed by any MAC of theirs ISPMan can find behind a port:
 * the one their login uses, or a radio linked to them. A fiber customer is
 * served from the site of the OLT their ONU is on.
 */
export async function networkMap(companyId: number): Promise<NetworkMap> {
  const portRows = await ports(companyId)
  if (!portRows) return { ready: false, linksReady: false, routers: [], customersBySite: {} }
  const db = tenantClient()
  const [links, placed, locs] = await Promise.all([listLinks(companyId), sitePlacement(companyId), locations(companyId)])
  const sites = portSites(portRows, links ?? [], placed)
  const chained = onChains(links ?? [])

  // Every MAC that belongs to a customer, and every MAC of the network's gear.
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
  const { data: deviceRows } = await db
    .from('network_devices')
    .select('id, customer_id, mac, kind, olt_id')
    .eq('company_id', companyId)
    .limit(10000)
  const onuOlt = new Map<number, number>()
  const gearByMac = new Map<string, number>()
  for (const d of (deviceRows ?? []) as { id: number; customer_id: number | null; mac: string | null; kind: string; olt_id: number | null }[]) {
    if (d.customer_id && d.mac) macOwner.set(d.mac.toUpperCase(), d.customer_id)
    if (d.customer_id && d.kind === 'onu' && d.olt_id) onuOlt.set(d.customer_id, d.olt_id)
    if (!d.customer_id && d.mac && d.kind !== 'onu' && d.kind !== 'cpe') gearByMac.set(d.mac.toUpperCase(), d.id)
  }

  const perPort = new Map<string, Set<number>>()
  const candidates = new Map<string, End[]>()
  const siteOf = new Map<number, number>()
  for (const r of locs) {
    const key = r.tunnel_id + '|' + r.port
    const mac = r.mac.toUpperCase()
    const owner = macOwner.get(mac)
    if (owner) {
      perPort.set(key, (perPort.get(key) ?? new Set()).add(owner))
      const s = sites.get(key)
      if (s) siteOf.set(owner, s)
    }
    const gear = gearByMac.get(mac)
    if (gear != null && !chained.has('device-' + gear)) {
      candidates.set(key, [...(candidates.get(key) ?? []), { type: 'device', id: gear }])
    }
  }
  if (onuOlt.size) {
    for (const [customer, olt] of onuOlt) {
      const s = placed.olts.get(olt)
      if (s) siteOf.set(customer, s)
    }
  }
  const customersBySite: Record<number, number> = {}
  for (const s of siteOf.values()) customersBySite[s] = (customersBySite[s] ?? 0) + 1

  const byRouter = new Map<number, MapPort[]>()
  for (const p of portRows) {
    const key = p.tunnel_id + '|' + p.port
    const chain = chainFrom(links ?? [], p.tunnel_id, p.port)
    // A port with nothing behind it, nobody answering and nothing plugged in
    // is an empty socket.
    if (!p.macs_behind && !p.neighbour_name && chain.length === 0) continue
    const list = byRouter.get(p.tunnel_id) ?? []
    list.push({
      id: p.id,
      tunnelId: p.tunnel_id,
      port: p.port,
      neighbour: p.neighbour_name
        ? { name: p.neighbour_name, port: p.neighbour_port, board: p.neighbour_board, ip: p.neighbour_ip }
        : null,
      macsBehind: p.macs_behind,
      customers: perPort.get(key)?.size ?? 0,
      chain,
      candidates: candidates.get(key) ?? [],
      siteId: sites.get(key) ?? null,
    })
    byRouter.set(p.tunnel_id, list)
  }
  const routers = [...byRouter].map(([tunnelId, list]) => ({
    tunnelId,
    ports: list.sort((a, b) => b.macsBehind - a.macsBehind || a.port.localeCompare(b.port, undefined, { numeric: true })),
  }))
  return { ready: true, linksReady: links !== null, routers, customersBySite }
}
