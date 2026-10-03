#!/usr/bin/env node
/**
 * ONE-OFF: every company's live expiries onto 8:00 AM LOCAL time on the
 * customer's cut-off day.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/expiry-time-all-companies.mjs                            dry run
 *   node scripts/expiry-time-all-companies.mjs --company=27               one company
 *   node scripts/expiry-time-all-companies.mjs --apply --user=<users.id>
 *
 * A DRY RUN PRINTS THE PLAN AND STOPS. --apply needs --user so every log row
 * names a real account.
 *
 * RUN AFTER migration 0026 is applied and the code that reads it is deployed.
 * Before that, the next payment or Extend writes midnight and puts a customer
 * back at 00:00.
 *
 * THE TIME. radcheck holds wall-clock text and FreeRADIUS reads it on the NAS
 * box's clock, which is UTC; one radcheck table serves every company. 8:00 AM in
 * a company's own zone (settings.timezone) is therefore worked out per company
 * and per date: America/Jamaica (UTC-5, no daylight saving) gives 13:00. The
 * same conversion is lib/radius/format.ts#applyExpiryClock, which a .mjs cannot
 * import, so it is repeated below and must be kept in step with it.
 *
 * THE RULE, per customer
 *   1. A cut-off day on record (a day longer than the month is clamped to its
 *      last day, as lib/expiry.ts#nextCutOff does).
 *   2. radcheck holds exactly one Expiration row for the customer's identity
 *      (MAC, or PPPoE username for a PPPoE customer).
 *   3. The expiry is LIVE: later than now on the RADIUS clock.
 *   4. The expiry's day is the cut-off day. It then moves to that day at the
 *      company's 8:00 AM.
 *   FORWARD ONLY. A row already holding a later time that day is left alone and
 *   printed, so nobody loses service they hold.
 *
 * ONE CUSTOMER CHANGES CUT-OFF DAY, named and not derived: Ezmze #1720 (cut-off
 * 14, holds 14 Oct) is put on the 15th on the owner's instruction (2026-10-03):
 * customers.cut_off_date 14 -> 15 and 14 Oct -> 15 Oct 8:00 AM. Both are logged.
 *
 * LEFT UNTOUCHED, counted per company so the numbers are visible
 *   - lapsed customers (expiry not later than now);
 *   - live customers whose expiry day is NOT their cut-off day. Their dates were
 *     set by hand or by a legacy till, and moving them onto the cut-off day is
 *     free service of up to a month, which is a separate decision from the time
 *     of day. They keep their stored time as well;
 *   - customers with no cut-off day or no radcheck expiry.
 *
 * WHAT --apply WRITES, per READY row
 *   - radcheck: one UPDATE of the Expiration value, guarded by the value it
 *     replaces. No row inserted or deleted, no other attribute touched.
 *   - log: one network_extend row in the shape Extend Access writes.
 *   - #1720 only: customers.cut_off_date = 15 and a customer_updated log row.
 *   correlation_id on every row = the run id.
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
const ONLY_COMPANY = arg('company') ? Number(arg('company')) : null
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

const LOCAL_TIME = [8, 0] // 8:00 AM on the company's own clock
const RUN_ID = randomUUID()
const MOVE_TO_15 = { company: 27, id: 1720 }
const REASON = 'Access ends at 8:00 AM local time on the cut-off day'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate()

/** "08 Oct 2026 13:00" -> { y, m, d, hh, mm, at } with `at` zone-free (as if UTC). */
function parse(value) {
  const p = String(value ?? '').trim().split(' ')
  if (p.length < 3) return null
  const m = MONTHS.indexOf(p[1])
  if (m === -1) return null
  const [hh, mm] = (p[3] ?? '00:00').split(':').map(Number)
  const y = Number(p[2])
  const d = Number(p[0])
  return { y, m, d, hh, mm, at: Date.UTC(y, m, d, hh, mm) }
}

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

