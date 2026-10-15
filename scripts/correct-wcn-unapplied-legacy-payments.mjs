#!/usr/bin/env node
/**
 * ONE-OFF: West Central (26) — 30 customers whose September payment at the
 * legacy till was copied into ISPMan without ever reducing their balance.
 * Owner, 15 Oct 2026: "One month each, Jillian Brissett J$3,500."
 *
 *   node scripts/correct-wcn-unapplied-legacy-payments.mjs                          dry run
 *   node scripts/correct-wcn-unapplied-legacy-payments.mjs --apply --expect=30      writes
 *
 * WHAT HAPPENED. The migration (5 Sep) opened every customer with no payment
 * since 20 Aug at one month owing. 35 legacy-till payments dated 5-9 Sep were
 * then inserted on 10 Sep 21:42 as plain rows — no carried_balance_before or
 * _after — so none of them reduced that opening month. The 2 Oct bulk bill
 * (log 6173) added September, and each of these customers stood at exactly
 * twice their monthly charge: the month they had paid at the legacy till, and
 * September. Four were fixed by hand by staff (1801, 1844, 2008, 2028) and are
 * not here; 1971 had the same money recorded twice and owes what he shows.
 *
 * THE EVIDENCE, per customer, checked again by this script before anything is
 * planned (the legacy side was read on 15 Oct 2026 from
 * COMPANY_wcnetjagmail_com.payments and is restated in the list below):
 *   - the ISPMan payment the legacy row became still exists, for this
 *     customer, notes "Migrated from legacy payment #<legacy id>";
 *   - it still has no balance stamps: it has never touched the balance;
 *   - no balance adjustment has been made to the customer since the 2 Oct
 *     bill, and this script has not corrected them already.
 * A customer failing any check is skipped and said so.
 *
 * WHAT --apply WRITES, per customer:
 *   customers  carried_balance reduced by one month (J$3,500; Jillian Brissett
 *              J$3,500 against her J$4,000 rate, owner's figure). Where that is
 *              more than they owe now — they have already paid the double — the
 *              balance goes to 0 and the rest to account_credit, which the
 *              engine takes off their next charge. Guarded on the balance and
 *              credit the dry run read.
 *   log        one balance_adjusted row, the shape the customer page writes
 *              (app/actions/customers.ts), naming the legacy payment and the
 *              ISPMan payment, under one run id (correlation_id).
 * NOT a reversal of September (correctly billed), NOT an edit of the old
 * payment rows (they stay as the record), NOT expiries or the network.
 *
 * --expect must equal the number the dry run plans: what is written is the set
 * somebody read.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'

const ROOT = process.cwd()
const { createClient } = createRequire(ROOT + '/package.json')('@supabase/supabase-js')

for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const COMPANY = 26
const BILL_AT = '2026-10-02T12:27:00Z' // log 6173: the bulk bill for September
const APPLY = process.argv.includes('--apply')
const expectArg = process.argv.find((a) => a.startsWith('--expect='))
const EXPECT = expectArg ? Number(expectArg.slice('--expect='.length)) : null
if (APPLY && EXPECT === null) {
  console.error('--apply needs --expect=<the count the dry run planned>.')
  process.exit(1)
}

/**
 * The 30, as reviewed by the owner on 15 Oct 2026. legacy = the legacy till's
 * payments row; ispman = the ISPMan payment it was copied into on 10 Sep.
 */
