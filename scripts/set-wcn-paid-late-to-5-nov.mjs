#!/usr/bin/env node
/**
 * ONE-OFF: West Central Networks customers who paid on or after 20 Sep 2026
 * set to expire 5 Nov 2026 — one month past the 5 Oct cut-off everyone else
 * was put on (scripts/correct-wcn-expiries-to-5-oct.mjs,
 * scripts/set-wcn-rb5009-to-5-oct.mjs).
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/set-wcn-paid-late-to-5-nov.mjs                          dry run (default)
 *   node scripts/set-wcn-paid-late-to-5-nov.mjs --apply --user=<users.id>
 *
 * THE LIST: every customer on either router with a payment dated 20 Sep or
 * later, in ISPMan or at the legacy till, read 2026-09-29. Five were found;
 * Faith Nash (#5701) already holds 05 Nov 2026 00:00 and is not listed. The
 * other four hold 5 Dec 2026 - 5 Feb 2027: two paid at the legacy till, which
 * wrote the far date; two paid at ISPMan's till, which extended from a date
 * the legacy till had already pushed too far.
 *
 * GUARDS, per row: company 26, MAC is the identity, cut-off day 5, exactly one
 * Expiration row for that exact username still holding `expect`, and 5 Nov is
 * earlier than it (a correction only moves back).
 *
 * WHAT --apply WRITES, per READY row, under one run id: one guarded UPDATE of
 * the radcheck Expiration, and one network_expiry_corrected log row in the
 * shape the Correct Expiry modal writes. Nothing else.
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

function loadEnv(file = '.env.local') {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
loadEnv()
const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error('Missing ' + n); process.exit(1) }
  return v
}
const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

const COMPANY = 26 // West Central Networks
const TARGET = '05 Nov 2026 00:00'
const TARGET_YMD = '2026-11-05'
const RUN_ID = randomUUID()
const REASON = 'Paid on or after 20 Sep for one month; set to 5 Nov on the owner\'s instruction'

const TARGETS = [
  { id: 2003, identity: 'E4:38:83:AE:9B:66', expect: '05 Feb 2027 19:40', paid: '2026-09-22 (legacy)' }, // Kamar Nash
  { id: 1874, identity: '60:22:32:D6:99:4D', expect: '05 Jan 2027 14:57', paid: '2026-09-22 (legacy)' }, // Romardo Foster
  { id: 1907, identity: '70:A7:41:1A:DC:C9', expect: '05 Jan 2027 00:00', paid: '2026-09-26 (ISPMan)' }, // Olive Bryan
  { id: 1929, identity: '74:AC:B9:F2:20:60', expect: '05 Dec 2026 00:00', paid: '2026-09-26 (ISPMan)' }, // Vanessa Forrest
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** lib/radius/format.ts#parseRadiusExpiration. */
function parseRadius(value) {
  if (!value) return null
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase())
  if (mi === -1) return null
  const d = new Date(Number(m[3]), mi, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0))
  return Number.isFinite(d.getTime()) ? d : null
}
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const safeValue = (s) => String(s ?? '').replace(/\|/g, '/').trim()

async function main() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })
  const { data: custs, error } = await db.from('customers')
    .select('id, company_id, first_name, last_name, mac_address, cut_off_date').in('id', TARGETS.map((t) => t.id))
  if (error) throw new Error('customers: ' + error.message)

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const target = parseRadius(TARGET)
  const plan = []
  for (const t of TARGETS) {
    const c = custs.find((x) => x.id === t.id)
    const row = { ...t, name: c ? (c.first_name + ' ' + (c.last_name ?? '')).trim() : '?', status: 'READY', why: '', live: null }
    plan.push(row)
    const skip = (why) => { row.status = 'SKIPPED'; row.why = why }
    if (!c) { skip('no customer'); continue }
    if (c.company_id !== COMPANY) { skip('customer is company ' + c.company_id); continue }
    if ((c.mac_address ?? '').toUpperCase() !== t.identity.toUpperCase()) { skip('MAC is now ' + c.mac_address); continue }
    if (c.cut_off_date !== 5) { skip('cut-off day is ' + c.cut_off_date); continue }
    const [rows] = await my.execute('SELECT username, value FROM radcheck WHERE username = ? AND attribute = ?', [t.identity, 'Expiration'])
    const exact = rows.filter((r) => r.username === t.identity)
    if (exact.length !== 1) { skip(exact.length + ' Expiration rows'); continue }
    row.live = exact[0].value
    if (row.live !== t.expect) { skip('radcheck moved since 2026-09-29: now ' + row.live); continue }
    if ((parseRadius(row.live)?.getTime() ?? 0) <= target.getTime()) { skip('not later than ' + TARGET); continue }
  }

  console.log('West Central Networks: paid on/after 20 Sep -> ' + TARGET + '   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  for (const p of plan) console.log([p.status, '#' + p.id, p.name, p.identity, p.paid, p.live ?? p.expect, p.status === 'READY' ? TARGET : p.why].join(' | '))
  const ready = plan.filter((p) => p.status === 'READY')
  console.log('\nREADY ' + ready.length + '   SKIPPED ' + (plan.length - ready.length))
  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> to correct the READY rows.')
    await my.end()
    return
  }

  let done = 0
  for (const p of ready) {
    const tag = '#' + p.id + ' ' + p.name + ': '
    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?', [TARGET, p.identity, 'Expiration', p.live])
    if ((res.affectedRows ?? 0) !== 1) { console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.'); continue }
    const { error: logErr } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: p.id, type: 'network_expiry_corrected', correlation_id: RUN_ID,
      details: 'Expiry corrected for ' + p.identity + '. Expiry ' + ymd(parseRadius(p.live)) + ' -> ' + TARGET_YMD +
        '. By ' + actor.email + ' | reason=' + safeValue(REASON) + ' | run=' + RUN_ID,
    })
    if (logErr) console.log(tag + 'radcheck corrected, but the log row failed: ' + logErr.message)
    done += 1
    console.log(tag + p.live + ' -> ' + TARGET)
  }
  console.log('\nCorrected ' + done + ' of ' + ready.length + ' READY row(s). run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
