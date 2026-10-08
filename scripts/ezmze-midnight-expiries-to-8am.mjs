#!/usr/bin/env node
/**
 * ONE-OFF: the ten Ezmze (company 27) expiries still at midnight move to 8:00 AM
 * Jamaica on the SAME DAY — 13:00 on the RADIUS clock. Owner, 8 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/ezmze-midnight-expiries-to-8am.mjs                        dry run (default)
 *   node scripts/ezmze-midnight-expiries-to-8am.mjs --apply --user=<users.id>
 *
 * WHY THESE TEN. All were written by the app in September, before the
 * company's 8:00 expiry time existed, and all are off the customer's cut-off
 * day — which is why scripts/expiry-time-all-companies.mjs left them alone. The
 * owner asked for the time to be put right and the day left as it is.
 * Paulette McInnis keeps her cut-off day of the 15th; only her time moves.
 *
 * NAMED, NOT DERIVED: each customer and the exact value they hold now. A row
 * that no longer reads exactly that is SKIPPED, the rest still go ahead.
 *
 * WHAT --apply WRITES, per READY row
 *   - radcheck: one UPDATE of the Expiration value, guarded by the value it
 *     replaces. Only the time changes; the day is the same.
 *   - log: one network_extend row in the shape the 8:00 run wrote.
 *   correlation_id on every row = the run id.
 *
 * Paulette's expiry (8 Oct 00:00) has passed, so moving it to 8:00 AM today
 * puts her back on until then, like everyone else whose cut-off was the 8th.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'

const APPLY = process.argv.includes('--apply')
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : null
}
const USER_ID = arg('user') ? Number(arg('user')) : null
if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log rows name who moved these.')
  process.exit(1)
}

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0) {
    const key = line.slice(0, eq).trim()
    if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
}
const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error('Missing ' + n); process.exit(1) }
  return v
}

const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

const COMPANY = 27
const RUN_ID = randomUUID()
const REASON = 'Expiry time to 8:00 AM local; the day is unchanged (owner, 8 Oct 2026)'

// customer id -> the Expiration value it holds now (read 8 Oct 2026).
const NAMED = new Map([
  [420, '08 Jan 2027 00:00'],   // Kerriann Scott
  [1406, '08 Nov 2026 00:00'],  // Davina Valintine Jones
  [1023, '08 Oct 2026 00:00'],  // Paulette McInnis
  [538, '15 Oct 2026 00:00'],   // Casrine Virgo
  [1288, '17 Oct 2026 00:00'],  // Nickiesha Lynch
  [573, '30 Oct 2026 00:00'],   // Lime Tree Garden School
  [675, '30 Oct 2026 00:00'],   // Lower Buxton School 1
  [676, '30 Oct 2026 00:00'],   // Lower Buxton School 2
  [2049, '31 Dec 2032 00:00'],  // Rayon Walker
  [5704, '31 Jan 2039 00:00'],  // Tony Wifey
])

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

/** Minutes the zone is ahead of UTC at `at`. Mirrors lib/radius/format.ts. */
function zoneOffsetMinutes(timeZone, at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - at.getTime()) / 60000)
}

/** The RADIUS-clock text for that day at the company's expiry time. Mirrors applyExpiryClock. */
function radiusText(y, m, d, hh, mm, timeZone) {
  const naive = Date.UTC(y, m, d, hh, mm)
  let instant = naive - zoneOffsetMinutes(timeZone, new Date(naive)) * 60000
  instant = naive - zoneOffsetMinutes(timeZone, new Date(instant)) * 60000
  const at = new Date(instant)
  return pad(at.getUTCDate()) + ' ' + MONTHS[at.getUTCMonth()] + ' ' + at.getUTCFullYear() +
    ' ' + pad(at.getUTCHours()) + ':' + pad(at.getUTCMinutes())
}

