#!/usr/bin/env node
/**
 * ONE-OFF: six Ezmze (company 27) customers who paid a month on 1-6 Oct and
 * were walked only to the next cut-off day. Each is moved on one month.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/correct-ezmze-one-day-stubs.mjs                         dry run (default)
 *   node scripts/correct-ezmze-one-day-stubs.mjs --apply --user=<users.id>
 *
 * A DRY RUN PRINTS EVERY CUSTOMER AND STOPS. --apply needs --user so each log
 * row names a real account. Customers are handled one by one: one that no
 * longer looks as found on 7 Oct is SKIPPED and the others still go ahead.
 *
 * WHAT WENT WRONG
 *   Each held an expiry short of their cut-off day — the 7th on a cut-off of
 *   the 8th, the 14th on the 15th, or 1 Oct on the 15th — and paid a month.
 *   A payment walks to the NEXT cut-off day, which was one day (or 9-14 days)
 *   away, so a month's money bought that much. 18 customers were caught on
 *   1-2 Oct, before the 7th/14th holders were moved onto the cut-off day on
 *   2-3 Oct; Ezmze staff fixed 13 by hand with Extend. These are the rest.
 *
 *   #1347 Mendelise Waugh is the 1-Oct case: her 3 Sep payment for August was
 *   given 1 Oct instead of her cut-off day the 15th (an old bill-day bug), so
 *   her 6 Oct payment for October only reached the 15 Oct she had already paid
 *   for. Everol Gray (#1134) is deliberately NOT here: he asked to be
 *   disconnected, and 8 Oct is what he paid for from the day he came back.
 *
 * WHAT --apply WRITES, per READY customer
 *   - radcheck Expiration: the short date -> one month on, at Ezmze's expiry
 *     time (08:00 America/Jamaica = 13:00 on the UTC RADIUS clock, the same
 *     conversion as lib/radius/format.ts#applyExpiryClock), guarded by the value
 *     it replaces.
 *   - the short payment's access_granted_until and service_active_until.
 *   - one network_extend log row: payment, reason, run id.
 *
 * WHAT IT DOES NOT TOUCH
 *   Money. Balances, credit, the payments' amounts and months are unchanged.
 *
 * READY ONLY IF, per customer: still in company 27 on the same cut-off day;
 * their latest service payment is the one found on 7 Oct and still says the
 * short date; no service payment since; radcheck holds exactly one Expiration
 * row for the MAC, on the short date.
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
  console.error('--apply needs --user=<users.id> so the log rows name who corrected these.')
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

// Stated, not derived: the six named on 7 Oct, with the date each is stuck on.
const TARGETS = [
  { id: 1201, cut: 8, short: '2026-10-08', to: '2026-11-08' }, // Jody Ann Grant
  { id: 1251, cut: 8, short: '2026-10-08', to: '2026-11-08' }, // Annallee Tristana Brown
  { id: 1389, cut: 15, short: '2026-10-15', to: '2026-11-15' }, // Adriana Onekia Morrison
  { id: 1184, cut: 15, short: '2026-10-15', to: '2026-11-15' }, // Attanya Richards
  { id: 1338, cut: 15, short: '2026-10-15', to: '2026-11-15' }, // Latoya Letisha Marston
  { id: 1347, cut: 15, short: '2026-10-15', to: '2026-11-15' }, // Mendelise Allicia Waugh
]

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

/** YYYY-MM-DD at the company's local time, as RADIUS-clock text: "08 Nov 2026 13:00". */
function radiusText(ymdValue, localTime, timeZone) {
  const [y, m, d] = ymdValue.split('-').map(Number)
  const [hh, mm] = localTime.split(':').map(Number)
  const naive = Date.UTC(y, m - 1, d, hh, mm)
  let instant = naive - zoneOffsetMinutes(timeZone, new Date(naive)) * 60000
  instant = naive - zoneOffsetMinutes(timeZone, new Date(instant)) * 60000
  const at = new Date(instant)
  return pad(at.getUTCDate()) + ' ' + MONTHS[at.getUTCMonth()] + ' ' + at.getUTCFullYear() +
    ' ' + pad(at.getUTCHours()) + ':' + pad(at.getUTCMinutes())
}

/** "2026-10-08" -> "08 Oct 2026", the date part of a radcheck value. */
const radiusDay = (ymdValue) => {
  const [y, m, d] = ymdValue.split('-').map(Number)
  return pad(d) + ' ' + MONTHS[m - 1] + ' ' + y
}

