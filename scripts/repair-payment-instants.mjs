#!/usr/bin/env node
/**
 * ONE-OFF: give service payments their real time of day.
 *
 *   node scripts/repair-payment-instants.mjs              # dry run, counts only
 *   node scripts/repair-payment-instants.mjs --apply      # writes
 *   node scripts/repair-payment-instants.mjs --apply --expect=<n>
 *
 * WHAT WAS WRONG
 *   Until 25 September 2026 the record-payment action wrote payment_date as
 *   `paid_on + 'T12:00:00'` with no zone — noon in the server's zone, which
 *   is UTC — on every service payment. In Jamaica that is 7:00 AM, and every
 *   payment on My Collections, the payments list and the dashboard read 7:00
 *   AM. The real moment the row was written is in created_at, which has
 *   always been right, and which the printed receipt already uses.
 *
 * WHAT IT DOES
 *   For a row stored at EXACTLY noon UTC whose paid_on date equals its
 *   created_at date in the company's timezone, payment_date becomes
 *   created_at. That is the one case with no ambiguity: the cashier stated
 *   the date the row was written, so the row's insert time is the payment's
 *   time.
 *
 * WHAT IT LEAVES ALONE, AND SAYS SO
 *   - paid_on and created_at on different dates in the company's zone: a
 *     back-dated payment, or one entered after midnight. There is no true time
 *     to recover, and noon UTC is at least the stated date. Skipped.
 *   - No paid_on (pre-0013 rows): the stated date is not recorded. Skipped.
 *   - Migrated rows ("Migrated from legacy payment #n" in notes): their
 *     payment_date was rebuilt from the legacy system by
 *     scripts/fix-payment-times.mjs and their created_at is the migration's
 *     insert time, not the payment's. Skipped whatever they hold.
 *   - Anything not at exactly 12:00:00.000 UTC: already a real instant.
 *
 * IDEMPOTENT. A repaired row is no longer at noon UTC, so a second run finds
 * nothing to do. Every change is recorded first in
 * supabase/repairs/2026-09-25_payment_instants.json (id, company, before,
 * after), which is what a reversal would read.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ROOT = process.cwd()
const { createClient } = createRequire(ROOT + '/package.json')('@supabase/supabase-js')
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const i = line.indexOf('=')
  if (i > 0 && !line.trim().startsWith('#')) process.env[line.slice(0, i).trim()] ??= line.slice(i + 1).trim()
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')
const expectArg = process.argv.find((a) => a.startsWith('--expect='))
const EXPECT = expectArg ? Number(expectArg.slice('--expect='.length)) : null
const BACKUP = 'supabase/repairs/2026-09-25_payment_instants.json'
const LEGACY_NOTE = /^Migrated from legacy payment #(\d+)$/

/** The calendar date an instant falls on in a zone, "YYYY-MM-DD" — lib/format.ts#instantToDateOnly. */
function instantToDateOnly(value, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return get('year') + '-' + get('month') + '-' + get('day')
}

/** Exactly 12:00:00.000 UTC, whatever offset the string was serialised with. */
function isNoonUtc(iso) {
  const d = new Date(iso)
  return d.getUTCHours() === 12 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
}

async function all(table, cols, order = 'id') {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from(table).select(cols).order(order).range(from, from + 999)
    if (error) throw new Error(table + ': ' + error.message)
    rows.push(...data)
    if (data.length < 1000) break
  }
  return rows
}

// --- Inputs --------------------------------------------------------------

const tz = {}
for (const s of await all('settings', 'company_id, timezone')) tz[s.company_id] = s.timezone || 'America/Jamaica'
const names = {}
for (const c of await all('companies', 'id, name')) names[c.id] = c.name

const payments = await all('payments', 'id, company_id, payment_kind, payment_date, paid_on, created_at, notes')

// --- Classify ------------------------------------------------------------

