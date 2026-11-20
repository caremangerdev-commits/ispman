import { timingSafeEqual } from 'node:crypto'

import { NextResponse, type NextRequest } from 'next/server'

import { getSchemaCapabilities } from '@/lib/schema'
import { pollUsage } from '@/lib/usage/poll'

/**
 * One pass of the usage poller, for the ticker beside it and nobody else.
 *
 * NOT A SESSION ROUTE, like /api/billing/tick: the caller is a worker with no
 * user and therefore no cookie, and it authenticates with a shared secret.
 * Same two extra guards as /api/tunnels/peers — loopback only, and the schema
 * checked after the secret so an unauthenticated caller learns nothing.
 *
 * A KILL SWITCH THAT DOES NOT NEED pm2. USAGE_POLL_ENABLED=false in
 * .env.local refuses every tick with a 503 while the ticker keeps running, so
 * polling can be stopped from the same place everything else is configured.
 * Checked on every tick, not at startup.
 *
 * ALWAYS 200 WITH A SUMMARY WHEN THE PASS RAN, even if every router failed.
 * A router being off is not an error in this route — it is a fact about that
 * router, reported per router, and the ticker logs the counts. A non-200 is
 * reserved for the pass not happening at all.
 */

export const dynamic = 'force-dynamic'

/** A pass visits ten routers in turn; the default 15s would cut it short. */
export const maxDuration = 300

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function sameSecret(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  const forwardedFor = (req.headers.get('x-forwarded-for') ?? '').trim()
  if (forwardedFor && !LOOPBACK.has(forwardedFor)) {
    return NextResponse.json({ ok: false, error: 'Not available here.' }, { status: 403 })
  }

  const secret = process.env.USAGE_POLL_SECRET
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'USAGE_POLL_SECRET is not configured.' },
      { status: 503 }
    )
  }
  if (!sameSecret(req.headers.get('x-usage-poll-secret') ?? '', secret)) {
    return NextResponse.json({ ok: false, error: 'Unauthorised.' }, { status: 401 })
  }

  if ((process.env.USAGE_POLL_ENABLED ?? 'true').toLowerCase() === 'false') {
    return NextResponse.json(
      { ok: false, error: 'Usage polling is switched off (USAGE_POLL_ENABLED=false).' },
      { status: 503 }
    )
  }

  const caps = await getSchemaCapabilities()
  if (!caps.routerLogins) {
    return NextResponse.json({ ok: false, error: 'Migration 0052 is not applied.' }, { status: 503 })
  }
  if (!caps.usage) {
    return NextResponse.json({ ok: false, error: 'Migration 0053 is not applied.' }, { status: 503 })
  }

  try {
    const summary = await pollUsage()
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[usage] pass failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
