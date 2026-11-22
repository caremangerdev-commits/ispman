import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { SiteManager } from '@/components/network/SiteManager'
import { listSites } from '@/lib/data/sites'
import { buildInventory } from '@/lib/network/inventory'
import { networkMap } from '@/lib/network/topology'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Sites · ISPMan' }
export const dynamic = 'force-dynamic'

export default async function SitesPage() {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }
  const [sites, { rows }, map] = await Promise.all([
    listSites(company.id),
    buildInventory(company.id),
    networkMap(company.id),
  ])
  return (
    <SiteManager
      sites={sites ?? []}
      rows={rows}
      map={map}
      canManage={can(profile.role, 'manage_router_tunnels')}
      ready={sites !== null}
    />
  )
}
