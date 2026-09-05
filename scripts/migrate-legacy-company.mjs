#!/usr/bin/env node
/**
 * ONE-OFF migration: legacy WISP (MariaDB) -> ISPMan (Supabase).
 *
 * DISPOSABLE. Run once per legacy company, then delete this file. Nothing in
 * the app imports it and nothing should start to.
 *
 *   node scripts/migrate-legacy-company.mjs <schema> <company_id> --csv=<path> [--dry-run]
 *
 *   node scripts/migrate-legacy-company.mjs COMPANY_wcnetjagmail_com 26 \
 *     --csv=./export.csv --dry-run
 *
 * WHAT IT DOES NOT DO
 *   - It does not touch radcheck. These subscribers are already provisioned
 *     with real, paid expiries and ISPMan reads expiry live from radcheck.
 *     A write here would move a customer's access.
 *   - It does not call any app action. Payments are inserted as plain rows;
 *     see STEP 3.
 *
 * SCHEMA FACTS THIS RELIES ON (verified against both live databases, not
 * assumed — re-verify if you point it at a differently-shaped legacy box):
 *
 *   legacy payments: id, customer, name, amount, type, date, agent
 *     - the customer link is `customer`, NOT customer_id.
 *     - `date` is VARCHAR(16) holding 'YYYY-MM-DD HH:MM'. All 18,719 rows are
 *       exactly that shape, so >= comparisons against 'YYYY-MM-DD' are correct
 *       lexicographic string comparisons. It is not a DATE column.
 *     - `agent` holds either a cld_users.users id ('87') or a bare name
 *       ('Jerome Cole'), depending on the era of the row.
 *
 *   ispman payments: payment_date is TIMESTAMPTZ; paid_on is DATE.
 *     Both are written — see toPaymentDates().
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'
import Papa from 'papaparse'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A payment on or after this date means the customer is square: no carry. */
const PAID_SINCE = '2026-08-20'

/** How far back payment history is brought across. */
const PAYMENTS_SINCE = '2026-03-04'

/**
 * months_paid stamped on every migrated payment.
 *
 * The legacy table has no months column and the figure is not recoverable from
 * the amount (payments there are not clean multiples of the bill). 1 is the
 * ISPMan column default and reads as "one month of service", which is what
 * these rows were. Set it to 0 if you would rather they read as buying no
 * service — nothing in this script depends on the value.
 */
const HISTORICAL_MONTHS_PAID = 1

const CUSTOMER_CHUNK = 100
const PAYMENT_CHUNK = 200

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')))
const opts = Object.fromEntries(
  argv.filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => [a.slice(2, a.indexOf('=')), a.slice(a.indexOf('=') + 1)])
)
const positional = argv.filter((a) => !a.startsWith('--'))

const SCHEMA = positional[0]
const COMPANY_ID = Number(positional[1])
const CSV_PATH = opts.csv
const DRY_RUN = flags.has('--dry-run')
/** Allows a run against a company that already holds customers. */
const FORCE = flags.has('--force')

if (!SCHEMA || !Number.isInteger(COMPANY_ID) || !CSV_PATH) {
  console.error(
    'Usage: node scripts/migrate-legacy-company.mjs <schema> <company_id> ' +
    '--csv=<path> [--dry-run] [--force]'
  )
  process.exit(1)
}

