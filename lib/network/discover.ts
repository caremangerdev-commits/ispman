import 'server-only'

import { customersByMac, linkDevicesByMac } from '@/lib/data/customer-devices'
import { addDevices, listDevices } from '@/lib/data/devices'
import { listOlts } from '@/lib/data/olts'
import type { PollTarget } from '@/lib/data/router-logins'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { classifyDevice, type DeviceKind } from '@/lib/network/classify'
import { makerFromMac, RADIO_MAKERS } from '@/lib/network/oui'
import { readArp, readLeases, readNeighbours, withRouter } from '@/lib/routeros/api'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Finding what is on the network, from the routers ISPMan already logs in to.
 *
 * THREE TABLES ON EACH ROUTER, because each misses what the others catch:
 *
 *   - neighbours: devices that announce themselves (MikroTik, and Ubiquiti
 *     with discovery on). Gives a name and a model, but Mimosa radios and most
 *     Ubiquiti radios never appear here.
 *   - ARP: every address the router has talked to on its links. Catches every
 *     radio and switch with an IP, named only by its MAC's maker.
 *   - DHCP leases: devices that asked the router for an address, with the name
 *     they gave. A wireless customer's radio in router mode is one of these,
 *     and usually gives the customer's name.
 *
 * WHAT EACH THING IS, IN THIS ORDER:
 *
 *   1. Its MAC is a customer's MAC (the one their login uses): it is that
 *      customer's equipment. A radio maker means a wireless customer's radio;
 *      anything else is the customer's own router and is not listed — the
 *      customer page already covers it.
 *   2. A radio, switch or router maker that is nobody's: the network's own
 *      gear. A Ubiquiti that got its address by DHCP is far more likely a
 *      customer radio not yet matched (its MAC differs from the one on the
 *      customer) than a tower radio, which has a fixed address.
 *   3. Anything else — phones, laptops, customers' routers: not listed.
 *
 * NOTHING IS LOGGED IN TO AND NOTHING IS SCANNED. These are tables the router
 * already keeps; reading them costs three short API calls per router.
 */

export type FoundGroup = 'customer' | 'network' | 'unmatched'

export type FoundDevice = {
  name: string
  kind: DeviceKind
  brand: string | null
  model: string | null
  ip: string | null
  mac: string
  version: string | null
  routerId: number
  routerName: string
  heardOn: string | null
  group: FoundGroup
  /** For group 'customer': whose it is. */
  customer: { id: number; name: string } | null
}

export type DiscoveryReport = {
  found: FoundDevice[]
  known: number
  routersAsked: number
  failed: { router: string; error: string }[]
  /** Listed devices whose address moved, or that were added by IP with no MAC yet. */
  updates: { id: number; ip?: string; mac?: string }[]
}

