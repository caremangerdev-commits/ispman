#!/usr/bin/env node
/**
 * ONE-OFF: the postpaid day-based settings at West Central (26), Vernon (31)
 * and Smartcomm Bogue (32), and West Central's two test records out of
 * billing. Owner, 11 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/postpaid-settings-2026-10-11.mjs                        dry run (default)
 *   node scripts/postpaid-settings-2026-10-11.mjs --apply --user=<users.id>
 *
 * WHAT --apply WRITES
 *   settings, one UPDATE per company, guarded by the values it replaces and by
 *   the engine being OFF — every engine stays off:
 *     26 West Central    bill day 1 -> 24, engine start none -> 2026-10-24
 *     31 Vernon          engine start 2026-09-25 -> 2026-10-25
 *     32 Smartcomm Bogue engine start none -> 2026-10-27
 *   Each is the company's October bill day, so September — billed by Run
 *   Bills on 28 Sep (Vernon, Bogue) and 2 Oct (West Central) — stays as billed.
 *   One billing_settings_changed log row per company.
 *
 *   customers, the two test records at West Central: monthly_rate -> 0, which
 *   every billing path skips (Run Bills, the engine, the next bill day's
 *   settle). Guarded by the rate they hold now. One customer_updated row each,
 *   in the shape the edit form writes, so it shows in the customer's history.
 *     #5984 Test Customer   J$3,500 -> 0
 *     #6025 Haydn Samuels   J$3,499 -> 0
 *   Their records, balances and network entries are not touched.
 *
 * NOT HERE: the connection month. Its column does not exist until migration
 * 0032 is applied, and 0032 itself turns it on for these three.
 *
 * correlation_id on every log row = the run id.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : null
}
const USER_ID = arg('user') ? Number(arg('user')) : null
if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log rows name who changed these.')
  process.exit(1)
}

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0) {
    const key = line.slice(0, eq).trim()
    if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
}
const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error('Missing ' + n); process.exit(1) }
  return v
}
const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

const RUN_ID = randomUUID()
const REASON = 'Postpaid billed by the day: October is billed on the October bill day, engine still off (owner, 11 Oct 2026)'

// company -> what it holds now (read 11 Oct 2026) and what it becomes.
const SETTINGS = [
  { id: 26, now: { bill_date: 1, start: null }, to: { bill_date: 24, start: '2026-10-24' } },
  { id: 31, now: { bill_date: 25, start: '2026-09-25' }, to: { bill_date: 25, start: '2026-10-25' } },
  { id: 32, now: { bill_date: 27, start: null }, to: { bill_date: 27, start: '2026-10-27' } },
]

// West Central's test records: id -> the rate they hold now.
const TEST_RECORDS = [
  { id: 5984, company: 26, rate: 3500 },
  { id: 6025, company: 26, rate: 3499 },
]

const show = (v) => (v === null ? 'none' : String(v))

async function main() {
  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }
  const via = actor ? ' | via=super_admin:#' + actor.id : ''

  console.log('Postpaid settings and test records   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN') + '\n')

  // ---- settings ----
  const ready = []
  for (const s of SETTINGS) {
    const { data: row, error } = await db.from('settings')
      .select('bill_date, billing_type, billing_engine_mode, billing_engine_start_date')
      .eq('company_id', s.id).maybeSingle()
    const { data: co } = await db.from('companies').select('name').eq('id', s.id).maybeSingle()
    const name = co?.name ?? String(s.id)
    let why = ''
    if (error || !row) why = 'no settings row' + (error ? ': ' + error.message : '')
    else if (row.billing_engine_mode !== 'off') why = 'engine is ' + row.billing_engine_mode + ', not off'
    else if (row.billing_type !== 'postpaid') why = 'billing type is ' + row.billing_type
    else if (row.bill_date !== s.now.bill_date) why = 'bill day is ' + row.bill_date + ', not ' + s.now.bill_date
    else if (row.billing_engine_start_date !== s.now.start) why = 'start date is ' + show(row.billing_engine_start_date) + ', not ' + show(s.now.start)
    const changes = []
    if (s.now.bill_date !== s.to.bill_date) changes.push('bill day ' + s.now.bill_date + ' -> ' + s.to.bill_date)
    changes.push('engine start date ' + show(s.now.start) + ' -> ' + s.to.start)
    console.log((why ? 'SKIPPED ' : 'READY   ') + String(s.id).padEnd(4) + name.padEnd(26) + changes.join(', ') +
      '; engine stays off' + (why ? '   ' + why : ''))
    if (!why) ready.push({ ...s, name, changes })
  }

  // ---- test records ----
  const readyCustomers = []
  for (const t of TEST_RECORDS) {
    const { data: c } = await db.from('customers')
      .select('id, company_id, first_name, last_name, monthly_rate, carried_balance, account_credit')
      .eq('id', t.id).maybeSingle()
    const name = c ? (c.first_name + ' ' + (c.last_name ?? '')).trim() : '?'
    let why = ''
    if (!c || c.company_id !== t.company) why = 'not a West Central customer'
    else if (Number(c.monthly_rate) !== t.rate) why = 'rate is ' + c.monthly_rate + ', not ' + t.rate
    console.log((why ? 'SKIPPED ' : 'READY   ') + ('#' + t.id).padEnd(7) + name.padEnd(23) + 'monthly rate J$' + t.rate + ' -> 0' +
      (c ? '   (balance ' + c.carried_balance + ', credit ' + c.account_credit + ', untouched)' : '') + (why ? '   ' + why : ''))
    if (!why) readyCustomers.push({ ...t, name })
  }

  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id>.')
    return
  }

  for (const s of ready) {
    let q = db.from('settings')
      .update({ bill_date: s.to.bill_date, billing_engine_start_date: s.to.start })
      .eq('company_id', s.id).eq('billing_engine_mode', 'off').eq('bill_date', s.now.bill_date)
    q = s.now.start === null ? q.is('billing_engine_start_date', null) : q.eq('billing_engine_start_date', s.now.start)
    const { data, error } = await q.select('company_id')
    if (error || (data ?? []).length !== 1) {
      console.log(s.name + ': settings update matched ' + (data ?? []).length + ' rows' + (error ? ' (' + error.message + ')' : '') + '; no log row written.')
      continue
    }
    const { error: logErr } = await db.from('log').insert({
      company_id: s.id, user_id: actor.id, correlation_id: RUN_ID, type: 'billing_settings_changed',
      details: 'Billing settings: ' + s.changes.join('; ') + '; billing engine stays off. By ' + actor.email +
        ' | reason=' + REASON + ' | run=' + RUN_ID + via,
    })
    console.log(s.name + ': written' + (logErr ? ', but the log row failed: ' + logErr.message : ', logged.'))
  }

  for (const t of readyCustomers) {
    const { data, error } = await db.from('customers').update({ monthly_rate: 0 })
      .eq('id', t.id).eq('company_id', t.company).eq('monthly_rate', t.rate).select('id')
    if (error || (data ?? []).length !== 1) {
      console.log('#' + t.id + ': rate update matched ' + (data ?? []).length + ' rows' + (error ? ' (' + error.message + ')' : '') + '; no log row written.')
      continue
    }
    const { error: logErr } = await db.from('log').insert({
      company_id: t.company, user_id: actor.id, customer_id: t.id, correlation_id: RUN_ID, type: 'customer_updated',
      details: t.name + ' updated | changes=monthly_rate: ' + t.rate + ' → 0 | by=' + actor.email +
        ' | reason=test record, excluded from billing (owner, 11 Oct 2026) | run=' + RUN_ID + via,
    })
    console.log('#' + t.id + ' ' + t.name + ': rate 0' + (logErr ? ', but the log row failed: ' + logErr.message : ', logged.'))
  }
  console.log('\nrun=' + RUN_ID)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
