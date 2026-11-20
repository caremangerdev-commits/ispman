import { NextResponse, type NextRequest } from 'next/server'

import { devicePassword } from '@/lib/crypto'
import {
  findSetupToken, spendSetupToken, storeRouterLogin,
} from '@/lib/data/router-logins'
import { getRouterTunnel } from '@/lib/data/tunnels'
import { addTunnelNas, readTunnelSecret } from '@/lib/radius/operations'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { generateRadiusSecret, tunnelServer } from '@/lib/tunnels/server'
import {
  ROUTER_API_PORT, ROUTER_API_USER, nasDescription, nasShortname, routerSetupScript,
} from '@/lib/tunnels/wireguard'

/**
 * The RouterOS script behind the single pasted line.
 *
 * NO SESSION. The caller is a router, which has no login and never will. What
 * stands in for one is the token in the path: single use, 30 minutes old at
 * most, and stored only as a hash (migration 0052). Spending it is the first
 * write this route makes, so a replay changes nothing.
 *
 * IT ALWAYS ANSWERS 200 WITH A VALID SCRIPT, even to refuse. RouterOS's
 * /tool fetch treats any other status as a transport failure and prints its own
 * message about HTTP codes, which tells a tenant standing at a router nothing.
 * A refusal is therefore a script whose only job is to print a sentence they
 * can act on. The one exception is a server-side fault, which is a 500,
 * because that is for us and not for them.
 *
 * WHY THE RADIUS ENTRY IS WRITTEN HERE, before the router has a key. The
 * script carries the secret, so the secret has to exist by the time it is
 * built. The entry is harmless early: without its WireGuard peer the router
 * cannot reach the server over the tunnel at all, so an entry nobody can use
 * sits idle until the key arrives seconds later. An abandoned setup leaves one
 * behind, which revoking the router clears.
 *
 * THE ORDER IS THE RULE FROM lib/radius/operations.ts: the RADIUS write first,
 * then ours. A failed RADIUS write must leave no password stored against a
 * router that cannot authenticate.
 */

export const dynamic = 'force-dynamic'

/** A script that only speaks. Used for every refusal. */
function says(lines: string[]): NextResponse {
  const body = [
    '# ISPMan',
    ...lines.map((l) => ':put "' + l.replace(/"/g, "'") + '"'),
  ].join('\n') + '\n'
  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

const USED_OR_UNKNOWN = [
  '',
  'This setup link has been used already, or has expired.',
  'Nothing on this router has been changed.',
  '',
  'In ISPMan, open the router and choose Get a new setup line.',
]

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params

  if (!(await getSchemaCapabilities()).routerLogins) {
    return says(['', 'This system is not set up for one-line router setup yet.'])
  }

  const found = await findSetupToken(token)
  if (!found || found.usedAt) return says(USED_OR_UNKNOWN)

  // Spend it before anything is built. Two routers on the same link: one wins.
  const from = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || null
  if (!(await spendSetupToken(found.id, from))) return says(USED_OR_UNKNOWN)

  const tunnel = await getRouterTunnel(found.companyId, found.tunnelId)
  if (!tunnel) {
    return says(['', 'That router is no longer in ISPMan. Nothing has been changed.'])
  }
  if (tunnel.revokedAt) {
    return says(['', 'That router has been revoked in ISPMan. Nothing has been changed.'])
  }

  const srv = tunnelServer()
  if (!srv.ok) {
    console.error('[routers/setup] server not configured:', srv.problem)
    return says(['', 'ISPMan is not finished setting up tunnels on its side.', 'Nothing has been changed.'])
  }

  const { data: companyRow } = await tenantClient()
    .from('companies')
    .select('name')
    .eq('id', found.companyId)
    .maybeSingle()
  const companyName = (companyRow as { name: string } | null)?.name ?? 'Company #' + found.companyId

  // --- the RADIUS secret: reuse the router's own, or write it its first ------
  let secret: string
  const existing = await readTunnelSecret(tunnel.tunnelIp)
  if (existing.ok && existing.secret) {
    secret = existing.secret
  } else {
    secret = generateRadiusSecret()
    const nas = await addTunnelNas({
      tunnelIp: tunnel.tunnelIp,
      shortname: nasShortname(tunnel.tunnelIp, companyName, tunnel.name),
      secret,
      description: nasDescription(tunnel.id, companyName, tunnel.name),
    })
    if (!nas.ok) {
      console.error('[routers/setup] RADIUS entry failed for', tunnel.tunnelIp, nas.error)
      return says([
        '',
        'ISPMan could not add this router to its RADIUS server.',
        'Nothing on this router has been changed. Try the line again shortly.',
      ])
    }
  }

  // --- the login the script is about to create ------------------------------
  const password = devicePassword()
  const stored = await storeRouterLogin(found.companyId, tunnel.id, {
    user: ROUTER_API_USER,
    password,
    kind: 'api',
    port: ROUTER_API_PORT,
  })
  if (!stored.ok) {
    // The password was never sent anywhere, so the router is untouched. Do not
    // serve a script that sets a password ISPMan failed to remember.
    console.error('[routers/setup] could not store the login:', stored.error)
    return says([
      '',
      'ISPMan could not store the login it was about to create.',
      'Nothing on this router has been changed.',
    ])
  }

  const script = routerSetupScript({
    companyName,
    routerName: tunnel.name,
    tunnelIp: tunnel.tunnelIp,
    serverPublicKey: srv.server.publicKey,
    serverEndpoint: srv.server.endpoint,
    serverPort: srv.server.port,
    secret,
    services: tunnel.services,
    baseUrl: baseUrlFrom(req),
    token,
    apiPassword: password,
  })

  return new NextResponse(script + '\n', {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      // It carries a RADIUS secret and a password. Nothing caches it, anywhere.
      'cache-control': 'no-store, no-cache, must-revalidate, private',
      pragma: 'no-cache',
    },
  })
}

/**
 * Where the router should post its key back.
 *
 * PUBLIC_APP_URL first, and the request's own host only as a fallback: Host is
 * the caller's to set, and a script that tells a router where to send its next
 * request should not take that address from the request. The fallback exists
 * because this has to work on a staging host nobody configured.
 */
function baseUrlFrom(req: NextRequest): string {
  const configured = (process.env.PUBLIC_APP_URL ?? '').trim()
  if (configured) return configured
  const host = req.headers.get('host') ?? ''
  return host ? 'https://' + host : ''
}
