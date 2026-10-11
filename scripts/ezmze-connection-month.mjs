#!/usr/bin/env node
/**
 * HELD UNTIL EZMZE ANSWERS (owner, 11 Oct 2026). Ezmze (company 27): the
 * connection month for customers provisioned before the model who have not
 * paid yet, now that there is no first period for anyone.
 *
 *   node scripts/ezmze-connection-month.mjs                         dry run (default)
 *   node scripts/ezmze-connection-month.mjs --apply --user=<users.id>
 *
 * --apply needs migration 0032 (the setting) and follows Ezmze's setting:
 *
 *   ON (charge the connection month)
 *     - connected in September: September from the connection day to 30 Sep;
 *     - connected in October: October from the connection day to 31 Oct;
 *       both through set_month_charge() (0028), the guarded write Provision
 *       uses, logged as first_month_charged;
 *     - Gibraltar boxes 1 and 2: the 3 Sep bill run charged each a full
 *       September (J$12,000) before they were connected; it is replaced by the
 *       days they had — the J$12,000 comes off the balance, guarded, and the
 *       September days go on as a month charge;
 *     - Kay-Ann Willie and Daina D-B Brown: provisioned 9 Oct under the model,
 *       their J$3,000 October was zeroed by staff as an "error"; it goes back on
 *       the balance (their October charge is still on record).
 *   OFF
 *     - Gibraltar boxes 1 and 2: the bill-run September comes off entirely (the
 *       connection month is free); nothing else is written; Kay-Ann and Daina
 *       stay at 0.
 *
 * LEFT OUT ENTIRELY AND FLAGGED: Rayon Walker #2049 (expiry 31 Dec 2032),
 * Tony Wifey #5704 (rate 0, expiry 2039), Daddy Daddy #5835 — the owner is
 * asking Ezmze what they are.
 *
 * NAMED, NOT DERIVED: each customer with the balance and rate read on 11 Oct
 * 2026. A customer whose balance or rate has moved since, or who has paid, is
 * SKIPPED and listed; the rest still go ahead.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { createClient } from '@supabase/supabase-js'

const ROOT = process.cwd()
const { monthFigure, monthOf, daysToMonthEnd, monthLabel, round100 } =
  await import(pathToFileURL(path.join(ROOT, 'lib/prepaid-calendar.ts')).href)

const APPLY = process.argv.includes('--apply')
const userArg = process.argv.find((x) => x.startsWith('--user='))
const USER_ID = userArg ? Number(userArg.slice('--user='.length)) : null
if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log rows name who did this.')
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

const CO = 27
const RUN_ID = randomUUID()
const money = (n) => 'J$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

// [id, name, rate, connected (Jamaica date), carried balance read 11 Oct]
const CONNECTION = [
  [1402, 'Jamar Altano Watt', 4500, '2026-09-03', 4500],
  [1406, 'Davina Valintine Jones', 5000, '2026-09-03', 5000],
  [1405, 'Nickisha Richards', 6000, '2026-09-03', 6000],
  [2037, 'Livingston Johnson', 4500, '2026-09-05', 4400],
  [1720, 'Eastani Janee Wilson', 6000, '2026-09-07', 6000],
  [2062, 'Kevin Henry', 4000, '2026-09-10', 4000],
  [5777, 'Adrian Ken Johnson', 6000, '2026-09-19', 6000],
  [5778, 'Dauntae Dwight Wilson', 6000, '2026-09-19', 6000],
  [5791, 'Zavier Jaleel Shand', 4000, '2026-09-22', 4000],
  [5825, 'Kelaya Yolanda Walker', 6000, '2026-09-22', 6000],
  [5827, 'Paul Wright', 5000, '2026-09-22', 5000],
  [5844, 'Shavaughn Nathaniel Walters', 6000, '2026-09-24', 6000],
  [5847, 'Nola Griffiths', 4000, '2026-09-25', 4000],
  [5892, 'Merlene Shallana Campbell', 6000, '2026-09-29', 6000],
  [5953, 'Toney-ann Robinson', 6000, '2026-10-02', 0],
  [5965, 'Racquel Angella Hull', 4000, '2026-10-03', 0],
  [5976, 'Ricky Elmo Roberts', 5000, '2026-10-03', 0],
  [5988, 'Zoya Gabrielle McFarlane', 4000, '2026-10-05', 0],
  [5987, 'Rushain Joseph', 4000, '2026-10-05', 0],
  [5980, 'Sabrina Lynch', 4000, '2026-10-05', 0],
  [5998, 'Abigay Stewart', 4000, '2026-10-06', 0],
  [6000, 'Stemijor Bembridge', 4000, '2026-10-06', 0],
  [5999, 'Nathaniel Tafari Henry', 6000, '2026-10-07', 0],
]
// [id, name, rate, connected, carried read 11 Oct, the bill-run September]
const GIBRALTAR = [
  [503, 'Gibraltar All Age and Infant box 1', 12000, '2026-09-05', 24000, 12000],
  [504, 'Gibraltar All Age and Infant (box 2)', 12000, '2026-09-16', 24000, 12000],
]
// [id, name, carried read 11 Oct, the October charge staff zeroed]
const RESTORE = [
  [6011, 'Kay-Ann Willie', 0, 3000],
  [6027, 'Daina D-B Brown', 0, 3000],
]
const FLAGGED = [
  [2049, 'Rayon Walker', 'expiry 31 Dec 2032, rate J$6,000'],
  [5704, 'Tony Wifey', 'rate 0, expiry 31 Jan 2039'],
  [5835, 'Daddy Daddy', 'test record?'],
]

async function main() {
  const probe = await db.from('settings').select('charge_connection_month').eq('company_id', CO).maybeSingle()
  const has0032 = !probe.error
  if (APPLY && !has0032) { console.error('Refused: migration 0032 is not applied.'); process.exit(1) }
  // Before 0032 the dry run shows Ezmze as 0032 will set it: ON.
  const on = has0032 ? Boolean(probe.data?.charge_connection_month) : true

  const ids = [...CONNECTION.map((r) => r[0]), ...GIBRALTAR.map((r) => r[0]), ...RESTORE.map((r) => r[0])]
  const { data: custs } = await db.from('customers').select('id, monthly_rate, carried_balance, account_credit').eq('company_id', CO).in('id', ids)
  const byId = new Map(custs.map((c) => [c.id, c]))
  const { data: links } = await db.from('customer_additional_services').select('customer_id, additional_services(monthly_price)').in('customer_id', ids)
  const addons = new Map()
  for (const l of links ?? []) addons.set(l.customer_id, (addons.get(l.customer_id) ?? 0) + Number(l.additional_services?.monthly_price ?? 0))
  const { data: pays } = await db.from('payments').select('customer_id').in('customer_id', ids).neq('payment_kind', 'other')
  const paid = new Set((pays ?? []).map((p) => p.customer_id))
  const { data: charges } = await db.from('bill_charges').select('customer_id, period_start, amount').in('customer_id', ids)
  const hasMonth = (id, start) => (charges ?? []).some((c) => c.customer_id === id && c.period_start === start)

  let actor = null
  if (APPLY) {
    const { data: u } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (!u) { console.error('No users row ' + USER_ID); process.exit(1) }
    actor = u
  }

  console.log('Ezmze connection month   setting ' + (on ? 'ON' : 'OFF') + (has0032 ? '' : ' (0032 not applied: shown as 0032 will set it)') +
    '   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN') + '\n')

  const check = (id, rate, carried) => {
    const c = byId.get(id)
    if (!c) return 'not found'
    if (paid.has(id)) return 'has paid since'
    const nowRate = Number(c.monthly_rate ?? 0) + (addons.get(id) ?? 0)
    if (nowRate !== rate) return 'rate is now ' + nowRate + ', was ' + rate
    if (Number(c.carried_balance) !== carried) return 'balance is now ' + c.carried_balance + ', was ' + carried
    return null
  }

  let written = 0
  const stubFor = (rate, connected) => {
    const m = monthOf(connected)
    const days = daysToMonthEnd(connected)
    return { m, days, amount: monthFigure(rate, days, m.days), full: round100(rate) }
  }
  const writeMonth = async (id, connected, rate, why) => {
    const s = stubFor(rate, connected)
    const { data, error } = await db.rpc('set_month_charge', {
      p_company_id: CO, p_customer_id: id, p_period_start: s.m.start, p_period_end: s.m.end,
      p_charged_on: connected, p_amount: s.amount, p_service_days: s.days, p_full_amount: s.full,
      p_source: 'provision', p_expected_amount: null, p_touch_service: false, p_service_ended_on: null,
    })
    if (error || !data?.ok) return 'NOT written: ' + (error?.message ?? data?.reason)
    await db.from('log').insert({
      company_id: CO, user_id: actor.id, customer_id: id, correlation_id: RUN_ID, type: 'first_month_charged',
      details: 'Connection month charged: ' + money(s.amount) + ' for ' + monthLabel(s.m.start) + ', ' + s.days +
        ' days (' + connected + ' to ' + s.m.end + ') of ' + s.m.days + ', full month ' + money(s.full) +
        ' | balance_after=' + Number(data.carried_after).toFixed(2) + ' | reason=' + why + ' | by=' + actor.email + ' | run=' + RUN_ID,
    })
    return 'written, balance now ' + money(data.carried_after)
  }
  const adjustBalance = async (id, name, from, to, why) => {
    const { data: upd, error } = await db.from('customers').update({ carried_balance: to })
      .eq('company_id', CO).eq('id', id).eq('carried_balance', from).select('id')
    if (error || !upd?.length) return 'NOT written' + (error ? ': ' + error.message : ' (balance changed meanwhile)')
    await db.from('log').insert({
      company_id: CO, user_id: actor.id, customer_id: id, correlation_id: RUN_ID, type: 'balance_adjusted',
      details: 'Carried balance adjusted for ' + name + ' | old=' + money(from) + ' | new=' + money(to) +
        ' | by=' + actor.email + ' | reason=' + why + ' | run=' + RUN_ID,
    })
    return 'balance ' + money(from) + ' -> ' + money(to)
  }

  if (on) {
    console.log('CONNECTION MONTH CHARGED (' + CONNECTION.length + ')')
    for (const [id, name, rate, connected, carried] of CONNECTION) {
      const s = stubFor(rate, connected)
      let skip = check(id, rate, carried)
      if (!skip && hasMonth(id, s.m.start)) skip = monthLabel(s.m.start) + ' already has a charge'
      const line = '  #' + String(id).padEnd(5) + name.padEnd(29) + monthLabel(s.m.start).padEnd(15) + (s.days + ' days').padEnd(9) +
        money(s.amount).padStart(9) + '   balance ' + money(carried) + ' -> ' + money(carried + s.amount)
      if (skip) { console.log(line + '   SKIPPED: ' + skip); continue }
      if (!APPLY) { console.log(line); continue }
      console.log(line + '   ' + await writeMonth(id, connected, rate, 'no first period for anyone; connection month charged (owner, 11 Oct 2026)'))
      written += 1
    }
  }

  console.log('\nGIBRALTAR: BILL-RUN SEPTEMBER ' + (on ? 'REPLACED BY THE DAYS THEY HAD' : 'REMOVED (connection month free)'))
  for (const [id, name, rate, connected, carried, billRun] of GIBRALTAR) {
    const s = stubFor(rate, connected)
    let skip = check(id, rate, carried)
    if (!skip && hasMonth(id, s.m.start)) skip = 'September already has a month charge'
    const after = carried - billRun + (on ? s.amount : 0)
    const line = '  #' + String(id).padEnd(5) + name.padEnd(37) + 'Sep ' + money(billRun) + ' -> ' +
      (on ? money(s.amount) + ' (' + s.days + ' days)' : 'none') + '   balance ' + money(carried) + ' -> ' + money(after)
    if (skip) { console.log(line + '   SKIPPED: ' + skip); continue }
    if (!APPLY) { console.log(line); continue }
    const why = 'the 3 Sep bill run charged a full September before connection on ' + connected +
      (on ? '; replaced by the days they had' : '; the connection month is not charged') + ' (owner, 11 Oct 2026)'
    let result = await adjustBalance(id, name, carried, carried - billRun, why)
    if (on && result.startsWith('balance')) {
      const w = await writeMonth(id, connected, rate, why)
      if (w.startsWith('NOT')) result += '; month charge ' + w + ' — CHECK BY HAND'
      else result += '; ' + w
    }
    console.log(line + '   ' + result)
    written += 1
  }

  if (on) {
    console.log('\nPUT BACK: THE OCTOBER CHARGE STAFF REMOVED (' + RESTORE.length + ')')
    for (const [id, name, carried, octCharge] of RESTORE) {
      const c = byId.get(id)
      let skip = !c ? 'not found' : paid.has(id) ? 'has paid since' : Number(c.carried_balance) !== carried ? 'balance is now ' + c.carried_balance : null
      if (!skip && !hasMonth(id, '2026-10-01')) skip = 'no October charge on record'
      const line = '  #' + String(id).padEnd(5) + name.padEnd(29) + 'October ' + money(octCharge) + '   balance ' + money(carried) + ' -> ' + money(carried + octCharge)
      if (skip) { console.log(line + '   SKIPPED: ' + skip); continue }
      if (!APPLY) { console.log(line); continue }
      console.log(line + '   ' + await adjustBalance(id, name, carried, carried + octCharge,
        'October connection-month charge (9 to 31 Oct) put back; staff had removed it as an error (owner, 11 Oct 2026)'))
      written += 1
    }
  }

  console.log('\nLEFT OUT AND FLAGGED — the owner is asking Ezmze what they are:')
  for (const [id, name, note] of FLAGGED) console.log('  #' + String(id).padEnd(5) + name.padEnd(29) + note)

  console.log(APPLY ? '\nDone: ' + written + ' customer(s) written. run=' + RUN_ID : '\nDry run: nothing was written.')
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
