import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { OltManager, type OltRouterOption } from '@/components/network/OltManager'
import { listOlts } from '@/lib/data/olts'
import { routersWithLogin } from '@/lib/data/router-usage'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { OLT_BRANDS } from '@/lib/olt'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'OLTs · ISPMan' }
export const dynamic = 'force-dynamic'

export default async function OltsPage() {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }

  const [olts, tunnels, logins] = await Promise.all([
    listOlts(company.id),
    listRouterTunnels(company.id),
    routersWithLogin(company.id),
  ])

  if (olts === null) {
    return (
      <div className="max-w-2xl rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
        <p className="text-sm font-semibold text-amber-300">Migration required</p>
        <p className="mt-1 text-xs text-amber-300/80">OLTs need migration 0054.</p>
      </div>
    )
  }

  // Every live router is listed, so the form can say which ones are not ready
  // rather than leaving the owner to wonder why a router is missing.
  const routers: OltRouterOption[] = tunnels
    .filter((t) => !t.revokedAt)
    .map((t) => ({ id: t.id, name: t.name, ready: logins.has(t.id) }))

  return (
    <OltManager
      olts={olts}
      routers={routers}
      brands={OLT_BRANDS}
      canManage={can(profile.role, 'manage_router_tunnels')}
    />
  )
}
