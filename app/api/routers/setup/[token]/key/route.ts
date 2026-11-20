import { NextResponse, type NextRequest } from 'next/server'

import { logEvent } from '@/lib/audit'
import { findSetupToken, markKeyReported } from '@/lib/data/router-logins'
import { getRouterTunnel, tunnelHoldingKey } from '@/lib/data/tunnels'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { parseWireGuardKey } from '@/lib/tunnels/wireguard'

/**
 * The router reporting its own WireGuard public key.
 *
 * THIS IS THE STEP THAT USED TO BE A PERSON. In the four-screen flow the owner
 * reads the key off the router's terminal and pastes it into ISPMan. The setup
 * script posts it here instead, which is the only reason one pasted line can
 * finish the job.
 *
 * NOTHING SECRET TRAVELS IN THIS DIRECTION. A WireGuard public key is public
 * by construction; the private half never leaves the router and has no route
 * out of it. So the worst a forged post can do is record the wrong key against
 * a router, which stops that router's tunnel coming up and is both obvious and
 * fixable. It cannot read anything, and it cannot reach another company: the
 * token names the tunnel, the tunnel names the company.
 *
 * THE TOKEN IS ALREADY SPENT BY NOW — the GET that served the script spent it.
 * So this route wants the opposite of that one: used_at SET (the script really
 * was served) and key_at still null (it has not already reported). Expiry
 * still applies, so the window is the same 30 minutes.
 *
 * ONCE THE KEY LANDS, NOBODY DOES ANYTHING ELSE. The root job on the server
 * reads the peer list every 30 seconds and brings the tunnel up on its own.
 */

export const dynamic = 'force-dynamic'

function plain(status: number, message: string): NextResponse {
  return new NextResponse(message + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  if (!(await getSchemaCapabilities()).routerLogins) {
    return plain(503, 'Not available on this system.')
  }

  const found = await findSetupToken(token)
  // Unknown, expired, never served, or already reported: one answer for all
  // four. A caller trying tokens learns nothing from the difference.
  if (!found || !found.usedAt) return plain(404, 'Unknown setup link.')

  // --- the key --------------------------------------------------------------
  let raw = ''
  try {
    const form = await req.formData()
    const value = form.get('key')
    raw = typeof value === 'string' ? value : ''
  } catch {
    // /tool fetch sends http-data as a form body, but a hand-run curl might
    // send it as text. Accept either rather than failing on the shape.
    raw = (await req.text()).replace(/^key=/, '')
  }

  const key = parseWireGuardKey(decodeURIComponent(raw.trim()))
  if (!key) return plain(400, 'That is not a WireGuard public key.')

  const tunnel = await getRouterTunnel(found.companyId, found.tunnelId)
  if (!tunnel) return plain(404, 'That router is no longer in ISPMan.')
  if (tunnel.revokedAt) return plain(409, 'That router has been revoked.')

  // Already holds this key: the line was pasted twice. Succeed, so the script
  // prints "done" rather than scaring somebody who did nothing wrong.
  if (tunnel.publicKey === key) {
    await markKeyReported(found.id)
    return plain(200, 'Already recorded.')
  }

  const holder = await tunnelHoldingKey(key)
  if (holder && holder.id !== tunnel.id) {
    // Two routers cannot share a key: the server would flap between them.
    console.error(
      '[routers/setup] key for tunnel #' + tunnel.id + ' already belongs to #' + holder.id
    )
    return plain(409, 'That key already belongs to another router in ISPMan.')
  }

  // --- record it ------------------------------------------------------------
  // A replacement is allowed (a reset router makes a new key) but a race is
  // not: this must be the key for the tunnel as it stands now.
  const { data, error } = await tenantClient()
    .from('router_tunnels')
    .update({ public_key: key, key_set_at: new Date().toISOString() })
    .eq('id', tunnel.id)
    .eq('company_id', found.companyId)
    .is('revoked_at', null)
    .select('id')

  if (error || !data || data.length === 0) {
    console.error('[routers/setup] could not record the key:', error?.message ?? 'no row matched')
    return plain(500, 'ISPMan could not record the key.')
  }

  await markKeyReported(found.id)

  await logEvent({
    type: 'router_tunnel_key_set',
    tag: '[tunnels]',
    details:
      'Router tunnel set up from one line: ' + tunnel.name + ' at ' + tunnel.tunnelIp +
      '. Key reported by the router itself' +
      ' | public_key=' + key + ' | by=router',
  })

  return plain(200, 'Recorded.')
}