type Heard = {
  mac: string
  ip: string | null
  identity: string | null
  hostName: string | null
  platform: string | null
  board: string | null
  description: string | null
  version: string | null
  heardOn: string | null
  dhcp: boolean
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const ipv4 = (raw: string | null | undefined) => {
  const m = IPV4.exec(raw ?? '')
  return m && m.slice(1).every((p) => Number(p) <= 255) ? (raw as string) : null
}
/** Lowest address first, the way a network is laid out. */
const ipKey = (ip: string | null) =>
  ip ? ip.split('.').reduce((n, p) => n * 256 + Number(p), 0) : Number.MAX_SAFE_INTEGER

/** Everything one router knows about, one entry per MAC. */
async function hear(router: PollTarget): Promise<Heard[]> {
  const login = { host: router.tunnelIp, port: router.login.port, user: router.login.user, password: router.login.password }
  const [neighbours, arp, leases] = await withRouter(login, async (s) => [
    await readNeighbours(s),
    await readArp(s),
    // A router with no DHCP server answers with an empty list, not an error;
    // but an account without the right to read it errors, and that must not
    // lose the other two tables.
    await readLeases(s).catch(() => []),
  ] as const)

  const byMac = new Map<string, Heard>()
  const entry = (mac: string): Heard => {
    let h = byMac.get(mac)
    if (!h) {
      h = {
        mac, ip: null, identity: null, hostName: null, platform: null, board: null,
        description: null, version: null, heardOn: null, dhcp: false,
      }
      byMac.set(mac, h)
    }
    return h
  }
  for (const a of arp) {
    const h = entry(a.mac)
    h.ip = h.ip ?? ipv4(a.address)
    h.heardOn = h.heardOn ?? a.interface
  }
  for (const l of leases) {
    const h = entry(l.mac)
    h.ip = ipv4(l.address) ?? h.ip
    h.hostName = l.hostName
    h.dhcp = true
  }
  for (const n of neighbours) {
    if (!n.mac) continue
    const h = entry(n.mac)
    h.ip = h.ip ?? ipv4(n.address)
    h.identity = n.identity
    h.platform = n.platform
    h.board = n.board
    h.description = n.description
    h.version = n.version
    // "sfp-sfpplus2,bridge": the port, then the bridge. The port is the useful part.
    h.heardOn = n.heardOn ? n.heardOn.split(',')[0].trim() : h.heardOn
  }
  return [...byMac.values()]
}

/** What kind of network device something is, when it belongs to no customer. */
function networkKind(h: Heard, maker: string | null, announced: DeviceKind): DeviceKind {
  if (announced !== 'other' && announced !== 'cpe') return announced
  if (maker === 'Mimosa') return 'backhaul'
  if (maker === 'Cambium') return 'ap'
  if (maker === 'MikroTik') return announced === 'cpe' ? 'cpe' : 'router'
  if (maker === 'Ubiquiti') return h.dhcp ? 'cpe' : 'ap'
  return announced
}

/**
 * Ask every given router of one company what it knows, and sort it.
 * Nothing is saved here.
 */
export async function discoverForCompany(companyId: number, routers: PollTarget[]): Promise<DiscoveryReport> {
  const [tunnels, devices, olts] = await Promise.all([
    listRouterTunnels(companyId),
    listDevices(companyId),
    listOlts(companyId),
  ])
  const live = tunnels.filter((t) => !t.revokedAt)
  // A connected router is heard like anything else, but has no MAC on record.
  // It is recognised by announcing the name it has in ISPMan, or by its
  // tunnel address.
  const routerNames = new Set(live.map((t) => t.name.trim().toLowerCase()))
  const byMac = new Map((devices ?? []).filter((d) => d.mac).map((d) => [(d.mac as string).toUpperCase(), d]))
  // Also matched by IP: a device added by hand with no MAC (its MAC is then
  // filled in), and a switch or router whose other ports have their own MACs
  // — a CRS answers ARP from one port and announces itself from another.
  const byIp = new Map((devices ?? []).filter((d) => d.ip).map((d) => [d.ip as string, d]))
  const oltIps = new Set((olts ?? []).map((o) => o.mgmtIp))

  const report: DiscoveryReport = { found: [], known: 0, routersAsked: 0, failed: [], updates: [] }
  const heardBy: { h: Heard; router: PollTarget }[] = []

  // One router at a time, as the usage poller does: they share one tunnel
  // with RADIUS, which has a one-second timeout.
  for (const router of routers) {
    report.routersAsked += 1
    try {
      for (const h of await hear(router)) heardBy.push({ h, router })
    } catch (err) {
      report.failed.push({ router: router.name, error: err instanceof Error ? err.message : String(err) })
    }
  }

  let owners = new Map<string, { id: number; first_name: string | null; last_name: string | null }>()
  try {
    owners = await customersByMac(companyId, heardBy.map((x) => x.h.mac))
  } catch {
    // Without the customer list everything is still sorted, just unmatched.
  }

  const seen = new Set<string>()
  for (const { h, router } of heardBy) {
    if (seen.has(h.mac)) continue
    seen.add(h.mac)

    const listed = byMac.get(h.mac) ?? (h.ip ? byIp.get(h.ip) : undefined)
    if (listed) {
      report.known += 1
      const patch: { id: number; ip?: string; mac?: string } = { id: listed.id }
      if (h.ip && h.ip !== listed.ip && listed.mac === h.mac) patch.ip = h.ip
      if (!listed.mac) patch.mac = h.mac
      if (patch.ip || patch.mac) report.updates.push(patch)
      continue
    }
    if ((h.ip && oltIps.has(h.ip)) || (h.identity && routerNames.has(h.identity.trim().toLowerCase()))) {
      report.known += 1
      continue
    }

    const guess = classifyDevice({ platform: h.platform, board: h.board, description: h.description })
    const maker = guess.brand ?? makerFromMac(h.mac)
    const owner = owners.get(h.mac)
    const base = {
      brand: maker,
      model: guess.model,
      ip: h.ip,
      mac: h.mac,
      version: h.version,
      routerId: router.tunnelId,
      routerName: router.name,
      heardOn: h.heardOn,
    }

    if (owner) {
      // The customer's own router logs in with this MAC: that is the customer,
      // not a piece of the network.
      if (!maker || !RADIO_MAKERS.has(maker)) continue
      const name = [owner.first_name, owner.last_name].filter(Boolean).join(' ').trim() || 'Customer'
      report.found.push({
        ...base,
        name: h.identity || name + ' radio',
        kind: 'cpe',
        group: 'customer',
        customer: { id: owner.id, name },
      })
      continue
    }

    // Not a maker of network gear, and it did not announce itself: a phone, a
    // laptop, a customer's router. Not the network.
    if (!maker && guess.kind === 'other') continue

    const kind = networkKind(h, maker, guess.kind)
    const unmatched = kind === 'cpe' && h.dhcp
    report.found.push({
      ...base,
      name: h.identity || h.hostName || [maker, h.ip ?? h.mac].filter(Boolean).join(' '),
      kind,
      group: unmatched ? 'unmatched' : 'network',
      customer: null,
    })
  }

  const order: Record<FoundGroup, number> = { network: 0, customer: 1, unmatched: 2 }
  report.found.sort((a, b) => order[a.group] - order[b.group] || ipKey(a.ip) - ipKey(b.ip))
  return report
}

/** Move listed devices to their new address, and fill in MACs learned by IP. */
export async function applyDeviceUpdates(companyId: number, updates: DiscoveryReport['updates']): Promise<void> {
  const db = tenantClient()
  for (const u of updates.slice(0, 500)) {
    const patch: Record<string, string> = {}
    if (u.ip) patch.ip = u.ip
    if (u.mac) patch.mac = u.mac
    // A MAC already on another row would break the one-MAC-per-device rule;
    // the update fails on its own and the row keeps what it had.
    await db.from('network_devices').update(patch).eq('company_id', companyId).eq('id', u.id)
  }
}

/**
 * The background half: every wireless customer's radio is added and tied to
 * the customer without anyone pressing a button, the way ONUs are. The
 * network's own gear is only ever offered — what counts as a tower radio is
 * the owner's call. Addresses that moved are kept current, so the
 * up-or-down checks ping the right place.
 */
export async function autoDiscover(targets: PollTarget[]): Promise<{ added: number; linked: number; moved: number }> {
  const out = { added: 0, linked: 0, moved: 0 }
  const byCompany = new Map<number, PollTarget[]>()
  for (const t of targets) byCompany.set(t.companyId, [...(byCompany.get(t.companyId) ?? []), t])
  for (const [companyId, routers] of byCompany) {
    try {
      const report = await discoverForCompany(companyId, routers)
      await applyDeviceUpdates(companyId, report.updates)
      out.moved += report.updates.length
      const radios = report.found.filter((f) => f.group === 'customer')
      if (radios.length) {
        const res = await addDevices(
          companyId,
          null,
          radios.map((f) => ({
            kind: f.kind,
            name: f.name,
            brand: f.brand,
            model: f.model,
            ip: f.ip,
            mac: f.mac,
            version: f.version,
            foundVia: f.routerId,
            foundOn: f.heardOn,
            source: 'discovered' as const,
          }))
        )
        if (res.ok) out.added += res.added
      }
      out.linked += await linkDevicesByMac(companyId)
    } catch (err) {
      console.error('[discover] company ' + companyId + ':', err instanceof Error ? err.message : String(err))
    }
  }
  return out
}
