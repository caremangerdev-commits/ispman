#!/usr/bin/env node
/**
 * ONE-OFF: Ezmze (company 27) customers whose service has ended carry a full
 * month they did not use. Reduce it to the days they actually had.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/recalc-ezmze-lapsed-september.mjs                         dry run (default)
 *   node scripts/recalc-ezmze-lapsed-september.mjs --apply --user=<users.id>
 *
 * A DRY RUN PRINTS EVERY CUSTOMER AND STOPS. --apply needs --user so each log
 * row names a real account. Customers are handled one by one; one that no
 * longer looks as it did is SKIPPED and the rest still go ahead.
 *
 * THE RULE (owner, 7 Oct 2026 — the prepaid model)
 *   Days spent disconnected are free; a customer pays only for days the service
 *   was on. Their one charge is the 3 Sep 2026 bill run's (stamped "August",
 *   last_billed_date 2026-08-31), and it is treated AS SEPTEMBER, as agreed:
 *   paying it would have carried them from September's cut-off to October's.
 *
 *     owed = monthly rate x days of service in September / 30
 *     rounded to the nearest hundred: down below 50, up at 50 and above.
 *
 *   Days of service = 1 Sep to the day their service ended, both counted (the
 *   cut-off day counts as a service day). The day is the DATE WRITTEN in
 *   RADIUS: "08 Sep 2026 00:00" is the 8th, a staff disconnect at
 *   "06 Sep 2026 18:06" is the 6th.
 *
 *   DARWIN NOTICE (#415) IS LEFT OUT ENTIRELY: his RADIUS expiry reads
 *   "00 Dec 1969 19:00", which is not a date. A person has to say when his
 *   service ended.
 *
 * READY ONLY IF, per customer
 *   - company 27, and their service has ended (RADIUS expiry before now, on
 *     the RADIUS server's own clock), in September 2026;
 *   - exactly one Expiration row for their identity;
 *   - their balance is still exactly one month's rate (the one charge), no
 *     credit, never adjusted by hand, never charged by the billing engine, and
 *     no service payment at all.
 *
 * WHAT --apply WRITES, per READY customer
 *   - customers.carried_balance: the month's rate -> what they owe, guarded by
 *     the old value so a change in between is not overwritten.
 *   - one balance_adjusted log row, in the shape Adjust Balance writes, so the
 *     customer page shows the balance as adjusted, with the reason and run id.
 *
 * WHAT IT DOES NOT TOUCH
 *   Expiries, RADIUS, payments, credit, any other customer or company.
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
  console.error('--apply needs --user=<users.id> so the log rows name who adjusted these.')
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
const EXCLUDED = new Map([[415, 'Darwin Notice: RADIUS expiry is corrupt ("00 Dec 1969"); a person must say when his service ended']])
const SEPTEMBER_DAYS = 30
const RUN_ID = randomUUID()
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** Nearest hundred: down below 50, up at 50 and above. Cents first, so float noise cannot tip a .50. */
const round100 = (x) => {
  const cents = Math.round(x * 100)
  return Math.floor((cents + 5000) / 10000) * 100
}
const money = (n) => 'J$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    dateStrings: true, connectTimeout: 8000,
  }).catch((err) => {
    console.error('RADIUS not reachable (' + (err.code ?? err.message) + ') — is the SSH tunnel up? Nothing was read or written.')
    process.exit(1)
  })
  const [[clock]] = await my.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i') AS u")
  const [rc] = await my.query("SELECT username, value FROM radcheck WHERE attribute = 'Expiration'")
  await my.end()
  const np = clock.u.split(/[- :]/).map(Number)
  const NOW = Date.UTC(np[0], np[1] - 1, np[2], np[3], np[4])
  const rowsFor = new Map()
  for (const r of rc) {
    const k = r.username.trim().toUpperCase()
    rowsFor.set(k, [...(rowsFor.get(k) ?? []), r.value])
  }

  const customers = await all(() => db.from('customers')
    .select('id, first_name, last_name, mac_address, pppoe_username, customer_type, monthly_rate, carried_balance, account_credit, last_billed_date')
    .eq('company_id', COMPANY).order('id'))
  const payments = await all(() => db.from('payments').select('customer_id').eq('company_id', COMPANY).neq('payment_kind', 'other'))
  const charges = await all(() => db.from('bill_charges').select('customer_id').eq('company_id', COMPANY))
  const adjusted = await all(() => db.from('log').select('customer_id').eq('company_id', COMPANY).eq('type', 'balance_adjusted'))
  const paid = new Set(payments.map((p) => p.customer_id))
  const charged = new Set(charges.map((c) => c.customer_id))
  const handSet = new Set(adjusted.map((a) => a.customer_id))

  const plan = []
  const flagged = []
  for (const c of customers) {
    const identity = ((c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address) ?? '').trim().toUpperCase()
    const values = rowsFor.get(identity) ?? []
    if (values.length === 0) continue
    const name = (c.first_name + ' ' + (c.last_name ?? '')).trim()

    // Lapsed? Read the first value; a malformed one is lapsed only if it is the excluded case.
    const p = values[0].trim().split(/\s+/)
    const y = Number(p[2]), m = MONTHS.indexOf(String(p[1]).toLowerCase()), d = Number(p[0])
    const [hh, mi] = String(p[3] ?? '00:00').split(':').map(Number)
    const parsed = y > 2000 && m >= 0 && d >= 1 && d <= 31
    const at = parsed ? Date.UTC(y, m, d, hh || 0, mi || 0) : null

    if (EXCLUDED.has(c.id)) { flagged.push({ id: c.id, name, why: EXCLUDED.get(c.id), held: values.join(' | ') }); continue }
    if (!parsed || at > NOW) continue // live, or unreadable and not lapsed by any reading

    const rate = Number(c.monthly_rate)
    const balance = Number(c.carried_balance)
    const row = { id: c.id, name, rate, balance, held: values[0], status: 'READY', why: [] }
    const skip = (why) => { row.status = 'SKIPPED'; row.why.push(why) }

    if (values.length !== 1) skip(values.length + ' Expiration rows')
    if (!(y === 2026 && m === 8)) skip('service ended ' + values[0] + ', not in September 2026')
    if (!(rate > 0)) skip('no monthly rate')
    if (balance !== rate) skip('balance ' + balance + ' is not exactly one month (' + rate + ')')
    if (Number(c.account_credit) !== 0) skip('holds credit ' + c.account_credit)
    if (c.last_billed_date !== '2026-08-31') skip('last billed ' + c.last_billed_date + ', not the 3 Sep run')
    if (paid.has(c.id)) skip('has a service payment')
    if (charged.has(c.id)) skip('was charged by the billing engine')
    if (handSet.has(c.id)) skip('balance was adjusted by hand')

    row.days = d
    row.owed = round100((rate * d) / SEPTEMBER_DAYS)
    row.exact = (rate * d) / SEPTEMBER_DAYS
    plan.push(row)
  }

  const ready = plan.filter((r) => r.status === 'READY')
  console.log('Ezmze lapsed: September charge -> days of service   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  console.log('RADIUS clock (UTC) ' + clock.u + '\n')
  console.log('Status   #      Customer                       Rate  Service ended        Days   Exact      Balance -> Owed     Reduction')
  for (const r of plan) {
    console.log((r.status === 'READY' ? 'READY  ' : 'SKIPPED') + '  ' + ('#' + r.id).padEnd(6) + ' ' + r.name.slice(0, 29).padEnd(30) +
      String(r.rate).padStart(5) + '  ' + r.held.padEnd(19) + String(r.days).padStart(5) + String(r.exact.toFixed(2)).padStart(10) +
      String(r.balance).padStart(10) + ' -> ' + String(r.owed).padEnd(7) + String(r.balance - r.owed).padStart(8) +
      (r.why.length ? '\n         ' + r.why.join('; ') : ''))
  }
  for (const f of flagged) console.log('\nFLAGGED  #' + f.id + ' ' + f.name + ' — LEFT OUT. ' + f.why + '. RADIUS: ' + f.held)

  const before = ready.reduce((a, r) => a + r.balance, 0)
  const after = ready.reduce((a, r) => a + r.owed, 0)
  console.log('\nREADY ' + ready.length + ' of ' + plan.length + '.  Balances ' + money(before) + ' -> ' + money(after) +
    '  (reduced by ' + money(before - after) + ').  Expiries untouched.')

  if (!APPLY) {
    console.log('Dry run: nothing was written. Re-run with --apply --user=<users.id>.')
    return
  }

  const { data: actor } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
  if (!actor) { console.error('No users row ' + USER_ID); process.exit(1) }

  let done = 0
  for (const r of ready) {
    const { data: upd, error } = await db.from('customers')
      .update({ carried_balance: r.owed })
      .eq('id', r.id).eq('company_id', COMPANY).eq('carried_balance', r.balance)
      .select('id')
    if (error || !upd || upd.length !== 1) {
      console.log('#' + r.id + ' ' + r.name + ': not updated (' + (error?.message ?? 'balance changed in between') + ')')
      continue
    }
    const { error: le } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: r.id, correlation_id: RUN_ID,
      type: 'balance_adjusted',
      details:
        'Carried balance adjusted for ' + r.name +
        ' | old=' + money(r.balance) + ' | new=' + money(r.owed) +
        ' | by=' + actor.email +
        ' | reason=Prepaid model: September charged for the ' + r.days + ' day(s) of service (1-' + r.days +
        ' Sep), not the full month; days disconnected are free' +
        ' | run=' + RUN_ID,
    })
    if (le) console.log('#' + r.id + ': balance updated, log row failed: ' + le.message)
    done += 1
  }
  console.log('\nAdjusted ' + done + ' of ' + ready.length + '. run=' + RUN_ID)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
