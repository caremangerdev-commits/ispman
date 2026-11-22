import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { DeviceManager } from '@/components/network/DeviceManager'
import { listSites } from '@/lib/data/sites'
import { buildInventory } from '@/lib/network/inventory'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Devices · ISPMan' }
export const dynamic = 'force-dynamic'

/** One list of everything on the network. See lib/network/inventory.ts. */
export default async function DevicesPage() {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }

  const [{ rows, ready }, sites] = await Promise.all([buildInventory(company.id), listSites(company.id)])

  return (
    <DeviceManager
      rows={rows}
      sites={(sites ?? []).map((s) => ({ id: s.id, name: s.name }))}
      canManage={can(profile.role, 'manage_router_tunnels')}
      ready={ready}
    />
  )
}
