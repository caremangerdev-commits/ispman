// READ-ONLY preview of calendar-month prepaid for one company (migration 0028).
//
//   node scripts/preview-prepaid-calendar.mjs                 Ezmze (27)
//   node scripts/preview-prepaid-calendar.mjs --company=30
//
// Writes nothing. Needs the RADIUS tunnel, like the hourly pass does.
//
// It runs the APP'S OWN CODE, not a copy: planServicePass (the hourly service
// pass's read-only half), engineVerdict (the billing run's decision) and
// firstPeriodAnchor (the till's first-payment test). What it prints is what the
// next hourly pass would do, not an estimate of it. The model applies to a
// prepaid company whose engine is live (lib/data/prepaid-calendar.ts); for any
// other company this shows what it WOULD do.
//
//   1. THE NEXT HOURLY PASS. Who the pass would find with service ended, and
//      what their month's charge would become — the days they had, rounded.
//      Customers with no charge for that month are only marked; nothing about
//      their balance changes.
//
//   2. FIRST PAYMENTS STILL TO COME. Customers provisioned under the old rules
//      who have not paid since. Option A (owner, 8 Oct 2026): they finish on
//      the old first-payment rule, the till pricing them as it did before the
//      model; anyone provisioned under the model is counted apart.
//
//   3. 1 NOVEMBER. What the billing run would charge on the company's bill
//      day for November, for customers whose service is on now: the full
//      month, rounded to the nearest hundred.
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const EMPTY = 'data:text/javascript,export default {}'

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'server-only') return { url: EMPTY, shortCircuit: true }
    // next/navigation and friends are CommonJS files without an exports map.
    // Only the app's own imports: next's own requires resolve themselves.
    if (/^next[/][a-z-]+$/.test(spec) && !ctx.parentURL?.includes('node_modules')) {
      return next(spec + '.js', ctx)
    }
    const base =
      spec.startsWith('@/') ? path.join(ROOT, spec.slice(2))
        : (spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:') && !path.extname(spec)
          ? path.join(path.dirname(new URL(ctx.parentURL).pathname.replace(/^[/]([A-Za-z]:)/, '$1')), spec)
          : null
    if (base) {
      for (const cand of [base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
        if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true }
      }
    }
    return next(spec, ctx)
  },
})

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.trim().startsWith('#')) {
    process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
}

// The app's temporary [perf] timing lines print on every schema probe, which
// outside a request is every call. Not this preview's business.
const print = console.log
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('[perf]')) return
  print(...a)
}

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href)
const { planServicePass } = await load('lib/data/prepaid-service.ts')
const { firstPeriodAnchor } = await load('lib/data/first-period.ts')
const { provisionedUnderModel } = await load('lib/data/provision.ts')
const { readBillableCustomers } = await load('lib/data/bulk.ts')
const { addonTotals } = await load('lib/data/addon-totals.ts')
const { batchGetRadiusStatus } = await load('lib/radius-db.ts')
const { usernameKey } = await load('lib/radius/format.ts')
const { engineVerdict } = await load('lib/billing-engine.ts')
const { tenantClient } = await load('lib/supabase/tenant.ts')

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : null
}
const COMPANY = Number(arg('company') ?? 27)
const db = tenantClient()
const money = (n) => 'J$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)

const { data: settings, error: settingsError } = await db.from('settings')
  .select('billing_type, timezone, bill_date, billing_engine_mode, billing_engine_start_date, reconnection_fee')
  .eq('company_id', COMPANY).maybeSingle()
if (settingsError) {
  console.error(settingsError.code === '42703'
    ? 'Migration 0028 is not applied. Apply it first; nothing was read.'
    : 'Could not read settings: ' + settingsError.message)
  process.exit(1)
}
const { data: companyRow } = await db.from('companies').select('name').eq('id', COMPANY).maybeSingle()
const timezone = settings?.timezone || 'America/Jamaica'
const applies = settings?.billing_type === 'prepaid' && settings?.billing_engine_mode === 'live'

console.log('CALENDAR-MONTH PREPAID. READ-ONLY.')
console.log('Company ' + COMPANY + ' ' + (companyRow?.name ?? '') + ' | billing_type ' + settings?.billing_type +
  ' | engine ' + settings?.billing_engine_mode + ' from ' + (settings?.billing_engine_start_date ?? 'never') +
  ' | reconnection fee ' + money(settings?.reconnection_fee ?? 0) +
  ' | bill day ' + (settings?.bill_date ?? 1))
console.log(applies
  ? 'The model applies to this company now.'
  : 'The model does NOT apply to this company (it needs prepaid with the engine live). Below is what it WOULD do.')

// ---------------------------------------------------------------------------
// 1. The next hourly pass
// ---------------------------------------------------------------------------
let plan
try {
  plan = await planServicePass({ id: COMPANY, timezone })
} catch (err) {
  console.error('\n' + err.message + '\nIs the SSH tunnel up? Nothing was written.')
  process.exit(1)
}

const ended = plan.changes.filter((c) => c.kind === 'ended')
const reduced = ended.filter((c) => c.from && c.to)
const marked = ended.filter((c) => !c.from)
const resumed = plan.changes.filter((c) => c.kind === 'resumed')

