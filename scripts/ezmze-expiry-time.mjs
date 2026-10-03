#!/usr/bin/env node
/**
 * ONE-OFF: Ezmze (company 27) live expiries onto 8:00 AM Jamaica time on the
 * 8th and the 15th. 8:00 AM Jamaica (UTC-5, no daylight saving) is 13:00 on the
 * RADIUS machine's clock, which is UTC.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/ezmze-expiry-time.mjs                           dry run (default)
 *   node scripts/ezmze-expiry-time.mjs --apply --user=<users.id>
 *
 * A DRY RUN PRINTS EVERY ROW AND STOPS. --apply needs --user so every log row
 * names a real account.
 *
 * RUN AFTER migration 0026 is applied and the code that reads it is deployed.
 * Before that, the next payment or Extend writes midnight and puts a customer
 * back at 00:00.
 *
 * THE RULE, per customer
 *   1. company 27, a cut-off day of 8 or 15, and a LIVE expiry (later than now).
 *   2. radcheck holds exactly one Expiration row for the exact MAC.
 *   3. The expiry's day is the cut-off day. Then it moves to that day at 13:00.
 *   FORWARD ONLY. A row whose held time is already later than 13:00 on that day
 *   is left alone and printed, so nobody loses service they hold.
 *
 * ONE CUSTOMER CHANGES CUT-OFF DAY: #1720 (cut-off 14, holds 14 Oct) is put on
 * the 15th, as the owner instructed on 2026-10-03 - cut_off_date 14 -> 15, and
 * 14 Oct -> 15 Oct 13:00. Both are logged. It is named, not derived.
 *
 * LEFT UNTOUCHED, and printed so the count is visible
 *   - lapsed customers (expiry not later than now);
 *   - live customers whose expiry day is NOT their cut-off day (the owner said
 *     to leave the rest);
 *   - the four other customers whose cut-off day is not 8 or 15 (5, 9, 12, 28).
 *
 * WHAT --apply WRITES, per READY row
 *   - radcheck: one UPDATE of the Expiration value, guarded by the value it
 *     replaces. No row inserted or deleted, no other attribute touched.
 *   - log: one network_extend row in the shape Extend Access writes.
 *   - #1720 only: customers.cut_off_date = 15 and a customer_updated-style log
 *     row recording old and new.
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
const TIME = '13:00' // 8:00 AM Jamaica on the RADIUS machine's UTC clock
const RUN_ID = randomUUID()
const MOVE_TO_15 = 1720
const REASON = 'Access ends at 8:00 AM Jamaica time (13:00 on the RADIUS clock) on the cut-off day'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

/** "08 Oct 2026 13:00" -> { y, m, d, hh, mm, at } where `at` is minutes since an epoch, zone-free. */
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
const text = (y, m, d) => pad(d) + ' ' + MONTHS[m] + ' ' + y + ' ' + TIME
const ymd = (y, m, d) => y + '-' + pad(m + 1) + '-' + pad(d)

