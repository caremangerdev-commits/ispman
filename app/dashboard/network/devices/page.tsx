import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { DeviceManager, type InventoryRow } from '@/components/network/DeviceManager'
import { listDevices } from '@/lib/data/devices'
import { listOlts } from '@/lib/data/olts'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { readHandshakes } from '@/lib/tunnels/server'
import { tunnelStatus } from '@/lib/tunnels/status'

export const metadata: Metadata = { title: 'Devices · ISPMan' }
export const dynamic = 'force-dynamic'

/**
 * One list of everything on the network.
 *
 * THREE SOURCES, ONE TABLE. Routers come from the tunnel list, OLTs from the
 * OLT list, and everything else from the devices table. They are kept apart
 * underneath because ISPMan connects to the first two and each needs its own
 * settings; they are shown together because "what is on my network" is one
 * question.
 */
export default async function DevicesPage() {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }

  const now = new Date()
  const [tunnels, olts, devices, handshakes] = await Promise.all([
    listRouterTunnels(company.id),
    listOlts(company.id),
    listDevices(company.id),
    readHandshakes(now).catch(() => null),
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
    })
  }

  for (const o of olts ?? []) {
    rows.push({
      key: 'olt-' + o.id,
      kind: 'olt',
      name: o.name,
      brand: o.brand === 'zte' ? 'ZTE' : o.brand,
      model: [o.info?.model, o.info?.version].filter(Boolean).join(' ') || null,
      ip: o.mgmtIp,
      mac: null,
      where: 'behind ' + (routerName.get(o.tunnelId) ?? 'a removed router'),
      href: '/dashboard/network/olts/' + o.id,
      deviceId: null,
      status: o.ok === true ? 'up' : o.ok === false ? 'down' : null,
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
      where: via ? 'heard by ' + via + (d.foundOn ? ' on ' + d.foundOn : '') : d.notes,
      href: null,
      deviceId: d.id,
      status: null,
    })
  }

  return (
    <DeviceManager
      rows={rows}
      canManage={can(profile.role, 'manage_router_tunnels')}
      ready={devices !== null}
    />
  )
}
