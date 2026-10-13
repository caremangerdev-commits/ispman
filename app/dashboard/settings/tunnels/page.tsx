import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import {
  RouterTunnelsManager, type TunnelStatus, type TunnelView,
} from '@/components/settings/RouterTunnelsManager'
import { listRouterTunnels, type RouterTunnel } from '@/lib/data/tunnels'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'
import {
  HANDSHAKE_FRESH_SECONDS, readHandshakes, tunnelServer, type Handshakes,
} from '@/lib/tunnels/server'
import { ROUTER_SERVICES, shortKey, TUNNEL_NETWORK, TUNNEL_SERVER_IP } from '@/lib/tunnels/wireguard'

export const metadata: Metadata = { title: 'Router Tunnels · ISPMan' }

/** Same rule as the nav, so the URL cannot be used to bypass the menu. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'tunnels')) {
    redirect('/dashboard?denied=manage_router_tunnels')
  }
  return session
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return s + 's ago'
  const m = Math.round(s / 60)
  if (m < 90) return m + ' min ago'
  const h = Math.round(m / 60)
  if (h < 36) return h + ' h ago'
  return Math.round(h / 24) + ' days ago'
}

/**
 * What the server last saw of a router's tunnel. Reported only when the root
 * cron job's file is present and recent: a missing or stale file says nothing
 * about the routers, and must not be shown as every tunnel being down.
 */
function statusOf(
  tunnel: RouterTunnel,
  handshakes: Handshakes | null,
  now: Date
): { status: TunnelStatus; text: string } {
  if (!tunnel.publicKey) return { status: 'waiting', text: "Waiting for the router's key" }
  if (!handshakes) return { status: 'unknown', text: 'Status not available' }
  if (!handshakes.fresh) {
    return {
      status: 'unknown',
      text: 'Status out of date (' + ago(now.getTime() - handshakes.writtenAt.getTime()) + ')',
    }
  }
  if (!handshakes.peers.has(tunnel.publicKey)) {
    return { status: 'not_on_server', text: 'Waiting for the server side' }
  }
  const at = handshakes.peers.get(tunnel.publicKey) ?? null
  if (!at) return { status: 'never', text: 'Never connected' }
  const age = now.getTime() - at.getTime()
  return age <= HANDSHAKE_FRESH_SECONDS * 1000
    ? { status: 'up', text: 'Up, handshake ' + ago(age) }
    : { status: 'down', text: 'Down, last handshake ' + ago(age) }
}

const dateText = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

export default async function RouterTunnelsPage() {
  const { company, profile } = await guard()
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
            nas row is written.
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
  // when someone asks to see a router's config.
  const views: TunnelView[] = tunnels.map((t) => {
    const { status, text } = statusOf(t, handshakes, now)
    return {
      id: t.id,
      name: t.name,
      tunnelIp: t.tunnelIp,
      services: t.services.map((s) => serviceLabel.get(s) ?? s),
      keyPrefix: t.publicKey ? shortKey(t.publicKey) : null,
      status,
      statusText: text,
      createdText: dateText(t.createdAt) + (t.createdByName ? ' by ' + t.createdByName : ''),
      revokedText: t.revokedAt ? dateText(t.revokedAt) : null,
    }
  })

  return (
    <div className="max-w-3xl space-y-4">
      <p className="text-sm leading-relaxed text-gray-500">
        Each of {company.name}&apos;s routers reaches the RADIUS server through its own WireGuard
        tunnel, from a fixed address in {TUNNEL_NETWORK} with its own secret, so a new public IP
        from its ISP changes nothing. RADIUS goes to {TUNNEL_SERVER_IP}. The router makes its own
        key; ISPMan only ever sees the public half. The router&apos;s current RADIUS settings stay
        in place as the fallback until the move is finished.
        {operator ? ' Server half and rollout: docs/wireguard-tunnels.md.' : ''}
      </p>

      {!server.ok ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          {operator ? (
            <>
              <p className="text-sm font-semibold text-amber-300">Server not set up in ISPMan</p>
              <p className="mt-1 text-xs leading-relaxed text-amber-300/80">
                {server.problem} Routers can be added and given step 1 meanwhile, but no router key
                can be saved until it is set.
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
        operator={operator}
        canAdd={operator || server.ok}
        statusReported={handshakes !== null}
      />
    </div>
  )
}
