import 'server-only'

import type { SitePlacement } from '@/lib/data/sites'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * What is plugged into what (migration 0063). See the migration for the model.
 *
 * Every link has an upstream end (nearer the internet) and a downstream end.
 * Following links downstream from a router's port gives the chain out that
 * port: CCR sfp2 → edge switch → PowerBeam → PowerBeam → Lacovia. A device
 * with several links below it (a switch feeding four access points) branches.
 */

export type EndType = 'router' | 'olt' | 'device'
export type End = { type: EndType; id: number }

export type DeviceLink = {
  id: number
  up: End
  upPort: string | null
  down: End
  downPort: string | null
  medium: 'wired' | 'fiber' | 'wireless'
  source: 'auto' | 'manual'
}

type Row = {
  id: number
  up_type: EndType
  up_id: number
  up_port: string | null
  down_type: EndType
  down_id: number
  down_port: string | null
  medium: DeviceLink['medium']
  source: DeviceLink['source']
}

const NOT_READY = new Set(['PGRST205', 'PGRST204', '42P01', '42703'])
const TYPES = new Set<EndType>(['router', 'olt', 'device'])

export const endKey = (e: End) => e.type + '-' + e.id
export const isEnd = (e: unknown): e is End =>
  Boolean(e && typeof e === 'object' && TYPES.has((e as End).type) && Number.isInteger(Number((e as End).id)))
const same = (a: End, b: End) => a.type === b.type && a.id === b.id

const toLink = (r: Row): DeviceLink => ({
  id: r.id,
  up: { type: r.up_type, id: Number(r.up_id) },
  upPort: r.up_port,
  down: { type: r.down_type, id: Number(r.down_id) },
  downPort: r.down_port,
  medium: r.medium,
  source: r.source,
})

/** Null before migration 0063. */
export async function listLinks(companyId: number): Promise<DeviceLink[] | null> {
  const { data, error } = await tenantClient()
    .from('device_links')
    .select('id, up_type, up_id, up_port, down_type, down_id, down_port, medium, source')
    .eq('company_id', companyId)
    .limit(5000)
  if (error) {
    if (NOT_READY.has(error.code ?? '')) return null
    throw new Error('Could not load links: ' + error.message)
  }
  return ((data ?? []) as Row[]).map(toLink)
}

async function dismissed(companyId: number): Promise<Set<string>> {
  const { data } = await tenantClient()
    .from('device_link_dismissed')
    .select('up_type, up_id, down_type, down_id')
    .eq('company_id', companyId)
  return new Set(
    ((data ?? []) as { up_type: string; up_id: number; down_type: string; down_id: number }[]).map(
      (r) => r.up_type + '-' + r.up_id + '>' + r.down_type + '-' + r.down_id
    )
  )
}

async function insert(
  companyId: number,
  link: { up: End; upPort?: string | null; down: End; downPort?: string | null; medium?: DeviceLink['medium']; source: DeviceLink['source'] }
): Promise<boolean> {
  if (same(link.up, link.down)) return false
  const { error } = await tenantClient().from('device_links').upsert(
    {
      company_id: companyId,
      up_type: link.up.type,
      up_id: link.up.id,
      up_port: link.upPort ?? null,
      down_type: link.down.type,
      down_id: link.down.id,
      down_port: link.downPort ?? null,
      medium: link.medium ?? 'wired',
      source: link.source,
    },
    { onConflict: 'company_id,up_type,up_id,down_type,down_id', ignoreDuplicates: true }
  )
  return !error
}

/** Delete a link; an automatic one is remembered so discovery leaves it out. */
async function drop(companyId: number, link: DeviceLink): Promise<void> {
  const db = tenantClient()
  await db.from('device_links').delete().eq('company_id', companyId).eq('id', link.id)
  if (link.source === 'auto') {
    await db.from('device_link_dismissed').upsert(
      { company_id: companyId, up_type: link.up.type, up_id: link.up.id, down_type: link.down.type, down_id: link.down.id },
      { onConflict: 'company_id,up_type,up_id,down_type,down_id', ignoreDuplicates: true }
    )
  }
}

/**
 * Links discovery found on one router: who announced themselves on which
 * port, and which OLT sits behind which port. Added only for an end that is
 * not already somewhere in the map — once a person has drawn a chain, or
 * another router's pass has placed it, discovery does not draw a second path.
 */
export async function addDiscoveredLinks(
  companyId: number,
  found: { up: End; upPort: string; down: End; downPort: string | null }[]
): Promise<number> {
  if (found.length === 0) return 0
  const links = await listLinks(companyId)
  if (!links) return 0
  const skip = await dismissed(companyId)
  const placed = new Set(links.flatMap((l) => [endKey(l.down)]))
  let added = 0
  for (const f of found) {
    if (same(f.up, f.down) || placed.has(endKey(f.down))) continue
    // The upstream end must not itself sit below the new end: that would be
    // the other router's view of the same link, backwards.
    if (links.some((l) => same(l.up, f.down) && same(l.down, f.up))) continue
    if (skip.has(endKey(f.up) + '>' + endKey(f.down))) continue
    if (await insert(companyId, { ...f, source: 'auto' })) {
      added += 1
      placed.add(endKey(f.down))
    }
  }
  return added
}

