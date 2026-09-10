import { NextResponse, type NextRequest } from 'next/server'

import { runDispatch } from '@/lib/sms/dispatch'

/**
 * The dispatcher's entry point. Called on a loop by worker/sms-ticker.mjs.
 *
 * NOT A SESSION ROUTE. There is no signed-in user behind a background tick, so
 * this authenticates with a shared secret from the environment instead. It is
 * bound to 127.0.0.1 in practice — the ticker runs on the same box — but the
 * secret is what actually guards it, because Apache proxies this app and a
 * misconfigured vhost is a more likely mistake than a hostile network.
 *
 * WHY A ROUTE AND NOT A STANDALONE WORKER. Every rule the dispatcher applies —
 * which customers are due, what a usable phone number is, which template a
 * company uses, whether the master switch is on — already exists in this app.
 * A separate Node process could not import any of it without a build step, so
 * it would have grown its own copy, and this codebase has already paid for that
 * mistake three times (lib/search.ts, lib/log-detail.ts, lib/email.ts). The
 * ticker is deliberately dumb: it knows a URL and a timer.
 */

/** Never prerendered, never cached: it has effects. */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const secret = process.env.SMS_DISPATCH_SECRET

  // Refuses rather than running open. An unset secret is a misconfiguration,
  // and the safe reading of it is "this endpoint is not available" — not "let
  // anyone who finds it drain the queue".
  if (!secret) {
    return NextResponse.json(
      { error: 'SMS_DISPATCH_SECRET is not configured.' },
      { status: 503 }
    )
  }

  const provided = req.headers.get('x-sms-dispatch-secret')
  if (provided !== secret) {
    return NextResponse.json({ error: 'Unauthorised.' }, { status: 401 })
  }

  const url = new URL(req.url)
  const onlyRaw = url.searchParams.get('company')
  const only = onlyRaw && /^\d+$/.test(onlyRaw) ? Number(onlyRaw) : undefined

  try {
    const summary = await runDispatch(only)
    return NextResponse.json({
      ok: true,
      at: new Date().toISOString(),
      companies: summary.filter((s) => s.skipped === null),
      idle: summary.filter((s) => s.skipped !== null).length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[sms] dispatch failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
