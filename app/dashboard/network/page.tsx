import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { RouterCard } from '@/components/network/RouterCard'
import { getNetworkView } from '@/lib/data/network'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'

export const metadata: Metadata = { title: 'Network · ISPMan' }

/** Never cached: every figure on it is about this minute. */
export const dynamic = 'force-dynamic'

async function guard() {
  const session = await getSession()
  if (!can(session.profile.role, 'view_network_infrastructure')) {
    redirect('/dashboard?denied=view_network_infrastructure')
  }
  return session
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
      <p className="text-[10px] uppercase tracking-wider text-gray-500">{label}</p>
      <p className={'mt-1 text-2xl font-semibold tabular-nums ' + (tone ?? 'text-white')}>{value}</p>
    </div>
  )
}

export default async function NetworkPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()

  if (!caps.routerTunnels) {
    return (
      <div className="max-w-2xl">
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration required</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            The network view needs migration 0033, the same one router tunnels use.
          </p>
        </div>
      </div>
    )
  }

  const view = await getNetworkView(company.id)
  const live = view.routers.filter((r) => !r.revoked)

  return (
    <div className="max-w-5xl space-y-5">
      <p className="text-sm text-gray-500">
        Every router {company.name} has on the tunnel, whether it is answering, and how many
        customers have connected through it.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Routers" value={live.length} />
        <Stat label="Up now" value={view.up} tone={view.up ? 'text-green-400' : 'text-white'} />
        <Stat label="Not answering" value={view.down} tone={view.down ? 'text-red-400' : 'text-white'} />
        <Stat label="Customers, 24 h" value={view.customersDay} />
      </div>

      {/*
        A STALE REPORTING JOB IS NOT AN OUTAGE. When the file the server writes
        is missing or old, every router reads "status not available" and this
        line says why. Painting them all red instead would send someone up a
        tower that is perfectly fine.
      */}
      {view.checkedAgo ? (
        <p className="text-[11px] text-gray-600">Tunnel status as of {view.checkedAgo}.</p>
      ) : (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Tunnel status is not being reported</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            The routers below may be perfectly fine — we are not being told either way. The figures
            about customers still come from live accounting and are current.
          </p>
        </div>
      )}

      {view.pending ? (
        <p className="text-[11px] text-gray-600">
          {view.pending === 1 ? '1 router is' : view.pending + ' routers are'} still being set up.
        </p>
      ) : null}

      {live.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {live.map((r) => (
            <RouterCard key={r.id} router={r} accounting={view.accountingAvailable} />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-6 text-center">
          <p className="text-sm text-gray-400">No routers on the tunnel yet.</p>
          <p className="mt-1 text-xs text-gray-500">
            Add one under Settings &rarr; Router Tunnels and it appears here.
          </p>
        </div>
      )}
    </div>
  )
}
