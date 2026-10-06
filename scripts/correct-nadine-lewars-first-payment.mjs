#!/usr/bin/env node
/**
 * ONE-OFF: Ezmze (company 27), Nadine Lewars #1403, payment #15926.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/correct-nadine-lewars-first-payment.mjs                       dry run (default)
 *   node scripts/correct-nadine-lewars-first-payment.mjs --apply --user=<users.id>
 *
 * A DRY RUN PRINTS EVERY CHANGE AND STOPS. Nothing is written without --apply,
 * and --apply needs --user so the log row names a real account.
 *
 * WHAT WENT WRONG
 *   Connected 4 Sep, first expiry 8 Oct (cut-off 8). The billing engine went
 *   live on 1 Oct and charged her J$3,500 for October before she had paid
 *   anything. On 6 Oct she paid J$3,500 (Full Period chosen at the till) against
 *   J$7,466.67 due: the engine's J$3,500 plus her first period, J$3,966.67
 *   (34 days). The first-payment rule then counted only money beyond the whole
 *   amount due, so the payment bought 0 months and she stayed at 8 Oct.
 *   Fixed in code, cd36c49 (lib/billing.ts#firstPaymentMonths): settling a
 *   carried balance on a first payment counts as a month, as on any other
 *   payment.
 *
 * WHAT THE FIXED CODE WOULD HAVE WRITTEN, and this writes
 *   - months_paid 0 -> 1 on payment #15926
 *   - access_granted_until and service_active_until 8 Oct -> 8 Nov
 *   - radcheck Expiration 8 Oct -> 8 Nov, at Ezmze's expiry time (08:00 in
 *     America/Jamaica = 13:00 on the UTC RADIUS clock — the same conversion as
 *     lib/radius/format.ts#applyExpiryClock), guarded by the value it replaces
 *   - one network_extend log row naming the payment, the reason and the run
 *
 * WHAT IT DOES NOT CHANGE
 *   The money. Her balance stays J$3,966.67 — the fixed code leaves exactly
 *   that too (J$7,466.67 due less J$3,500 paid). The payment's amount, due,
 *   before/after balances, decision and bill period are untouched.
 *
 * IT REFUSES unless everything is still as found on 6 Oct: the payment unchanged,
 * no later service payment, the balance unchanged, and radcheck holding exactly
 * one Expiration row for her MAC, dated 8 Oct 2026.
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
  console.error('--apply needs --user=<users.id> so the log row names who corrected this.')
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
const CUSTOMER = 1403
const PAYMENT = 15926
const MAC = '68:97:10:2C:AD:8F'
const FROM_YMD = '2026-10-08'
const TO_YMD = '2026-11-08'
const RUN_ID = randomUUID()
const REASON =
  'First payment #' + PAYMENT + ' settled the engine\'s October charge but bought no month (fixed cd36c49); ' +
  'extended to the month it paid for'

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

/** "08 Nov 2026 13:00": YYYY-MM-DD at the company's local time, on the UTC RADIUS clock. */
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

const problems = []
const check = (ok, message) => { if (!ok) problems.push(message) }