/** The RADIUS-clock text for y/m/d at the company's 8:00 AM. Mirrors applyExpiryClock. */
function radiusText(y, m, d, timeZone) {
  const naive = Date.UTC(y, m, d, LOCAL_TIME[0], LOCAL_TIME[1])
  let instant = naive - zoneOffsetMinutes(timeZone, new Date(naive)) * 60000
  instant = naive - zoneOffsetMinutes(timeZone, new Date(instant)) * 60000
  const at = new Date(instant)
  return {
    text: pad(at.getUTCDate()) + ' ' + MONTHS[at.getUTCMonth()] + ' ' + at.getUTCFullYear() +
      ' ' + pad(at.getUTCHours()) + ':' + pad(at.getUTCMinutes()),
    at: Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours(), at.getUTCMinutes()),
    ymd: at.getUTCFullYear() + '-' + pad(at.getUTCMonth() + 1) + '-' + pad(at.getUTCDate()),
  }
}
const ymd = (y, m, d) => y + '-' + pad(m + 1) + '-' + pad(d)

async function all(build) {
  let out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw new Error(error.message)
    out = out.concat(data)
    if (data.length < 1000) break
  }
  return out
}

async function main() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })

  // "Now" on the RADIUS clock, which is what FreeRADIUS compares against.
  const [[clock]] = await my.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i') AS now_utc")
  const [np, nt] = clock.now_utc.split(' ')
  const [ny, nm, nd] = np.split('-').map(Number)
  const [nh, nmin] = nt.split(':').map(Number)
  const NOW = Date.UTC(ny, nm - 1, nd, nh, nmin)

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const settings = await all(() => db.from('settings').select('company_id, timezone').order('company_id'))
  const companies = await all(() => db.from('companies').select('id, name').order('id'))
  const nameOf = new Map(companies.map((c) => [c.id, c.name]))
  const zoneOf = new Map(settings.map((s) => [s.company_id, s.timezone || 'America/Jamaica']))

  const custs = await all(() => db.from('customers')
    .select('id, company_id, first_name, last_name, mac_address, pppoe_username, customer_type, cut_off_date')
    .order('id'))

  const [rcRows] = await my.execute('SELECT username, value FROM radcheck WHERE attribute = ?', ['Expiration'])
  const rowsByKey = new Map()
  for (const r of rcRows) {
    const k = r.username.trim().toUpperCase()
    rowsByKey.set(k, [...(rowsByKey.get(k) ?? []), r])
  }

  console.log('All companies: live expiries onto 8:00 AM local on the cut-off day   run=' + RUN_ID +
    (APPLY ? '   APPLY' : '   DRY RUN'))
  console.log('RADIUS clock now (UTC): ' + clock.now_utc + '\n')

  const plan = []
  const stats = new Map()
  const stat = (id) => {
    if (!stats.has(id)) stats.set(id, { ready: 0, same: 0, later: 0, multi: 0, lapsed: 0, offDay: 0, noCut: 0, noExpiry: 0 })
    return stats.get(id)
  }
  const offDay = []

  for (const c of custs) {
    if (ONLY_COMPANY && c.company_id !== ONLY_COMPANY) continue
    const s = stat(c.company_id)
    const identity = ((c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address) ?? '').trim()
    const rows = identity ? (rowsByKey.get(identity.toUpperCase()) ?? []) : []
    if (rows.length === 0) { s.noExpiry++; continue }
    if (rows.length > 1) { s.multi++; continue }

    const movesCutOff = c.company_id === MOVE_TO_15.company && c.id === MOVE_TO_15.id && c.cut_off_date === 14
    const cut = movesCutOff ? 15 : c.cut_off_date
    if (!cut) { s.noCut++; continue }

    const held = parse(rows[0].value)
    if (!held || held.at <= NOW) { s.lapsed++; continue }

    const wantedDay = Math.min(cut, daysInMonth(held.y, held.m))
    const heldDay = movesCutOff ? 14 : held.d
    if (heldDay !== (movesCutOff ? 14 : wantedDay)) {
      s.offDay++
      offDay.push({ company: c.company_id, id: c.id, held: rows[0].value, cut })
      continue
    }

    const targetDay = movesCutOff ? 15 : wantedDay
    const target = radiusText(held.y, held.m, targetDay, zoneOf.get(c.company_id) ?? 'America/Jamaica')
    const name = (c.first_name + ' ' + (c.last_name ?? '')).trim()
    const row = {
      company: c.company_id, id: c.id, name, username: rows[0].username, movesCutOff,
      from: rows[0].value, fromYmd: ymd(held.y, held.m, held.d), to: target.text, toYmd: target.ymd,
    }
    if (target.at < held.at) { s.later++; plan.push({ ...row, status: 'SKIPPED', why: 'already later (' + rows[0].value + '); left alone' }); continue }
    if (target.at === held.at) { s.same++; continue }
    s.ready++
    plan.push({ ...row, status: 'READY' })
  }

  for (const [id, s] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(String(id).padStart(3) + ' ' + (nameOf.get(id) ?? '?').padEnd(36) + ' tz=' + zoneOf.get(id) +
      '  READY ' + s.ready + '  already there ' + s.same + '  later-kept ' + s.later +
      '  | untouched: lapsed ' + s.lapsed + ', off cut-off day ' + s.offDay +
      ', no cut-off ' + s.noCut + ', no expiry ' + s.noExpiry + ', duplicate rows ' + s.multi)
  }
  const ready = plan.filter((p) => p.status === 'READY')
  const shapes = new Map()
  for (const p of ready) {
    const k = p.from.split(' ').slice(3).join(' ') + ' -> ' + p.to.split(' ').slice(3).join(' ')
    shapes.set(k, (shapes.get(k) ?? 0) + 1)
  }
  console.log('\nTime of day moved, across READY rows:')
  for (const [k, v] of [...shapes.entries()].sort()) console.log('  ' + String(v).padStart(5) + '  ' + k)
  for (const p of plan.filter((x) => x.status === 'SKIPPED')) {
    console.log('SKIPPED | ' + p.company + ' #' + p.id + ' ' + p.name + ' | ' + p.why)
  }
  console.log('\nREADY ' + ready.length + '   SKIPPED ' + (plan.length - ready.length) +
    '   live but off their cut-off day (left alone) ' + offDay.length)
  const moving = ready.find((p) => p.movesCutOff)
  console.log(moving
    ? 'Ezmze #' + MOVE_TO_15.id + ' ' + moving.name + ': cut-off 14 -> 15 and ' + moving.from + ' -> ' + moving.to
    : 'Ezmze #' + MOVE_TO_15.id + ' is not READY.')

  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> to move the READY rows.')
    await my.end()
    return
  }

  let done = 0
  for (const p of ready) {
    const tag = p.company + ' #' + p.id + ' ' + p.name + ': '
    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [p.to, p.username, 'Expiration', p.from])
    if ((res.affectedRows ?? 0) !== 1) {
      console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
      continue
    }
    if (p.movesCutOff) {
      const { error: ce } = await db.from('customers').update({ cut_off_date: 15 })
        .eq('id', p.id).eq('company_id', p.company).eq('cut_off_date', 14)
      if (ce) console.log(tag + 'radcheck moved, but the cut-off day update failed: ' + ce.message)
      else {
        await db.from('log').insert({
          company_id: p.company, user_id: actor.id, customer_id: p.id,
          type: 'customer_updated', correlation_id: RUN_ID,
          details: 'cut_off_date: 14 -> 15. By ' + actor.email + ' | reason=Put on the 15th on the owner\'s instruction | run=' + RUN_ID,
        })
      }
    }
    const { error: logErr } = await db.from('log').insert({
      company_id: p.company, user_id: actor.id, customer_id: p.id,
      type: 'network_extend', correlation_id: RUN_ID,
      details:
        'Access extended for ' + p.username + '. Expiry ' + p.fromYmd + ' -> ' + p.toYmd +
        '. By ' + actor.email + ' | reason=' + REASON + ' | run=' + RUN_ID,
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
