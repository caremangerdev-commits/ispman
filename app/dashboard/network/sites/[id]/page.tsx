import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { SiteDetail } from '@/components/network/SiteDetail'
import { listSites } from '@/lib/data/sites'
import { buildInventory } from '@/lib/network/inventory'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Site · ISPMan' }
export const dynamic = 'force-dynamic'

export default async function SitePage({ params }: { params: Promise<{ id: string }> }) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }
  const { id } = await params
  const [sites, { rows }] = await Promise.all([listSites(company.id), buildInventory(company.id)])
  const site = (sites ?? []).find((s) => s.id === Number(id))
  if (!site) notFound()
  return <SiteDetail site={site} sites={sites ?? []} rows={rows} canManage={can(profile.role, 'manage_router_tunnels')} />
}
