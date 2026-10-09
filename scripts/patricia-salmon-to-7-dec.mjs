#!/usr/bin/env node
/**
 * ONE-OFF: Patricia Salmon (West Central #1949) back to 7 Dec 2026 at
 * 8:00 AM Jamaica, 13:00 on the RADIUS clock. Owner, 9 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/patricia-salmon-to-7-dec.mjs                         dry run (default)
 *   node scripts/patricia-salmon-to-7-dec.mjs --apply --user=<users.id>
 *
 * She paid one month. Payment #15632 was typed as J$35,000 and bought six
 * months, 7 Nov 2026 -> 7 May 2027; the amount was corrected to J$3,500 on
 * 6 Oct, which did not touch the expiry. One month from 7 Nov is 7 Dec.
 * EXPIRY ONLY: her J$3,500 balance is West Central's to collect (owner).
 *
 * GUARDED: written only if radcheck still holds exactly FROM, the value
 * payment #15632 wrote. Anything else and nothing is written.
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

const COMPANY = 26
const CUSTOMER = 1949
const FROM = '07 May 2027 13:00'
const TO = '07 Dec 2026 13:00' // 8:00 AM America/Jamaica (UTC-5, no daylight saving)
const RUN_ID = randomUUID()
const REASON = 'Paid one month; payment #15632 was typed as J$35,000 and bought six months, then corrected to J$3,500 without the expiry following (owner, 9 Oct 2026). Balance left for West Central to collect'

async function main() {
  const { data: c, error: ce } = await db.from('customers')
    .select('id, first_name, last_name, mac_address, pppoe_username, customer_type, cut_off_date')
    .eq('company_id', COMPANY).eq('id', CUSTOMER).maybeSingle()
  if (ce || !c) { console.error('Customer #' + CUSTOMER + ' not found' + (ce ? ': ' + ce.message : '')); process.exit(1) }
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
      'Expiry corrected for ' + rows[0].username + '. Expiry 2027-05-07 -> 2026-12-07. By ' + actor.email +
      ' | reason=' + REASON + ' (was ' + FROM + ', now ' + TO + ' RADIUS clock) | run=' + RUN_ID,
  })
  console.log(logErr ? 'radcheck moved, but the log row failed: ' + logErr.message : 'Moved. Logged. run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