const repair = []
const skipped = { legacy: 0, noPaidOn: 0, noCreatedAt: 0, dateMismatch: 0 }
const perCompany = {}
const bump = (co, key) => {
  perCompany[co] ??= { repair: 0, legacy: 0, noPaidOn: 0, noCreatedAt: 0, dateMismatch: 0 }
  perCompany[co][key]++
}

let atNoon = 0
for (const p of payments) {
  if (!isNoonUtc(p.payment_date)) continue
  atNoon++

  if (LEGACY_NOTE.test(String(p.notes ?? ''))) { skipped.legacy++; bump(p.company_id, 'legacy'); continue }
  if (!p.paid_on) { skipped.noPaidOn++; bump(p.company_id, 'noPaidOn'); continue }
  if (!p.created_at) { skipped.noCreatedAt++; bump(p.company_id, 'noCreatedAt'); continue }

  const zone = tz[p.company_id] ?? 'America/Jamaica'
  const createdOn = instantToDateOnly(new Date(p.created_at), zone)
  if (createdOn !== p.paid_on) { skipped.dateMismatch++; bump(p.company_id, 'dateMismatch'); continue }

  repair.push({ id: p.id, company_id: p.company_id, before: p.payment_date, after: new Date(p.created_at).toISOString() })
  bump(p.company_id, 'repair')
}

// --- Report --------------------------------------------------------------

console.log((APPLY ? 'APPLY' : 'DRY RUN') + ' — repair-payment-instants')
console.log('payments read:          ', payments.length)
console.log('at exactly noon UTC:    ', atNoon)
console.log('to repair (created_at): ', repair.length)
console.log('skipped, legacy rows:   ', skipped.legacy)
console.log('skipped, no paid_on:    ', skipped.noPaidOn)
console.log('skipped, no created_at: ', skipped.noCreatedAt)
console.log('skipped, dates differ:  ', skipped.dateMismatch, '(back-dated, or entered after midnight in the company zone)')
console.log()
console.log('company | name | tz | repair | legacy | no paid_on | dates differ')
for (const co of Object.keys(perCompany).map(Number).sort((a, b) => a - b)) {
  const c = perCompany[co]
  console.log(co, '|', names[co], '|', tz[co], '|', c.repair, '|', c.legacy, '|', c.noPaidOn, '|', c.dateMismatch)
}

if (repair.length) {
  console.log('\nsample of what changes (id, company, before -> after, shown in the company zone):')
  const fmt = (iso, zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso))
  for (const r of repair.slice(-8)) {
    const zone = tz[r.company_id]
    console.log(' ', r.id, r.company_id, fmt(r.before, zone), '->', fmt(r.after, zone))
  }
}

if (!APPLY) {
  console.log('\nDry run. Nothing written. Re-run with --apply' + (repair.length ? ' --expect=' + repair.length : '') + ' to write.')
  process.exit(0)
}

// --- Write ---------------------------------------------------------------

if (EXPECT !== null && EXPECT !== repair.length) {
  console.error('\nRefusing: --expect=' + EXPECT + ' but ' + repair.length + ' rows would change. Re-run the dry run.')
  process.exit(1)
}
if (repair.length === 0) { console.log('\nNothing to write.'); process.exit(0) }

if (existsSync(BACKUP)) {
  console.error('\nRefusing: ' + BACKUP + ' already exists. A previous apply wrote it; a second run must not overwrite the record.')
  process.exit(1)
}
writeFileSync(BACKUP, JSON.stringify({ ran_at: new Date().toISOString(), rule: 'payment_date := created_at where payment_date was exactly noon UTC and paid_on = created_at date in company tz', rows: repair }, null, 1) + '\n')
console.log('\nrecord written:', BACKUP)

let written = 0
for (const r of repair) {
  const { error } = await db.from('payments')
    .update({ payment_date: r.after })
    .eq('id', r.id).eq('company_id', r.company_id)
    // Still at the value the dry run saw: a row something else moved meanwhile is left alone.
    .eq('payment_date', r.before)
  if (error) { console.error('row', r.id, 'failed:', error.message); continue }
  written++
}
console.log('rows updated:', written, 'of', repair.length)
