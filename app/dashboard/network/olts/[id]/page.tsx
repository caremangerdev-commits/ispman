import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { OltDetail } from '@/components/network/OltDetail'
import { getOlt } from '@/lib/data/olts'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { ago } from '@/lib/tunnels/status'

export const metadata: Metadata = { title: 'OLT · ISPMan' }
export const dynamic = 'force-dynamic'

export default async function OltPage({ params }: { params: Promise<{ id: string }> }) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }

  const { id } = await params
  const olt = await getOlt(company.id, Number(id))
  if (!olt) notFound()

  const tunnels = await listRouterTunnels(company.id)
  const routerName = tunnels.find((t) => t.id === olt.tunnelId)?.name ?? 'a removed router'

  // Worded here, on the server, against one clock reading: a component that
  // reads the time while rendering gets a different answer each render.
  const checkedText = olt.checkedAt
    ? ago(new Date().getTime() - new Date(olt.checkedAt).getTime())
    : null

  return (
    <OltDetail
      olt={olt}
      routerName={routerName}
      checkedText={checkedText}
      canManage={can(profile.role, 'manage_router_tunnels')}
    />
  )
}
