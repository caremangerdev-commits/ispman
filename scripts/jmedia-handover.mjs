#!/usr/bin/env node
/**
 * JMEDIA (company 30) onto the billing engine: each customer's "billed through"
 * date — the last day already charged by hand — so the engine charges only the
 * days after it. Owner, 8 Oct 2026:
 *
 *   "Engine live from 1 November, November charged only for the days after
 *    each customer's current paid period, full calendar months from December.
 *    Cut-off days stay the 7th and 24th. Preview it before anything goes live."
 *
 *   node scripts/jmedia-handover.mjs                          dry run (default): the preview
 *   node scripts/jmedia-handover.mjs --apply --user=<users.id>
 *
 * NEEDS migration 0030 (customers.billed_through) for --apply, and the RADIUS
 * tunnel for both. The dry run works before 0030.
 *
 * THE RULE, per customer (B = their bill day, 4 or 20; E = their RADIUS expiry)
 *   - Their current period is the bill-date period that runs into November:
 *     4 Oct to 4 Nov, or 20 Oct to 20 Nov. Billed through the day before it
 *     ends: 3 Nov or 19 Nov. November is then charged for the days after —
 *     4 to 30 Nov (27 days) or 20 to 30 Nov (11 days) — and every month from
 *     December in full. A bill day of 1 is billed through 31 Oct: November in
 *     full.
 *   - PAID AHEAD outside credit: an expiry further out than that period, with
 *     no account credit holding the prepayment, means the months were paid in
 *     the legacy till. Billed through the day before the last bill day on or
 *     before the expiry. Every one is FLAGGED for a person to confirm.
 *   - Paid ahead INTO CREDIT (account_credit > 0): the prepayment is already
 *     money the engine draws from; counting the months as billed too would give
 *     them twice. The ordinary date stands.
 *
 * ORDER (the 20th group's 20 Oct charge is still to be raised by hand, and Run
 * Bills refuses once the engine is live):
 *   1. On 20 Oct, charge the 20th group's 20 Oct to 20 Nov period as before.
 *   2. Re-run this dry run, read it.
 *   3. --apply (refused before 20 Oct, company time).
 *   4. Settings > Billing for JMEDIA: Engine Live, start date 2026-11-01.
 *
 * WHAT --apply WRITES: customers.billed_through where it is still NULL
 * (guarded), and one billed_through_set log row per customer, correlation_id
 * = the run id. Nothing else — no balance, no expiry, no setting.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('@/')) {
      const b = path.join(ROOT, spec.slice(2))
      for (const e of ['.ts', '.tsx']) if (existsSync(b + e)) return { url: pathToFileURL(b + e).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})
const { engineVerdict } = await import(pathToFileURL(path.join(ROOT, 'lib/billing-engine.ts')).href)
const { effectiveBillDay } = await import(pathToFileURL(path.join(ROOT, 'lib/billing.ts')).href)

const req = createRequire(ROOT + '/package.json')
const { createClient } = req('@supabase/supabase-js')
const mysql = req('mysql2/promise')

const APPLY = process.argv.includes('--apply')
const userArg = process.argv.find((x) => x.startsWith('--user='))
const USER_ID = userArg ? Number(userArg.slice('--user='.length)) : null
if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log rows name who set these.')
  process.exit(1)
}

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.trim().startsWith('#')) {
    process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const COMPANY = 30
const START = '2026-11-01'

// FLAGGED customers the owner confirmed on 8 Oct 2026, each AT THE DATE the
// preview showed then. --apply writes a flagged customer only if they are here
// and the rule still gives the same date; anything else is skipped and listed.
const CONFIRMED = new Map([
  [5708, '2027-10-03'], // Ann brown, expiry Oct 2027
  [5711, '2027-02-03'], // Miss simms, expiry Feb 2027
  [5722, '2026-12-19'], // Louie Thomas, "paid for until december 20"
  [5736, '2027-04-03'], // Shadae clarke, expiry Apr 2027
  [5746, '2028-09-30'], // Gio, rate 0
  [5750, '2027-10-19'], // Rent13 Mr Fix It, "not to be charged"
  [5779, '2026-12-03'], // Aaron ebanks, unpaid first period to 7 Dec (old rule)
  [5780, '2028-01-03'], // Jayden Pryce, expiry Jan 2028
])

// HELD by the owner: no billed-through date until JMEDIA says which is right.
const HELD = new Map([
  [5747, 'Marlon Crowe: expiry Nov 2027 and a J$3,500 debt contradict each other (owner, 8 Oct 2026)'],
])
const RUN_ID = randomUUID()
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n) => String(n).padStart(2, '0')
const money = (n) => 'J$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()

/** "07 Nov 2026 13:00" -> "2026-11-07", the date written. */
function expiryDate(value) {
  const p = String(value ?? '').trim().split(/\s+/)
  const m = MONTHS.indexOf((p[1] ?? '').toLowerCase())
  if (p.length < 3 || m === -1 || !Number(p[0])) return null
  return p[2] + '-' + pad(m + 1) + '-' + pad(Number(p[0]))
}