const CUSTOMERS = [
  { id: 1744, legacy: 19201, paid: '2026-09-08', paidAmount: 3500, ispman: 13282, amount: 3500 },
  { id: 1748, legacy: 19177, paid: '2026-09-05', paidAmount: 3500, ispman: 13260, amount: 3500 },
  { id: 1753, legacy: 19170, paid: '2026-09-05', paidAmount: 3500, ispman: 13253, amount: 3500 },
  { id: 1755, legacy: 19178, paid: '2026-09-05', paidAmount: 3500, ispman: 13261, amount: 3500 },
  { id: 1765, legacy: 19196, paid: '2026-09-07', paidAmount: 3500, ispman: 13277, amount: 3500 },
  { id: 1767, legacy: 19184, paid: '2026-09-05', paidAmount: 3500, ispman: 13267, amount: 3500 },
  { id: 1797, legacy: 19186, paid: '2026-09-06', paidAmount: 3000, ispman: 13269, amount: 3500 },
  { id: 1805, legacy: 19197, paid: '2026-09-07', paidAmount: 3500, ispman: 13278, amount: 3500 },
  { id: 1807, legacy: 19202, paid: '2026-09-08', paidAmount: 3500, ispman: 13283, amount: 3500 },
  { id: 1814, legacy: 19189, paid: '2026-09-07', paidAmount: 3500, ispman: 13272, amount: 3500 },
  { id: 1816, legacy: 19172, paid: '2026-09-05', paidAmount: 3500, ispman: 13255, amount: 3500 },
  { id: 1818, legacy: 19171, paid: '2026-09-05', paidAmount: 3500, ispman: 13254, amount: 3500 },
  { id: 1826, legacy: 19167, paid: '2026-09-05', paidAmount: 3500, ispman: 13250, amount: 3500 },
  { id: 1834, legacy: 19200, paid: '2026-09-08', paidAmount: 3500, ispman: 13281, amount: 3500 },
  { id: 1852, legacy: 19191, paid: '2026-09-07', paidAmount: 3550, ispman: 13274, amount: 3500 },
  { id: 1859, legacy: 19192, paid: '2026-09-07', paidAmount: 3500, ispman: 13275, amount: 3500 },
  { id: 1860, legacy: 19174, paid: '2026-09-05', paidAmount: 3000, ispman: 13257, amount: 3500 },
  { id: 1862, legacy: 19198, paid: '2026-09-08', paidAmount: 3500, ispman: 13279, amount: 3500 },
  { id: 1863, legacy: 19175, paid: '2026-09-05', paidAmount: 3000, ispman: 13258, amount: 3500 },
  { id: 1873, legacy: 19203, paid: '2026-09-09', paidAmount: 3500, ispman: 13284, amount: 3500 },
  { id: 1894, legacy: 19190, paid: '2026-09-07', paidAmount: 3000, ispman: 13273, amount: 3500 },
  // Rate J$4,000; she paid J$3,500 against a J$4,000 legacy bill. Owner: J$3,500.
  { id: 1900, legacy: 19187, paid: '2026-09-07', paidAmount: 3500, ispman: 13270, amount: 3500 },
  { id: 1916, legacy: 19176, paid: '2026-09-05', paidAmount: 3500, ispman: 13259, amount: 3500 },
  { id: 1921, legacy: 19173, paid: '2026-09-05', paidAmount: 3000, ispman: 13256, amount: 3500 },
  { id: 1949, legacy: 19199, paid: '2026-09-08', paidAmount: 3500, ispman: 13280, amount: 3500 },
  { id: 1955, legacy: 19169, paid: '2026-09-05', paidAmount: 3500, ispman: 13252, amount: 3500 },
  { id: 1965, legacy: 19180, paid: '2026-09-05', paidAmount: 3000, ispman: 13263, amount: 3500 },
  { id: 1979, legacy: 19168, paid: '2026-09-05', paidAmount: 3500, ispman: 13251, amount: 3500 },
  { id: 2013, legacy: 19181, paid: '2026-09-05', paidAmount: 3000, ispman: 13264, amount: 3500 },
  { id: 2017, legacy: 19185, paid: '2026-09-05', paidAmount: 3500, ispman: 13268, amount: 3500 },
]

const money = (n) => 'J$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const round2 = (n) => Math.round(n * 100) / 100
const short = (ymd) => {
  const [, m, d] = ymd.split('-').map(Number)
  return d + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
}

// The platform owner writes into the tenant, so the row carries the marker the
// app's own audit writer adds (lib/audit.ts), as the import scripts do.
const { data: actor, error: actorError } = await db.from('users')
  .select('id, email').eq('is_super_admin', true).order('id').limit(1).maybeSingle()
if (actorError || !actor) throw new Error('Could not find the platform owner user: ' + (actorError?.message ?? 'none'))
const VIA = ' | via=super_admin:#' + actor.id

const ids = CUSTOMERS.map((c) => c.id)
const { data: rows, error: ce } = await db.from('customers')
  .select('id, company_id, first_name, last_name, carried_balance, account_credit').in('id', ids)
if (ce) throw ce
const byId = new Map(rows.map((r) => [r.id, r]))
const { data: pays, error: pe } = await db.from('payments')
  .select('id, customer_id, company_id, amount, notes, carried_balance_before, carried_balance_after')
  .in('id', CUSTOMERS.map((c) => c.ispman))
if (pe) throw pe
const payById = new Map(pays.map((p) => [p.id, p]))
const { data: adjusted, error: le } = await db.from('log')
  .select('id, customer_id, created_at, details').eq('company_id', COMPANY).eq('type', 'balance_adjusted')
  .in('customer_id', ids).gt('created_at', BILL_AT)
if (le) throw le

