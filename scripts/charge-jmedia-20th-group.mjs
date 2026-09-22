// One month's rate put on the carried balance of JMEDIA's 20th group, dated 20 September 2026.
//
//   node scripts/charge-jmedia-20th-group.mjs            dry run: prints the list, writes nothing
//   node scripts/charge-jmedia-20th-group.mjs --write    writes
//
// WHY A SCRIPT AND NOT RUN BILLS. JMEDIA's 20th group is prepaid: the charge raised on the
// 20th is for the month AHEAD (20 Sep to 20 Oct 2026). Run Bills bills in arrears, names the
// charge "August 2026", stamps last_billed_date 2026-08-31, and cannot skip a customer. The
// owner wants the charge dated 20 September, on everyone in the group, with a row per
// customer. Adjust Balance (app/actions/customers.ts#adjustCarriedBalance) writes the right
// shape but one customer at a time and always dated now.
//
// WHAT IT WRITES, per customer charged:
//   customers.carried_balance   0 -> monthly_rate  (guarded: the row must still read exactly
//                               as it did when the list was made)
//   log                         one `balance_adjusted` row, the same shape the Adjust Balance
//                               modal writes, so the customer page marks the balance
//                               "Adjusted" with the reason on hover, and the app's readers
//                               (lib/data/balance-adjustments.ts) find it.
//                               created_at = 20 SEPTEMBER 2026 (noon, America/Jamaica).
//                               This is THE column that carries the date. Nothing else does.
//                               correlation_id = one id for the whole run (migration 0016).
//
// WHAT IT DOES NOT WRITE. last_billed_date stays NULL: that column means "last day of the
// period the bill run billed" and is Run Bills' already-billed guard; 2026-09-20 there would
// read as "billed for September" and the 20 Oct run would skip this group. radcheck,
// account_credit, bill_date, cut_off_date and payments are untouched.
//
// WHO IS CHARGED: every customer of company 30 whose bill_date is 20, EXCEPT
//   - anyone already carrying a balance (carried_balance > 0), and
//   - anyone whose account_credit already covers the month (credit >= monthly_rate).
// A rate of 0 is charged 0, which is skipped: comping someone is done by setting their rate
// to 0, not by this script.
//
// Re-runnable: a second run finds carried_balance > 0 on everyone it charged and skips them.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ROOT = process.cwd()
const { createClient } = createRequire(ROOT + '/package.json')('@supabase/supabase-js')
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.trim().startsWith('#')) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim()
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const WRITE = process.argv.includes('--write')
const COMPANY = 30
const BILL_DAY = 20
// Noon in Kingston on the 20th, so it reads as 20 September in any zone the office uses.
const CHARGED_AT = '2026-09-20T12:00:00-05:00'
const REASON = 'Prepaid month ahead, 20 Sep to 20 Oct 2026: one month at the monthly rate, charged 20 Sep 2026'

// The log row is filed under the platform owner who ran this, with the same via= marker
// lib/audit.ts appends when a platform operator writes into a tenant.
const { data: actor, error: actorError } = await db.from('users')
  .select('id, email').eq('is_super_admin', true).order('id').limit(1).maybeSingle()
if (actorError || !actor) throw new Error('Could not find the platform owner user: ' + (actorError?.message ?? 'none'))
const BY = actor.email
const VIA = ' | via=super_admin:#' + actor.id

const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const { data: rows, error } = await db.from('customers')
  .select('id, first_name, last_name, monthly_rate, carried_balance, account_credit, bill_date, last_billed_date')
  .eq('company_id', COMPANY).eq('bill_date', BILL_DAY).order('id')
if (error) throw new Error(error.message)

const plan = []
for (const r of rows) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Customer #' + r.id
  const rate = Number(r.monthly_rate ?? 0)
  const carried = Number(r.carried_balance ?? 0)
  const credit = Number(r.account_credit ?? 0)
  let skip = null
  if (carried > 0) skip = 'already carries ' + money(carried)
  else if (rate > 0 && credit >= rate) skip = 'credit ' + money(credit) + ' covers the month'
  else if (rate <= 0) skip = 'rate is 0'
  plan.push({ id: r.id, name, rate, carried, credit, skip, row: r })
}

const charge = plan.filter((p) => !p.skip)
const total = charge.reduce((s, p) => s + p.rate, 0)

console.log((WRITE ? 'WRITING' : 'DRY RUN') + ' — JMEDIA (company ' + COMPANY + '), bill day ' + BILL_DAY + ': ' + rows.length + ' customers')
console.log('Charge dated ' + CHARGED_AT + ' on log.created_at; by ' + BY + VIA + '\n')
for (const p of plan) {
  console.log(
    (p.skip ? 'SKIP   ' : 'CHARGE ') + String(p.id).padEnd(6) + p.name.padEnd(30) +
    (p.skip ? p.skip : money(p.rate) + '   carried ' + money(p.carried) + ' -> ' + money(p.rate))
  )
}
console.log('\n' + charge.length + ' to charge, ' + money(total) + ' in total; ' + (plan.length - charge.length) + ' skipped.')

if (!WRITE) { console.log('\nDry run. Nothing written. Re-run with --write.'); process.exit(0) }

const runId = randomUUID()
let done = 0, failed = 0
for (const p of charge) {
  const r = p.row
  // Guarded on every value the decision was made from.
  const { error: upErr, count } = await db.from('customers')
    .update({ carried_balance: p.rate }, { count: 'exact' })
    .eq('company_id', COMPANY).eq('id', p.id)
    .eq('bill_date', BILL_DAY)
    .eq('carried_balance', r.carried_balance)
    .eq('monthly_rate', r.monthly_rate)
  if (upErr || (count ?? 0) !== 1) {
    failed += 1
    console.log('FAILED ' + p.id + ' ' + p.name + ': ' + (upErr ? upErr.message : 'row changed since the list was made (matched ' + count + '); nothing written'))
    continue
  }
  const { data: logged, error: logErr } = await db.from('log').insert({
    company_id: COMPANY, user_id: actor.id, customer_id: p.id,
    type: 'balance_adjusted',
    created_at: CHARGED_AT,
    correlation_id: runId,
    details:
      'Carried balance adjusted for ' + p.name +
      ' | old=' + money(p.carried) + ' | new=' + money(p.rate) +
      ' | by=' + BY + ' | reason=' + REASON + VIA,
  }).select('id, created_at').maybeSingle()
  if (logErr || !logged) {
    console.log('CHARGED ' + p.id + ' ' + p.name + ' but the log row failed: ' + (logErr?.message ?? 'no row returned') + '. Log it by hand.')
  } else {
    console.log('CHARGED ' + p.id + ' ' + p.name.padEnd(30) + money(p.rate) + '   log #' + logged.id + ' at ' + logged.created_at)
  }
  done += 1
}
console.log('\nCharged ' + done + ' of ' + charge.length + '; ' + failed + ' failed. run id ' + runId)
