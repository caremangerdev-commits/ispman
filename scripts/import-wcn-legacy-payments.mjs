// Three West Central Networks payments already taken in the legacy system, brought into ISPMan
// as money only: the balance is settled, radcheck and every expiry column are untouched.
//
//   node scripts/import-wcn-legacy-payments.mjs            dry run: prints the plan, writes nothing
//   node scripts/import-wcn-legacy-payments.mjs --write    writes
//
// WHY A SCRIPT AND NOT THE TILL. The legacy till already extended these customers when it took
// the money. Recording them at ISPMan's till would price them as renewals and walk the expiry
// again; recording them as "other" at the till would leave the carried balance standing. This
// writes the money the way the catch-up import does (scripts/catchup-company.mjs) — settles the
// balance, holds any surplus as credit, never touches the network — but for three named rows,
// dated when the legacy till took them, under one run id.
//
// FILL THE LIST BELOW BEFORE RUNNING. The legacy database is not reachable from this machine
// (the catch-up's tunnel to 127.0.0.1:3306 is not open), so the three payments are stated here
// rather than read. Each entry:
//   legacyPaymentId   the legacy payments row id. Stamped in notes as
//                     "Migrated from legacy payment #<id>", which is the key the catch-up import
//                     uses to know a legacy row is already here — so a later catch-up will not
//                     import it a second time. REQUIRED, and it must be the real legacy id.
//   legacyCustomerId  the legacy customer id, matched to the ISPMan customer through the
//                     "Legacy #<id>" note the migration wrote (or give ispmanCustomerId instead).
//   amount            what was handed over.
//   paidOn            the date the legacy till took it, YYYY-MM-DD. payment_date is stamped as
//                     noon on that date in the company's timezone, which is what the app itself
//                     writes for a back-dated payment (lib/format.ts#paymentInstant).
//   method            cash | card | bank_transfer | cheque | online | other (lib/data/checkoff.ts)
//   agent             the collector's name as it should read on the row and the receipt.
//   userId            the ISPMan users.id of that collector, or null. The catch-up learns this
//                     from the user_id on that agent's migrated payments; here it is stated.
//
// WHAT IT WRITES, per payment:
//   payments                one row: payment_kind 'service' with months_paid 0 — the app's own
//                           money-only shape, what its till writes for a payment that bought no
//                           months (lib/billing.ts#monthsCovered; the receipt reads months_paid 0
//                           as "access unchanged"). paid_on, payment_date (noon, company tz),
//                           payment_method + legacy payment_type, checked_off false, user_id,
//                           agent, notes = the legacy marker, the customer's misc category
//                           stamped as the app does, and the balance stamps (amount_due,
//                           carried_balance_before/after, credit_applied) so the row says what
//                           it did. NO access_granted_until, NO service_active_until, NO billing
//                           period: none is named for a payment that bought no month.
//   customers               carried_balance -> max(0, balance - amount); account_credit += any
//                           surplus. Guarded: the row must still read exactly as it did when the
//                           plan was made. Nothing else on the customer changes.
//   log                     one `legacy_payment_imported` row, the shape lib/audit.ts#logEvent
//                           writes (company, user, customer, type, details, amount,
//                           correlation_id). logEvent itself needs a signed-in session, so the
//                           row is written directly, as scripts/charge-jmedia-20th-group.mjs
//                           does. created_at is the moment of the import: the payment's own date
//                           is on the payments row. correlation_id = one id for the whole run.
//                           NOT `balance_adjusted`: that type marks a balance as hand-set on the
//                           customer page, and a payment is not an adjustment.
//
// WHAT IT NEVER TOUCHES: radcheck, access_granted_until, service_active_until, last_bill_date,
// last_billed_date, bill_date, cut_off_date, billing periods, SMS.
//
// A NOTE ON THE SHAPE. Not kind "other": in the app that is a fee, it settles nothing
// (app/actions/payments.ts#recordOtherPayment), and a report grouping by kind would read
// these as fees. A service row with zero months is what ISPMan itself writes when money
// settles a balance and moves no expiry, so these rows read exactly as the app's own do.
//
// Re-runnable: a payment whose legacy id is already in notes is skipped, so a second run after a
// partial write finishes the rest and touches nothing twice.
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
const COMPANY = 26 // West Central Networks
const REASON = 'Taken in the legacy system, where the expiry was already extended; money recorded in ISPMan, access untouched'

