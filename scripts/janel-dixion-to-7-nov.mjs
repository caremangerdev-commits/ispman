#!/usr/bin/env node
/**
 * ONE-OFF: Janel Dixion (JMEDIA #5740) back to 7 Nov 2026 at
 * 8:00 AM Jamaica, 13:00 on the RADIUS clock. Owner, 8 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/janel-dixion-to-7-nov.mjs                         dry run (default)
 *   node scripts/janel-dixion-to-7-nov.mjs --apply --user=<users.id>
 *
 * She paid October only: J$3,500 on 8 Oct (payment #16491) moved her 10 Oct
 * -> 7 Nov; that payment was deleted a minute later, which restored her
 * balance but left the expiry at 7 Nov; the same J$3,500 re-entered (#16493)
 * then counted forward from it, 7 Nov -> 7 Dec. One month's money, two
 * months' access. Back a month, so it is logged as a correction.
 *
 * GUARDED: written only if radcheck still holds exactly FROM, the value
 * payment #16493 wrote. Anything else and nothing is written.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'

const APPLY = process.argv.includes('--apply')
const userArg = process.argv.find((x) => x.startsWith('--user='))
const USER_ID = userArg ? Number(userArg.slice('--user='.length)) : null
if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log row names who moved this.')
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

const COMPANY = 30
const CUSTOMER = 5740
const FROM = '07 Dec 2026 13:00'
const TO = '07 Nov 2026 13:00' // 8:00 AM America/Jamaica (UTC-5, no daylight saving)
const RUN_ID = randomUUID()
const REASON = 'Paid October only; a deleted payment (#16491) left its month on the expiry and the re-entered payment (#16493) counted forward from it (owner, 9 Oct 2026)'

async function main() {
  const { data: c, error: ce } = await db.from('customers')
    .select('id, first_name, last_name, mac_address, pppoe_username, customer_type, cut_off_date')
    .eq('company_id', COMPANY).eq('id', CUSTOMER).maybeSingle()
  if (ce || !c) { console.error('Customer #' + CUSTOMER + ' not found' + (ce ? ': ' + ce.message : '')); process.exit(1) }
  if (c.cut_off_date !== 7) { console.error('Cut-off day is ' + c.cut_off_date + ', not 7. Nothing written.'); process.exit(1) }
  const identity = ((c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address) ?? '').trim()

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

  const [rows] = await my.execute(
    'SELECT username, value FROM radcheck WHERE TRIM(username) = ? AND attribute = ?', [identity, 'Expiration'])
  const name = (c.first_name + ' ' + (c.last_name ?? '')).trim()
  console.log('#' + CUSTOMER + ' ' + name + '  ' + identity + '  cut-off ' + c.cut_off_date + '   run=' + RUN_ID +
    (APPLY ? '   APPLY' : '   DRY RUN'))
  if (rows.length !== 1 || rows[0].value !== FROM) {
    console.log('SKIPPED: radcheck holds ' + JSON.stringify(rows.map((r) => r.value)) + ', expected exactly "' + FROM + '". Nothing written.')
    await my.end()
    return
  }
  console.log('READY   ' + FROM + '  ->  ' + TO)

  if (!APPLY) {
    console.log('Dry run: nothing was written. Re-run with --apply --user=<users.id>.')
    await my.end()
    return
  }

  const [res] = await my.execute(
    'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
    [TO, rows[0].username, 'Expiration', FROM])
  if ((res.affectedRows ?? 0) !== 1) {
    console.log('radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
    await my.end()
    return
  }
  const { error: logErr } = await db.from('log').insert({
    company_id: COMPANY, user_id: actor.id, customer_id: CUSTOMER, correlation_id: RUN_ID,
    type: 'network_expiry_corrected',
    details:
      'Expiry corrected for ' + rows[0].username + '. Expiry 2026-12-07 -> 2026-11-07. By ' + actor.email +
      ' | reason=' + REASON + ' (was ' + FROM + ', now ' + TO + ' RADIUS clock) | run=' + RUN_ID,
  })
  console.log(logErr ? 'radcheck moved, but the log row failed: ' + logErr.message : 'Moved. Logged. run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
