import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { RouterTunnelsManager, type TunnelView } from '@/components/settings/RouterTunnelsManager'
import { listRouterTunnels } from '@/lib/data/tunnels'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'
import { readHandshakes, tunnelServer, tunnelSyncConfigured } from '@/lib/tunnels/server'
import { tunnelStatus } from '@/lib/tunnels/status'
import { ROUTER_SERVICES, shortKey } from '@/lib/tunnels/wireguard'

export const metadata: Metadata = { title: 'Router Tunnels · ISPMan' }

/** Same rule as the nav, so the URL cannot be used to bypass the menu. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'tunnels')) {
    redirect('/dashboard?denied=manage_router_tunnels')
  }
  return session
}

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Router Tunnels: a numbered guide, not an explanation (owner, 13 Oct 2026).
 * The page says one sentence about what a tunnel is for; everything else is
 * the five steps, each shown once the one before it is done — see
 * components/settings/RouterTunnelsManager.tsx.
 */
export default async function RouterTunnelsPage() {
  const { profile, company } = await guard()
  const caps = await getSchemaCapabilities()
  // The platform operator, who runs the server half; everyone else is told
  // the operator does it, and never shown how the server is set up.
  const operator = can(profile.role, 'apply_router_tunnels_on_server')

  if (!caps.routerTunnels) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration required</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
            Router tunnels need migration 0033. Until it is applied nothing here is saved and no
            router is added to the RADIUS server.
          </p>
        </div>
      </div>
    )
  }

  const [tunnels, handshakes] = await Promise.all([listRouterTunnels(company.id), readHandshakes()])
  const server = tunnelServer()
  const now = new Date()
  const serviceLabel = new Map<string, string>(ROUTER_SERVICES.map((s) => [s.value, s.label]))

  // No secret leaves this page: the RADIUS secret is fetched by an action only
  // when step 4 asks for a router's commands.
  const views: TunnelView[] = tunnels.map((t) => {
    const { status, text } = tunnelStatus(t.publicKey, handshakes, now)
    return {
      id: t.id,
      name: t.name,
      tunnelIp: t.tunnelIp,
      services: t.services.map((s) => serviceLabel.get(s) ?? s),
      hasKey: t.publicKey !== null,
      keyPrefix: t.publicKey ? shortKey(t.publicKey) : null,
      status,
      statusText: text,
      createdText: dateText(t.createdAt) + (t.createdByName ? ' by ' + t.createdByName : ''),
      revokedText: t.revokedAt ? dateText(t.revokedAt) : null,
    }
  })

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm text-gray-500">
        Each router sends RADIUS through its own tunnel, from an address that never changes, so
        a new IP from its internet provider can&apos;t take {company.name} off the air.
        {operator ? ' Server side and rollout: docs/wireguard-tunnels.md.' : ''}
      </p>

      {!server.ok ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          {operator ? (
            <>
              <p className="text-sm font-semibold text-amber-300">Server not set up in ISPMan</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
                {server.problem} Routers can be added and taken through step 2 meanwhile, but no
                router key can be saved until it is set.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-amber-300">Not available yet</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
                Router tunnels aren&apos;t available on this server yet. Ask the platform operator
                to finish setting them up.
              </p>
            </>
          )}
        </div>
      ) : null}

      <RouterTunnelsManager
        tunnels={views}
        half={tunnelSyncConfigured() ? 'auto' : operator ? 'operator' : 'tenant'}
        operator={operator}
        canAdd={operator || server.ok}
        statusReported={handshakes !== null}
      />
    </div>
  )
}
