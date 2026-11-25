import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'

import { OltDetail } from '@/components/network/OltDetail'
import { getOnuDefaults } from '@/lib/data/olt-defaults'
import { getAutoAuthorise, getOlt, savedOnuReading } from '@/lib/data/olts'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'
import { ago } from '@/lib/tunnels/status'

export const metadata: Metadata = { title: 'OLT · ISPMan' }
export const dynamic = 'force-dynamic'

export default async function OltPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ port?: string; onu?: string }>
}) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }

  const { id } = await params
  const sp = await searchParams
  // From the ONU search: open straight on that ONU.
  const focus = sp.onu ? { port: String(sp.port ?? ''), serial: String(sp.onu).toUpperCase() } : null
  const olt = await getOlt(company.id, Number(id))
  if (!olt) notFound()

  const tunnels = await listRouterTunnels(company.id)
  const autoAuthorise = await getAutoAuthorise(company.id, olt.id)
  const onuDefaults = await getOnuDefaults(company.id, olt.id)
  const saved = await savedOnuReading(company.id, olt.id).catch(() => null)
  const routerName = tunnels.find((t) => t.id === olt.tunnelId)?.name ?? 'a removed router'

  // Worded here, on the server, against one clock reading: a component that
  // reads the time while rendering gets a different answer each render.
  const checkedText = olt.checkedAt
    ? ago(new Date().getTime() - new Date(olt.checkedAt).getTime())
    : null
  const savedText = saved?.updatedAt ? ago(new Date().getTime() - new Date(saved.updatedAt).getTime()) : null

  return (
    <OltDetail
      olt={olt}
      routerName={routerName}
      checkedText={checkedText}
      autoAuthorise={autoAuthorise}
      onuDefaults={onuDefaults}
      saved={saved ? { onus: saved.onus, customers: saved.customers, text: savedText } : null}
      focus={focus}
      canManage={can(profile.role, 'manage_router_tunnels')}
    />
  )
}