/** Plug a device into a router port, in front of whatever was on it. */
export async function attachToPort(companyId: number, router: number, port: string, end: End): Promise<boolean> {
  const links = (await listLinks(companyId)) ?? []
  const first = links.filter((l) => l.up.type === 'router' && l.up.id === router && l.upPort === port)
  if (first.some((l) => same(l.down, end))) return true
  if (!(await insert(companyId, { up: { type: 'router', id: router }, upPort: port, down: end, source: 'manual' }))) return false
  // What was on the port now hangs off the new device.
  for (const l of first) {
    await drop(companyId, l)
    await insert(companyId, { up: end, down: l.down, downPort: l.downPort, medium: l.medium, source: 'manual' })
  }
  return true
}

/** Put a device in the middle of a link: up → new → down. */
export async function insertIntoLink(companyId: number, linkId: number, end: End): Promise<boolean> {
  const links = (await listLinks(companyId)) ?? []
  const link = links.find((l) => l.id === linkId)
  if (!link || same(link.up, end) || same(link.down, end)) return false
  await drop(companyId, link)
  const a = await insert(companyId, { up: link.up, upPort: link.upPort, down: end, source: 'manual' })
  const b = await insert(companyId, { up: end, down: link.down, downPort: link.downPort, medium: link.medium, source: 'manual' })
  return a && b
}

/** Hang a device below another, as a new branch (a switch feeding an AP). */
export async function addBelow(companyId: number, parent: End, end: End, medium: DeviceLink['medium'] = 'wired'): Promise<boolean> {
  return insert(companyId, { up: parent, down: end, medium, source: 'manual' })
}

/** Take a device out of the map; what hung below it moves up to its parent. */
export async function removeFromMap(companyId: number, end: End): Promise<boolean> {
  const links = (await listLinks(companyId)) ?? []
  const above = links.filter((l) => same(l.down, end))
  const below = links.filter((l) => same(l.up, end))
  if (above.length === 0 && below.length === 0) return false
  for (const l of [...above, ...below]) await drop(companyId, l)
  const parent = above[0]
  if (parent) {
    for (const l of below) {
      await insert(companyId, { up: parent.up, upPort: parent.upPort, down: l.down, downPort: l.downPort, medium: l.medium, source: 'manual' })
    }
  }
  return true
}

/** Mark a link as a wireless hop or a cable. */
export async function setMedium(companyId: number, linkId: number, medium: DeviceLink['medium']): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('device_links')
    .update({ medium })
    .eq('company_id', companyId)
    .eq('id', linkId)
    .select('id')
  return !error && Boolean(data && data.length)
}

/* ------------------------------ The tree ------------------------------ */

export type ChainNode = {
  end: End
  key: string
  /** The link that reaches this node from above. */
  linkId: number
  medium: DeviceLink['medium']
  source: DeviceLink['source']
  /** Port on this device facing up, when known ("13 - Uplink"). */
  port: string | null
  children: ChainNode[]
}

/** Everything downstream of one router port, as a tree. */
export function chainFrom(links: DeviceLink[], router: number, port: string): ChainNode[] {
  const below = new Map<string, DeviceLink[]>()
  for (const l of links) below.set(endKey(l.up), [...(below.get(endKey(l.up)) ?? []), l])
  const seen = new Set<string>([endKey({ type: 'router', id: router })])
  const grow = (l: DeviceLink, depth: number): ChainNode => {
    const key = endKey(l.down)
    seen.add(key)
    // A router ISPMan is connected to is the start of its own map: shown as
    // the end of this chain, not expanded again here.
    const next =
      depth > 12 || l.down.type === 'router'
        ? []
        : (below.get(key) ?? []).filter((x) => !seen.has(endKey(x.down))).map((x) => grow(x, depth + 1))
    return { end: l.down, key, linkId: l.id, medium: l.medium, source: l.source, port: l.downPort, children: next }
  }
  return (below.get(endKey({ type: 'router', id: router })) ?? [])
    .filter((l) => l.upPort === port && !seen.has(endKey(l.down)))
    .map((l) => grow(l, 0))
}

/**
 * The site a port serves: the farthest site along its chain. Customers and
 * equipment out that port that are not on the chain themselves are beyond its
 * last hop, so they are served from there.
 */
export function chainSite(nodes: ChainNode[], placed: SitePlacement): number | null {
  const siteOf = (e: End) =>
    (e.type === 'router' ? placed.routers : e.type === 'olt' ? placed.olts : placed.devices).get(e.id) ?? null
  let best: { site: number; depth: number } | null = null
  const walk = (list: ChainNode[], depth: number) => {
    for (const n of list) {
      const s = siteOf(n.end)
      if (s != null && (!best || depth > best.depth)) best = { site: s, depth }
      walk(n.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return (best as { site: number; depth: number } | null)?.site ?? null
}