async function main() {
  const { data: settings, error: se } = await db.from('settings')
    .select('expiry_time, timezone').eq('company_id', COMPANY).single()
  if (se) throw new Error('settings: ' + se.message)
  const target = radiusText(TO_YMD, settings.expiry_time, settings.timezone)

  const { data: c } = await db.from('customers')
    .select('id, company_id, first_name, last_name, mac_address, carried_balance, account_credit, cut_off_date')
    .eq('id', CUSTOMER).single()
  const { data: p } = await db.from('payments').select('*').eq('id', PAYMENT).single()
  const { data: later } = await db.from('payments').select('id, created_at, amount')
    .eq('customer_id', CUSTOMER).neq('payment_kind', 'other').gt('created_at', p.created_at)

  check(c.company_id === COMPANY, 'customer is not in company 27')
  check(c.mac_address === MAC, 'MAC is now ' + c.mac_address)
  check(c.cut_off_date === 8, 'cut-off day is now ' + c.cut_off_date)
  check(Number(c.carried_balance) === 3966.67, 'balance is now ' + c.carried_balance + ', not 3966.67')
  check(p.customer_id === CUSTOMER, 'payment belongs to customer ' + p.customer_id)
  check(Number(p.amount) === 3500, 'payment amount is now ' + p.amount)
  check(Number(p.months_paid) === 0, 'payment months_paid is already ' + p.months_paid)
  check(p.access_granted_until === FROM_YMD, 'access_granted_until is now ' + p.access_granted_until)
  check(Number(p.amount_due) === 7466.67, 'amount_due is now ' + p.amount_due)
  check(Number(p.carried_balance_before) === 3500, 'carried_balance_before is now ' + p.carried_balance_before)
  check((later ?? []).length === 0, 'a later service payment exists: ' + JSON.stringify(later))

  // radcheck — reached through the SSH tunnel on 127.0.0.1:3306.
  let held = null
  let radiusError = null
  let my = null
  try {
    my = await mysql.createConnection({
      host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
      database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
    })
    const [rows] = await my.execute(
      'SELECT username, value FROM radcheck WHERE UPPER(TRIM(username)) = ? AND attribute = ?', [MAC, 'Expiration'])
    check(rows.length === 1, rows.length + ' Expiration rows for ' + MAC)
    if (rows.length === 1) {
      held = rows[0]
      check(held.username === MAC, 'radcheck spells the MAC "' + held.username + '"')
      check(held.value.startsWith('08 Oct 2026'), 'radcheck now holds ' + held.value + ', not 8 Oct 2026')
    }
  } catch (err) {
    radiusError = err.code ?? err.message
    problems.push('radcheck could not be read (' + radiusError + ') — is the SSH tunnel to the RADIUS box up?')
  }

  console.log('Nadine Lewars #' + CUSTOMER + ' — correct first payment #' + PAYMENT + '   run=' + RUN_ID +
    (APPLY ? '   APPLY' : '   DRY RUN') + '\n')
  console.log('payment #' + PAYMENT + ' (J$' + p.amount + ' on ' + p.paid_on + ', due J$' + p.amount_due + ', ' + p.access_decision + ')')
  console.log('  months_paid            ' + p.months_paid + ' -> 1')
  console.log('  access_granted_until   ' + p.access_granted_until + ' -> ' + TO_YMD)
  console.log('  service_active_until   ' + p.service_active_until + ' -> ' + TO_YMD)
  console.log('radcheck Expiration ' + MAC)
  console.log('  ' + (held ? held.value : '(not read)') + ' -> ' + target +
    '   (8 Nov, ' + settings.expiry_time + ' ' + settings.timezone + ')')
  console.log('log: one network_extend row on the customer, reason + run id')
  console.log('unchanged: balance J$' + c.carried_balance + ' still owed, credit J$' + c.account_credit +
    ', the payment\'s amount, due, balances, decision and bill period')

  if (problems.length) {
    console.log('\nREFUSING' + (APPLY ? '' : ' (would refuse to apply)') + ':')
    for (const m of problems) console.log('  - ' + m)
    if (my) await my.end()
    if (APPLY) process.exit(1)
    return
  }

  if (!APPLY) {
    console.log('\nAll checks pass. Dry run: nothing was written. Re-run with --apply --user=<users.id>.')
    await my.end()
    return
  }

  const { data: actor } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
  if (!actor) { console.error('No users row ' + USER_ID); await my.end(); process.exit(1) }

  // radcheck first, guarded by the value it replaces: if the network write does
  // not land, the payment row must not claim access it does not grant.
  const [res] = await my.execute(
    'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
    [target, held.username, 'Expiration', held.value])
  await my.end()
  if ((res.affectedRows ?? 0) !== 1) {
    console.log('radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; nothing else written.')
    process.exit(1)
  }

  const { error: pe } = await db.from('payments')
    .update({ months_paid: 1, access_granted_until: TO_YMD, service_active_until: TO_YMD })
    .eq('id', PAYMENT).eq('company_id', COMPANY).eq('months_paid', 0)
  if (pe) console.log('radcheck moved, but the payment update failed: ' + pe.message)

  const { error: le } = await db.from('log').insert({
    company_id: COMPANY, user_id: actor.id, customer_id: CUSTOMER,
    type: 'network_extend', correlation_id: RUN_ID,
    details:
      'Access extended for ' + MAC + '. Expiry ' + FROM_YMD + ' -> ' + TO_YMD +
      '. By ' + actor.email + ' | reason=' + REASON + ' | run=' + RUN_ID,
  })
  if (le) console.log('radcheck and payment updated, but the log row failed: ' + le.message)

  console.log('\nDone: ' + held.value + ' -> ' + target + ', payment #' + PAYMENT + ' months_paid 1. run=' + RUN_ID)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
