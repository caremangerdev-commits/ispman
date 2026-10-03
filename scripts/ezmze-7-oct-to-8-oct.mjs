#!/usr/bin/env node
/**
 * ONE-OFF: Ezmze (company 27) customers holding 7 Oct 2026 on a cut-off day of 8
 * are moved FORWARD to 8 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/ezmze-7-oct-to-8-oct.mjs                         dry run (default)
 *   node scripts/ezmze-7-oct-to-8-oct.mjs --apply --user=<users.id>
 *
 * A DRY RUN PRINTS AND STOPS. --apply needs --user so every log row names a
 * real account.
 *
 * WHY. The cut-off walk goes to the next cut-off day strictly after the expiry,
 * so an expiry the day BEFORE the cut-off day buys one day for a month's money.
 * These 15 were set to the 7th by a date picked at the till on 3 Sep; their
 * cut-off day is the 8th. Moving them to the 8th makes the next payment a full
 * month. Forward by one day, never backward: nobody loses service.
 *
 * THE LIST IS DERIVED, NOT STATED. A customer is READY when
 *   1. company 27 and cut_off_date = 8;
 *   2. radcheck holds exactly one Expiration row for its exact MAC, with the
 *      value "07 Oct 2026 00:00";
 *   3. no other spelling of the MAC (case, whitespace) holds an Expiration.
 * Anything else is SKIPPED and printed with its reason.
 *
 * TIME. radcheck holds wall-clock text with no zone, and every expiry the app
 * writes is midnight Jamaica time as "08 Oct 2026 00:00"
 * (lib/radius/format.ts#formatRadiusExpiration). The new value is that string.
 *
 * WHAT --apply WRITES, per READY row
 *   - radcheck: one UPDATE of the Expiration value, guarded by the value it
 *     replaces. No row inserted or deleted, no other attribute touched.
 *   - log: one network_extend row in the shape Extend Access writes
 *     (lib/radius/operations.ts#networkEventDetails), correlation_id = run id.
 *
 * WHAT IT DOES NOT TOUCH
 *   Balances, credit, payments, bill dates, cut-off days, or any customer not
 *   holding exactly 7 Oct.
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
  console.error('--apply needs --user=<users.id> so the log rows name who extended these.')
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

const COMPANY = 27 // Ezmze
const CUT_OFF = 8
const FROM = '07 Oct 2026 00:00'
const TO = '08 Oct 2026 00:00'
const RUN_ID = randomUUID()
const REASON = 'Expiry sat one day before the cut-off day of 8, so a month paid bought one day; set to the cut-off day'

async function main() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })

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

  const [held] = await my.execute('SELECT username, value FROM radcheck WHERE attribute = ? AND value = ?', ['Expiration', FROM])
  const heldBy = new Set(held.map((r) => r.username.toUpperCase()))

  const plan = []
  for (const c of custs) {
    const mac = c.mac_address ?? ''
    if (!heldBy.has(mac.toUpperCase())) continue
    const name = (c.first_name + ' ' + (c.last_name ?? '')).trim()
    const row = { id: c.id, name, identity: mac, status: 'READY', why: '' }
    plan.push(row)
    const skip = (why) => { row.status = 'SKIPPED'; row.why = why }

    if (c.cut_off_date !== CUT_OFF) { skip('cut-off day is ' + c.cut_off_date + ', not ' + CUT_OFF); continue }
    const [rows] = await my.execute(
      'SELECT username, value FROM radcheck WHERE UPPER(TRIM(username)) = ? AND attribute = ?', [mac.toUpperCase(), 'Expiration'])
    if (rows.length !== 1) { skip(rows.length + ' Expiration rows for this MAC'); continue }
    if (rows[0].username !== mac) { skip('radcheck spells it "' + rows[0].username + '"'); continue }
    if (rows[0].value !== FROM) { skip('radcheck now holds ' + rows[0].value); continue }
  }

  console.log('Ezmze: ' + FROM + ' -> ' + TO + '   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  for (const p of plan) console.log([p.status, '#' + p.id, p.name, p.identity, p.status === 'READY' ? FROM + ' -> ' + TO : p.why].join(' | '))
  const ready = plan.filter((p) => p.status === 'READY')
  console.log('\nREADY ' + ready.length + '   SKIPPED ' + (plan.length - ready.length))

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
      [TO, p.identity, 'Expiration', FROM])
    if ((res.affectedRows ?? 0) !== 1) {
      console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
      continue
    }
    const { error: logErr } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: p.id,
      type: 'network_extend',
      correlation_id: RUN_ID,
      details:
        'Access extended for ' + p.identity + '. Expiry 2026-10-07 -> 2026-10-08. By ' + actor.email +
        ' | reason=' + REASON + ' | run=' + RUN_ID,
    })
    if (logErr) console.log(tag + 'radcheck moved, but the log row failed: ' + logErr.message)
    done += 1
    console.log(tag + FROM + ' -> ' + TO)
  }
  console.log('\nMoved ' + done + ' of ' + ready.length + ' READY row(s). run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