const ymdOf = (value) => {
  const [d, mon, y] = value.split(' ')
  return y + '-' + pad(MONTHS.indexOf(mon) + 1) + '-' + d
}

async function main() {
  const { data: settings, error: se } = await db.from('settings')
    .select('expiry_time, timezone').eq('company_id', COMPANY).maybeSingle()
  if (se || !settings?.expiry_time) {
    console.error('Could not read Ezmze expiry time' + (se ? ': ' + se.message : ' (none set)'))
    process.exit(1)
  }
  const [hh, mm] = settings.expiry_time.split(':').map(Number)
  const zone = settings.timezone || 'America/Jamaica'

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    dateStrings: true, connectTimeout: 8000,
  }).catch((err) => {
    console.error('RADIUS not reachable (' + (err.code ?? err.message) + ') — is the SSH tunnel up? Nothing was read or written.')
    process.exit(1)
  })

  const { data: custs, error: ce } = await db.from('customers')
    .select('id, company_id, first_name, last_name, mac_address, pppoe_username, customer_type')
    .eq('company_id', COMPANY).in('id', [...NAMED.keys()])
  if (ce) throw new Error(ce.message)

  console.log('Ezmze midnight expiries -> ' + settings.expiry_time + ' ' + zone + ', same day   run=' + RUN_ID +
    (APPLY ? '   APPLY' : '   DRY RUN') + '\n')

  const plan = []
  for (const [id, expected] of NAMED) {
    const c = custs.find((x) => x.id === id)
    const name = c ? (c.first_name + ' ' + (c.last_name ?? '')).trim() : '?'
    const identity = c ? ((c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address) ?? '').trim() : ''
    const row = { id, name, identity, from: expected, to: null, status: 'SKIPPED', why: '' }
    plan.push(row)
    if (!c) { row.why = 'not an Ezmze customer'; continue }
    if (!identity) { row.why = 'no MAC or username'; continue }
    const [rows] = await my.execute(
      'SELECT username, value FROM radcheck WHERE TRIM(username) = ? AND attribute = ?', [identity, 'Expiration'])
    if (rows.length !== 1) { row.why = rows.length + ' Expiration rows'; continue }
    if (rows[0].value !== expected) { row.why = 'now holds "' + rows[0].value + '", not "' + expected + '"'; continue }
    const [d, mon, y] = expected.split(' ')
    row.username = rows[0].username
    row.to = radiusText(Number(y), MONTHS.indexOf(mon), Number(d), hh, mm, zone)
    row.status = 'READY'
  }

  for (const p of plan) {
    console.log(p.status.padEnd(8) + ('#' + p.id).padEnd(7) + p.name.padEnd(30) + p.from + '  ->  ' + (p.to ?? '—') +
      (p.why ? '   ' + p.why : ''))
  }
  const ready = plan.filter((p) => p.status === 'READY')
  console.log('\nREADY ' + ready.length + ' of ' + plan.length + '.')

  if (!APPLY) {
    console.log('Dry run: nothing was written. Re-run with --apply --user=<users.id>.')
    await my.end()
    return
  }

  let done = 0
  for (const p of ready) {
    const tag = '#' + p.id + ' ' + p.name + ': '
    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [p.to, p.username, 'Expiration', p.from])
    if ((res.affectedRows ?? 0) !== 1) {
      console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
      continue
    }
    const { error: logErr } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: p.id, correlation_id: RUN_ID,
      type: 'network_extend',
      details:
        'Access extended for ' + p.username + '. Expiry ' + ymdOf(p.from) + ' -> ' + ymdOf(p.to) +
        '. By ' + actor.email + ' | reason=' + REASON + ' (was ' + p.from + ', now ' + p.to +
        ' RADIUS clock) | run=' + RUN_ID,
    })
    if (logErr) console.log(tag + 'radcheck moved, but the log row failed: ' + logErr.message)
    done += 1
  }
  console.log('\nMoved ' + done + ' of ' + ready.length + ' READY row(s). run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
