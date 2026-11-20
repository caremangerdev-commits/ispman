import { NextResponse, type NextRequest } from 'next/server'

import { routerLoginFor } from '@/lib/data/router-logins'
import { can } from '@/lib/permissions'
import { readRouterLive, safeInterfaceName, withRouter } from '@/lib/routeros/api'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'

/**
 * One live reading from one router, for the Network page to draw.
 *
 * A SESSION ROUTE. The router id from the path is only ever looked up inside
 * the session's own company, so an id from another tenant is "not found".
 *
 * NOTHING IS STORED. The page asks every few seconds while it is open and
 * draws what comes back; when nobody is looking, no router is being asked.
 * History is the usage poller's job, at five minutes — a live graph kept for
 * every router around the clock would be thousands of logins a day to draw
 * lines nobody is watching.
 */

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_network_infrastructure')) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!(await getSchemaCapabilities()).routerLogins) {
    return NextResponse.json({ ok: false, error: 'Not set up.' }, { status: 503 })
  }

  const { id } = await ctx.params
  const tunnelId = Number(id)
  if (!Number.isInteger(tunnelId) || tunnelId <= 0) {
    return NextResponse.json({ ok: false, error: 'Not found.' }, { status: 404 })
  }

  const target = await routerLoginFor(company.id, tunnelId)
  if (!target) {
    return NextResponse.json({ ok: false, error: 'This router has no ISPMan login yet.' }, { status: 404 })
  }

  const uplink = safeInterfaceName(req.nextUrl.searchParams.get('uplink'))
  try {
    const live = await withRouter(
      {
        host: target.tunnelIp,
        port: target.login.port,
        user: target.login.user,
        password: target.login.password,
        // Shorter than the page's own interval budget: a router that is down
        // should show as unreachable quickly, not hold a request open.
        timeoutMs: 6000,
      },
      (session) => readRouterLive(session, uplink)
    )
    return NextResponse.json({ ok: true, at: Date.now(), ...live })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Could not reach the router.',
    })
  }
}
