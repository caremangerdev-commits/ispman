#!/usr/bin/env node
/**
 * ONE-OFF: Paulette McInnis (Ezmze #1023) onto her cut-off day — 15 Oct 2026 at
 * 8:00 AM Jamaica, 13:00 on the RADIUS clock. Owner, 8 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/paulette-mcinnis-to-15-oct.mjs                         dry run (default)
 *   node scripts/paulette-mcinnis-to-15-oct.mjs --apply --user=<users.id>
 *
 * Her cut-off day on record is the 15th; her expiry sat on the 8th from a
 * September Extend. The owner keeps the cut-off day and moves the expiry onto
 * it. Forward a week, so it is logged as an extension.
 *
 * GUARDED: written only if radcheck still holds exactly FROM, the value run
 * 31861823 wrote this morning. Anything else and nothing is written.
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

const COMPANY = 27
const CUSTOMER = 1023
const FROM = '08 Oct 2026 13:00'
const TO = '15 Oct 2026 13:00' // 8:00 AM America/Jamaica (UTC-5, no daylight saving)
const RUN_ID = randomUUID()
const REASON = 'Expiry onto her cut-off day, the 15th (owner, 8 Oct 2026)'

async function main() {
  const { data: c, error: ce } = await db.from('customers')
    .select('id, first_name, last_name, mac_address, pppoe_username, customer_type, cut_off_date')
    .eq('company_id', COMPANY).eq('id', CUSTOMER).maybeSingle()
  if (ce || !c) { console.error('Customer #' + CUSTOMER + ' not found' + (ce ? ': ' + ce.message : '')); process.exit(1) }
  if (c.cut_off_date !== 15) { console.error('Cut-off day is ' + c.cut_off_date + ', not 15. Nothing written.'); process.exit(1) }
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
    type: 'network_extend',
    details:
      'Access extended for ' + rows[0].username + '. Expiry 2026-10-08 -> 2026-10-15. By ' + actor.email +
      ' | reason=' + REASON + ' (was ' + FROM + ', now ' + TO + ' RADIUS clock) | run=' + RUN_ID,
  })
  console.log(logErr ? 'radcheck moved, but the log row failed: ' + logErr.message : 'Moved. Logged. run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
