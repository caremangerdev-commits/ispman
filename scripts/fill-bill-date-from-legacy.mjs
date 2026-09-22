#!/usr/bin/env node
/**
 * ONE-OFF: customers.bill_date <- customers.bill_due_date, for the migrated
 * companies, WHERE bill_date IS NULL.
 *
 *   node scripts/fill-bill-date-from-legacy.mjs                        dry run (default)
 *   node scripts/fill-bill-date-from-legacy.mjs --apply --expect=N     the UPDATEs
 *
 * A DRY RUN PRINTS EVERY ROW AND STOPS. Nothing is written without --apply, and
 * --apply refuses unless --expect matches the number of rows it finds: what is
 * written is the set somebody read, not whatever matches a minute later.
 *
 * WHAT WENT WRONG
 *   scripts/migrate-legacy-company.mjs copied each legacy customer's
 *   bill_due_date into ISPMan's column OF THE SAME NAME. Nothing in the app
 *   reads that column. The day billing actually reads is customers.bill_date
 *   (migration 0011), which the migration never wrote — so every migrated
 *   customer had no bill day of their own and fell back to the company's
 *   (lib/billing.ts#effectiveBillDay). The company's came from legacy's company
 *   row and disagrees with the customers': Vernon's says 26 and both
 *   Smartcomms' say 27, while their customers say 25.
 *
 *   This is the column fix, not a re-migration: the values are the ones already
 *   copied across on migration day.
 *
 * WHAT IT WRITES
 *   FILL      bill_date is NULL and bill_due_date is a day 1-31. Written.
 *   SAME      bill_date already equals bill_due_date. Nothing to do.
 *   CONFLICT  bill_date is ALREADY SET to something else. NEVER WRITTEN. Somebody
 *             chose that value after the migration — Ezmze's 980 were set to the
 *             1st through Set Bill Dates and have been BILLED on it; Smartcomm
 *             Bogue's staff set 13 by hand. A column fix fills a gap; it does not
 *             overrule a decision. Every one is printed so it can be overruled by
 *             a person.
 *   INVALID   bill_due_date is null, 0 or past 31 — not a day. Left NULL, so the
 *             customer keeps following the company's day.
 *   APP-MADE  the row was created IN ISPMAN, not by the migration, so its
 *             bill_due_date is not a copied legacy value at all — it is the
 *             column default, 25. NEVER WRITTEN. Found by the first dry run: six
 *             Ezmze customers added at the counter on 4-5 September, who would
 *             have been moved off the 1st, at the one company already billed on
 *             it, on the strength of a default. Told apart by date_added: a
 *             migrated row keeps its LEGACY signup date, an app-made row's
 *             date_added is the day it was created — and it was not created on
 *             the company's migration day.
 *
 * KNOWN LIMIT OF THE SOURCE, said here so nobody rediscovers it: the column's
 * default is 25. JMEDIA was never migrated and all of its customers read 25. For
 * a company where every row says 25 this cannot tell a decision from a default.
 * The instruction was to use the values as copied, and that is what this does.
 *
 * WHICH COMPANIES. The eight created by the migration script. NOT Demo ISP (23,
 * seed data) and NOT JMEDIA (30, a DHCP lease import whose 25s are the column
 * default and whose owner has set real bill dates by hand).
 *
 * REVERSIBLE. --apply first writes every filled customer id, per company and
 * value, to supabase/repairs/2026-09-20_bill_date_filled.json, and refuses to
 * write if that cannot be saved. Every one of them was NULL before, so undoing
 * it is setting those ids back to NULL. Each UPDATE re-asserts `bill_date IS
 * NULL` and the source value, so a row edited between the read and the write is
 * left alone. Re-running after --apply finds nothing to fill.
 *
 * WHAT IT DOES NOT TOUCH
 *   settings.bill_date (the company day), bill_due_date itself, balances,
 *   expiries, payments, radcheck, the log.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const expectArg = process.argv.find((a) => a.startsWith('--expect='))
const EXPECT = expectArg ? Number(expectArg.slice('--expect='.length)) : null
const BACKUP = 'supabase/repairs/2026-09-20_bill_date_filled.json'

const MIGRATED = [26, 27, 31, 32, 33, 34, 35, 36]

// --- environment --------------------------------------------------------------

// Split, not matched: no regex needed to read KEY=value.
function loadEnv(file = '.env.local') {
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    const i = line.indexOf('=')
    if (i <= 0 || line.startsWith('#')) continue
    const key = line.slice(0, i).trim()
    let value = line.slice(i + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}
loadEnv()
const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error('Missing ' + n); process.exit(1) }
  return v
}

const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function all(build) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...data)
    if (data.length < 1000) break
  }
  return out
}

// --- read ---------------------------------------------------------------------

const { data: companyRows, error: companyError } = await db
  .from('companies').select('id, name').in('id', MIGRATED).order('id')
if (companyError) throw new Error(companyError.message)
const { data: settingRows, error: settingError } = await db
  .from('settings').select('company_id, bill_date').in('company_id', MIGRATED)
if (settingError) throw new Error(settingError.message)
const companyDay = new Map(settingRows.map((s) => [s.company_id, s.bill_date]))

const isDay = (v) => Number.isInteger(v) && v >= 1 && v <= 31
const name = (c) => [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Customer #' + c.id

const fill = []       // { c, to }
const conflict = []   // { c }
const totals = []

for (const company of companyRows) {
  const rows = await all(() => db.from('customers')
    .select('id, company_id, first_name, last_name, account_number, cut_off_date, bill_date, bill_due_date, date_added, created_at')
    .eq('company_id', company.id).order('id'))

  // The migration's day for this company: the day most of its rows were created.
  const perDay = new Map()
  for (const c of rows) perDay.set(c.created_at.slice(0, 10), (perDay.get(c.created_at.slice(0, 10)) ?? 0) + 1)
  const migrationDay = [...perDay].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  const appMade = (c) => {
    const created = c.created_at.slice(0, 10)
    return created !== migrationDay && String(c.date_added ?? '').slice(0, 10) === created
  }

  const t = { company, customers: rows.length, fill: 0, same: 0, conflict: 0, invalid: 0, appMade: 0, byValue: {} }
  const mine = []
  const theirs = []
  const defaults = []

  for (const c of rows) {
    const from = c.bill_due_date
    if (!isDay(from)) { t.invalid++; continue }
    if (c.bill_date === null && appMade(c)) {
      t.appMade++
      defaults.push(c)
    } else if (c.bill_date === null) {
      t.fill++
      t.byValue[from] = (t.byValue[from] ?? 0) + 1
      mine.push({ c, to: from })
    } else if (c.bill_date === from) {
      t.same++
    } else {
      t.conflict++
      theirs.push({ c })
    }
  }

  console.log('\n' + '='.repeat(100))
  console.log(company.id + '  ' + company.name + '   (' + rows.length + ' customers; company bill day ' +
    (companyDay.get(company.id) ?? '-') + ')')
  console.log('='.repeat(100))

  if (mine.length) {
    console.log('FILL — bill_date is NULL, becomes:')
    console.log('  ' + 'customer'.padEnd(10) + 'account'.padEnd(12) + 'cut-off'.padEnd(9) + 'bill_date'.padEnd(16) + 'name')
    for (const { c, to } of mine) {
      console.log('  ' + ('#' + c.id).padEnd(10) + String(c.account_number ?? '-').padEnd(12) +
        String(c.cut_off_date ?? '-').padEnd(9) + ('NULL -> ' + to).padEnd(16) + name(c))
    }
  }
  if (theirs.length) {
    console.log('\nCONFLICT — bill_date already set to something else. NOT WRITTEN:')
    console.log('  ' + 'customer'.padEnd(10) + 'account'.padEnd(12) + 'cut-off'.padEnd(9) + 'bill_date'.padEnd(11) + 'legacy copy'.padEnd(13) + 'name')
    for (const { c } of theirs) {
      console.log('  ' + ('#' + c.id).padEnd(10) + String(c.account_number ?? '-').padEnd(12) +
        String(c.cut_off_date ?? '-').padEnd(9) + String(c.bill_date).padEnd(11) +
        String(c.bill_due_date).padEnd(13) + name(c))
    }
  }

  if (defaults.length) {
    console.log('\nAPP-MADE — created in ISPMan, so the 25 is the column default, not a legacy value. NOT WRITTEN:')
    for (const c of defaults) {
      console.log('  ' + ('#' + c.id).padEnd(10) + String(c.account_number ?? '-').padEnd(12) +
        ('created ' + c.created_at.slice(0, 10)).padEnd(20) + ('default ' + c.bill_due_date).padEnd(13) + name(c))
    }
  }

  fill.push(...mine)
  conflict.push(...theirs)
  totals.push(t)
}

// --- summary ------------------------------------------------------------------

console.log('\n' + '-'.repeat(100))
console.log('company'.padEnd(42) + 'customers'.padStart(10) + 'FILL'.padStart(8) + 'same'.padStart(8) +
  'CONFLICT'.padStart(10) + 'invalid'.padStart(9) + 'app-made'.padStart(10) + '   filled with')
for (const t of totals) {
  const values = Object.entries(t.byValue).sort((a, b) => b[1] - a[1]).map(([v, n]) => v + ' x' + n).join(', ')
  console.log((t.company.id + ' ' + t.company.name).slice(0, 41).padEnd(42) + String(t.customers).padStart(10) +
    String(t.fill).padStart(8) + String(t.same).padStart(8) + String(t.conflict).padStart(10) +
    String(t.invalid).padStart(9) + String(t.appMade).padStart(10) + '   ' + (values || '-'))
}
console.log('TO FILL: ' + fill.length + '    left alone as CONFLICT: ' + conflict.length)

// --- write --------------------------------------------------------------------

if (!APPLY) {
  console.log('\nDRY RUN. Nothing was written. To write exactly these rows:')
  console.log('  node scripts/fill-bill-date-from-legacy.mjs --apply --expect=' + fill.length)
  process.exit(0)
}

console.log('\n' + '='.repeat(100) + '\nAPPLY\n' + '='.repeat(100))
const refuse = (why) => { console.error('REFUSED, nothing written: ' + why); process.exit(1) }

if (fill.length === 0) {
  console.log('No migrated customer has a NULL bill_date with a usable legacy day. Already applied; nothing to do.')
  process.exit(0)
}
if (EXPECT === null || !Number.isInteger(EXPECT)) refuse('--apply needs --expect=<the number the dry run printed>')
if (fill.length !== EXPECT) refuse('the dry run you read had ' + EXPECT + ' rows; there are ' + fill.length + ' now. Run it again and read them.')
if (fill.some((f) => f.c.bill_date !== null)) refuse('a row that already has a bill_date is in the set')

// Grouped by company and value: one guarded UPDATE per group chunk.
const groups = new Map()
for (const { c, to } of fill) {
  const key = c.company_id + ':' + to
  if (!groups.has(key)) groups.set(key, { companyId: c.company_id, to, ids: [] })
  groups.get(key).ids.push(c.id)
}

// The old state, saved BEFORE the write. Every id here was NULL.
const previous = existsSync(BACKUP) ? JSON.parse(readFileSync(BACKUP, 'utf8')) : []
const record = previous.concat([{
  applied_at: new Date().toISOString(),
  note: 'customers.bill_date was NULL for every id listed; set to `to`. Undo = set these ids back to NULL.',
  groups: [...groups.values()].map((g) => ({ company_id: g.companyId, to: g.to, count: g.ids.length, customer_ids: g.ids })),
}])
try {
  writeFileSync(BACKUP, JSON.stringify(record) + '\n')
} catch (err) {
  refuse('could not save the record to ' + BACKUP + ': ' + err.message)
}
console.log('Record saved to ' + BACKUP + ' (' + fill.length + ' customer ids in ' + groups.size + ' groups).')

let matched = 0
for (const g of groups.values()) {
  let groupMatched = 0
  for (let i = 0; i < g.ids.length; i += 200) {
    // By id AND by the condition it was chosen on: still NULL, source still
    // this value. A row somebody edited in between is left alone.
    const { error, count } = await db.from('customers')
      .update({ bill_date: g.to }, { count: 'exact' })
      .eq('company_id', g.companyId)
      .in('id', g.ids.slice(i, i + 200))
      .is('bill_date', null)
      .eq('bill_due_date', g.to)
    if (error) { console.error('UPDATE FAILED after ' + matched + ' rows: ' + error.message); process.exit(1) }
    groupMatched += count ?? 0
  }
  matched += groupMatched
  console.log('  company ' + String(g.companyId).padEnd(4) + 'bill_date = ' + String(g.to).padEnd(4) +
    'matched ' + groupMatched + ' of ' + g.ids.length)
}
console.log('UPDATE matched ' + matched + ' rows (expected ' + fill.length + ').')

const left = await db.from('customers').select('id', { count: 'exact', head: true })
  .in('company_id', MIGRATED).is('bill_date', null).gte('bill_due_date', 1).lte('bill_due_date', 31)
// What should be left is exactly the app-made rows, which were never in the set.
const heldBack = totals.reduce((sum, t) => sum + t.appMade, 0)
console.log('VERIFY: customers at these companies still NULL with a day in bill_due_date: ' + left.count +
  ' (expect ' + heldBack + ', the app-made rows held back).')

if (matched !== fill.length || left.count !== heldBack) {
  console.error('THE COUNTS DO NOT AGREE. Read them before doing anything else.')
  process.exit(1)
}
console.log('Done.')
