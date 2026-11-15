import 'server-only'

import { listRouterTunnels } from '@/lib/data/tunnels'
import { EMPTY_ACTIVITY, radiusConfigured, routerActivity, type RouterActivity } from '@/lib/radius-db'
import { readHandshakes } from '@/lib/tunnels/server'
import { ago, tunnelStatus, type TunnelStatus } from '@/lib/tunnels/status'

/**
 * A company's routers as the Network page shows them.
 *
 * TWO SOURCES, DELIBERATELY NOT MERGED INTO ONE VERDICT. The tunnel handshake
 * says whether the router is reachable right now; the accounting says what it
 * has been doing for customers. They answer different questions and they can
 * disagree — a router can hold its tunnel while its radios are down, and a
 * router on the old public path can be serving customers with no tunnel at
 * all. A single green dot derived from both would hide exactly the cases worth
 * looking at, so each is reported on its own.
 *
 * NOTHING HERE IS A LIVE COUNT OF WHO IS ONLINE. radacct cannot answer that on
 * this platform: interim accounting is off on every router, so an open session
 * stays open for ever (lib/radius-db.ts#RouterActivity). Everything below is
 * counted from session STARTS inside a 24-hour window, which is a fact about
 * the last day rather than a guess about this second.
 */

export type NetworkRouter = {
  id: number
  name: string
  tunnelIp: string
  /** Null until the owner pastes the key the router generated. */
  publicKey: string | null
  revoked: boolean
  status: TunnelStatus
  /** The status in the operator's words, e.g. "Up, handshake 12s ago". */
  statusText: string
  activity: RouterActivity
  /**
   * How long ago a customer last connected, already in words.
   *
   * FORMATTED HERE, NOT IN THE CARD, so every row on the page is measured from
   * the same instant. A component that reads the clock itself gets a slightly
   * different one each time it renders, which is both a lie and what the
   * purity rule forbids.
   */
  lastConnectionAgo: string | null
  /** True when radacct holds nothing at all for this address in 24 hours. */
  silent: boolean
}

export type NetworkView = {
  routers: NetworkRouter[]
  /** Routers whose tunnel is up right now. */
  up: number
  /** Routers that have a key and are not revoked, but are not answering. */
  down: number
  /** Routers still waiting for their key, or for the server side. */
  pending: number
  /** Customers seen across every router in the last 24 hours. */
  customersDay: number
  /**
   * Null when the handshake file is missing or stale. The page then says the
   * status is unavailable rather than painting every router red: a broken
   * reporting job is not an outage, and treating it as one would have an
   * operator driving to a tower that is fine.
   */
  checkedAt: Date | null
  /** checkedAt in words, measured from the same instant as the rows. */
  checkedAgo: string | null
  /** False when the RADIUS env vars are absent — the activity columns go away. */
  accountingAvailable: boolean
}

export async function getNetworkView(companyId: number): Promise<NetworkView> {
  const now = new Date()

  const [tunnels, handshakes] = await Promise.all([
    listRouterTunnels(companyId),
    readHandshakes(now).catch(() => null),
  ])

  const live = tunnels.filter((t) => !t.revokedAt)
  const accountingAvailable = radiusConfigured()

  const activity = accountingAvailable
    ? await routerActivity(live.map((t) => t.tunnelIp)).catch(() => new Map<string, RouterActivity>())
    : new Map<string, RouterActivity>()

  const routers: NetworkRouter[] = tunnels.map((t) => {
    const { status, text } = tunnelStatus(t.publicKey, handshakes, now)
    const seen = activity.get(t.tunnelIp)
    return {
      id: t.id,
      name: t.name,
      tunnelIp: t.tunnelIp,
      publicKey: t.publicKey,
      revoked: Boolean(t.revokedAt),
      status,
      statusText: text,
      activity: seen ?? EMPTY_ACTIVITY,
      lastConnectionAgo: seen?.lastSessionAt
        ? ago(now.getTime() - seen.lastSessionAt.getTime())
        : null,
      silent: accountingAvailable && !seen,
    }
  })

  const counted = routers.filter((r) => !r.revoked)
  return {
    routers,
    up: counted.filter((r) => r.status === 'up').length,
    down: counted.filter((r) => r.status === 'down' || r.status === 'never').length,
    pending: counted.filter((r) => r.status === 'waiting' || r.status === 'not_on_server').length,
    customersDay: counted.reduce((n, r) => n + r.activity.customersDay, 0),
    checkedAt: handshakes && handshakes.fresh ? handshakes.writtenAt : null,
    checkedAgo: handshakes && handshakes.fresh
      ? ago(now.getTime() - handshakes.writtenAt.getTime())
      : null,
    accountingAvailable,
  }
}