/**
 * THE THREE PAYMENTS. Read from the legacy database (schema COMPANY_wcnetjagmail_com) on
 * 25 September 2026 through the catch-up's dry run, and chosen by the owner from the ten
 * legacy rows then missing for customers ISPMan knows. The other seven were left in legacy.
 * Both customer keys are given: the ISPMan id the plan is made against, and the legacy id
 * the customer's own "Legacy #n" note carries, for the record.
 */
const PAYMENTS = [
  { legacyPaymentId: 19213, legacyCustomerId: 191,  ispmanCustomerId: 1733, amount: 3500, paidOn: '2026-09-16', method: 'cash', agent: 'Jillian Brissitte', userId: 161 },
  { legacyPaymentId: 19215, legacyCustomerId: 2247, ispmanCustomerId: 2003, amount: 3500, paidOn: '2026-09-22', method: 'cash', agent: 'Michelle Bennett',  userId: 160 },
  { legacyPaymentId: 19216, legacyCustomerId: 1749, ispmanCustomerId: 1874, amount: 3500, paidOn: '2026-09-22', method: 'cash', agent: 'Michelle Bennett',  userId: 160 },
]

// --- Shapes shared with the app, restated here because a script cannot import TypeScript ---

/** lib/data/checkoff.ts#PAYMENT_METHODS and #legacyPaymentType — the legacy METHOD column the app still writes. */
const METHODS = ['cash', 'card', 'bank_transfer', 'cheque', 'paypal', 'cashapp', 'zelle', 'wire_transfer', 'online', 'other']
const legacyPaymentType = (m) => (m === 'cash' ? 'cash' : m === 'card' || m === 'cheque' ? 'card' : 'online')

/** lib/format.ts#zonedNoon — noon on a calendar date in a named zone. */
function zonedNoon(dateOnly, timeZone) {
  const [y, m, d] = dateOnly.split('-').map(Number)
  const target = Date.UTC(y, m - 1, d, 12, 0, 0)
  let instant = target
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant))
    const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    instant -= Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - target
  }
  return new Date(instant)
}

const money = (n) => 'J$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const round2 = (n) => Math.round(n * 100) / 100

// --- Inputs ------------------------------------------------------------------------------

if (PAYMENTS.length === 0) {
  console.error('PAYMENTS is empty. Fill in the three legacy payments at the top of this script, then run again.')
  process.exit(1)
}

const { data: actor, error: actorError } = await db.from('users')
  .select('id, email').eq('is_super_admin', true).order('id').limit(1).maybeSingle()
if (actorError || !actor) throw new Error('Could not find the platform owner user: ' + (actorError?.message ?? 'none'))
const BY = actor.email
const VIA = ' | via=super_admin:#' + actor.id

const { data: settings } = await db.from('settings').select('timezone').eq('company_id', COMPANY).maybeSingle()
const TZ = settings?.timezone || 'America/Jamaica'

const { data: customers, error: custErr } = await db.from('customers')
  .select('id, first_name, last_name, notes, carried_balance, account_credit, misc_category_id')
  .eq('company_id', COMPANY)
if (custErr) throw new Error(custErr.message)
const byId = new Map(customers.map((c) => [c.id, c]))
const byLegacy = new Map()
for (const c of customers) {
  const m = /legacy\s*#\s*(\d+)/i.exec(String(c.notes ?? ''))
  if (m) byLegacy.set(Number(m[1]), c)
}

// Already here? The legacy marker in notes is the key, exactly as the catch-up reads it.
const { data: existing, error: exErr } = await db.from('payments')
  .select('id, notes').eq('company_id', COMPANY).ilike('notes', 'Migrated from legacy payment #%')
if (exErr) throw new Error(exErr.message)
const imported = new Map()
for (const p of existing) {
  const m = /#(\d+)$/.exec(String(p.notes))
  if (m) imported.set(Number(m[1]), p.id)
}

