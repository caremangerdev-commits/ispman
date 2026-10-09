#!/usr/bin/env node
/**
 * ONE-OFF: four customers holding a month from a DELETED payment — put back
 * to the expiry their surviving payments bought. Owner, 9 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/correct-deleted-payment-months.mjs                        dry run (default)
 *   node scripts/correct-deleted-payment-months.mjs --apply --user=<users.id>
 *
 * WHY. Deleting a payment restored the balance but left the expiry where the
 * payment had moved it; a payment re-entered after that counted forward from
 * it. Found by the read-only check of all 35 deleted payments, 9 Oct 2026.
 *
 * NAMED, NOT DERIVED: each customer, the exact Expiration they hold now, and
 * the one it moves to. A row that no longer reads exactly FROM is SKIPPED and
 * the rest still go ahead. EXPIRY ONLY: no balance, credit or payment is
 * touched — Orrett Daley's balance and credit need a person (owner).
 *
 * LEFT OUT on the owner's instruction: Jayden Pryce #5780 (as he is for now),
 * Marcia Brown #4964 (needs Smartcomm Networking to say what she paid).
 *
 * WHAT --apply WRITES, per READY row: one guarded UPDATE of the Expiration
 * value, and one network_expiry_corrected log row; correlation_id = run id.
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

const RUN_ID = randomUUID()
const NAMED = [
  {
    company: 26, id: 1934, from: '05 Dec 2026 13:00', to: '05 Nov 2026 13:00',
    why: 'deleted payment #15078 left 5 Oct -> 5 Nov on the expiry; the re-entered payment #15079 counted forward from it, 5 Nov -> 5 Dec. One payment, one month',
  },
  {
    company: 31, id: 3328, from: '01 Dec 2026 13:00', to: '01 Nov 2026 13:00',
    why: 'deleted payment #15815 left 1 Oct -> 5 Nov on the expiry; payment #15816 counted forward from it, 5 Nov -> 1 Dec. One payment, one month. Expiry only: balance and credit left for a person (owner)',
  },
  {
    company: 33, id: 5085, from: '10 Nov 2026 13:00', to: '10 Oct 2026 13:00',
    why: 'deleted payment #13538 left 12 Sep -> 10 Oct on the expiry; payment #13539 counted forward from it, 10 Oct -> 10 Nov. One payment, to 10 Oct',
  },
  {
    company: 31, id: 2154, from: '01 Dec 2026 13:00', to: '01 Nov 2026 13:00',
    why: 'deleted payment #15004 left 1 Nov -> 1 Dec on the expiry and was never re-entered; payment #14830 bought to 1 Nov',
  },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ymdOf = (value) => {
  const [d, mon, y] = value.split(' ')
  return y + '-' + String(MONTHS.indexOf(mon) + 1).padStart(2, '0') + '-' + d
}

async function main() {
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

  console.log('Deleted-payment months: put back   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN') + '\n')
  let ready = 0
  let done = 0
  for (const n of NAMED) {
    const { data: c } = await db.from('customers')
      .select('id, first_name, last_name, mac_address, pppoe_username, customer_type, carried_balance, account_credit')
      .eq('company_id', n.company).eq('id', n.id).maybeSingle()
    const name = c ? ((c.first_name ?? '') + ' ' + (c.last_name ?? '')).trim() : '?'
    const tag = 'co ' + n.company + '  #' + n.id + ' ' + name.padEnd(26)
    if (!c) { console.log('SKIPPED ' + tag + ' not found in that company'); continue }
    const identity = ((c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address) ?? '').trim()
    const [rows] = await my.execute(
      'SELECT username, value FROM radcheck WHERE TRIM(username) = ? AND attribute = ?', [identity, 'Expiration'])
    if (rows.length !== 1 || rows[0].value !== n.from) {
      console.log('SKIPPED ' + tag + ' holds ' + JSON.stringify(rows.map((r) => r.value)) + ', expected exactly "' + n.from + '"')
      continue
    }
    ready += 1
    console.log('READY   ' + tag + n.from + '  ->  ' + n.to + '   (balance ' + c.carried_balance + ', credit ' + c.account_credit + ', untouched)')
    if (!APPLY) continue

    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [n.to, rows[0].username, 'Expiration', n.from])
    if ((res.affectedRows ?? 0) !== 1) {
      console.log('        radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
      continue
    }
    const { error: logErr } = await db.from('log').insert({
      company_id: n.company, user_id: actor.id, customer_id: n.id, correlation_id: RUN_ID,
      type: 'network_expiry_corrected',
      details:
        'Expiry corrected for ' + rows[0].username + '. Expiry ' + ymdOf(n.from) + ' -> ' + ymdOf(n.to) +
        '. By ' + actor.email + ' | reason=' + n.why + ' (was ' + n.from + ', now ' + n.to + ' RADIUS clock) | run=' + RUN_ID,
    })
    console.log(logErr ? '        moved, but the log row failed: ' + logErr.message : '        moved, logged')
    done += 1
  }
  await my.end()
  console.log('\nREADY ' + ready + ' of ' + NAMED.length + '.' + (APPLY ? ' Moved ' + done + '. run=' + RUN_ID : ' Dry run: nothing was written.'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