const plan = []
for (const x of CUSTOMERS) {
  const c = byId.get(x.id)
  const p = payById.get(x.ispman)
  const name = c ? [c.first_name, c.last_name].join(' ').trim() : '#' + x.id
  const done = adjusted.find((l) => l.customer_id === x.id && l.details.includes('legacy_payment=#' + x.legacy))
  const since = adjusted.find((l) => l.customer_id === x.id && !l.details.includes('legacy_payment=#' + x.legacy))
  const skip =
    !c ? 'customer not found'
      : c.company_id !== COMPANY ? 'not a West Central customer'
        : done ? 'already corrected by this script (log #' + done.id + ')'
          : !p ? 'ISPMan payment #' + x.ispman + ' not found'
            : p.customer_id !== x.id || p.company_id !== COMPANY ? 'ISPMan payment #' + x.ispman + ' is not this customer\'s'
              : !String(p.notes ?? '').includes('Migrated from legacy payment #' + x.legacy) ? 'payment #' + x.ispman + ' is not legacy #' + x.legacy
                : p.carried_balance_before !== null ? 'payment #' + x.ispman + ' has since been applied to the balance'
                  : since ? 'balance adjusted since the bill (log #' + since.id + ', ' + since.created_at.slice(0, 10) + ')'
                    : null
  const before = Number(c?.carried_balance ?? 0)
  const creditBefore = Number(c?.account_credit ?? 0)
  const after = round2(Math.max(0, before - x.amount))
  const credit = round2(Math.max(0, x.amount - before))
  plan.push({ x, c, name, skip, before, creditBefore, after, credit, creditAfter: round2(creditBefore + credit) })
}

const doing = plan.filter((r) => !r.skip)
console.log((APPLY ? 'APPLYING' : 'DRY RUN') + ' — West Central (26): one month off for a legacy-till payment that never reached the balance')
console.log('Log rows: balance_adjusted, by ' + actor.email + VIA + '\n')
console.log('id    customer                    legacy till payment          ISPMan    balance now -> after     credit added')
for (const r of plan) {
  const lead = String(r.x.id).padEnd(6) + r.name.slice(0, 27).padEnd(28) +
    ('#' + r.x.legacy + ' ' + short(r.x.paid) + ' ' + money(r.x.paidAmount)).padEnd(29) + ('#' + r.x.ispman).padEnd(10)
  if (r.skip) console.log(lead + 'SKIP: ' + r.skip)
  else console.log(lead + (money(r.before) + ' -> ' + money(r.after)).padEnd(25) + (r.credit ? money(r.credit) : '—'))
}
const off = doing.reduce((s, r) => s + r.x.amount, 0)
const reduced = doing.reduce((s, r) => s + (r.before - r.after), 0)
const credited = doing.reduce((s, r) => s + r.credit, 0)
console.log('\n' + doing.length + ' to correct, ' + (plan.length - doing.length) + ' skipped. ' + money(off) + ' taken off: ' +
  money(reduced) + ' off balances, ' + money(credited) + ' as credit (' + doing.filter((r) => r.credit).length + ' customers). ' +
  doing.filter((r) => r.after > 0).length + ' still owe something after.')

if (!APPLY) {
  console.log('\nDry run. Nothing written. To write exactly this: --apply --expect=' + doing.length)
  process.exit(0)
}
if (doing.length !== EXPECT) {
  console.error('\n--expect=' + EXPECT + ' but ' + doing.length + ' are planned. Nothing written: run the dry run again and read it.')
  process.exit(1)
}

const runId = randomUUID()
let written = 0
let failed = 0
for (const r of doing) {
  const { error: upErr, count } = await db.from('customers')
    .update({ carried_balance: r.after, account_credit: r.creditAfter }, { count: 'exact' })
    .eq('company_id', COMPANY).eq('id', r.x.id)
    .eq('carried_balance', r.before).eq('account_credit', r.creditBefore)
  if (upErr || (count ?? 0) !== 1) {
    failed += 1
    console.log('FAILED #' + r.x.id + ' ' + r.name + ': ' + (upErr ? upErr.message : 'balance changed since the dry run (matched ' + count + '); nothing written'))
    continue
  }
  const reason =
    'paid at the legacy till on ' + short(r.x.paid) + ' (legacy payment #' + r.x.legacy + ', ' + money(r.x.paidAmount) +
    '), copied into ISPMan on 10 Sep as payment #' + r.x.ispman + ' without reducing the balance; one month taken off (owner, 15 Oct 2026)'
  const { data: logged, error: logErr } = await db.from('log').insert({
    company_id: COMPANY, user_id: actor.id, customer_id: r.x.id,
    type: 'balance_adjusted',
    correlation_id: runId,
    details:
      'Carried balance adjusted for ' + r.name +
      ' | old=' + money(r.before) + ' | new=' + money(r.after) +
      (r.credit ? ' | credit_added=' + money(r.credit) : '') +
      ' | legacy_payment=#' + r.x.legacy + ' | payment=#' + r.x.ispman +
      ' | by=' + actor.email + ' | reason=' + reason + VIA,
  }).select('id').maybeSingle()
  if (logErr || !logged) {
    console.log('CORRECTED #' + r.x.id + ' ' + r.name + ' but the log row failed: ' + (logErr?.message ?? 'no row') + '. Log it by hand.')
  } else {
    console.log('CORRECTED #' + r.x.id + ' ' + r.name.padEnd(28) + money(r.before) + ' -> ' + money(r.after) +
      (r.credit ? '  credit +' + money(r.credit) : '') + '   log #' + logged.id)
  }
  written += 1
}
console.log('\nCorrected ' + written + ' of ' + doing.length + '; ' + failed + ' failed. run id ' + runId)