async function main() {
  const { data: settings, error: se } = await db.from('settings')
    .select('expiry_time, timezone').eq('company_id', COMPANY).single()
  if (se) throw new Error('settings: ' + se.message)

  let my = null
  let radiusError = null
  try {
    my = await mysql.createConnection({
      host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
      database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306),
      dateStrings: true, connectTimeout: 8000,
    })
  } catch (err) {
    radiusError = err.code ?? err.message
  }

  const plan = []
  for (const t of TARGETS) {
    const row = { ...t, status: 'READY', why: [] }
    plan.push(row)
    const skip = (why) => { row.status = 'SKIPPED'; row.why.push(why) }

    const { data: c } = await db.from('customers')
      .select('id, company_id, first_name, last_name, mac_address, cut_off_date, carried_balance')
      .eq('id', t.id).maybeSingle()
    if (!c) { skip('customer not found'); continue }
    row.name = (c.first_name + ' ' + (c.last_name ?? '')).trim()
    row.mac = c.mac_address
    row.balance = c.carried_balance
    if (c.company_id !== COMPANY) skip('customer is company ' + c.company_id)
    if (c.cut_off_date !== t.cut) skip('cut-off day is now ' + c.cut_off_date)

    const { data: pays } = await db.from('payments')
      .select('id, created_at, paid_on, amount, access_granted_until')
      .eq('customer_id', t.id).neq('payment_kind', 'other')
      .order('created_at', { ascending: false }).limit(1)
    const p = pays?.[0]
    if (!p) { skip('no service payment'); continue }
    row.payment = p
    if (p.access_granted_until !== t.short) {
      skip('latest payment #' + p.id + ' now grants ' + p.access_granted_until + ', not ' + t.short)
    }

    row.target = radiusText(t.to, settings.expiry_time, settings.timezone)
    if (!my) { skip('radcheck not readable (' + radiusError + ') — is the SSH tunnel up?'); continue }
    const [rows] = await my.execute(
      'SELECT username, value FROM radcheck WHERE UPPER(TRIM(username)) = ? AND attribute = ?',
      [String(c.mac_address ?? '').trim().toUpperCase(), 'Expiration'])
    if (rows.length !== 1) { skip(rows.length + ' Expiration rows for ' + c.mac_address); continue }
    row.held = rows[0]
    if (!rows[0].value.startsWith(radiusDay(t.short))) {
      skip('radcheck now holds ' + rows[0].value + ' (staff may have fixed it already)')
    }
  }

  console.log('Ezmze one-day corrections   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN') + '\n')
  for (const r of plan) {
    console.log((r.status === 'READY' ? 'READY  ' : 'SKIPPED') + '  #' + String(r.id).padEnd(5) + ' ' + String(r.name ?? '?').padEnd(28) +
      ' paid ' + (r.payment ? r.payment.paid_on + ' J$' + r.payment.amount : '?') +
      '   ' + (r.held ? r.held.value : r.short) + '  ->  ' + (r.target ?? r.to) +
      (r.why.length ? '\n           ' + r.why.join('; ') : ''))
  }
  const ready = plan.filter((r) => r.status === 'READY')
  console.log('\nREADY ' + ready.length + ' of ' + plan.length + '. Balances unchanged.')

  if (!APPLY) {
    console.log('Dry run: nothing was written. Re-run with --apply --user=<users.id>.')
    if (my) await my.end()
    return
  }
  if (!my) { console.error('radcheck not reachable; nothing written.'); process.exit(1) }

  const { data: actor } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
  if (!actor) { console.error('No users row ' + USER_ID); await my.end(); process.exit(1) }

  let done = 0
  for (const r of ready) {
    const tag = '#' + r.id + ' ' + r.name + ': '
    // radcheck first, guarded by the value it replaces.
    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [r.target, r.held.username, 'Expiration', r.held.value])
    if ((res.affectedRows ?? 0) !== 1) { console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; skipped.'); continue }

    const { error: pe } = await db.from('payments')
      .update({ access_granted_until: r.to, service_active_until: r.to })
      .eq('id', r.payment.id).eq('company_id', COMPANY)
    if (pe) console.log(tag + 'radcheck moved, payment update failed: ' + pe.message)

    const { error: le } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: r.id,
      type: 'network_extend', correlation_id: RUN_ID,
      details:
        'Access extended for ' + r.held.username + '. Expiry ' + r.short + ' -> ' + r.to +
        '. By ' + actor.email +
        ' | reason=Payment #' + r.payment.id + ' paid a month but only reached the next cut-off day; extended to the month it paid for' +
        ' | run=' + RUN_ID,
    })
    if (le) console.log(tag + 'radcheck and payment updated, log row failed: ' + le.message)
    done += 1
    console.log(tag + r.held.value + ' -> ' + r.target)
  }
  await my.end()
  console.log('\nCorrected ' + done + ' of ' + ready.length + '. run=' + RUN_ID)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