console.log('\n1. THE NEXT HOURLY PASS (today ' + plan.today + ')')
console.log('   Charges reduced to the days of service: ' + reduced.length)
let totalBefore = 0
let totalAfter = 0
for (const c of reduced.sort((a, b) => a.on.localeCompare(b.on) || a.name.localeCompare(b.name))) {
  totalBefore += c.from.amount
  totalAfter += c.to.amount
  console.log('     ' + lpad(c.customerId, 5) + '  ' + pad(c.name, 30) + ' ended ' + c.on + '  ' +
    c.periodStart.slice(0, 7) + '  ' + lpad(money(c.from.amount), 12) + ' -> ' + lpad(money(c.to.amount), 11) +
    '  (' + c.to.days + ' days)')
}
if (reduced.length) {
  console.log('     ' + pad('', 37) + 'total ' + lpad(money(totalBefore), 30) + ' -> ' + lpad(money(totalAfter), 11) +
    '   balances fall by ' + money(totalBefore - totalAfter))
}
console.log('   Service ended, no charge for that month (marked only, balance unchanged): ' + marked.length)
const byMonth = {}
for (const c of marked) byMonth[c.on.slice(0, 7)] = (byMonth[c.on.slice(0, 7)] ?? 0) + 1
for (const [m, n] of Object.entries(byMonth).sort()) console.log('     ended in ' + m + ': ' + n)
if (resumed.length) {
  console.log('   Resumed (marked and back on, not through the till): ' + resumed.length)
}

// ---------------------------------------------------------------------------
// 2. First payments still to come
// ---------------------------------------------------------------------------
const { data: provisions, error: provError } = await db.from('log')
  .select('customer_id')
  .eq('company_id', COMPANY).eq('type', 'network_provision').not('customer_id', 'is', null)
  .limit(10000)
if (provError) throw new Error(provError.message)
const candidates = [...new Set(provisions.map((r) => r.customer_id))]
const pending = []
let underModel = 0
for (const id of candidates) {
  const anchor = await firstPeriodAnchor(COMPANY, id)
  if (!anchor) continue
  if (await provisionedUnderModel(COMPANY, id)) underModel += 1
  else pending.push({ id, anchor })
}
console.log('\n2. PROVISIONED BEFORE THE MODEL, FIRST PAYMENT STILL TO COME: ' + pending.length +
  ' (of ' + candidates.length + ' ever provisioned in the app; ' + underModel + ' more provisioned under the model)')
if (pending.length) {
  const { data: rows } = await db.from('customers')
    .select('id, first_name, last_name, carried_balance, monthly_rate')
    .eq('company_id', COMPANY).in('id', pending.map((p) => p.id))
  const byId = new Map((rows ?? []).map((r) => [r.id, r]))
  for (const p of pending.sort((a, b) => a.anchor - b.anchor)) {
    const r = byId.get(p.id)
    console.log('     ' + lpad(p.id, 5) + '  ' + pad([r?.first_name, r?.last_name].filter(Boolean).join(' '), 30) +
      ' provisioned ' + p.anchor.toISOString().slice(0, 10) +
      '  balance ' + lpad(money(r?.carried_balance ?? 0), 11) + '  rate ' + money(r?.monthly_rate ?? 0))
  }
  console.log('   Option A (owner, 8 Oct 2026): their first payment is priced on the old rule, as it')
  console.log('   was before the model. After it they are on the model like everyone else.')
}

// ---------------------------------------------------------------------------
// 3. 1 November
// ---------------------------------------------------------------------------
const customers = await readBillableCustomers(COMPANY)
const addons = await addonTotals(customers.map((c) => c.id))
const registry = await batchGetRadiusStatus(customers.map((c) => c.identity))
const endingIds = new Set(ended.map((c) => c.customerId))
let count = 0
let total = 0
const tally = {}
for (const c of customers) {
  const record = c.identity ? registry.get(usernameKey(c.identity)) : undefined
  const service = !record || !record.exists ? 'unprovisioned' : record.status === 'active' ? 'active' : 'disconnected'
  const d = engineVerdict({
    billingType: settings?.billing_type ?? 'prepaid',
    today: '2026-11-01',
    startDate: settings?.billing_engine_start_date ?? null,
    companyBillDay: settings?.bill_date ?? null,
    customer: { id: c.id, dateAdded: c.dateAdded, monthlyCharge: c.monthlyRate + (addons.get(c.id) ?? 0) },
    service: endingIds.has(c.id) ? 'disconnected' : service,
  })
  tally[d.verdict] = (tally[d.verdict] ?? 0) + 1
  if (d.verdict === 'charge') { count += 1; total += d.amount }
}
console.log('\n3. 1 NOVEMBER, if service stays as it is now: ' + count + ' charged, ' + money(total) +
  ' (November, full month, each rounded to the nearest hundred)')
console.log('   verdicts: ' + JSON.stringify(tally))
console.log('   Customers cut off before then are not charged for November; anyone who pays and comes')
console.log('   back is charged at the till for the days to the month end.')

console.log('\nNothing was written.')
process.exit(0)
