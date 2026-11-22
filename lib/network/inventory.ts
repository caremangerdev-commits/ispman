import 'server-only'

import type { InventoryRow } from '@/components/network/DeviceManager'
import { deviceCustomers } from '@/lib/data/customer-devices'
import { deviceStatuses, listDevices } from '@/lib/data/devices'
import { listOlts } from '@/lib/data/olts'
import { sitePlacement } from '@/lib/data/sites'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { readHandshakes } from '@/lib/tunnels/server'
import { tunnelStatus } from '@/lib/tunnels/status'

/**
 * Everything on a company's network as one list, for the Devices and Sites
 * pages alike.
 *
 * THREE SOURCES, ONE LIST. Routers come from the tunnel list, OLTs from the
 * OLT list, and everything else from the devices table. They are kept apart
 * underneath because ISPMan connects to the first two and each needs its own
 * settings; they are shown together because "what is on my network" is one
 * question.
 */

const OLT_BRAND: Record<string, string> = { zte: 'ZTE', huawei: 'Huawei', vsol: 'V-SOL', cdata: 'C-Data', gcom: 'GCOM' }

export async function buildInventory(companyId: number): Promise<{ rows: InventoryRow[]; ready: boolean }> {
  const now = new Date()
  const [tunnels, olts, devices, handshakes, owners, statuses, placed] = await Promise.all([
    listRouterTunnels(companyId),
    listOlts(companyId),
    listDevices(companyId),
    readHandshakes(now).catch(() => null),
    deviceCustomers(companyId),
    deviceStatuses(companyId),
    sitePlacement(companyId),
  ])

  const routerName = new Map(tunnels.map((t) => [t.id, t.name]))
  const rows: InventoryRow[] = []

  for (const t of tunnels) {
    if (t.revokedAt) continue
    const { status } = tunnelStatus(t.publicKey, handshakes, now)
    rows.push({
      key: 'router-' + t.id,
      kind: 'router',
      name: t.name,
      brand: 'MikroTik',
      model: null,
      ip: t.tunnelIp,
      mac: null,
      where: null,
      href: '/dashboard/network',
      deviceId: null,
      status: status === 'up' ? 'up' : status === 'down' || status === 'never' ? 'down' : null,
      place: { table: 'router', id: t.id },
      siteId: placed.routers.get(t.id) ?? null,
      linksToSiteId: null,
    })
  }

  for (const o of olts ?? []) {
    rows.push({
      key: 'olt-' + o.id,
      kind: 'olt',
      name: o.name,
      brand: OLT_BRAND[o.brand] ?? o.brand,
      model: [o.info?.model, o.info?.version].filter(Boolean).join(' ') || null,
      ip: o.mgmtIp,
      mac: null,
      where: 'behind ' + (routerName.get(o.tunnelId) ?? 'a removed router'),
      href: '/dashboard/network/olts/' + o.id,
      deviceId: null,
      status: o.ok === true ? 'up' : o.ok === false ? 'down' : null,
      place: { table: 'olt', id: o.id },
      siteId: placed.olts.get(o.id) ?? null,
      linksToSiteId: null,
    })
  }

  for (const d of devices ?? []) {
    const via = d.foundVia ? routerName.get(d.foundVia) : null
    rows.push({
      key: 'device-' + d.id,
      kind: d.kind,
      name: d.name,
      brand: d.brand,
      model: d.model,
      ip: d.ip,
      mac: d.mac,
      where: via ? 'seen by ' + via + (d.foundOn ? ' on ' + d.foundOn : '') : d.notes,
      href: null,
      customer: owners.get(d.id) ?? null,
      deviceId: d.id,
      status: statuses.get(d.id)?.status ?? null,
      place: { table: 'device', id: d.id },
      siteId: placed.devices.get(d.id) ?? null,
      linksToSiteId: placed.linksTo.get(d.id) ?? null,
    })
  }

  return { rows, ready: devices !== null }
}
