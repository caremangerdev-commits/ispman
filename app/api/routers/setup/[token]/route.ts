import { NextResponse, type NextRequest } from 'next/server'

import { findSetupToken, spendSetupToken } from '@/lib/data/router-logins'
import { getRouterTunnel } from '@/lib/data/tunnels'
import { getSchemaCapabilities } from '@/lib/schema'
import { buildSetupScript } from '@/lib/tunnels/setup-build'

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

  const built = await buildSetupScript({
    companyId: found.companyId,
    tunnel,
    baseUrl: baseUrlFrom(req),
    token,
  })
  if (!built.ok) return says(built.lines)
  const script = built.script

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
