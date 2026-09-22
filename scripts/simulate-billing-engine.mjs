// READ-ONLY simulation of the daily billing engine over real rows.
//
//   node scripts/simulate-billing-engine.mjs
//
// Runs lib/billing-engine.ts#engineVerdict — the one decision the tick and the
// Billing Runs preview both make — against JMEDIA's and Ezmze's real customers
// with an injected "today", a company billing type and an engine start date.
// Nothing is written: charges are recorded in an in-memory set that stands in
// for the unique index on bill_charges (customer_id, period_start), so a
// second tick on the same period reads "already charged" exactly as the
// function would report it.
//
// SERVICE STATE IS ASSUMED ACTIVE. radcheck is not reachable from a
// workstation; the real tick reads it and skips anyone cut off. Every count
// below is therefore an upper bound on who the live engine would charge.
//
// The amount is monthly_rate PLUS active add-ons, read the way the till reads
// them (app/actions/payments.ts): customer_additional_services joined to
// additional_services.monthly_price.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
registerHooks({ resolve(s, c, n) {
  if (s.startsWith('@/')) { const b = path.join(ROOT, s.slice(2)); for (const e of ['.ts', '.tsx']) if (existsSync(b + e)) return { url: pathToFileURL(b + e).href, shortCircuit: true } }
  return n(s, c) } })
const { engineVerdict, prepaidPeriod, postpaidPeriod, toChargeElements } =
  await import(pathToFileURL(path.join(ROOT, 'lib/billing-engine.ts')).href)

const { createClient } = createRequire(ROOT + '/package.json')('@supabase/supabase-js')
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.trim().startsWith('#')) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim()
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

async function all(build) {
  const out = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await build().range(f, f + 999)
    if (error) throw new Error(error.message)
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

const money = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function load(companyId) {
  const rows = await all(() => db.from('customers')
    .select('id, first_name, last_name, monthly_rate, carried_balance, account_credit, bill_date, date_added')
    .eq('company_id', companyId).order('id'))
  const { data: s, error } = await db.from('settings').select('bill_date, timezone').eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(error.message)

  // Add-ons, the way the till sums them.
  const links = await all(() => db.from('customer_additional_services')
    .select('customer_id, additional_services(monthly_price)')
    .in('customer_id', rows.map((r) => r.id)))
  const addons = new Map()
  for (const l of links) addons.set(l.customer_id, (addons.get(l.customer_id) ?? 0) + Number(l.additional_services?.monthly_price ?? 0))

  return {
    companyBillDay: s?.bill_date ?? null,
    customers: rows.map((r) => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      billDate: r.bill_date,
      dateAdded: r.date_added,
      monthlyCharge: Number(r.monthly_rate ?? 0) + (addons.get(r.id) ?? 0),
      addons: addons.get(r.id) ?? 0,
      carried: Number(r.carried_balance ?? 0),
      credit: Number(r.account_credit ?? 0),
    })),
  }
}

/**
 * One tick for one company on one day. `charged` is the in-memory stand-in for
 * the unique index; `balances` is the in-memory stand-in for customers, so a
 * later tick sees what an earlier one did to credit and balance.
 */
function tick(label, company, { today, billingType, startDate, charged, balances, showCharges = false }) {
  const tally = { charge: 0, not_due: 0, before_start: 0, joined_after: 0, zero_rate: 0, already: 0 }
  const byDay = {}
  let total = 0
  let creditDrawn = 0
  const decided = []

  for (const c of company.customers) {
    const decision = engineVerdict({
      billingType, today, startDate, companyBillDay: company.companyBillDay,
      customer: { id: c.id, billDate: c.billDate, dateAdded: c.dateAdded, monthlyCharge: c.monthlyCharge },
      service: 'active',
    })
    decided.push({ customer: c, decision })
    const key = c.id + '|' + decision.period.start
    if (decision.verdict === 'charge' && charged.has(key)) { tally.already += 1; continue }
    tally[decision.verdict] += 1
    if (decision.verdict !== 'charge') continue

    // What apply_bill_charges() would do, in memory.
    charged.add(key)
    const b = balances.get(c.id) ?? { carried: c.carried, credit: c.credit }
    const drawn = Math.min(Math.max(b.credit, 0), decision.amount)
    b.credit -= drawn
    b.carried += decision.amount - drawn
    balances.set(c.id, b)
    total += decision.amount
    creditDrawn += drawn
    const dk = 'day ' + decision.billDay
    byDay[dk] = (byDay[dk] ?? 0) + 1
    if (showCharges) {
      console.log('      ' + String(c.id).padEnd(6) + c.name.padEnd(30) + money(decision.amount).padStart(10) +
        (c.addons ? '  (incl. add-ons ' + money(c.addons) + ')' : '') +
        (drawn ? '  credit drawn ' + money(drawn) : '') +
        '  ' + decision.period.start + ' to ' + decision.period.end)
    }
  }

  const elements = toChargeElements(decided).length
  console.log(
    '  ' + label.padEnd(44) +
    'charge ' + String(tally.charge).padStart(4) +
    '  already ' + String(tally.already).padStart(4) +
    '  not_due ' + String(tally.not_due).padStart(4) +
    '  before_start ' + String(tally.before_start).padStart(4) +
    '  joined_after ' + String(tally.joined_after).padStart(3) +
    '  zero_rate ' + String(tally.zero_rate).padStart(3) +
    '  total ' + money(total).padStart(12) +
    (creditDrawn ? '  credit drawn ' + money(creditDrawn) : '') +
    (Object.keys(byDay).length ? '  ' + JSON.stringify(byDay) : '') +
    (elements !== tally.charge + tally.already ? '  (elements ' + elements + ')' : '')
  )
}