/** The day before `ymd`. */
function dayBefore(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d - 1))
  return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate())
}

/** The last occurrence of bill day `b` on or before `ymd` (clamped to short months). */
function lastBillDayOnOrBefore(ymd, b) {
  let [y, m] = ymd.split('-').map(Number)
  const d = Number(ymd.slice(8, 10))
  let day = Math.min(b, daysIn(y, m))
  if (day > d) {
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
    day = Math.min(b, daysIn(y, m))
  }
  return y + '-' + pad(m) + '-' + pad(day)
}

async function main() {
  const { data: settings } = await db.from('settings').select('bill_date, timezone, billing_engine_mode, billing_engine_start_date')
    .eq('company_id', COMPANY).maybeSingle()
  const companyDay = settings?.bill_date ?? 1
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: settings?.timezone || 'America/Jamaica' }).format(new Date())

  if (APPLY && today < '2026-10-20') {
    console.error('Refused: it is ' + today + '. Apply after the 20th group\'s 20 Oct charge has been raised (see ORDER in the header).')
    process.exit(1)
  }

  const probe = await db.from('customers').select('billed_through').limit(1)
  const has0030 = !probe.error
  if (APPLY && !has0030) {
    console.error('Refused: migration 0030 (customers.billed_through) is not applied.')
    process.exit(1)
  }

  const { data: custs, error } = await db.from('customers')
    .select('id, first_name, last_name, mac_address, pppoe_username, customer_type, bill_date, cut_off_date, monthly_rate, carried_balance, account_credit, last_billed_date' +
      (has0030 ? ', billed_through' : ''))
    .eq('company_id', COMPANY).order('id')
  if (error) throw new Error(error.message)

  const ids = custs.map((c) => c.id)
  const { data: links } = await db.from('customer_additional_services')
    .select('customer_id, additional_services(monthly_price)').in('customer_id', ids)
  const addons = new Map()
  for (const l of links ?? []) addons.set(l.customer_id, (addons.get(l.customer_id) ?? 0) + Number(l.additional_services?.monthly_price ?? 0))

  const my = await mysql.createConnection({
    host: process.env.RADIUS_DB_HOST, user: process.env.RADIUS_DB_USER, password: process.env.RADIUS_DB_PASSWORD,
    database: process.env.RADIUS_DB_NAME, port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    dateStrings: true, connectTimeout: 8000,
  }).catch((err) => {
    console.error('RADIUS not reachable (' + (err.code ?? err.message) + ') — is the SSH tunnel up? Nothing was read or written.')
    process.exit(1)
  })
  const [rc] = await my.query("SELECT username, value FROM radcheck WHERE attribute = 'Expiration'")
  await my.end()
  const exp = new Map()
  for (const r of rc) exp.set(r.username.trim().toUpperCase(), [...(exp.get(r.username.trim().toUpperCase()) ?? []), r.value])

  console.log('JMEDIA hand-over to the engine (start ' + START + ')   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  console.log('Today ' + today + ' | engine now ' + settings?.billing_engine_mode + ' from ' + (settings?.billing_engine_start_date ?? 'never') +
    ' | company bill day ' + companyDay + (has0030 ? '' : ' | migration 0030 NOT applied (dry run only)'))
  console.log('ASSUMES the 20th group\'s 20 Oct to 20 Nov period is charged by hand on 20 Oct, as before.\n')

  const plan = []
  for (const c of custs) {
    const identity = ((c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address) ?? '').trim().toUpperCase()
    const rows = identity ? exp.get(identity) ?? [] : []
    const E = rows.length === 1 ? expiryDate(rows[0]) : null
    const B = effectiveBillDay(c.bill_date, companyDay)
    const credit = Number(c.account_credit ?? 0)
    const carried = Number(c.carried_balance ?? 0)
    const rate = Number(c.monthly_rate ?? 0) + (addons.get(c.id) ?? 0)

    // The bill-date period running into November ends on B Nov.
    const base = B > 1 ? '2026-11-' + pad(B - 1) : '2026-10-31'
    let through = base
    const notes = []
    let flag = false
    if (rows.length !== 1) { notes.push(rows.length + ' expiry rows'); flag = true }
    if (E) {
      const ahead = dayBefore(lastBillDayOnOrBefore(E, B))
      if (ahead > base) {
        if (credit > 0) {
          notes.push('paid ahead into credit ' + money(credit) + ' (expiry ' + E + '): credit pays the months, not counted twice')
        } else {
          through = ahead
          flag = true
          notes.push('PAID AHEAD outside credit: expiry ' + E)
        }
      }
    }
    if (rate <= 0) notes.push('rate 0')
    if (carried > 0) notes.push('owes ' + money(carried) + ' now')

    const verdict = (today2) => engineVerdict({
      billingType: 'prepaid', today: today2, startDate: START, companyBillDay: companyDay,
      customer: { id: c.id, dateAdded: null, monthlyCharge: rate, billedThrough: through },
      service: 'active',
    })
    const nov = verdict('2026-11-01')
    const dec = verdict('2026-12-01')
    plan.push({
      c, B, E, through, base, rate, credit, carried, flag, notes,
      nov: nov.verdict === 'charge' ? nov : null, novWhy: nov.verdict,
      dec: dec.verdict === 'charge' ? dec : null, decWhy: dec.verdict,
      existing: has0030 ? c.billed_through ?? null : null,
    })
  }

  const line = (p) => {
    const name = ((p.c.first_name ?? '') + ' ' + (p.c.last_name ?? '')).trim().slice(0, 26)
    const nov = p.nov ? money(p.nov.amount) + (p.nov.serviceDays !== null ? ' (' + p.nov.serviceDays + 'd)' : ' (full)') : p.novWhy
    const dec = p.dec ? money(p.dec.amount) + (p.dec.serviceDays !== null ? ' (' + p.dec.serviceDays + 'd)' : '') : p.decWhy
    return '  ' + String(p.c.id).padEnd(6) + name.padEnd(28) + ('bill ' + p.B).padEnd(9) + ('cut ' + p.c.cut_off_date).padEnd(8) +
      money(p.rate).padEnd(9) + ('exp ' + (p.E ?? '-')).padEnd(16) + ('through ' + p.through).padEnd(20) +
      ('Nov ' + nov).padEnd(22) + ('Dec ' + dec).padEnd(16) + p.notes.join('; ')
  }

  // What --apply would do with each flagged or held customer.
  for (const p of plan) {
    if (HELD.has(p.c.id)) p.status = 'held'
    else if (!p.flag) p.status = 'write'
    else if (CONFIRMED.get(p.c.id) === p.through) p.status = 'write'
    else p.status = 'unconfirmed'
  }

  for (const [title, test] of [
    ['4TH GROUP (bill 4, cut-off 7)', (p) => p.B === 4 && !p.flag && p.status === 'write'],
    ['20TH GROUP (bill 20, cut-off 24)', (p) => p.B === 20 && !p.flag && p.status === 'write'],
    ['OTHER BILL DAYS', (p) => p.B !== 4 && p.B !== 20 && !p.flag && p.status === 'write'],
    ['FLAGGED, CONFIRMED by the owner 8 Oct at this date', (p) => p.flag && p.status === 'write'],
    ['FLAGGED, NOT CONFIRMED — skipped by --apply until the owner confirms', (p) => p.status === 'unconfirmed'],
    ['HELD — no date written', (p) => p.status === 'held'],
  ]) {
    const rows = plan.filter(test)
    if (!rows.length) continue
    console.log(title + ' (' + rows.length + ')')
    for (const p of rows) {
      console.log(line(p))
      if (p.status === 'held') console.log('        ' + HELD.get(p.c.id))
      if (p.status === 'unconfirmed' && CONFIRMED.has(p.c.id)) {
        console.log('        confirmed at ' + CONFIRMED.get(p.c.id) + ', the rule now gives ' + p.through)
      }
    }
    console.log('')
  }
  for (const p of plan.filter((x) => x.status === 'held')) {
    console.log('NOTE: #' + p.c.id + ' has no billed-through date, so if this is still open on ' + START +
      ' the engine charges them a FULL month then, like a customer it has always billed.')
  }

  const novTotal = plan.reduce((s, p) => s + (p.nov ? p.nov.amount : 0), 0)
  const decTotal = plan.reduce((s, p) => s + (p.dec ? p.dec.amount : 0), 0)
  console.log('IF EVERYONE HAS SERVICE on the day: 1 Nov charges ' + plan.filter((p) => p.nov).length + ' customers ' + money(novTotal) +
    '; 1 Dec charges ' + plan.filter((p) => p.dec).length + ' customers ' + money(decTotal) + '.')
  console.log('Customers cut off on 1 Nov are not charged; the till charges them from their return, never into days billed by hand.')

  if (!APPLY) {
    console.log('\nDry run: nothing was written.')
    return
  }

  const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
  if (ue || !u) { console.error('No users row ' + USER_ID); process.exit(1) }

  let done = 0
  for (const p of plan) {
    if (p.status === 'held') { console.log('#' + p.c.id + ' HELD; not written.'); continue }
    if (p.status === 'unconfirmed') { console.log('#' + p.c.id + ' flagged and not confirmed at ' + p.through + '; not written.'); continue }
    if (p.existing) { console.log('#' + p.c.id + ' already billed through ' + p.existing + '; left.'); continue }
    const { data: upd, error: e2 } = await db.from('customers').update({ billed_through: p.through })
      .eq('company_id', COMPANY).eq('id', p.c.id).is('billed_through', null).select('id')
    if (e2 || !upd?.length) { console.log('#' + p.c.id + ': not written' + (e2 ? ' (' + e2.message + ')' : ' (changed meanwhile)')); continue }
    await db.from('log').insert({
      company_id: COMPANY, user_id: u.id, customer_id: p.c.id, correlation_id: RUN_ID,
      type: 'billed_through_set',
      details: 'Billed through ' + p.through + ' for the engine hand-over (engine from ' + START + '; owner, 8 Oct 2026). ' +
        'Bill day ' + p.B + ', expiry ' + (p.E ?? 'none') + (p.notes.length ? '. ' + p.notes.join('; ') : '') +
        '. By ' + u.email + ' | run=' + RUN_ID,
    })
    done += 1
  }
  console.log('\nSet ' + done + ' of ' + plan.length + '. run=' + RUN_ID)
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err)
  process.exit(1)
})
