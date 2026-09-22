import { NextResponse, type NextRequest } from 'next/server'

import { runBillingTick } from '@/lib/data/billing-engine'

/**
 * The billing engine's entry point. Called hourly by worker/billing-ticker.mjs.
 *
 * NOT A SESSION ROUTE. There is no signed-in user behind a background tick, so
 * this authenticates with a shared secret from the environment, exactly as
 * /api/sms/dispatch does. The ticker runs on the same box and the route is
 * bound to 127.0.0.1 in practice, but the secret is what actually guards it.
 *
 * TWO REFUSALS BEFORE ANY COMPANY IS LOOKED AT:
 *   BILLING_TICK_SECRET unset or wrong    503 / 401 — misconfigured or not you
 *   BILLING_ENGINE_ENABLED not "true"     503 — THE ENVIRONMENT KILL SWITCH
 * The second is deliberately separate from the per-company modes: an operator
 * who wants every company stopped at once flips one flag and restarts the app,
 * without visiting each company's settings. `pm2 stop ispman-billing` is the
 * other kill switch; either alone is enough.
 *
 * WHY A ROUTE AND NOT A STANDALONE WORKER. Every rule the engine applies —
 * period shapes, the verdict, the service check, add-ons, the company's date —
 * lives in this app. A separate process could not import any of it without a
 * build step, so it would have grown its own copy. The ticker is deliberately
 * dumb: it knows a URL and an hour.
 *
 * `?company=<id>` restricts a tick to one company, for a manual run from the
 * shell. The same code path, the same rows, just one company.
 */

/** Never prerendered, never cached: it has effects. */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const secret = process.env.BILLING_TICK_SECRET

  if (!secret) {
    return NextResponse.json(
      { ok: false, error: 'BILLING_TICK_SECRET is not configured.' },
      { status: 503 }
    )
  }

  const provided = req.headers.get('x-billing-tick-secret')
  if (provided !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorised.' }, { status: 401 })
  }

  // The kill switch. Checked AFTER the secret so an unauthenticated caller
  // cannot learn whether the engine is on.
  if (process.env.BILLING_ENGINE_ENABLED !== 'true') {
    return NextResponse.json(
      { ok: false, error: 'BILLING_ENGINE_ENABLED is not "true". The engine is switched off.' },
      { status: 503 }
    )
  }

  const url = new URL(req.url)
  const onlyRaw = url.searchParams.get('company')
  const only = onlyRaw && /^\d+$/.test(onlyRaw) ? Number(onlyRaw) : undefined

  try {
    const companies = await runBillingTick(only)
    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      companies,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[billing] tick failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
