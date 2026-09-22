#!/usr/bin/env node
/**
 * The billing ticker.
 *
 * DELIBERATELY DUMB, like the SMS ticker beside it. It knows a URL and a
 * timer. Every decision — which companies are on the engine, what today is in
 * their zone, who is due, what the period is, who had service — lives in the
 * app behind /api/billing/tick, so this process cannot drift away from what
 * the Billing Runs page shows.
 *
 *   pm2 start worker/billing-ticker.mjs --name ispman-billing --cwd /PATH/TO/ispman
 *
 * ONE INSTANCE, fork mode, never cluster. A second ticker would not double a
 * charge — the unique index on bill_charges is the guard — but it would race
 * the day's bill_runs row for no benefit.
 *
 * HOURLY, not daily. A day's run is retried by every following tick until it
 * is done, so one failed hour (radcheck unreachable, the app mid-deploy) is
 * caught by the next, and a tick that lands just after a company's midnight
 * still charges that date. The app makes each hour after the first a no-op.
 *
 * KILL SWITCHES, either of:
 *   pm2 stop ispman-billing
 *   BILLING_ENGINE_ENABLED=false in .env.local, then pm2 restart ispman --update-env
 * The second is checked by the app on every tick, so the ticker can keep
 * running and every tick is refused with 503 until the flag is set back.
 *
 * Environment (same .env.local the app reads):
 *   BILLING_TICK_URL       default http://127.0.0.1:3000/api/billing/tick
 *   BILLING_TICK_SECRET    must match the app's
 *   BILLING_TICK_SECONDS   default 3600
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

const URL_ = process.env.BILLING_TICK_URL || 'http://127.0.0.1:3000/api/billing/tick'
const SECRET = process.env.BILLING_TICK_SECRET
const TICK_MS = Math.max(60, Number(process.env.BILLING_TICK_SECONDS || 3600)) * 1000

if (!SECRET) {
  console.error('BILLING_TICK_SECRET is not set. Refusing to start.')
  process.exit(1)
}

let stopping = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tick() {
  const started = Date.now()
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'x-billing-tick-secret': SECRET },
      // NEVER FOLLOW A REDIRECT. The app's proxy sends anything without a
      // session to /login, and a followed redirect returns that page as a 200
      // with no JSON in it. Failing loudly here is the whole point.
      redirect: 'manual',
      // A live tick for a 1,000-customer company is one radcheck read and one
      // function call; five minutes is generous.
      signal: AbortSignal.timeout(300_000),
    })

    if (res.status >= 300 && res.status < 400) {
      console.error(
        '[billing-ticker] ' + res.status + ' redirect to ' +
        (res.headers.get('location') ?? '?') +
        ' — /api/billing/tick is being intercepted before it runs. ' +
        'Check PUBLIC_PATHS in proxy.ts.'
      )
      return
    }

    const body = await res.json().catch(() => null)

    if (res.status === 503) {
      // The engine is switched off in the environment. Said once per tick so
      // the log shows the ticker is alive and the app is refusing on purpose.
      console.log('[billing-ticker] engine disabled: ' + (body?.error ?? '503'))
      return
    }

    if (!res.ok) {
      console.error('[billing-ticker] ' + res.status + ' ' + (body?.error ?? ''))
      return
    }

    if (!body || body.ok !== true) {
      console.error(
        '[billing-ticker] 200 but not a tick response — something else served ' +
        'this URL. Nothing was run.'
      )
      return
    }

    // One line per company that did anything; silence for the rest. This runs
    // every hour forever, and most hours charge nobody.
    for (const c of body.companies ?? []) {
      if (c.skipped) continue
      console.log(
        '[billing-ticker] ' + c.companyName + ' ' + c.runDate + ' (' + c.mode + '): ' +
        c.status + ', charged ' + c.charged + ' for ' + c.totalAmount +
        (c.error ? ' — ' + c.error : '')
      )
    }
  } catch (err) {
    // A restart of the app during a deploy lands here. Logged and retried on
    // the next tick rather than exiting, so pm2 does not have to restart this too.
    console.error('[billing-ticker] ' + (err?.message ?? String(err)))
  } finally {
    const took = Date.now() - started
    if (took > 60_000) console.warn('[billing-ticker] tick took ' + Math.round(took / 1000) + 's')
  }
}

async function main() {
  console.log('[billing-ticker] started; ' + URL_ + ' every ' + TICK_MS / 1000 + 's')

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log('[billing-ticker] stopping')
      stopping = true
    })
  }

  while (!stopping) {
    await tick()
    if (stopping) break
    await sleep(TICK_MS)
  }

  process.exit(0)
}

main()