// Guards against `--dry-run` being typo'd into something that silently writes.
for (const f of flags) {
  if (f !== '--dry-run' && f !== '--force') {
    console.error('Unknown flag ' + f + '. Refusing to run rather than guess.')
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

/**
 * .env.local by hand — this is a plain node script, so Next's loader is not in
 * play and the project carries no dotenv dependency.
 */
function loadEnv(file = '.env.local') {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    console.error('Could not read ' + file + '. Run this from the project root.')
    process.exit(1)
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
}
loadEnv()

const need = (name) => {
  const v = process.env[name]
  if (!v) {
    console.error('Missing ' + name + ' in the environment.')
    process.exit(1)
  }
  return v
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0')

const chunk = (arr, size) => {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Header matching, in the spirit of lib/import/csv.ts. */
const normaliseKey = (s) => (s ?? '').toString().toLowerCase().replace(/[^a-z0-9]/g, '')

const HEADER_HINTS = {
  name: ['name', 'fullname', 'customername'],
  first_name: ['firstname', 'first', 'givenname'],
  last_name: ['lastname', 'last', 'surname', 'familyname'],
  phone: ['phone', 'mobile', 'cell', 'contact', 'telephone', 'tel'],
  address: ['address', 'location', 'street', 'addr'],
  gps: ['gps', 'coordinates', 'latlng', 'latlong'],
  mac_address: ['mac', 'macaddress', 'hwaddr', 'hardwareaddress'],
  monthly_rate: ['monthlyrate', 'rate', 'bill', 'monthly', 'amount', 'price', 'monthlyprice'],
  date_added: ['dateadded', 'joined', 'signup', 'signupdate', 'startdate', 'created'],
  cut_off_date: ['cutoffdate', 'cutoff', 'cutoffday'],
  bill_due_date: ['billduedate', 'billdue', 'duedate'],
  pppoe_username: ['pppoeusername', 'pppoe', 'username', 'user'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks'],
}

/**
 * Maps the file's headers onto customer columns.
 *
 * The mapping is printed in the report BEFORE anything is written, because
 * this script has never seen your export and a silently unmapped rate column
 * would give every carried balance a value of 0.
 */
function mapHeaders(fields) {
  const mapping = {}
  const used = new Set()
  for (const [target, hints] of Object.entries(HEADER_HINTS)) {
    for (const field of fields) {
      if (used.has(field)) continue
      if (hints.includes(normaliseKey(field))) {
        mapping[target] = field
        used.add(field)
        break
      }
    }
  }
  return { mapping, unmapped: fields.filter((f) => !used.has(f)) }
}

/**
 * "AA:BB:CC:DD:EE:FF", or null.
 *
 * Null is a real value here, never an omission — see buildPayload.
 */
function normaliseMac(raw) {
  const hex = (raw ?? '').toString().trim().replace(/[\s:.-]/g, '')
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return null
  const mac = hex.toUpperCase().match(/.{2}/g).join(':')
  return mac === '00:00:00:00:00:00' ? null : mac
}

/**
 * A date-only 'YYYY-MM-DD' out of whatever the export wrote, WITHOUT building
 * a Date. new Date('2026-08-20') is UTC midnight, which renders as the 19th
 * for this company, and that is exactly the bug this avoids.
 */
function toYmd(raw) {
  const s = (raw ?? '').toString().trim()
  if (!s) return null

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3]

  // D/M/Y or M/D/Y. Ambiguous by nature: where both halves are <= 12 there is
  // nothing in the data that decides it, so the US reading is taken and the
  // count is reported so it can be sanity-checked against the source.
  const slash = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s)
  if (slash) {
    let [, a, b, y] = slash
    if (y.length === 2) y = '20' + y
    const month = Number(a)
    const day = Number(b)
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return y + '-' + pad2(month) + '-' + pad2(day)
  }

  return null
}

function splitFullName(raw) {
  const cleaned = (raw ?? '').toString()
    .replace(/\s+/g, ' ').trim().replace(/\s*\d+$/, '').trim()
  if (!cleaned) return { first: '', last: '' }

  const words = cleaned.split(' ')
  if (words.length === 1) return { first: '', last: words[0] }
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] }
}

function toMoney(raw) {
  const s = (raw ?? '').toString().replace(/[^0-9.\-]/g, '')
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// Payment field mapping
// ---------------------------------------------------------------------------

/** Legacy `type` -> ISPMan payment_method (lib/data/checkoff.ts#PAYMENT_METHODS). */
const METHOD_BY_LEGACY_TYPE = {
  'cash deposit': 'cash',
  'bank deposit': 'bank_transfer',
  'wire transfer': 'wire_transfer',
  'cashapp': 'cashapp',
  'zelle': 'zelle',
  'bill express': 'other',
}

/** Narrows a method to a value the legacy payment_type column accepts. */
function legacyPaymentType(method) {
  if (method === 'cash') return 'cash'
  if (method === 'card' || method === 'cheque') return 'card'
  return 'online'
}

/**
 * The two ISPMan date columns from one legacy 'YYYY-MM-DD HH:MM' string.
 *
 * NO JS DATE IS CONSTRUCTED ANYWHERE IN HERE. Read this before "simplifying"
 * it.
 *
 * paid_on is a DATE and is the business date the whole app reports on — the
 * payments list filters it, the dashboard buckets revenue by it, checkoff
 * attributes collections to it. It gets the legacy day verbatim.
 *
 * payment_date is a TIMESTAMPTZ and is what the app ORDERS by, and what the
 * customer detail history renders (lib/data/customers.ts selects payment_date
 * and no paid_on). So it cannot be skipped, and it cannot be given midnight:
 * an instant at 00:00Z renders as the previous day for a UTC-5 company, so
 * every migrated payment would show one day early on the customer's page.
 *
 * It is therefore anchored at NOON UTC of the legacy day, which lands on the
 * correct calendar day in any zone within +/-12h. The legacy time of day is
 * folded in as SECONDS past noon (0..1439s, so 12:00:00-12:23:59Z) purely so
 * that several payments on one day still sort in the order they were taken.
 * The clock time it displays is not the time the customer paid, and was never
 * recoverable as a real instant anyway — the legacy column stored no zone.
 */
function toPaymentDates(legacyDate) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec((legacyDate ?? '').toString().trim())
  if (!m) return null

  const minutesOfDay = Number(m[2]) * 60 + Number(m[3])
  if (!Number.isFinite(minutesOfDay) || minutesOfDay > 1439) return null

  return {
    paidOn: m[1],
    paymentDate:
      m[1] + 'T12:' + pad2(Math.floor(minutesOfDay / 60)) + ':' + pad2(minutesOfDay % 60) + 'Z',
  }
}

// ---------------------------------------------------------------------------
// Report collection
// ---------------------------------------------------------------------------

const skipped = []
const skip = (stage, what, reason) => skipped.push({ stage, what, reason })

const rule = (title) => {
  console.log('\n' + '-'.repeat(72))
  console.log(title)
  console.log('-'.repeat(72))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const supabase = createClient(
    need('NEXT_PUBLIC_SUPABASE_URL'),
    need('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  )

  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'),
    user: need('RADIUS_DB_USER'),
    password: need('RADIUS_DB_PASSWORD'),
    port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    connectTimeout: 15_000,
    // Every date comparison here is a string comparison against the legacy
    // VARCHAR column; nothing is to be handed back as a JS Date.
    dateStrings: true,
  })

  console.log('\n' + '='.repeat(72))
  console.log(
    'LEGACY MIGRATION' + (DRY_RUN ? '  [DRY RUN — nothing will be written]' : '  [LIVE]')
  )
  console.log('='.repeat(72))
  console.log('  legacy schema : ' + SCHEMA)
  console.log('  target company: ' + COMPANY_ID)
  console.log('  csv           : ' + CSV_PATH)

  // -------------------------------------------------------------------------
  // Preflight
  // -------------------------------------------------------------------------

  const [schemaRows] = await my.query(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [SCHEMA, 'payments']
  )
  if (Number(schemaRows[0].n) === 0) {
    throw new Error('Legacy schema ' + SCHEMA + ' has no payments table.')
  }

  const { data: company, error: companyError } = await supabase
    .from('companies').select('id, name').eq('id', COMPANY_ID).maybeSingle()
  if (companyError) throw new Error('Could not read company: ' + companyError.message)
  if (!company) throw new Error('No company with id ' + COMPANY_ID + ' in ISPMan.')
  console.log('  company name  : ' + company.name)

  const { count: existingCount, error: existingError } = await supabase
    .from('customers').select('id', { count: 'exact', head: true }).eq('company_id', COMPANY_ID)
  if (existingError) throw new Error('Could not count customers: ' + existingError.message)

  if (existingCount > 0) {
    console.log('\n  !! Company ' + COMPANY_ID + ' already holds ' + existingCount + ' customers.')
    if (!DRY_RUN && !FORCE) {
      // Nothing in here is idempotent: a second live run duplicates every
      // customer and every payment. Stopping is the only safe default.
      throw new Error(
        'Refusing to write into a company that already has customers. ' +
        'Re-run with --force only if you are certain this is a resumed import.'
      )
    }
  }

  // -------------------------------------------------------------------------
  // STEP 1 — customers, from the export CSV
  // -------------------------------------------------------------------------

  rule('STEP 1  customers')

  const csvText = readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, '')
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true })
  for (const e of parsed.errors.slice(0, 5)) {
    console.log('  csv parse warning row ' + e.row + ': ' + e.message)
  }

  const { mapping, unmapped } = mapHeaders(parsed.meta.fields ?? [])
  console.log('  rows in file  : ' + parsed.data.length)
  console.log('  column mapping:')
  for (const [target, field] of Object.entries(mapping)) {
    console.log('      ' + target.padEnd(16) + ' <- "' + field + '"')
  }
  if (unmapped.length > 0) console.log('  NOT mapped    : ' + unmapped.join(', '))

  if (!mapping.notes) {
    throw new Error(
      'No notes column found in the CSV. The legacy id is recovered from ' +
      '"Legacy #<id>" in notes, so there is nothing to key the migration on.'
    )
  }
  if (!mapping.name && !mapping.last_name) {
    throw new Error('No name column found in the CSV.')
  }
  if (!mapping.monthly_rate) {
    console.log(
      '  !! No rate column mapped, so every carried balance would be 0. ' +
      'Check the mapping above before running live.'
    )
  }

  const get = (row, target) => (mapping[target] ? row[mapping[target]] : undefined)

  const candidates = []
  const seenLegacyIds = new Map()
  let ambiguousDates = 0

  parsed.data.forEach((row, index) => {
    const rowNumber = index + 2 // header is row 1
    const notes = (get(row, 'notes') ?? '').toString().trim()

    const legacyMatch = /legacy\s*#\s*(\d+)/i.exec(notes)
    if (!legacyMatch) {
      skip('customer', 'CSV row ' + rowNumber, 'no "Legacy #<id>" in notes')
      return
    }
    const legacyId = Number(legacyMatch[1])

    if (seenLegacyIds.has(legacyId)) {
      skip(
        'customer', 'CSV row ' + rowNumber,
        'legacy #' + legacyId + ' already taken from row ' + seenLegacyIds.get(legacyId)
      )
      return
    }

    let first = (get(row, 'first_name') ?? '').toString().trim()
    let last = (get(row, 'last_name') ?? '').toString().trim()
    if (!first && !last && mapping.name) {
      ({ first, last } = splitFullName(get(row, 'name')))
    }
    // A lone name is a name: last_name is what the app sorts and shows by.
    if (!last && first) { last = first; first = '' }
    if (!last) {
      skip('customer', 'CSV row ' + rowNumber + ' (legacy #' + legacyId + ')', 'no name')
      return
    }

    const rawDate = (get(row, 'date_added') ?? '').toString().trim()
    const dateAdded = toYmd(rawDate)
    if (rawDate && !dateAdded) {
      skip(
        'customer.date_added', 'legacy #' + legacyId,
        'unreadable date "' + rawDate + '" — stored as null, customer still migrated'
      )
    }
    if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(rawDate)) ambiguousDates += 1

    const rate = toMoney(get(row, 'monthly_rate')) ?? 0
    if (rate === 0) {
      skip(
        'customer.monthly_rate', 'legacy #' + legacyId,
        'rate read as 0 — carried balance will be 0 even if unpaid'
      )
    }

    seenLegacyIds.set(legacyId, rowNumber)
    candidates.push({
      rowNumber,
      legacyId,
      first_name: first,
      last_name: last,
      phone: (get(row, 'phone') ?? '').toString().trim() || null,
      address: (get(row, 'address') ?? '').toString().trim() || null,
      gps: (get(row, 'gps') ?? '').toString().trim() || null,
      pppoe_username: (get(row, 'pppoe_username') ?? '').toString().trim() || null,
      notes: notes || null,
      mac_address: normaliseMac(get(row, 'mac_address')),
      monthly_rate: rate,
      date_added: dateAdded,
      cut_off_date: toMoney(get(row, 'cut_off_date')),
      bill_due_date: toMoney(get(row, 'bill_due_date')),
    })
  })

  console.log('  usable rows   : ' + candidates.length)
  if (ambiguousDates > 0) {
    console.log(
      '  !! ' + ambiguousDates + ' date_added values were D/M/Y-or-M/D/Y ambiguous ' +
      'and were read as M/D/Y.'
    )
  }

  // -------------------------------------------------------------------------
  // STEP 2 — carried balance
  //
  // Computed BEFORE the insert rather than as a second pass, so a customer is
  // never live in ISPMan holding a balance that is about to be corrected.
  // -------------------------------------------------------------------------

  rule('STEP 2  carried balance')

  const legacyIds = candidates.map((c) => c.legacyId)

  // The legacy `balance` column is deliberately never read: the charging
  // mechanism was not running for part of its history, so the figure there is
  // not a debt anyone owes. Recency of payment is the only trustworthy signal.
  //
  // `date` is a VARCHAR holding 'YYYY-MM-DD HH:MM', so >= against a bare
  // 'YYYY-MM-DD' is a lexicographic comparison and is correct for this format.
  let paidRecently = new Set()
  if (legacyIds.length > 0) {
    const [rows] = await my.query(
      'SELECT DISTINCT customer FROM `' + SCHEMA + '`.payments ' +
      'WHERE customer IN (?) AND date >= ?',
      [legacyIds, PAID_SINCE]
    )
    paidRecently = new Set(rows.map((r) => Number(r.customer)))
  }

  let zeroed = 0
  let charged = 0
  let chargedTotal = 0
  for (const c of candidates) {
    c.carried_balance = paidRecently.has(c.legacyId) ? 0 : c.monthly_rate
    if (c.carried_balance === 0) zeroed += 1
    else {
      charged += 1
      chargedTotal += c.carried_balance
    }
  }

  console.log('  paid since ' + PAID_SINCE + ' -> balance 0 : ' + zeroed)
  console.log('  not paid -> balance = monthly rate : ' + charged)
  console.log('  total carried balance to write     : ' + chargedTotal.toLocaleString())

  // -------------------------------------------------------------------------
  // STEP 1 (write) — insert customers, keeping legacy id -> new id
  // -------------------------------------------------------------------------

  /** legacy id -> ISPMan customer id. In memory only; no legacy_id column. */
  const idMap = new Map()
  let inserted = 0

  const buildPayload = (c) => ({
    company_id: COMPANY_ID,
    first_name: c.first_name,
    last_name: c.last_name,
    phone: c.phone,
    address: c.address,
    gps: c.gps,
    notes: c.notes,
    pppoe_username: c.pppoe_username,

    // BOTH KEYS ARE ALWAYS PRESENT AND EXPLICITLY NULL WHEN EMPTY.
    // mac_address defaults to 00:00:00:00:00:00 and date_added defaults to
    // CURRENT_DATE, so omitting either lets the column default win silently:
    // every MAC-less customer would share one RADIUS username, and the whole
    // migrated base would read as having signed up on migration day.
    // Do not collapse these into a conditional spread.
    mac_address: c.mac_address,
    date_added: c.date_added,

    monthly_rate: c.monthly_rate,
    balance: 0,
    carried_balance: c.carried_balance,
    account_credit: 0,

    ...(c.cut_off_date != null ? { cut_off_date: c.cut_off_date } : {}),
    ...(c.bill_due_date != null ? { bill_due_date: c.bill_due_date } : {}),
  })

  if (DRY_RUN) {
    for (const c of candidates) idMap.set(c.legacyId, null)
    inserted = candidates.length
    if (candidates.length > 0) {
      console.log('\n  sample customer payload (first row, not written):')
      console.log(
        '    ' + JSON.stringify(buildPayload(candidates[0]), null, 2).replace(/\n/g, '\n    ')
      )
    }
  } else {
    for (const batch of chunk(candidates, CUSTOMER_CHUNK)) {
      const { data, error } = await supabase
        .from('customers')
        .insert(batch.map(buildPayload))
        .select('id')

      if (error) {
        // Retry the batch a row at a time so one bad row does not cost the
        // other 99, and so the report can name the offender.
        for (const c of batch) {
          const { data: one, error: rowError } = await supabase
            .from('customers').insert(buildPayload(c)).select('id').single()

          if (rowError) {
            skip(
              'customer',
              'legacy #' + c.legacyId + ' ' + c.first_name + ' ' + c.last_name,
              rowError.message
            )
          } else {
            idMap.set(c.legacyId, one.id)
            inserted += 1
          }
        }
        continue
      }

      // A multi-row INSERT ... RETURNING gives rows back in insertion order,
      // which is what pairs them with the batch. Asserted rather than trusted:
      // a mismatch would silently attach every later customer's payments to
      // the wrong person.
      if (data.length !== batch.length) {
        throw new Error(
          'Insert returned ' + data.length + ' ids for ' + batch.length + ' rows. ' +
          'Cannot pair legacy ids safely — stopping with a partial import.'
        )
      }
      batch.forEach((c, i) => idMap.set(c.legacyId, data[i].id))
      inserted += batch.length
    }
  }

  console.log('\n  customers inserted: ' + inserted)

  // -------------------------------------------------------------------------
  // STEP 3 — payment history
  //
  // CRITICAL: these are inserted as PLAIN ROWS. They must never go through
  // recordPayment() or anything else that settles a balance or extends access.
  // Replaying six months of payments through the live path would re-apply
  // every expiry extension against radcheck and overwrite every carried
  // balance step 2 just set. The rows exist for display and reporting only.
  // -------------------------------------------------------------------------

  rule('STEP 3  payments since ' + PAYMENTS_SINCE)

  // cld_users resolves the numeric agent ids. Older rows already hold a name.
  const agentNames = new Map()
  try {
    const [users] = await my.query('SELECT id, first_name, last_name FROM cld_users.users')
    for (const u of users) {
      agentNames.set(Number(u.id), [u.first_name, u.last_name].filter(Boolean).join(' ').trim())
    }
  } catch (err) {
    console.log(
      '  !! could not read cld_users.users (' + err.message + '); ' +
      'numeric agents will be written as "Legacy agent #<id>"'
    )
  }

  const resolveAgent = (raw) => {
    const s = (raw ?? '').toString().trim()
    if (!s) return 'Legacy import'
    if (!/^\d+$/.test(s)) return s
    return agentNames.get(Number(s)) || 'Legacy agent #' + s
  }

  const [legacyPayments] = await my.query(
    'SELECT id, customer, amount, type, date, agent FROM `' + SCHEMA + '`.payments ' +
    'WHERE date >= ? ORDER BY date ASC, id ASC',
    [PAYMENTS_SINCE]
  )
  console.log('  legacy payments in window: ' + legacyPayments.length)

  const paymentRows = []
  const methodCounts = {}
  let unmappedCustomer = 0

  for (const p of legacyPayments) {
    const legacyCustomer = Number(p.customer)

    if (!idMap.has(legacyCustomer)) {
      // Expected: the export was filtered, so the legacy company has payers
      // who are not part of this migration. Counted, not listed one by one.
      unmappedCustomer += 1
      continue
    }

    const dates = toPaymentDates(p.date)
    if (!dates) {
      skip('payment', 'legacy payment #' + p.id, 'unreadable date "' + p.date + '"')
      continue
    }

    const amount = Number(p.amount)
    if (!Number.isFinite(amount)) {
      skip('payment', 'legacy payment #' + p.id, 'unreadable amount "' + p.amount + '"')
      continue
    }

    const legacyType = (p.type ?? '').toString().trim().toLowerCase()
    const method = METHOD_BY_LEGACY_TYPE[legacyType] ?? 'other'
    if (!METHOD_BY_LEGACY_TYPE[legacyType]) {
      skip(
        'payment.type', 'legacy payment #' + p.id,
        'unknown type "' + p.type + '" — recorded as method "other"'
      )
    }
    methodCounts[method] = (methodCounts[method] ?? 0) + 1

    paymentRows.push({
      company_id: COMPANY_ID,
      customer_id: idMap.get(legacyCustomer),
      amount,
      months_paid: HISTORICAL_MONTHS_PAID,

      // paid_on is the DATE the app reports on; payment_date is the TIMESTAMPTZ
      // it orders by and renders on the customer page. See toPaymentDates.
      paid_on: dates.paidOn,
      payment_date: dates.paymentDate,

      payment_method: method,
      payment_type: legacyPaymentType(method),

      // 'service' is required to carry a null category (0013's CHECK).
      payment_kind: 'service',
      payment_category_id: null,

      // Never collected at an ISPMan till, so it belongs to no checkoff and to
      // no ISPMan user. Marking it checked off would assert a count that never
      // happened.
      checked_off: false,
      user_id: null,

      agent: resolveAgent(p.agent),
      notes: 'Migrated from legacy payment #' + p.id,

      // billing_period_*, access_granted_until, carried_balance_before/after,
      // access_decision, service_charge and service_active_until are left NULL
      // on purpose. The rate and add-ons in force when these were taken are
      // not recoverable, and inventing them would put wrong figures on a
      // reprinted receipt — the same reasoning migration 0013 gives for not
      // backfilling its own historical rows.
    })
  }

  console.log('  outside this migration (customer not in the export): ' + unmappedCustomer)
  console.log('  payments to insert       : ' + paymentRows.length)
  console.log(
    '  by method                : ' +
    (Object.entries(methodCounts).map(([m, n]) => m + '=' + n).join(', ') || 'none')
  )

  let paymentsInserted = 0
  if (DRY_RUN) {
    if (paymentRows.length > 0) {
      console.log('\n  sample payment row (not written):')
      console.log('    ' + JSON.stringify(paymentRows[0], null, 2).replace(/\n/g, '\n    '))
    }
  } else {
    for (const batch of chunk(paymentRows, PAYMENT_CHUNK)) {
      const { error } = await supabase.from('payments').insert(batch)
      if (error) {
        for (const row of batch) {
          const { error: rowError } = await supabase.from('payments').insert(row)
          if (rowError) skip('payment', row.notes, rowError.message)
          else paymentsInserted += 1
        }
        continue
      }
      paymentsInserted += batch.length
    }
  }

  // -------------------------------------------------------------------------
  // STEP 4 — report
  // -------------------------------------------------------------------------

  rule('STEP 4  report')

  console.log('  mode                       : ' + (DRY_RUN ? 'DRY RUN (nothing written)' : 'LIVE'))
  console.log('  legacy schema              : ' + SCHEMA)
  console.log('  target company             : ' + COMPANY_ID + ' (' + company.name + ')')
  console.log('')
  console.log('  CSV rows read              : ' + parsed.data.length)
  console.log('  customers inserted         : ' + inserted + (DRY_RUN ? ' (would be)' : ''))
  console.log('  balances zeroed (paid)     : ' + zeroed)
  console.log('  balances charged (unpaid)  : ' + charged)
  console.log('  carried balance written    : ' + chargedTotal.toLocaleString())
  console.log(
    '  payments inserted          : ' +
    (DRY_RUN ? paymentRows.length + ' (would be)' : paymentsInserted)
  )
  console.log('  payments outside migration : ' + unmappedCustomer)
  console.log('')
  console.log('  radcheck                   : NOT TOUCHED')

  if (skipped.length === 0) {
    console.log('\n  skipped: nothing')
  } else {
    console.log('\n  skipped / flagged (' + skipped.length + '):')
    const byStage = {}
    for (const s of skipped) (byStage[s.stage] ??= []).push(s)
    for (const [stage, items] of Object.entries(byStage)) {
      console.log('\n    [' + stage + '] ' + items.length)
      for (const s of items.slice(0, 25)) console.log('      ' + s.what + ' — ' + s.reason)
      if (items.length > 25) console.log('      ... and ' + (items.length - 25) + ' more')
    }
  }

  console.log('')
  await my.end()
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message)
  console.error(err.stack)
  process.exit(1)
})
