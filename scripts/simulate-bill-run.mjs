// READ-ONLY simulation of the bill run, kept as the check that went with billing by bill date.
//
//   node scripts/simulate-bill-run.mjs
//
// Real customer rows, the REAL decision (lib/billing.ts#billRunVerdict — the one call the
// preview and the write both make), and an injected "today". Nothing is written: a run's
// stamps are applied to an in-memory copy only.
//
// What it shows: JMEDIA on 20 Sep under the old whole-company behaviour and the new default;
// the same run pressed late on the 23rd and too late on the 25th; JMEDIA on 4 Oct and 20 Oct
// as two runs of one period; Ezmze on 1 Oct billing the identical set either way; and the
// payment label agreeing with the run for a company billed on its own day.
//
// JMEDIA's expiries are rebuilt from the log because radcheck is not reachable from a
// workstation. Ezmze's service state is assumed active: what is being compared there is
// due-versus-all, which service state does not affect.
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
registerHooks({ resolve(s, c, n) {
  if (s.startsWith('@/')) { const b = path.join(ROOT, s.slice(2)); for (const e of ['.ts', '.tsx']) if (existsSync(b + e)) return { url: pathToFileURL(b + e).href, shortCircuit: true } }
  return n(s, c) } })
const { billRunVerdict, billingPeriodLabel, effectiveBillDay } = await import(pathToFileURL(path.join(ROOT, 'lib/billing.ts')).href)

const { createClient } = createRequire(ROOT + '/package.json')('@supabase/supabase-js')
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.trim().startsWith('#')) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim()
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
async function all(build) { const out = []; for (let f = 0; ; f += 1000) { const { data, error } = await build().range(f, f + 999); if (error) throw new Error(error.message); out.push(...data); if (data.length < 1000) break } return out }

async function load(companyId) {
  const rows = await all(() => db.from('customers')
    .select('id, first_name, last_name, monthly_rate, last_billed_date, bill_date, date_added, mac_address')
    .eq('company_id', companyId).order('id'))
  const { data: s } = await db.from('settings').select('bill_date').eq('company_id', companyId).maybeSingle()
  return {
    companyBillDate: s?.bill_date ?? null,
    customers: rows.map((r) => ({
      id: r.id, name: [r.first_name, r.last_name].filter(Boolean).join(' '),
      monthlyRate: Number(r.monthly_rate ?? 0), lastBilledDate: r.last_billed_date,
      billDate: r.bill_date, dateAdded: r.date_added, mac: r.mac_address,
    })),
  }
}

const period = (key) => {
  const [y, m] = key.split('-').map(Number)
  const pad = (n) => String(n).padStart(2, '0')
  return { key, start: y + '-' + pad(m) + '-01', end: y + '-' + pad(m) + '-' + pad(new Date(y, m, 0).getDate()) }
}

/** One run. `expiry` maps customer id -> YYYY-MM-DD held in radcheck, or is null for "assume active". */
function run(label, { customers, companyBillDate }, { today, periodKey, scope, expiry }) {
  const p = period(periodKey)
  const tally = {}
  const byDay = new Map()
  const billed = []
  for (const c of customers) {
    const held = expiry ? expiry.get(c.id) : '9999-12-31'
    const service = !c.mac || !held ? 'unprovisioned' : held > today ? 'active' : 'disconnected'
    const d = billRunVerdict({ period: p, scope, today, companyBillDate, customer: c, service })
    tally[d.verdict] = (tally[d.verdict] ?? 0) + 1
    const line = byDay.get(d.billDay) ?? { due: d.dueDate, bill: 0, not_due: 0, before_joined: 0, other: 0 }
    if (d.verdict in line) line[d.verdict]++; else line.other++
    byDay.set(d.billDay, line)
    if (d.verdict === 'bill') billed.push(c)
  }
  console.log('\n' + label)
  console.log('  today ' + today + ' | period ' + periodKey + ' | scope ' + scope)
  for (const [day, l] of [...byDay].sort((a, b) => a[0] - b[0])) {
    console.log('    bill day ' + String(day).padEnd(3) + 'due ' + l.due + '  included ' + String(l.bill).padEnd(4) +
      ' not due ' + String(l.not_due).padEnd(4) + ' joined after ' + String(l.before_joined).padEnd(4) + ' other skips ' + l.other)
  }
  console.log('  verdicts: ' + JSON.stringify(tally) + '  => BILLED ' + billed.length +
    ', J$' + billed.reduce((s, c) => s + c.monthlyRate, 0).toLocaleString())
  return { billed, stampEnd: p.end }
}

// ---------------------------------------------------------------------------
// JMEDIA: expiries rebuilt from the log (radcheck is not reachable from here).
// ---------------------------------------------------------------------------
const jm = await load(30)
const { data: netlog } = await db.from('log').select('id, customer_id, type, details')
  .eq('company_id', 30).in('type', ['network_provision', 'network_extend', 'network_expiry_corrected', 'network_reconnect', 'network_disconnect']).order('id')
