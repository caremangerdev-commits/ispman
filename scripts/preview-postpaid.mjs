// READ-ONLY preview of postpaid day-based billing (owner, 11 Oct 2026) on each
// company's October bill day.
//
//   node scripts/preview-postpaid.mjs                 Vernon, Smartcomm Bogue, West Central, Smartcomm Networking
//   node scripts/preview-postpaid.mjs --company=31
//
// Writes nothing: no settings, no charges, no log. Needs the RADIUS tunnel.
//
// It runs the APP'S OWN CODE, not a copy: decideCompany (lib/data/billing-
// engine.ts), the decision the hourly tick makes, with the company's engine
// set live IN MEMORY ONLY, its start date on the bill day, and today the bill
// day. The settings as stored are printed beside the ones used.
//
// SERVICE AS IT STANDS NOW. The registry is read today, not on the bill day:
// a customer on now is counted on to the end of October. Anyone whose expiry
// falls before the bill day is listed — if they do not pay by then they are
// cut off, and their October is the days they had.
//
// Each company: what October comes to, and every customer whose October
// differs from a full month at their rate, with the reason.
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

// The app's temporary [perf] timing lines print on every schema probe.
const print = console.log
console.log = (...a) => {
  if (typeof a[0] === 'string' && a[0].startsWith('[perf]')) return
  print(...a)
}

const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href)
const { decideCompany } = await load('lib/data/billing-engine.ts')
const { readBillableCustomers } = await load('lib/data/bulk.ts')
const { readServiceBreaks } = await load('lib/data/service-breaks.ts')
const { chargesConnectionMonth, readConnectedOn } = await load('lib/data/prepaid-calendar.ts')
const { batchGetRadiusStatus } = await load('lib/radius-db.ts')
const { usernameKey } = await load('lib/radius/format.ts')
const { localDateOnly } = await load('lib/format.ts')
const { tenantClient } = await load('lib/supabase/tenant.ts')

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : null
}

// The owner's decisions, 11 Oct 2026, written to settings that day
// (scripts/postpaid-settings-2026-10-11.mjs): West Central's bill day is the
// 24th; each start date is the October bill day, so September — billed by Run
// Bills on 28 Sep and 2 Oct — stays as billed. A company with no start date
// stored is previewed from its October bill day.
//
// Smartcomm Networking (33) added 15 Oct 2026: its engine went live between
// 14 and 15 Oct (start 23 Oct, bill day 23), after this list was written.
const PLAN = [{ id: 31 }, { id: 32 }, { id: 26 }, { id: 33 }]
const only = arg('company') ? Number(arg('company')) : null
// --connection-month=on|off: the setting as it WILL be, before migration 0032
// makes it readable. Without it, the stored setting.
const connectionOverride = arg('connection-month') === null ? undefined : arg('connection-month') === 'on'

const db = tenantClient()
const money = (n) => 'J$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pad = (s, n) => String(s).padEnd(n)
const lpad = (s, n) => String(s).padStart(n)
const short = (ymd) => {
  const [, m, d] = ymd.split('-').map(Number)
  return d + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]
}

console.log('POSTPAID BY THE DAY: OCTOBER, ON EACH BILL DAY. READ-ONLY. Every engine stays as it is.')