// --- Plan --------------------------------------------------------------------------------

/** ISPMan customer id -> balance and credit as this run leaves them, so two payments for one customer chain. */
const ledger = new Map()
const plan = []
for (const p of PAYMENTS) {
  const problems = []
  if (!Number.isInteger(p.legacyPaymentId) || p.legacyPaymentId <= 0) problems.push('legacyPaymentId missing')
  if (!(Number(p.amount) > 0)) problems.push('amount must be > 0')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.paidOn))) problems.push('paidOn must be YYYY-MM-DD')
  if (!METHODS.includes(p.method)) problems.push('method must be one of ' + METHODS.join('|'))
  if (!p.agent) problems.push('agent missing')

  const customer = p.ispmanCustomerId ? byId.get(p.ispmanCustomerId) : byLegacy.get(Number(p.legacyCustomerId))
  if (!customer) problems.push('customer not found in company ' + COMPANY + ' (legacy #' + p.legacyCustomerId + ' / ispman #' + p.ispmanCustomerId + ')')
  // Both keys given: they must name the same record, or one of them is a typo.
  else if (p.ispmanCustomerId && p.legacyCustomerId && byLegacy.get(Number(p.legacyCustomerId)) !== customer) {
    problems.push('ispman #' + p.ispmanCustomerId + ' is not legacy #' + p.legacyCustomerId + ' (its note says "' + customer.notes + '")')
  }

  let skip = null
  if (problems.length) skip = problems.join('; ')
  else if (imported.has(p.legacyPaymentId)) skip = 'already imported as payment #' + imported.get(p.legacyPaymentId)

  if (skip) { plan.push({ p, skip }); continue }

  const name = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer #' + customer.id
  const state = ledger.get(customer.id) ?? {
    balance: Number(customer.carried_balance ?? 0), credit: Number(customer.account_credit ?? 0),
    openingBalance: Number(customer.carried_balance ?? 0), openingCredit: Number(customer.account_credit ?? 0),
  }
  const amount = round2(Number(p.amount))
  const before = state.balance
  const after = round2(Math.max(0, before - amount))
  const credit = round2(Math.max(0, amount - before))
  // What the customer row must read for THIS payment to apply, and what it reads after. A
  // second payment for the same customer in this run expects what the first left behind.
  const guardCredit = state.credit
  state.balance = after
  state.credit = round2(state.credit + credit)
  ledger.set(customer.id, state)

  plan.push({
    p, customer, name, amount, before, after, credit,
    guardBalance: before, guardCredit, newCredit: state.credit,
    paymentDate: zonedNoon(p.paidOn, TZ),
    row: {
      company_id: COMPANY,
      customer_id: customer.id,
      amount,
      // Zero: this money bought no month. The app's till stamps the same for a payment that
      // moves no expiry, and the receipt reads it as "access unchanged".
      months_paid: 0,
      payment_kind: 'service',
      payment_category_id: null,
      paid_on: p.paidOn,
      payment_date: zonedNoon(p.paidOn, TZ).toISOString(),
      payment_method: p.method,
      payment_type: legacyPaymentType(p.method),
      checked_off: false,
      user_id: p.userId ?? null,
      agent: p.agent,
      notes: 'Migrated from legacy payment #' + p.legacyPaymentId,
      customer_misc_category_id: customer.misc_category_id ?? null,
      amount_due: before,
      carried_balance_before: before,
      carried_balance_after: after,
      credit_applied: credit,
    },
  })
}

