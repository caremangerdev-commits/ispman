#!/usr/bin/env node
/**
 * The SMS ticker.
 *
 * DELIBERATELY DUMB. It knows a URL and a timer. Every decision — who is due,
 * what a usable phone number is, which template applies, whether the tenant's
 * master switch is on — lives in the app behind /api/sms/dispatch, so this
 * process cannot drift away from what the pages show. See the note in
 * app/api/sms/dispatch/route.ts.
 *
 *   pm2 start worker/sms-ticker.mjs --name ispman-sms -i 1
 *
 * ONE INSTANCE. `-i 1`, fork mode, never cluster. A second ticker would not
 * corrupt anything — the outbox claim is a compare-and-swap and the dedupe key
 * is a unique index — but it would double the rate at which each SIM sends,
 * which is the one thing the throttle exists to prevent.
 *
 * Environment (same .env.local the app reads):
 *   SMS_DISPATCH_URL     default http://127.0.0.1:3000/api/sms/dispatch
 *   SMS_DISPATCH_SECRET  must match the app's
 *   SMS_TICK_SECONDS     default 60
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

function loadEnv(file = '.env.local') {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
}
loadEnv()

const URL_ = process.env.SMS_DISPATCH_URL || 'http://127.0.0.1:3000/api/sms/dispatch'
const SECRET = process.env.SMS_DISPATCH_SECRET
const TICK_MS = Math.max(15, Number(process.env.SMS_TICK_SECONDS || 60)) * 1000

if (!SECRET) {
  console.error('SMS_DISPATCH_SECRET is not set. Refusing to start.')
  process.exit(1)
}

/**
 * A tick may take most of a minute — the dispatcher paces sends at the tenant's
 * throttle and holds the request open while it does. So this waits for the
 * response before scheduling the next one rather than firing on a fixed
 * interval, which would stack overlapping requests the moment one ran long.
 */
let stopping = false

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tick() {
  const started = Date.now()
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'x-sms-dispatch-secret': SECRET },
      // NEVER FOLLOW A REDIRECT. The app's proxy sends anything without a
      // session to /login, and a followed redirect returns that page as a 200
      // with no JSON in it — which this loop would have read as "a tick that
      // did nothing" and printed no warning about, every minute, forever.
      // Failing loudly here is the whole point.
      redirect: 'manual',
      // Generous: the app's own budget cuts a tick off at 50s, and this only
      // has to outlast that plus the round trip.
      signal: AbortSignal.timeout(90_000),
    })

    if (res.status >= 300 && res.status < 400) {
      console.error(
        '[sms-ticker] ' + res.status + ' redirect to ' +
        (res.headers.get('location') ?? '?') +
        ' — /api/sms/dispatch is being intercepted before it runs. ' +
        'Check PUBLIC_PATHS in proxy.ts.'
      )
      return
    }

    const body = await res.json().catch(() => null)

    if (!res.ok) {
      console.error('[sms-ticker] ' + res.status + ' ' + (body?.error ?? ''))
      return
    }

    // A 200 that is not the JSON this endpoint returns means something answered
    // in its place. Treated as a failure rather than an empty tick.
    if (!body || body.ok !== true) {
      console.error(
        '[sms-ticker] 200 but not a dispatch response — something else served ' +
        'this URL. Nothing was dispatched.'
      )
      return
    }

    // Quiet when there is nothing to say. This runs every minute forever, and a
    // line per tick would bury the one that matters in a week of "0 sent".
    const active = (body?.companies ?? []).filter(
      (c) => c.sent || c.failed || c.enqueued || c.recovered
    )
    for (const c of active) {
      console.log(
        '[sms-ticker] ' + c.companyName +
        ': queued ' + c.enqueued + ', sent ' + c.sent + ', failed ' + c.failed +
        (c.recovered ? ', recovered ' + c.recovered : '')
      )
    }
  } catch (err) {
    // A restart of the app during a deploy lands here. Logged and retried on the
    // next tick rather than exiting, so pm2 does not have to restart this too.
    console.error('[sms-ticker] ' + (err?.message ?? String(err)))
  } finally {
    const took = Date.now() - started
    if (took > TICK_MS) console.warn('[sms-ticker] tick took ' + Math.round(took / 1000) + 's')
  }
}

async function main() {
  console.log('[sms-ticker] started; ' + URL_ + ' every ' + TICK_MS / 1000 + 's')

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log('[sms-ticker] stopping')
      stopping = true
    })
  }

  while (!stopping) {
    await tick()
    // Checked again after the tick so a stop during a long request is not
    // followed by a full sleep before the process exits.
    if (stopping) break
    await sleep(TICK_MS)
  }

  process.exit(0)
}

main()
