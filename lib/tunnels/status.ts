import { HANDSHAKE_FRESH_SECONDS, type Handshakes } from '@/lib/tunnels/server'

/**
 * A router tunnel's state as the cards show it. One definition for the
 * company's Router Tunnels page and the platform overview, so the two can
 * never call the same router by different names.
 *
 * Every label here can be read by a company admin: none names the RADIUS
 * server's software or how the server is set up.
 */
export type TunnelStatus = 'waiting' | 'up' | 'down' | 'never' | 'not_on_server' | 'unknown'

export function ago(ms: number): string {
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
 * job's file is present and recent: a missing or stale file says nothing about
 * the routers, and must not be shown as every tunnel being down.
 */
export function tunnelStatus(
  publicKey: string | null,
  handshakes: Handshakes | null,
  now: Date
): { status: TunnelStatus; text: string } {
  if (!publicKey) return { status: 'waiting', text: "Waiting for the router's key" }
  if (!handshakes) return { status: 'unknown', text: 'Status not available' }
  if (!handshakes.fresh) {
    return {
      status: 'unknown',
      text: 'Status out of date (' + ago(now.getTime() - handshakes.writtenAt.getTime()) + ')',
    }
  }
  if (!handshakes.peers.has(publicKey)) {
    return { status: 'not_on_server', text: 'Waiting for the server side' }
  }
  const at = handshakes.peers.get(publicKey) ?? null
  if (!at) return { status: 'never', text: 'Never connected' }
  const age = now.getTime() - at.getTime()
  return age <= HANDSHAKE_FRESH_SECONDS * 1000
    ? { status: 'up', text: 'Up, handshake ' + ago(age) }
    : { status: 'down', text: 'Down, last handshake ' + ago(age) }
}