const doing = plan.filter((x) => !x.skip)
console.log((WRITE ? 'WRITING' : 'DRY RUN') + ' — West Central Networks (company ' + COMPANY + '), ' + PAYMENTS.length + ' legacy payment(s); tz ' + TZ)
console.log('Rows: payment_kind service, months_paid 0 — money only, no expiry, no billing period')
console.log('Log rows by ' + BY + VIA + '\n')
for (const x of plan) {
  if (x.skip) { console.log('SKIP   legacy #' + x.p.legacyPaymentId + ': ' + x.skip); continue }
  console.log('IMPORT legacy #' + x.p.legacyPaymentId + '  ' + x.name + ' (customer #' + x.customer.id + ')')
  console.log('       ' + money(x.amount) + ' ' + x.p.method + ' on ' + x.p.paidOn + ' by ' + x.p.agent + (x.p.userId ? ' (user #' + x.p.userId + ')' : ' (no user link)'))
  console.log('       payment_date ' + x.row.payment_date + '  (noon ' + TZ + ')')
  console.log('       carried_balance ' + money(x.before) + ' -> ' + money(x.after) + (x.credit > 0 ? '   account_credit +' + money(x.credit) : ''))
  console.log('       radcheck / expiry: untouched')
}
const total = doing.reduce((s, x) => s + x.amount, 0)
console.log('\n' + doing.length + ' to import, ' + money(total) + ' in total; ' + (plan.length - doing.length) + ' skipped.')
for (const [id, s] of ledger) {
  const c = byId.get(id)
  console.log('customer #' + id + ' ends at balance ' + money(s.balance) + ' (was ' + money(s.openingBalance) + '), credit ' + money(s.credit) + ' (was ' + money(s.openingCredit) + ')' + (c ? '' : ' ?'))
}

if (!WRITE) { console.log('\nDry run. Nothing written. Re-run with --write.'); process.exit(0) }
if (doing.length === 0) { console.log('\nNothing to write.'); process.exit(0) }

// --- Write -------------------------------------------------------------------------------

const runId = randomUUID()
let done = 0, failed = 0
for (const x of doing) {
  const c = x.customer
  // The customer first, guarded on the values the plan was made from. If two payments in this
  // run are for one customer, the second is guarded on what the first left.
  const { error: upErr, count } = await db.from('customers')
    .update({ carried_balance: x.after, account_credit: x.newCredit }, { count: 'exact' })
    .eq('company_id', COMPANY).eq('id', c.id)
    .eq('carried_balance', x.guardBalance)
    .eq('account_credit', x.guardCredit)
  if (upErr || (count ?? 0) !== 1) {
    failed += 1
    console.log('FAILED legacy #' + x.p.legacyPaymentId + ' ' + x.name + ': ' + (upErr ? upErr.message : 'customer row changed since the plan was made (matched ' + count + '); nothing written'))
    continue
  }

  const { data: inserted, error: insErr } = await db.from('payments')
    .insert(x.row).select('id').single()
  if (insErr || !inserted) {
    failed += 1
    console.log('FAILED legacy #' + x.p.legacyPaymentId + ' ' + x.name + ': balance moved but the payment row failed: ' + (insErr?.message ?? 'no row') + '. Put the balance back to ' + money(x.before) + ' by hand.')
    continue
  }

  const { data: logged, error: logErr } = await db.from('log').insert({
    company_id: COMPANY, user_id: actor.id, customer_id: c.id,
    type: 'legacy_payment_imported',
    amount: x.amount,
    correlation_id: runId,
    details:
      'Legacy payment imported for ' + x.name +
      ' | legacy=#' + x.p.legacyPaymentId + ' | payment=#' + inserted.id +
      ' | amount=' + money(x.amount) + ' | paid_on=' + x.p.paidOn + ' | method=' + x.p.method + ' | agent=' + x.p.agent +
      ' | balance_old=' + money(x.before) + ' | balance_new=' + money(x.after) +
      (x.credit > 0 ? ' | credit_added=' + money(x.credit) : '') +
      ' | by=' + BY + ' | reason=' + REASON + VIA,
  }).select('id').maybeSingle()
  if (logErr || !logged) {
    console.log('IMPORTED legacy #' + x.p.legacyPaymentId + ' as payment #' + inserted.id + ' but the log row failed: ' + (logErr?.message ?? 'no row returned') + '. Log it by hand.')
  } else {
    console.log('IMPORTED legacy #' + x.p.legacyPaymentId + ' ' + x.name.padEnd(28) + money(x.amount) + '   payment #' + inserted.id + '   log #' + logged.id)
  }
  done += 1
}
console.log('\nImported ' + done + ' of ' + doing.length + '; ' + failed + ' failed. run id ' + runId)