for (const plan of PLAN) {
  if (only !== null && plan.id !== only) continue

  const { data: s, error } = await db.from('settings')
    .select('billing_type, timezone, bill_date, billing_engine_mode, billing_engine_start_date')
    .eq('company_id', plan.id).maybeSingle()
  if (error) throw new Error('Could not read settings: ' + error.message)
  const { data: co } = await db.from('companies').select('name').eq('id', plan.id).maybeSingle()

  const billDay = s?.bill_date ?? 1
  const today = '2026-10-' + String(billDay).padStart(2, '0')
  const timezone = s?.timezone || 'America/Jamaica'
  const company = {
    id: plan.id,
    name: co?.name ?? String(plan.id),
    timezone,
    companyBillDay: billDay,
    billingType: 'postpaid',
    mode: 'live',
    startDate: s?.billing_engine_start_date ?? today,
  }

  console.log('\n' + '='.repeat(100))
  console.log(company.name + ' (' + plan.id + ')')
  console.log('  stored:  ' + s?.billing_type + ', engine ' + s?.billing_engine_mode +
    ' from ' + (s?.billing_engine_start_date ?? 'never') + ', bill day ' + (s?.bill_date ?? 'none'))
  console.log('  preview: postpaid, engine live from ' + company.startDate + ', bill day ' + billDay)

  let decision
  let breaks
  let registry
  try {
    decision = await decideCompany(company, today, { chargeConnectionMonth: connectionOverride })
    const base = await readBillableCustomers(plan.id)
    breaks = await readServiceBreaks({ companyId: plan.id, timezone, today, customers: base })
    registry = await batchGetRadiusStatus(base.map((c) => c.identity))
  } catch (err) {
    console.error('\n' + err.message + '\nIs the SSH tunnel up? Nothing was written.')
    process.exit(1)
  }
  const connectedOn = await readConnectedOn(plan.id)
  const connectionMonth = connectionOverride ?? await chargesConnectionMonth(plan.id)
  console.log('  connection month: ' + (connectionMonth ? 'ON' : 'OFF') +
    (connectionOverride === undefined ? '' : ' (as set by --connection-month, not as stored)') +
    ' — customers connected in October are ' + (connectionMonth ? 'charged from connection day' : 'not charged for October'))
  // The connection day the engine uses: connected_on (0032), else the day the
  // record was made.
  const joinedOn = (c) => String(connectedOn.get(c.id) ?? c.dateAdded ?? '').slice(0, 10)
  const connectedInOctober = (c) => joinedOn(c) > '2026-10-01' && joinedOn(c) <= '2026-10-31'
  const connectedNote = (c) => 'connected ' + joinedOn(c) + (connectedOn.has(c.id) ? '' : ' (day the record was made; no connection day recorded)')

  const monthBreaks = (id) => (breaks.get(id) ?? [])
    .filter((b) => b.off <= '2026-10-31' && (b.back === null || b.back > '2026-10-01'))
  const describe = (b) => {
    const from = b.off < '2026-10-01' ? 'off before October' : 'off ' + short(b.off)
    if (b.back === null) return from + ', still off'
    if (b.back === today) return from + ', back on outside ISPMan (day not logged; counted from ' + short(today) + ')'
    return from + ', back ' + short(b.back)
  }

  const groups = {
    part: [], none: [], joinedCharged: [], connected: [], rounding: [], unprovisioned: [], zero: [], already: [], other: [],
  }
  let charged = 0
  let chargedTotal = 0
  let fullTotal = 0
  const expiringBefore = []

  for (const l of decision.lines) {
    const c = l.customer
    const d = l.decision
    const rate = c.monthlyCharge
    if (l.already) { groups.already.push(l); continue }
    if (d.verdict === 'charge') {
      charged += 1
      chargedTotal += d.amount
      fullTotal += rate
      if (d.serviceDays !== null && connectedInOctober(c)) groups.joinedCharged.push(l)
      else if (d.serviceDays !== null) groups.part.push(l)
      else if (d.amount !== rate) groups.rounding.push(l)
      const record = c.identity ? registry.get(usernameKey(c.identity)) : undefined
      const expiry = record?.expiry ? localDateOnly(record.expiry) : null
      if (record?.status === 'active' && expiry !== null && expiry < today) expiringBefore.push({ l, expiry })
    } else if (d.verdict === 'no_service') groups.none.push(l)
    else if (d.verdict === 'joined_after') groups.connected.push(l)
    else if (d.verdict === 'unprovisioned') groups.unprovisioned.push(l)
    else if (d.verdict === 'zero_rate') groups.zero.push(l)
    else groups.other.push(l)
  }

  console.log('\n  ' + decision.considered + ' customers. October billed on ' + short(today) + ': ' +
    charged + ' charged, ' + money(chargedTotal) + '  (at full-month rates: ' + money(fullTotal) +
    ', difference ' + money(chargedTotal - fullTotal) + ')')
  console.log('  verdicts: ' + JSON.stringify(decision.counts))

  const row = (l, tail) => '    ' + lpad(l.customer.id, 5) + '  ' + pad(l.customer.name.slice(0, 30), 31) +
    lpad(money(l.customer.monthlyCharge), 12) + '  ' + tail

  console.log('\n  PART OF OCTOBER (' + groups.part.length + '): rate -> charge, days of 31')
  for (const l of groups.part.sort((a, b) => a.decision.serviceDays - b.decision.serviceDays)) {
    console.log(row(l, '-> ' + lpad(money(l.decision.amount), 11) + '  ' + lpad(l.decision.serviceDays, 2) + ' days  ' +
      monthBreaks(l.customer.id).map(describe).join('; ')))
  }

  console.log('\n  NOTHING FOR OCTOBER, OFF ALL MONTH SO FAR (' + groups.none.length + ')')
  for (const l of groups.none.sort((a, b) => a.customer.name.localeCompare(b.customer.name))) {
    console.log(row(l, monthBreaks(l.customer.id).map(describe).join('; ')))
  }

  const joinedTotal = groups.joinedCharged.reduce((s, l) => s + l.decision.amount, 0)
  console.log('\n  CONNECTED IN OCTOBER, CHARGED FROM THE CONNECTION DAY (' + groups.joinedCharged.length + ', ' + money(joinedTotal) + ')')
  for (const l of groups.joinedCharged.sort((a, b) => joinedOn(a.customer).localeCompare(joinedOn(b.customer)))) {
    const off = monthBreaks(l.customer.id).map(describe).join('; ')
    console.log(row(l, '-> ' + lpad(money(l.decision.amount), 11) + '  ' + lpad(l.decision.serviceDays, 2) + ' days  ' +
      connectedNote(l.customer) + (off ? '; ' + off : '')))
  }

  console.log('\n  CONNECTED IN OCTOBER, NOT CHARGED (' + groups.connected.length + ')')
  for (const l of groups.connected) console.log(row(l, connectedNote(l.customer)))

  console.log('\n  FULL MONTH, ROUNDED TO THE NEAREST HUNDRED (' + groups.rounding.length + ')')
  for (const l of groups.rounding) {
    console.log(row(l, '-> ' + lpad(money(l.decision.amount), 11) + '  (' +
      (l.decision.amount > l.customer.monthlyCharge ? '+' : '') + money(l.decision.amount - l.customer.monthlyCharge) + ')'))
  }

  console.log('\n  NOT IN THE NETWORK REGISTRY, NOT CHARGED (' + groups.unprovisioned.length + ')')
  for (const l of groups.unprovisioned) console.log(row(l, l.customer.identity ? 'username ' + l.customer.identity : 'no username'))

  if (groups.zero.length) {
    console.log('\n  NO RATE, NOT CHARGED (' + groups.zero.length + ')')
    for (const l of groups.zero) console.log(row(l, ''))
  }
  if (groups.already.length) console.log('\n  OCTOBER ALREADY CHARGED BY THE ENGINE: ' + groups.already.length)
  if (groups.other.length) {
    console.log('\n  OTHER (' + groups.other.length + ')')
    for (const l of groups.other) console.log(row(l, l.decision.verdict))
  }

  console.log('\n  ON NOW, EXPIRY BEFORE ' + short(today).toUpperCase() + ' (' + expiringBefore.length +
    '): counted on to the month end above; unpaid by then, they are cut off and charged the days they had')
  for (const { l, expiry } of expiringBefore.sort((a, b) => a.expiry.localeCompare(b.expiry))) {
    console.log(row(l, 'expires ' + short(expiry)))
  }
}

console.log('\nNothing was written.')
process.exit(0)
