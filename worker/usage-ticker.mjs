#!/usr/bin/env node
/**
 * The usage ticker.
 *
 * DELIBERATELY DUMB, like the two tickers beside it. It knows a URL and a
 * timer. Which routers to visit, how to log in, how to turn counters into
 * usage and which day it belongs to all live in the app behind
 * /api/usage/poll, so this process cannot drift from what the customer record
 * shows.
 *
 *   pm2 start worker/usage-ticker.mjs --name ispman-usage --cwd /PATH/TO/ispman
 *
 * ONE INSTANCE, fork mode, never cluster. Two passes at once would both read
 * the same counters, both compute a delta from the same previous reading, and
 * both add it — counting every byte twice.
 *
 * EVERY FIVE MINUTES. The counters are cumulative, so a missed pass loses
 * nothing: the next one's delta covers both intervals. The interval therefore
 * only decides how fresh "used so far today" is, not how accurate the day's
 * total is. Five minutes is also short enough that a router rebooting between
 * passes loses little, since a reset discards whatever was not yet read.
 *
 * KILL SWITCHES, either of:
 *   pm2 stop ispman-usage
 *   USAGE_POLL_ENABLED=false in .env.local, then pm2 restart ispman --update-env
 * The second is checked by the app on every tick, so the ticker can keep
 * running and every tick is refused with 503 until the flag is set back.
 *
 * Environment (same .env.local the app reads):
 *   USAGE_POLL_URL       default http://127.0.0.1:3000/api/usage/poll
 *   USAGE_POLL_SECRET    must match the app's
 *   USAGE_POLL_SECONDS   default 300
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

const URL_ = process.env.USAGE_POLL_URL || 'http://127.0.0.1:3000/api/usage/poll'
const SECRET = process.env.USAGE_POLL_SECRET
const TICK_MS = Math.max(60, Number(process.env.USAGE_POLL_SECONDS || 300)) * 1000

if (!SECRET) {
  console.error('USAGE_POLL_SECRET is not set. Refusing to start.')
  process.exit(1)
}

let stopping = false
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const gb = (bytes) => (bytes / 1024 / 1024 / 1024).toFixed(2)

async function tick() {
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'x-usage-poll-secret': SECRET },
      // NEVER FOLLOW A REDIRECT. The app's proxy sends anything without a
      // session to /login, and a followed redirect returns that page as a 200
      // with no JSON in it. Failing loudly here is the whole point.
      redirect: 'manual',
      // A pass visits each router in turn over a tunnel. Generous, but it must
      // be shorter than the interval so two passes can never overlap.
      signal: AbortSignal.timeout(240_000),
    })

    if (res.status >= 300 && res.status < 400) {
      console.error(
        '[usage-ticker] ' + res.status + ' redirect to ' +
        (res.headers.get('location') ?? '?') +
        ' — /api/usage/poll is being intercepted before it runs. ' +
        'Check PUBLIC_PATHS in proxy.ts.'
      )
      return
    }

    const body = await res.json().catch(() => null)

    if (res.status === 503) {
      console.log('[usage-ticker] not polling: ' + (body?.error ?? '503'))
      return
    }
    if (!res.ok) {
      console.error('[usage-ticker] ' + res.status + ' ' + (body?.error ?? ''))
      return
    }
    if (!body || body.ok !== true) {
      console.error(
        '[usage-ticker] 200 but not a poll response — something else served ' +
        'this URL. Nothing was read.'
      )
      return
    }

    const routers = body.routers ?? []
    const failed = routers.filter((r) => !r.ok)
    const added = routers.reduce((n, r) => n + (r.bytesAdded ?? 0), 0)

    // ONE SUMMARY LINE PER PASS, not one per router. This runs 288 times a day
    // and a healthy pass is not news; the per-router detail is only printed
    // for the ones that failed.
    console.log(
      '[usage-ticker] ' + routers.length + ' routers, ' +
      routers.reduce((n, r) => n + (r.matched ?? 0), 0) + ' queues matched, ' +
      routers.reduce((n, r) => n + (r.unmatched ?? 0), 0) + ' unmatched, ' +
      gb(added) + ' GB added, ' + Math.round((body.tookMs ?? 0) / 1000) + 's' +
      (failed.length ? ' — ' + failed.length + ' router(s) failed' : '')
    )

    for (const r of failed) {
      console.error('[usage-ticker] ' + r.router + ' (' + r.tunnelIp + '): ' + (r.error ?? '?'))
    }

    // A rotated ROUTER_SECRET_KEY leaves rows nothing can decrypt. Those
    // routers are skipped silently by the poller, so say so here or the only
    // symptom is usage quietly stopping for them.
    if (body.undecryptable) {
      console.error(
        '[usage-ticker] ' + body.undecryptable + ' router login(s) could not be decrypted. ' +
        'Paste the setup line on those routers again.'
      )
    }

    const resets = routers.reduce((n, r) => n + (r.resets ?? 0), 0)
    if (resets) {
      console.log('[usage-ticker] ' + resets + ' queue counter(s) had restarted since the last pass.')
    }
  } catch (err) {
    console.error('[usage-ticker] ' + (err?.message ?? String(err)))
  }
}

async function main() {
  console.log(
    '[usage-ticker] started, every ' + Math.round(TICK_MS / 1000) + 's against ' + URL_
  )
  // A first pass at once, so starting the worker is its own test.
  while (!stopping) {
    await tick()
    await sleep(TICK_MS)
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    console.log('[usage-ticker] stopping')
    process.exit(0)
  })
}

main()