async function main() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })

  // "Now" on the RADIUS clock, which is what FreeRADIUS compares against.
  const [[clock]] = await my.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i') AS now_utc")
  const nowParts = clock.now_utc.split(' ')
  const [ny, nm, nd] = nowParts[0].split('-').map(Number)
  const [nh, nmin] = nowParts[1].split(':').map(Number)
  const NOW = Date.UTC(ny, nm - 1, nd, nh, nmin)

  let custs = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('customers')
      .select('id, first_name, last_name, mac_address, cut_off_date')
      .eq('company_id', COMPANY).order('id').range(from, from + 999)
    if (error) throw new Error('customers: ' + error.message)
    custs = custs.concat(data)
    if (data.length < 1000) break
  }

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const [all] = await my.execute('SELECT username, value FROM radcheck WHERE attribute = ?', ['Expiration'])
  const rowsByMac = new Map()
  for (const r of all) {
    const k = r.username.trim().toUpperCase()
    rowsByMac.set(k, [...(rowsByMac.get(k) ?? []), r])
  }

  const plan = []
  const left = { lapsed: 0, offDay: 0, otherCutOff: 0, noExpiry: 0 }
  const offDayList = []
  for (const c of custs) {
    const mac = c.mac_address ?? ''
    const rows = rowsByMac.get(mac.trim().toUpperCase()) ?? []
    const name = (c.first_name + ' ' + (c.last_name ?? '')).trim()
    if (rows.length === 0) { left.noExpiry++; continue }

    const movesCutOff = c.id === MOVE_TO_15 && c.cut_off_date === 14
    const cut = movesCutOff ? 15 : c.cut_off_date
    if (cut !== 8 && cut !== 15) { left.otherCutOff++; continue }

    const held = parse(rows[0].value)
    if (!held || held.at <= NOW) { left.lapsed++; continue }

    const row = {
      id: c.id, name, identity: mac, cut, movesCutOff, status: 'READY', why: '',
      from: rows[0].value, y: held.y, m: held.m, d: held.d,
    }
    const skip = (why) => { row.status = 'SKIPPED'; row.why = why }

    // Under the cut-off day rule the expiry's day must be the cut-off day. #1720
    // is on 14 Oct and is being put on 15 Oct, so its target day is the 15th.
    const targetDay = movesCutOff ? 15 : cut
    if (held.d !== (movesCutOff ? 14 : cut)) {
      left.offDay++
      offDayList.push('#' + c.id + ' ' + name + ' holds ' + rows[0].value + ' (cut-off ' + cut + ')')
      continue
    }
    plan.push(row)

    if (rows.length !== 1) { skip(rows.length + ' Expiration rows for this MAC'); continue }
    if (rows[0].username !== mac) { skip('radcheck spells it "' + rows[0].username + '"'); continue }
    const target = parse(text(held.y, held.m, targetDay))
    row.to = text(held.y, held.m, targetDay)
    row.toYmd = ymd(held.y, held.m, targetDay)
    if (target.at < held.at) { skip('already later than ' + TIME + ' (' + rows[0].value + '); left alone'); continue }
    if (target.at === held.at) { skip('already at ' + TIME); continue }
  }

  console.log('Ezmze: live expiries onto ' + TIME + ' (8:00 AM Jamaica)   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  console.log('RADIUS clock now (UTC): ' + clock.now_utc)
  const byGroup = {}
  for (const p of plan) {
    const key = p.status + (p.status === 'READY' ? ' ' + p.from.split(' ').slice(0, 3).join(' ') + ' -> ' + p.to.split(' ').slice(0, 3).join(' ') : ' ' + p.why)
    byGroup[key] = (byGroup[key] ?? 0) + 1
  }
  for (const [k, v] of Object.entries(byGroup).sort()) console.log(String(v).padStart(5) + '  ' + k)
  for (const p of plan.filter((x) => x.status === 'SKIPPED' && !x.why.startsWith('already at'))) {
    console.log('SKIPPED | #' + p.id + ' | ' + p.name + ' | ' + p.why)
  }
  const ready = plan.filter((p) => p.status === 'READY')
  console.log('\nREADY ' + ready.length + '   SKIPPED ' + (plan.length - ready.length))
  console.log('Left untouched: lapsed ' + left.lapsed + ', live but off their cut-off day ' + left.offDay +
    ', cut-off day not 8 or 15 ' + left.otherCutOff + ', no radcheck expiry ' + left.noExpiry)
  for (const l of offDayList) console.log('  off-day: ' + l)
  const moving = ready.find((p) => p.movesCutOff)
  console.log(moving
    ? '#' + MOVE_TO_15 + ' ' + moving.name + ': cut-off 14 -> 15 and ' + moving.from + ' -> ' + moving.to
    : '#' + MOVE_TO_15 + ' is not READY (see above).')

  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> to move the READY rows.')
    await my.end()
    return
  }

  let done = 0
  for (const p of ready) {
    const tag = '#' + p.id + ' ' + p.name + ': '
    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [p.to, p.identity, 'Expiration', p.from])
    if ((res.affectedRows ?? 0) !== 1) {
      console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
      continue
    }
    if (p.movesCutOff) {
      const { error: ce } = await db.from('customers').update({ cut_off_date: 15 })
        .eq('id', p.id).eq('company_id', COMPANY).eq('cut_off_date', 14)
      if (ce) console.log(tag + 'radcheck moved, but the cut-off day update failed: ' + ce.message)
      else {
        await db.from('log').insert({
          company_id: COMPANY, user_id: actor.id, customer_id: p.id,
          type: 'customer_updated', correlation_id: RUN_ID,
          details: 'cut_off_date: 14 -> 15. By ' + actor.email + ' | reason=Put on the 15th on the owner\'s instruction | run=' + RUN_ID,
        })
      }
    }
    const { error: logErr } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: p.id,
      type: 'network_extend', correlation_id: RUN_ID,
      details:
        'Access extended for ' + p.identity + '. Expiry ' + ymd(p.y, p.m, p.d) + ' -> ' + p.toYmd +
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
