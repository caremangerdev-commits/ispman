#!/usr/bin/env node
/**
 * ONE-OFF: clear payments.billing_period_start/end on payments that settled no
 * billed month.
 *
 *   node scripts/clear-prepayment-bill-periods.mjs                       dry run (default)
 *   node scripts/clear-prepayment-bill-periods.mjs --apply --expect=64   the one UPDATE
 *
 * A DRY RUN PRINTS EVERY ROW AND STOPS. Nothing is written without --apply, and
 * --apply refuses unless --expect matches the number of rows it finds: what is
 * cleared is the set somebody looked at, not whatever matches a minute later.
 *
 * WHAT WENT WRONG
 *   Until fc24272 recordPayment stamped a bill period on EVERY payment, derived
 *   from the payment date and the customer's bill day alone (lib/billing.ts
 *   #settledMonthStart). Nothing asked whether a bill was being paid. A
 *   customer with nothing on their carried balance is prepaying for time ahead
 *   — no bill run's charge is being cleared — and was stamped a month anyway:
 *   with a bill day of the 20th, a payment on 19 September reads July.
 *
 *   Nothing reads these columns yet. Bills will, and a bill naming a month the
 *   customer was never billed for is worse than one naming none.
 *
 * THE RULE, the same one the code now applies going forward
 *   A payment has a bill period only if carried_balance_before > 0 — which is
 *   lib/billing.ts#settledMonths, the test that decides whether the money buys
 *   a renewal month. Where it was zero (or, impossibly, negative) the period is
 *   cleared to NULL. A first-period payment (migration 0017) has nothing
 *   carried either; its charge was never raised by a bill run, so it is
 *   cleared for the same reason and is marked in the listing.
 *
 * WHAT IT DOES NOT TOUCH
 *   Rows with a positive carried_balance_before: their month is the design
 *   working. Rows whose carried_balance_before is NULL: migrated and pre-0011
 *   payments where nothing is known about what was owed — listed as a count,
 *   never written. Amounts, balances, credit, expiries, radcheck, the log.
 *
 * REVERSIBLE. --apply first writes every row's old period to
 * supabase/repairs/2026-09-19_cleared_bill_periods.json (payment id, company
 * id and the two dates — no names, no money), and refuses to write if that
 * file cannot be saved. Re-running after --apply finds nothing and says so.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const expectArg = process.argv.find((a) => a.startsWith('--expect='))
const EXPECT = expectArg ? Number(expectArg.slice('--expect='.length)) : null
const BACKUP = 'supabase/repairs/2026-09-19_cleared_bill_periods.json'

// --- environment --------------------------------------------------------------

// Split, not matched: no regex needed to read KEY=value.
function loadEnv(file = '.env.local') {
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    const i = line.indexOf('=')
    if (i <= 0 || line.startsWith('#')) continue
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
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

async function all(build) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

// --- read ---------------------------------------------------------------------

const companies = new Map(
  (await all(() => db.from('companies').select('id, name').order('id'))).map((c) => [c.id, c.name])
)

// The target: a period stamped, and nothing carried when the payment was taken.
const target = () => db.from('payments')
  .select(
    'id, company_id, customer_id, amount, paid_on, created_at, billing_period_start, billing_period_end, ' +
    'carried_balance_before, carried_balance_after, amount_due, first_period_discount, credit_applied'
  )
  .not('billing_period_start', 'is', null)
  .lte('carried_balance_before', 0)
  .order('company_id').order('id')

const rows = await all(target)

const unknown = await db.from('payments').select('id', { count: 'exact', head: true })
  .not('billing_period_start', 'is', null).is('carried_balance_before', null)
const kept = await db.from('payments').select('id', { count: 'exact', head: true })
  .not('billing_period_start', 'is', null).gt('carried_balance_before', 0)

const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))]
const customers = new Map()
for (let i = 0; i < customerIds.length; i += 200) {
  const { data, error } = await db.from('customers')
    .select('id, first_name, last_name, bill_date').in('id', customerIds.slice(i, i + 200))
  if (error) throw new Error(error.message)
  for (const c of data) customers.set(c.id, c)
}

// --- print --------------------------------------------------------------------

const n = (v) => (v == null ? null : Number(v))
const money = (v) => (v == null ? '-' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2 }))

console.log('PAYMENTS WITH A BILL PERIOD STAMPED AND NOTHING CARRIED\n')
let company = null
const perCompany = new Map()
for (const r of rows) {
  if (r.company_id !== company) {
    company = r.company_id
    console.log('\n' + company + '  ' + (companies.get(company) ?? '?'))
    console.log('  ' + 'payment'.padEnd(8) + 'paid on'.padEnd(12) + 'amount'.padStart(11) + '  ' +
      'carried before'.padStart(14) + '  ' + 'stamped period'.padEnd(24) + 'bill day'.padEnd(9) + 'kind         customer')
  }
  perCompany.set(company, (perCompany.get(company) ?? 0) + 1)
  const c = customers.get(r.customer_id)
  const who = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '(customer gone)'
  // amount_due is what the till asked for. With nothing carried it can only be
  // positive for a first period, whose charge never came from a bill run.
  const kind = n(r.amount_due) > 0 ? 'first period' : 'prepayment'
  console.log('  ' +
    String(r.id).padEnd(8) +
    String(r.paid_on ?? String(r.created_at).slice(0, 10)).padEnd(12) +
    money(r.amount).padStart(11) + '  ' +
    money(r.carried_balance_before).padStart(14) + '  ' +
    (r.billing_period_start + ' to ' + String(r.billing_period_end).slice(5)).padEnd(24) +
    String(c?.bill_date ?? '-').padEnd(9) +
    kind.padEnd(13) + '#' + r.customer_id + ' ' + who)
}

console.log('\n' + '-'.repeat(100))
for (const [id, count] of perCompany) console.log('  ' + String(id).padEnd(4) + (companies.get(id) ?? '?').padEnd(36) + count)
console.log('  TO CLEAR: ' + rows.length)
console.log('  left alone, carried balance > 0 (the month is the design working): ' + kept.count)
console.log('  left alone, carried balance unknown (NULL):                        ' + unknown.count)

// --- write --------------------------------------------------------------------

if (!APPLY) {
  console.log('\nDRY RUN. Nothing was written. To write exactly these rows:')
  console.log('  node scripts/clear-prepayment-bill-periods.mjs --apply --expect=' + rows.length)
  process.exit(0)
}

console.log('\n' + '='.repeat(100) + '\nAPPLY\n' + '='.repeat(100))
const refuse = (why) => { console.error('REFUSED, nothing written: ' + why); process.exit(1) }

if (rows.length === 0) {
  console.log('No payment carries a period with nothing carried. Already applied; nothing to do.')
  process.exit(0)
}
if (EXPECT === null || !Number.isInteger(EXPECT)) refuse('--apply needs --expect=<the number the dry run printed>')
if (rows.length !== EXPECT) refuse('the dry run you read had ' + EXPECT + ' rows; there are ' + rows.length + ' now. Run it again and read them.')
if (rows.some((r) => n(r.carried_balance_before) > 0)) refuse('a row with a positive carried balance is in the set')

// The old values, saved BEFORE the write. Appended to, never overwritten, so a
// second run for stragglers keeps the first run's record.
const previous = existsSync(BACKUP) ? JSON.parse(readFileSync(BACKUP, 'utf8')) : []
const record = previous.concat(rows.map((r) => ({
  payment_id: r.id, company_id: r.company_id,
  billing_period_start: r.billing_period_start, billing_period_end: r.billing_period_end,
  cleared_at: new Date().toISOString(),
})))
try {
  writeFileSync(BACKUP, JSON.stringify(record, null, 1) + '\n')
} catch (err) {
  refuse('could not save the old values to ' + BACKUP + ': ' + err.message)
}
console.log('Old values saved to ' + BACKUP + ' (' + rows.length + ' rows, ' + record.length + ' in the file).')

// By id AND by the condition: a row that stopped matching between the read and
// the write is left alone rather than cleared on the strength of a stale list.
const ids = rows.map((r) => r.id)
let matched = 0
for (let i = 0; i < ids.length; i += 200) {
  const { error, count } = await db.from('payments')
    .update({ billing_period_start: null, billing_period_end: null }, { count: 'exact' })
    .in('id', ids.slice(i, i + 200))
    .not('billing_period_start', 'is', null)
    .lte('carried_balance_before', 0)
  if (error) { console.error('UPDATE FAILED after ' + matched + ' rows: ' + error.message); process.exit(1) }
  matched += count ?? 0
}
console.log('UPDATE matched ' + matched + ' rows (expected ' + rows.length + ').')

const left = await db.from('payments').select('id', { count: 'exact', head: true })
  .not('billing_period_start', 'is', null).lte('carried_balance_before', 0)
const keptNow = await db.from('payments').select('id', { count: 'exact', head: true })
  .not('billing_period_start', 'is', null).gt('carried_balance_before', 0)
console.log('VERIFY: still stamped with nothing carried: ' + left.count + ' (expect 0). ' +
  'Stamped with a balance, untouched: ' + keptNow.count + ' (expect ' + kept.count + ').')

if (matched !== rows.length || left.count !== 0 || keptNow.count !== kept.count) {
  console.error('THE COUNTS DO NOT AGREE. Read them before doing anything else.')
  process.exit(1)
}
console.log('Done.')