// ---------------------------------------------------------------------------
// The shapes alone, no rows: the dates the user should be able to read off.
// ---------------------------------------------------------------------------
console.log('SHAPES')
const show = (l, p) => console.log('  ' + l.padEnd(46) + p.start + ' to ' + p.end + '   charged ' + p.chargeDate)
show('prepaid, bill day 20, today 2026-09-22', prepaidPeriod('2026-09-22', 20))
show('prepaid, bill day 20, today 2026-09-19', prepaidPeriod('2026-09-19', 20))
show('prepaid, bill day 20, today 2026-10-20', prepaidPeriod('2026-10-20', 20))
show('prepaid, bill day 4,  today 2026-10-04', prepaidPeriod('2026-10-04', 4))
show('prepaid, bill day 1,  today 2026-10-01', prepaidPeriod('2026-10-01', 1))
show('prepaid, bill day 31, today 2026-09-30', prepaidPeriod('2026-09-30', 31))
show('prepaid, bill day 31, today 2026-10-31', prepaidPeriod('2026-10-31', 31))
show('prepaid, bill day 31, today 2027-02-28', prepaidPeriod('2027-02-28', 31))
show('postpaid, bill day 1,  today 2026-10-01', postpaidPeriod('2026-10-01', 1))
show('postpaid, bill day 1,  today 2026-09-30', postpaidPeriod('2026-09-30', 1))
show('postpaid, bill day 26, today 2026-09-22', postpaidPeriod('2026-09-22', 26))
show('postpaid, bill day 31, today 2026-09-15', postpaidPeriod('2026-09-15', 31))

// ---------------------------------------------------------------------------
// JMEDIA: prepaid, engine start 2026-09-21 (today's hand charge stays alone).
// ---------------------------------------------------------------------------
const jmedia = await load(30)
console.log('\nJMEDIA (30), prepaid, start 2026-09-21, company bill day ' + jmedia.companyBillDay + ', ' + jmedia.customers.length + ' customers')
{
  const charged = new Set()
  const balances = new Map()
  const opts = (today, extra = {}) => ({ today, billingType: 'prepaid', startDate: '2026-09-21', charged, balances, ...extra })
  tick('22 Sep (today)', jmedia, opts('2026-09-22'))
  tick('23 Sep', jmedia, opts('2026-09-23'))
  tick('4 Oct  (4th group first charge)', jmedia, opts('2026-10-04', { showCharges: false }))
  tick('5 Oct  (same period again)', jmedia, opts('2026-10-05'))
  tick('20 Oct (20th group)', jmedia, opts('2026-10-20', { showCharges: true }))
  tick('21 Oct (same period again)', jmedia, opts('2026-10-21'))
  tick('1 Nov  (day-1 customers)', jmedia, opts('2026-11-01'))
  tick('4 Nov  (4th group again)', jmedia, opts('2026-11-04'))
  tick('20 Nov (20th group again)', jmedia, opts('2026-11-20'))
  console.log('  balances after 20 Nov for the two who held credit:')
  for (const id of [5744, 5758]) {
    const c = jmedia.customers.find((x) => x.id === id)
    const b = balances.get(id)
    console.log('      ' + id + ' ' + c.name.padEnd(20) + 'credit ' + money(c.credit) + ' -> ' + money(b?.credit ?? c.credit) + '   carried ' + money(c.carried) + ' -> ' + money(b?.carried ?? c.carried))
  }
}

// What a start date of 2026-09-20 would have done instead (the hazard).
{
  const charged = new Set()
  const balances = new Map()
  console.log('  -- if the start date were 2026-09-20 instead:')
  tick('22 Sep, start 20 Sep  (WOULD DOUBLE-CHARGE)', jmedia, { today: '2026-09-22', billingType: 'prepaid', startDate: '2026-09-20', charged, balances })
}

// ---------------------------------------------------------------------------
// Ezmze: prepaid per the user, bill day 1 for 983 of 989, engine start 1 Oct.
// ---------------------------------------------------------------------------
const ezmze = await load(27)
console.log('\nEZMZE (27), prepaid, start 2026-10-01, company bill day ' + ezmze.companyBillDay + ', ' + ezmze.customers.length + ' customers')
{
  const charged = new Set()
  const balances = new Map()
  const opts = (today) => ({ today, billingType: 'prepaid', startDate: '2026-10-01', charged, balances })
  tick('30 Sep', ezmze, opts('2026-09-30'))
  tick('1 Oct', ezmze, opts('2026-10-01'))
  tick('2 Oct  (same period again)', ezmze, opts('2026-10-02'))
  tick('1 Nov', ezmze, opts('2026-11-01'))
  const withAddons = ezmze.customers.filter((c) => c.addons > 0).length
  const withCredit = ezmze.customers.filter((c) => c.credit > 0).length
  console.log('  customers with add-ons: ' + withAddons + ', holding credit: ' + withCredit)
}

// The same company read as POSTPAID, to show the other shape on real rows.
{
  const charged = new Set()
  const balances = new Map()
  console.log('  -- the same rows if Ezmze were postpaid (bill day ' + ezmze.companyBillDay + '):')
  const opts = (today) => ({ today, billingType: 'postpaid', startDate: '2026-10-01', charged, balances })
  tick('30 Sep (postpaid)', ezmze, opts('2026-09-30'))
  tick('1 Oct  (postpaid)', ezmze, opts('2026-10-01'))
  tick('15 Oct (postpaid, same month)', ezmze, opts('2026-10-15'))
}

console.log('\nRead-only. Nothing was written.')
