#!/usr/bin/env node
/**
 * ONE-OFF: Ezmze (company 27), last_billed_date 2026-09-30 -> 2026-08-31.
 *
 * KEPT AS THE PROOF, not only as the tool. It re-derives every row's answer
 * from payments and the log, never from the stamp, so it can be re-run after
 * the correction and still show why each row reads what it reads.
 *
 *   node scripts/correct-last-billed-date-ezmze.mjs            dry run (default)
 *   node scripts/correct-last-billed-date-ezmze.mjs --apply    the one UPDATE
 *
 * A DRY RUN PRINTS EVERY ROW AND STOPS. Nothing is written without --apply.
 *
 * WHAT WENT WRONG
 *   The only bill run (log #313, 3 Sep 2026 13:03Z) billed AUGUST 2026 and
 *   stamped 2026-08-31. The payment path then overwrote that stamp with the
 *   payment date on 71 customers who paid on 3 Sep (fixed in ea0719c). The
 *   hand repair for those 71 — supabase/repairs/2026-09-04_last_billed_date_
 *   collision.sql — was run on 4 Sep with the wrong value and without its date
 *   predicate: it wrote 2026-09-30 onto all 952 customers the company then had.
 *
 *   2026-09-30 is wrong in both directions. app/actions/bulk.ts#billedInPeriod
 *   reads it as "already billed for September", so a September run skips all
 *   952 and a month goes unbilled. And because it lies AFTER August, it passes
 *   billBatch's `last_billed_date.gt.<period end>` guard, so a second August
 *   run would bill all 952 again.
 *
 * THE PROOF, per row
 *   Every customer row is created with carried_balance = 0 — app/actions/
 *   customers.ts and app/actions/import.ts both write 0. In the code as it
 *   stood on 3 Sep the only writers of that column were the bill run, which
 *   adds monthly_rate, and recordPayment. So the balance standing after the run
 *   and BEFORE THE CUSTOMER'S FIRST PAYMENT is the run's charge and nothing
 *   else. It is read from the first thing that touched the row afterwards:
 *     - payments.carried_balance_before on the customer's earliest payment, or
 *     - old= on their earliest balance_adjusted log row, or
 *     - customers.carried_balance today, when nothing has touched the row.
 *
 *   ONLY THE FIRST EVENT IS EVIDENCE, and that is not caution for its own sake.
 *   The 3 Sep recordPayment could RAISE a balance: a short payment wrote
 *   carried_balance = rate - paid whatever was owed (lib/billing.ts
 *   #carriedBalanceAfter at b69741f), so J$1,000 on a clear account left
 *   J$5,000 "owing" — customer 1239, payment #653. A balance read after any
 *   payment therefore proves nothing about the run. The first event's `before`
 *   is safe because no payment can precede it.
 *
 *   BILLED    that balance equals the monthly rate (the rate at the run, where
 *             a customer_updated row records a later change).
 *   BILLED*   a positive charge stood on the zero-opened account, but it is not
 *             today's rate and no log explains why. Only the run could have put
 *             it there; the rate was edited since without an audit row. Listed
 *             apart so a reader can overrule.
 *   UNPLACED  anything else. --apply REFUSES if there is even one.
 *
 *   The repair's intended 71 are identified independently: the distinct
 *   customers holding a payment dated 2026-09-03 recorded before ea0719c.
 *
 * WHAT --apply WRITES
 *   One UPDATE: last_billed_date = 2026-08-31 where company_id = 27 and
 *   last_billed_date = 2026-09-30. It refuses unless every such row is proven
 *   above AND there are exactly 952 of them, and it checks the count the
 *   database reports back. Re-running is a no-op: the WHERE no longer matches.
 *
 * WHAT IT DOES NOT TOUCH
 *   Balances, credit, payments, radcheck, the log. Rows with a NULL stamp (the
 *   customers created after the run, never billed) are left NULL.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')

const COMPANY = 27
const WRONG = '2026-09-30'
const RIGHT = '2026-08-31'
const EXPECTED = 952
const RESIDUE_DATE = '2026-09-03'            // the repair file's predicate
const FIX_COMMIT = '2026-09-04T11:31:06'     // ea0719c, 06:31 -05:00, in UTC

// --- environment --------------------------------------------------------------

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

// `| name=value` fields of a log.details string, SPLIT rather than matched. The
// format's one regex lives in lib/log-detail.ts, which a .mjs cannot import;
// splitting on the separator needs no second copy of it.
function fields(details) {
  const out = {}
  for (const part of String(details ?? '').split(' | ').slice(1)) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return out
}
const money = (s) => (s == null ? null : Number(String(s).replace(/[^0-9.-]/g, '')))
const name = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + c.id

// --- read ---------------------------------------------------------------------

const { data: runs, error: runsError } = await db.from('log').select('id, created_at, details')
  .eq('company_id', COMPANY).eq('type', 'bulk_bill').order('created_at')
if (runsError) throw new Error(runsError.message)
if (runs.length !== 1) {
  console.error('Expected exactly one bulk_bill row for company ' + COMPANY + ', found ' + runs.length +
    '. The proof below assumes a single August run; it needs rethinking before anything is written.')
  process.exit(1)
}

const customers = await all(() => db.from('customers').select('*').eq('company_id', COMPANY).order('id'))
const pays = await all(() => db.from('payments').select('*').eq('company_id', COMPANY).order('created_at'))
const logs = await all(() =>
  db.from('log').select('id, customer_id, type, details, created_at').eq('company_id', COMPANY)
    .in('type', ['balance_adjusted', 'payment_deleted', 'payment_updated', 'customer_updated'])
    .order('created_at'))

console.log((APPLY ? 'APPLY' : 'DRY RUN') + ' - company ' + COMPANY)
console.log('\nBILL RUNS ON RECORD: ' + runs.length)
for (const r of runs) console.log('  log #' + r.id + ' ' + r.created_at + '\n  ' + r.details)
const RUN_AT = runs[0].created_at

// The cohort is every row carrying either stamp, so the proof still prints
// after the correction has been applied.
const cohort = customers.filter((c) => c.last_billed_date === WRONG || c.last_billed_date === RIGHT)
const others = customers.filter((c) => !cohort.includes(c))
console.log('\nCustomers: ' + customers.length +
  '. Stamped ' + WRONG + ': ' + cohort.filter((c) => c.last_billed_date === WRONG).length +
  '. Stamped ' + RIGHT + ': ' + cohort.filter((c) => c.last_billed_date === RIGHT).length +
  '. Other: ' + others.length + ' (' +
  [...new Set(others.map((c) => String(c.last_billed_date)))].join(', ') + ')')
console.log('Stamped rows created AFTER the run: ' + cohort.filter((c) => c.created_at > RUN_AT).length)
console.log('Unstamped rows created BEFORE the run: ' + others.filter((c) => c.created_at <= RUN_AT).length)

// --- ledger -------------------------------------------------------------------

const eventsBy = new Map()
const push = (id, e) => { if (!eventsBy.has(id)) eventsBy.set(id, []); eventsBy.get(id).push(e) }
for (const p of pays)
  push(p.customer_id, {
    at: p.created_at, what: 'payment #' + p.id,
    before: Number(p.carried_balance_before), after: Number(p.carried_balance_after),
  })
for (const l of logs.filter((l) => l.type === 'balance_adjusted')) {
  const f = fields(l.details)
  push(l.customer_id, { at: l.created_at, what: 'adjustment log #' + l.id, before: money(f.old), after: money(f.new) })
}
for (const list of eventsBy.values()) list.sort((a, b) => a.at.localeCompare(b.at))

// A logged rate change: the rate the run used is the OLD side of the earliest one.
const rateAtRun = new Map()
for (const l of logs.filter((l) => l.type === 'customer_updated')) {
  const changes = fields(l.details).changes ?? ''
  for (const part of changes.split('; ')) {
    if (!part.startsWith('monthly_rate: ')) continue
    const old = money(part.slice('monthly_rate: '.length).split(' ')[0])
    if (!rateAtRun.has(l.customer_id)) rateAtRun.set(l.customer_id, { rate: old, log: l.id })
  }
}

// --- the repair's intended targets ------------------------------------------------
//
// The old payment path wrote last_billed_date = ymd(paymentDate) on a postpaid
// payment. The repair matched last_billed_date = 2026-09-03, so its targets are
// the customers holding a payment dated that day, recorded before the fix.
const residue = new Map()
for (const p of pays) {
  if (p.paid_on !== RESIDUE_DATE || p.created_at >= FIX_COMMIT) continue
  if (!residue.has(p.customer_id)) residue.set(p.customer_id, [])
  residue.get(p.customer_id).push(p.id)
}

// --- classify -----------------------------------------------------------------

const rows = []
for (const c of cohort) {
  const ev = eventsBy.get(c.id) ?? []
  const rateNow = Number(c.monthly_rate ?? 0)
  const logged = rateAtRun.get(c.id)
  const rate = logged ? logged.rate : rateNow
  const v = ev.length ? ev[0].before : Number(c.carried_balance ?? 0)
  const source = ev.length
    ? ev[0].what + ' (' + ev[0].at.slice(0, 16) + 'Z) found ' + v
    : 'untouched since the run, balance today ' + v

  let proof, verdict
  if (c.created_at > RUN_AT) {
    verdict = 'UNPLACED'; proof = 'created after the run, so the run cannot have billed it'
  } else if (rate > 0 && v === rate) {
    verdict = 'BILLED'
    proof = 'charge = rate ' + rate + (logged ? ' (rate at the run, per log #' + logged.log + '; now ' + rateNow + ')' : '')
  } else if (v > 0) {
    verdict = 'BILLED*'
    proof = 'charge ' + v + ' on a zero-opened account, but rate today is ' + rateNow + ' and no log explains the difference'
  } else {
    verdict = 'UNPLACED'; proof = 'no charge standing after the run (rate ' + rateNow + ')'
  }

  // Later movement nothing explains would be the mark of a second, unlogged run.
  const breaks = []
  for (let i = 1; i < ev.length; i++)
    if (Math.abs(ev[i].before - ev[i - 1].after) >= 1)
      breaks.push(ev[i - 1].what + ' left ' + ev[i - 1].after + ', ' + ev[i].what + ' found ' + ev[i].before)
  if (ev.length && Math.abs(ev[ev.length - 1].after - Number(c.carried_balance ?? 0)) >= 1)
    breaks.push(ev[ev.length - 1].what + ' left ' + ev[ev.length - 1].after + ', balance today ' + c.carried_balance)

  rows.push({ c, verdict, proof, source, v, breaks, target: residue.get(c.id) ?? null })
}

const placed = (r) => r.verdict !== 'UNPLACED'
const proposal = (r) =>
  !placed(r) ? '(no proposal)' : r.c.last_billed_date === RIGHT ? '(already correct)' : RIGHT

const line = (r) =>
  String(r.c.id).padStart(5) + '  ' + name(r.c).slice(0, 34).padEnd(34) + '  ' +
  r.c.last_billed_date + ' -> ' + proposal(r).padEnd(17) + '  ' +
  r.verdict.padEnd(8) + '  ' + r.source + '; ' + r.proof +
  (r.target ? '  [paid ' + RESIDUE_DATE + ': #' + r.target.join(', #') + ']' : '') +
  (r.breaks.length ? '  {unexplained: ' + r.breaks.join(' | ') + '}' : '')

const section = (title, list) => {
  console.log('\n' + '='.repeat(100) + '\n' + title + ' - ' + list.length + ' rows\n' + '='.repeat(100))
  for (const r of list) console.log(line(r))
}

section('A. THE REPAIR\'S INTENDED TARGETS: held a payment dated ' + RESIDUE_DATE + ' under the old code. Should read ' + RIGHT,
  rows.filter((r) => r.target && placed(r)))
section('B. COLLATERAL: never carried payment residue, billed for August, proven by charge = rate. Should read ' + RIGHT,
  rows.filter((r) => !r.target && r.verdict === 'BILLED'))
section('C. COLLATERAL, WEAKER PROOF: a run charge stood on the account but is not today\'s rate. Should read ' + RIGHT + ', listed apart',
  rows.filter((r) => !r.target && r.verdict === 'BILLED*'))
section('D. CANNOT BE PLACED', rows.filter((r) => !placed(r)))

// --- cross-checks -------------------------------------------------------------

console.log('\n' + '='.repeat(100) + '\nCROSS-CHECKS\n' + '='.repeat(100))
const charged = rows.filter(placed).reduce((s, r) => s + r.v, 0)
const logTotal = money((/billed (J\$[0-9,]+)/.exec(runs[0].details) ?? [])[1])
const logCount = Number((/: (\d+) customers billed/.exec(runs[0].details) ?? [])[1])
const missing = logCount - rows.filter(placed).length
console.log('Run log: ' + logCount + ' customers, J$' + logTotal.toLocaleString())
console.log('Proven here: ' + rows.filter(placed).length + ' customers, J$' + charged.toLocaleString())
console.log('Difference: ' + missing + ' customers, J$' + (logTotal - charged).toLocaleString() +
  ' (customers billed on 3 Sep whose rows no longer exist; average J$' +
  Math.round((logTotal - charged) / Math.max(1, missing)).toLocaleString() + ')')

console.log('\nDistinct customers with a surviving payment dated ' + RESIDUE_DATE + ' before the fix: ' + residue.size)
console.log('Payments dated 2026-09-04 created before the fix commit (would have stamped 09-04): ' +
  pays.filter((p) => p.paid_on === '2026-09-04' && p.created_at < FIX_COMMIT).length)
console.log('Payment deletions/corrections logged before the fix (their payment rows may be gone):')
for (const l of logs.filter((l) => (l.type === 'payment_deleted' || l.type === 'payment_updated') && l.created_at < FIX_COMMIT))
  console.log('  #' + l.customer_id + ' in A: ' + residue.has(l.customer_id) + ' - ' + l.details)

console.log('\nRows with balance movement no payment or adjustment explains:')
for (const r of rows.filter((r) => r.breaks.length)) console.log('  ' + r.c.id + ' ' + name(r.c) + ': ' + r.breaks.join(' | '))

// --- write --------------------------------------------------------------------

if (!APPLY) {
  console.log('\nDRY RUN. Nothing was written. Re-run with --apply to write.')
  process.exit(0)
}

console.log('\n' + '='.repeat(100) + '\nAPPLY\n' + '='.repeat(100))

const toFix = rows.filter((r) => r.c.last_billed_date === WRONG)
const refuse = (why) => { console.error('REFUSED, nothing written: ' + why); process.exit(1) }

if (toFix.length === 0) {
  console.log('No row carries ' + WRONG + '. Already applied; nothing to do.')
  process.exit(0)
}
const unplaced = toFix.filter((r) => !placed(r))
if (unplaced.length)
  refuse(unplaced.length + ' row(s) stamped ' + WRONG + ' could not be placed: ' + unplaced.map((r) => r.c.id).join(', '))
if (toFix.length !== EXPECTED)
  refuse('expected ' + EXPECTED + ' rows stamped ' + WRONG + ', proved ' + toFix.length)

// Counted again by the database, immediately before the write, so the set just
// proven and the set about to be matched are the same size.
const pre = await db.from('customers').select('id', { count: 'exact', head: true })
  .eq('company_id', COMPANY).eq('last_billed_date', WRONG)
if (pre.error) refuse('could not count: ' + pre.error.message)
if (pre.count !== EXPECTED) refuse('the database now counts ' + pre.count + ' rows stamped ' + WRONG + ', not ' + EXPECTED)

const { error, count } = await db.from('customers')
  .update({ last_billed_date: RIGHT }, { count: 'exact' })
  .eq('company_id', COMPANY)
  .eq('last_billed_date', WRONG)

if (error) { console.error('UPDATE FAILED: ' + error.message); process.exit(1) }
console.log('UPDATE matched ' + count + ' rows (expected ' + EXPECTED + ').')

const left = await db.from('customers').select('id', { count: 'exact', head: true })
  .eq('company_id', COMPANY).eq('last_billed_date', WRONG)
const now = await db.from('customers').select('id', { count: 'exact', head: true })
  .eq('company_id', COMPANY).eq('last_billed_date', RIGHT)
console.log('VERIFY: still ' + WRONG + ': ' + left.count + ' (expect 0). Now ' + RIGHT + ': ' + now.count + ' (expect ' + EXPECTED + ').')

if (count !== EXPECTED || left.count !== 0 || now.count !== EXPECTED) {
  console.error('THE COUNTS DO NOT AGREE. Read them before doing anything else.')
  process.exit(1)
}
console.log('Done.')