const expiry = new Map()
// log #2612: 55 customers bulk-provisioned to 2026-09-24. #5728 was provisioned by hand earlier.
for (const c of jm.customers) expiry.set(c.id, '2026-09-24')
for (const l of netlog) {
  const dates = l.details.match(/20\d\d-\d\d-\d\d/g) ?? []
  if (dates.length) expiry.set(l.customer_id, dates[dates.length - 1])
}
const held = {}
for (const c of jm.customers) { const k = 'bill ' + c.billDate + ' holds ' + expiry.get(c.id); held[k] = (held[k] ?? 0) + 1 }
console.log('JMEDIA, expiries as the log leaves them today:')
for (const [k, v] of Object.entries(held).sort()) console.log('   ' + k.padEnd(28) + v)

console.log('\n' + '='.repeat(96) + '\nJMEDIA on 20 SEPTEMBER\n' + '='.repeat(96))
run('OLD BEHAVIOUR (scope all) — what pressing Bill All would have done', jm, { today: '2026-09-20', periodKey: '2026-08', scope: 'all', expiry })
const a = run('NEW DEFAULT (scope due)', jm, { today: '2026-09-20', periodKey: '2026-08', scope: 'due', expiry })
run('...the same run pressed LATE, on 23 September (last day of the window)', jm, { today: '2026-09-23', periodKey: '2026-08', scope: 'due', expiry })
run('...and on 25 September, nobody having paid: late is still DUE, but access has lapsed', jm, { today: '2026-09-25', periodKey: '2026-08', scope: 'due', expiry })

// Carry the 20 Sep run forward in memory: stamp who was billed; say the 20th-group then paid
// and were written to 28 Oct (24 Oct + 4 grace), which is what serviceExpiry gives them.
const after = { ...jm, customers: jm.customers.map((c) => a.billed.includes(c) ? { ...c, lastBilledDate: a.stampEnd } : c) }
const expiryOct = new Map(expiry)
for (const c of a.billed) expiryOct.set(c.id, '2026-10-28')

console.log('\n' + '='.repeat(96) + '\nJMEDIA on 4 OCTOBER (after the 20 Sep run; the 20th-group paid and hold 28 Oct)\n' + '='.repeat(96))
run('NEW DEFAULT, the picker\'s default period (September)', after, { today: '2026-10-04', periodKey: '2026-09', scope: 'due', expiry: expiryOct })
run('...and if somebody picked AUGUST again on 4 Oct: the guard holds, and the 4th-group are still not August\'s', after, { today: '2026-10-04', periodKey: '2026-08', scope: 'due', expiry: expiryOct })
run('...then 20 OCTOBER, September again: the second run of the same period', {
  ...after, customers: after.customers.map((c) => effectiveBillDay(c.billDate, after.companyBillDate) === 4 && c.monthlyRate > 0 ? { ...c, lastBilledDate: '2026-09-30' } : c),
}, { today: '2026-10-20', periodKey: '2026-09', scope: 'due', expiry: expiryOct })

// ---------------------------------------------------------------------------
// Ezmze on 1 October. radcheck unknown from here, so everyone is assumed active:
// the comparison that matters is due-vs-all, which service state does not affect.
// ---------------------------------------------------------------------------
const ez = await load(27)
console.log('\n' + '='.repeat(96) + '\nEZMZE on 1 OCTOBER (service assumed active for all; radcheck decides that on the day)\n' + '='.repeat(96))
const e1 = run('OLD BEHAVIOUR (scope all), September', ez, { today: '2026-10-01', periodKey: '2026-09', scope: 'all', expiry: null })
const e2 = run('NEW DEFAULT (scope due), September', ez, { today: '2026-10-01', periodKey: '2026-09', scope: 'due', expiry: null })
const same = e1.billed.length === e2.billed.length && e1.billed.every((c, i) => c.id === e2.billed[i].id)
console.log('\n  SAME CUSTOMERS BILLED, old vs new: ' + (same ? 'YES — identical set of ' + e2.billed.length : 'NO'))
run('...a re-run of AUGUST today (19 Sep), old behaviour: who it would still bill', ez, { today: '2026-09-19', periodKey: '2026-08', scope: 'all', expiry: null })
run('...the same re-run under the new default', ez, { today: '2026-09-19', periodKey: '2026-08', scope: 'due', expiry: null })

// ---------------------------------------------------------------------------
// The payment label and the run now agree, for a company billed on its own day.
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(96) + '\nONE BILL DAY, BOTH CALLERS — a Vernon customer (no bill date; company day 26) owing J$3,500\n' + '='.repeat(96))
for (const day of ['2026-09-19', '2026-09-26', '2026-09-27']) {
  const [y, m, d] = day.split('-').map(Number)
  const at = new Date(y, m - 1, d)
  const before = billingPeriodLabel(at, effectiveBillDay(null, null), 3500)   // what `?? 1` used to give
  const now = billingPeriodLabel(at, effectiveBillDay(null, 26), 3500)
  const runSays = billRunVerdict({ period: period('2026-08'), scope: 'due', today: day, companyBillDate: 26,
    customer: { lastBilledDate: null, billDate: null, dateAdded: '2019-01-01', monthlyRate: 3500 }, service: 'active' })
  console.log('  ' + day + ': payment label was "' + before + '", is now "' + now + '"  | bill run, August: ' + runSays.verdict + ' (due ' + runSays.dueDate + ')')
}
