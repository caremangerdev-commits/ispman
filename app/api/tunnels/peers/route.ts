import { timingSafeEqual } from 'node:crypto'

import { NextResponse, type NextRequest } from 'next/server'

import { livePeersAllCompanies } from '@/lib/data/tunnels'
import { getSchemaCapabilities } from '@/lib/schema'
import { TUNNEL_NETWORK, TUNNEL_SERVER_IP } from '@/lib/tunnels/wireguard'

/**
 * The peer list for the server's WireGuard interface, for the root job
 * (deploy/wireguard/ispman-wg-sync) and nobody else.
 *
 * NOT A SESSION ROUTE, like /api/billing/tick: a shared secret from the
 * environment, sent as x-tunnel-sync-secret. Two more guards:
 *
 *   LOOPBACK ONLY. The job calls 127.0.0.1:3000 directly. Next.js stamps
 *   x-forwarded-for with the socket's address when no proxy set it, so a
 *   direct local call reads 127.0.0.1; a request that came in through Apache
 *   carries the outside address Apache put there (with anything the caller
 *   forged ahead of it). Anything but a single loopback address is refused
 *   before the secret is even compared.
 *
 *   READ ONLY, AND NOTHING SECRET. It returns public keys and tunnel
 *   addresses — what `wg show` on the server already holds. No RADIUS secret,
 *   no company names. Changes happen in the job, which validates every entry
 *   against its own copy of the range and refuses mass removals.
 */

export const dynamic = 'force-dynamic'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(req: NextRequest) {
  const forwardedFor = (req.headers.get('x-forwarded-for') ?? '').trim()
  if (forwardedFor && !LOOPBACK.has(forwardedFor)) {
    return NextResponse.json({ ok: false, error: 'Not available here.' }, { status: 403 })
  }

  const secret = process.env.TUNNEL_SYNC_SECRET
  if (!secret) {
    return NextResponse.json({ ok: false, error: 'TUNNEL_SYNC_SECRET is not configured.' }, { status: 503 })
  }
  if (!sameSecret(req.headers.get('x-tunnel-sync-secret') ?? '', secret)) {
    return NextResponse.json({ ok: false, error: 'Unauthorised.' }, { status: 401 })
  }

  // Checked after the secret so an unauthenticated caller learns nothing.
  if (!(await getSchemaCapabilities()).routerTunnels) {
    return NextResponse.json({ ok: false, error: 'Migration 0033 is not applied.' }, { status: 503 })
  }

  try {
    const peers = await livePeersAllCompanies()
    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      network: TUNNEL_NETWORK,
      serverIp: TUNNEL_SERVER_IP,
      peers: peers.map((p) => ({ id: p.id, publicKey: p.publicKey, tunnelIp: p.tunnelIp })),
    })
  } catch (err) {
    // An error must never read as an empty list: the job would take that as
    // "remove every peer". It gets a 500 and changes nothing.
    const message = err instanceof Error ? err.message : String(err)
    console.error('[tunnels] peer list failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
