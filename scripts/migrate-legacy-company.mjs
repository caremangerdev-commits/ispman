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

import { randomBytes } from 'node:crypto'
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

/**
 * Mirrors lib/account-number.ts#ACCOUNT_SEQ_BASE. Duplicated rather than
 * imported because this is a plain node script and that is a TypeScript module
 * behind the @/ alias; if the app's base ever changes, change it here too.
 */
const ACCOUNT_SEQ_BASE = 10000

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

/**
 * The ISPMan company to load into, or the literal `new` to have STEP -1 make
 * one. `let` because creating it is what fills this in.
 */
let COMPANY_ID = Number(positional[1])
const NEW_COMPANY = String(positional[1] ?? '').toLowerCase() === 'new'

/**
 * Actually create the company, rather than only printing what it would be.
 *
 * SEPARATE FROM `new` ON PURPOSE. `new` says which company to target; this says
 * go ahead and make it. Without this flag the run prints the payload and stops
 * before STEP 0, so the seven legacy-backed fields can be read before a tenant
 * exists.
 */
const CREATE_COMPANY = flags.has('--create-company')

/**
 * Currency and timezone, which the legacy database DOES NOT HOLD.
 *
 * cld_users.companies has no column for either and no per-schema settings row
 * supplies them, so there is nothing to migrate and any value the script picked
 * would be its own invention. Required explicitly when creating rather than
 * defaulted to JMD/America/Jamaica, because "every one of these is Jamaican so
 * far" is a pattern, not a fact about the next one.
 */
const CURRENCY = opts.currency
const TIMEZONE = opts.timezone

const CSV_PATH = opts.csv
const DRY_RUN = flags.has('--dry-run')
/** Allows a run against a company that already holds customers. */
const FORCE = flags.has('--force')

/**
 * The tenant's id in cld_users.companies — NOT the ISPMan company id and NOT
 * derivable from the schema name.
 *
 * Required, and deliberately not guessed. cld_users.users.company_id is the
 * only thing that says which staff belong to this WISP, and picking the wrong
 * one would create another company's people as this one's operators with live
 * logins. There is no safe default for that.
 */
const CLD_COMPANY_ID = Number(opts.cld)

/**
 * Read customers from the legacy `customers` table instead of an export CSV.
 *
 * West Central was migrated from a curated CSV that carried "Legacy #<id>" in
 * a notes column to link each row back. The remaining WISPs each keep a
 * `customers` table in their own schema whose primary key IS that legacy id,
 * with the same fields the CSV was built from — so for those there is no
 * export step to get wrong, no header to map by guesswork, and no chance of
 * running against a stale file.
 *
 * OPT-IN, not the default. --csv still behaves exactly as it did, because the
 * CSV path is what West Central was actually migrated with and changing it now
 * would invalidate the one run that has already happened.
 */
const FROM_DB = flags.has('--from-db')

/**
 * Extra cld_users ids to leave out, on top of the platform-operator set.
 * Comma separated: --skip-user=61,67
 */
const SKIP_USER_IDS = new Set(
  String(opts['skip-user'] ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Number.isInteger)
)

/**
 * How STEP 2 decides the opening balance. --carry=rate (the default) is the
 * behaviour every earlier run used; --carry=none opens every customer at zero.
 *
 * WHY THE CHOICE EXISTS. The default infers debt from silence: no payment
 * since PAID_SINCE means one month's rate is owed. That reads a real signal
 * when a company has payment history. When a company has NONE — and NYC NICK
 * MAR and Tkl Wireless have not one payment row between them, ever — the
 * inference has nothing behind it, and every single customer is billed a month
 * they may well have paid in cash off the books. Across those two that is
 * about J$1.5m of invented debt on day one.
 *
 * A zero opening balance is wrong in the other direction, and cheaply so: a
 * customer who really does owe is asked next cycle instead. An owner can chase
 * a payment that was missed. An owner cannot un-send a demand for money that
 * was never owed.
 */
const CARRY = String(opts['carry'] ?? 'rate').trim().toLowerCase()
if (!['rate', 'none'].includes(CARRY)) {
  console.error('--carry must be "rate" or "none". Refusing to run rather than guess.')
  process.exit(1)
}

if (
  !SCHEMA || (!Number.isInteger(COMPANY_ID) && !NEW_COMPANY) ||
  !Number.isInteger(CLD_COMPANY_ID) ||
  (!CSV_PATH && !FROM_DB) || (CSV_PATH && FROM_DB)
) {
  console.error(
    'Usage: node scripts/migrate-legacy-company.mjs <schema> (<company_id> | new) \\\n' +
    '         (--csv=<path> | --from-db) --cld=<cld_users company_id> \\\n' +
    '         [--create-company --currency=JMD --timezone=America/Jamaica] \\\n' +
    '         [--dry-run] [--force]\n\n' +
    '  --cld            the id in cld_users.companies: 1 West Central, 2 Kadian,\n' +
    '                   3 Vernon, 6 Tkl, 7 Smartcomm, 8 Smartcomm Bogue, 14 NYC NICK MAR.\n' +
    '  new              target a company STEP -1 will create.\n' +
    '  --create-company actually create it. Without this the payload is printed\n' +
    '                   and the run stops, so it can be checked first.\n' +
    '  --currency       required with --create-company. The legacy database has\n' +
    '  --timezone       no column for either, so neither can be migrated.\n' +
    '  --csv            a curated export whose notes carry "Legacy #<id>".\n' +
    '  --from-db        read customers straight from <schema>.customers.\n' +
    '                   Exactly one of --csv and --from-db.\n' +
    '  --carry          rate (default) opens unpaid customers owing one month.\n' +
    '                   none opens everyone at zero — use it when the company\n' +
    '                   has no payment history to infer anything from.'
  )
  process.exit(1)
}

if (CREATE_COMPANY && !NEW_COMPANY) {
  console.error('--create-company only makes sense with `new` as the company id.')
  process.exit(1)
}

if (CREATE_COMPANY && !DRY_RUN && (!CURRENCY || !TIMEZONE)) {
  console.error(
    'Creating a company needs --currency and --timezone. The legacy database\n' +
    'holds neither, so there is nothing to migrate and nothing safe to assume.'
  )
  process.exit(1)
}

// Guards against `--dry-run` being typo'd into something that silently writes.
for (const f of flags) {
  if (!['--dry-run', '--force', '--from-db', '--create-company'].includes(f)) {
    console.error('Unknown flag ' + f + '. Refusing to run rather than guess.')
    process.exit(1)
  }
}

// The same guard for the valued ones, which matters MORE and not less: a bare
// flag that goes unrecognised is at least absent, but `--cary=none` parses
// happily into opts, is never read, and the run falls back to charging every
// customer a month — the exact outcome the flag was passed to prevent.
for (const k of Object.keys(opts)) {
  if (!['cld', 'csv', 'currency', 'timezone', 'skip-user', 'carry'].includes(k)) {
    console.error('Unknown option --' + k + '. Refusing to run rather than guess.')
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
/**
 * The instant a legacy wall-clock time actually names.
 *
 * THIS USED TO PACK RATHER THAN CONVERT, and it produced times that were
 * technically ordered and visibly wrong. The old fold was
 *
 *   date + 'T12:' + hour + ':' + minute + 'Z'
 *
 * which put the legacy HOUR in the minutes field and the legacy MINUTE in the
 * seconds field. Ordering within a day survived, and nothing was lost — the
 * digits were all still there — but the app renders h:mm and does not show
 * seconds, so every payment taken in the same legacy hour displayed as the
 * same minute. It read as "rounded to the hour". Worse, 18:31 was stored as
 * 12:18Z and displayed as 7:18 AM.
 *
 * A legacy timestamp is wall-clock in the company's own zone, so the honest
 * conversion is that zone's offset at that moment. Jamaica has no DST, but the
 * offset is computed rather than assumed so the next market does not inherit a
 * hidden -5.
 */
function toPaymentDates(legacyDate, timeZone) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec((legacyDate ?? '').toString().trim())
  if (!m) return null

  const hour = Number(m[2])
  const minute = Number(m[3])
  if (hour > 23 || minute > 59) return null

  const [y, mo, d] = m[1].split('-').map(Number)
  const utc = zonedWallClockToUtc(y, mo, d, hour, minute, timeZone)
  if (!utc) return null

  return { paidOn: m[1], paymentDate: utc.toISOString() }
}

/**
 * Reads a wall-clock time in a named zone as the UTC instant it means.
 *
 * Two steps, because JavaScript has no "make a Date in this zone" constructor:
 * take the fields as if they were UTC, ask what wall-clock that instant shows
 * in the target zone, and shift by the difference. Applied twice so a boundary
 * lands correctly where the offset differs either side of it — a no-op in
 * Jamaica, which does not observe DST, and correct anywhere that does.
 */
function zonedWallClockToUtc(y, mo, d, h, mi, timeZone) {
  const wanted = Date.UTC(y, mo - 1, d, h, mi, 0)

  const offsetAt = (instant) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant))
    const f = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    const shown = Date.UTC(f('year'), f('month') - 1, f('day'), f('hour') % 24, f('minute'), f('second'))
    return shown - instant
  }

  let guess = wanted - offsetAt(wanted)
  guess = wanted - offsetAt(guess)
  const out = new Date(guess)
  return Number.isFinite(out.getTime()) ? out : null
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * cld_users.users.role -> ISPMan role.
 *
 * Billing -> cashier is the one worth stating: in the legacy app "Billing" is
 * the person at the counter taking money, which is exactly what ISPMan calls a
 * cashier. It is NOT an accounting role and must not become a manager, or the
 * migration would hand the payments book and the CSV export to every teller.
 *
 * An unrecognised role is NOT defaulted. Guessing would either over-grant (a
 * technician who can delete payments) or under-grant silently; the run reports
 * it and skips the account so a human decides.
 */
const ROLE_BY_LEGACY = {
  admin: 'company_admin',
  manager: 'manager',
  billing: 'cashier',
  'technical support': 'technician',
  'customer support': 'csr',
}

/** Same shape the app's own createUser enforces. */
/**
 * Kept in step with lib/email.ts by hand — a .mjs script cannot import the TS.
 * A staff account is a login and the only route to a password reset, so an
 * address that cannot receive mail is worse here than a rejected one. West
 * Central's #51 got through the older, looser pattern on "gmail.com1".
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[A-Za-z]{2,63}$/

/**
 * The platform operator's own legacy accounts, one per tenant. NOT staff.
 *
 * The legacy app had no cross-tenant role, so the operator gave themselves a
 * separate Admin login inside each company — five of them, all some case
 * variant of "haydn samuels", each with its own throwaway address:
 *
 *   #40 co1 wcnetjahs@   #61 co3 hagsamuels@   #67 co3 wcnetjav@
 *   #73 co7 wcnetjasm@   #74 co8 wcnetjasmb@
 *
 * ISPMan does have a cross-tenant role: the operator is one super_admin who
 * enters any tenant through the switch. Recreating these would hand out four
 * more live company_admin logins that nobody needs and that each widen the
 * blast radius of a leaked password.
 *
 * BY ID, NOT BY NAME — the same rule as everything else here. Matching
 * "haydn samuels" would be matching a string that five different rows share,
 * and would silently skip a genuine employee who happened to be called that.
 */
const PLATFORM_OPERATOR_LEGACY_IDS = new Set([40, 61, 67, 73, 74])

/** ISPMan's companies.phone is varchar(25). The legacy column is varchar(40). */
const COMPANY_PHONE_MAX = 25

/**
 * Fits a legacy phone field into the ISPMan column WITHOUT EVER CUTTING A
 * NUMBER IN HALF.
 *
 * The legacy field is free text and some companies list several numbers:
 * Vernon's is "18764149477/8765492791/18767975876", 34 characters against a
 * 25-character column, which is what stopped the first live run.
 *
 * A plain slice would have produced "18764149477/876549279" — a number that
 * looks dialable and is not. So the field is split on its separators and whole
 * numbers are kept while they fit; anything that does not fit is dropped and
 * REPORTED, so the operator knows a contact number did not come across rather
 * than finding out when they try to use it.
 */
function fitCompanyPhone(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { value: null, dropped: [] }
  if (text.length <= COMPANY_PHONE_MAX) return { value: text, dropped: [] }

  const parts = text.split(/[/,;]+/).map((s) => s.trim()).filter(Boolean)
  const kept = []
  const dropped = []
  for (const p of parts) {
    const candidate = kept.length ? kept.join('/') + '/' + p : p
    if (candidate.length <= COMPANY_PHONE_MAX) kept.push(p)
    else dropped.push(p)
  }

  // A single number longer than the column has no honest reduction: half a
  // phone number is worse than none, so it is dropped whole.
  return { value: kept.length ? kept.join('/') : null, dropped }
}

/**
 * A temporary password for a migrated account.
 *
 * THE LEGACY BCRYPT HASH CANNOT COME ACROSS. Supabase's admin createUser takes
 * a plaintext password, not a hash, so there is no supported way to carry the
 * old credential over — and carrying it would import whatever password policy
 * the legacy app had, which is unknown, along with any weak passwords in it.
 *
 * So every migrated account gets a fresh random one, printed ONCE by the run
 * that creates it and stored nowhere. 18 random bytes in base64url is well past
 * anything guessable and still short enough to read down a phone.
 */
function tempPassword() {
  return randomBytes(18).toString('base64url')
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
  console.log('  target company: ' + (NEW_COMPANY ? 'new (STEP -1)' : COMPANY_ID))
  console.log('  customer source: ' + (FROM_DB ? SCHEMA + '.customers (--from-db)' : CSV_PATH))

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

  // -------------------------------------------------------------------------
  // STEP -1 — the ISPMan company
  //
  // WHAT THE LEGACY SIDE ACTUALLY HOLDS is one row in cld_users.companies with
  // eight columns, of which seven are usable: name, email, address, phone,
  // cut_off_date, bill_due_date, bill. That is the whole of it. The per-schema
  // `settings` tables are empty in six of the seven WISPs and the seventh holds
  // a single row that CONTRADICTS the company row (West Central: company says
  // cut-off 5, its settings row says 7).
  //
  // So the seven are filled and NOTHING ELSE IS INVENTED. Currency, timezone,
  // date format, grace period, tax rate, expiry warning, expiry mode, billing
  // type, the three policy thresholds, the first-period rules, DDNS and the
  // RADIUS secret have no legacy source at all — they take ISPMan's own column
  // defaults, exactly as a company created through the platform UI would.
  // Guessing at them from a Jamaican address would be inventing billing policy.
  // -------------------------------------------------------------------------

  if (NEW_COMPANY) {
    rule('STEP -1  company')

    const [cldRows] = await my.query(
      'SELECT * FROM cld_users.companies WHERE company_id = ?', [CLD_COMPANY_ID]
    )
    if (cldRows.length === 0) {
      throw new Error('No cld_users.companies row with company_id ' + CLD_COMPANY_ID + '.')
    }
    const legacy = cldRows[0]

    const phone = fitCompanyPhone(legacy.company_phone)

    const companyPayload = {
      name: String(legacy.company_name ?? '').trim(),
      email: String(legacy.company_email ?? '').trim() || null,
      phone: phone.value,
      address: String(legacy.company_address ?? '').trim() || null,
      // Same two the platform's own New Company flow sets. Not legacy-derived —
      // the legacy database has no concept of either.
      plan: 'starter',
      status: 'active',
    }

    // Probed directly rather than through lib/schema.ts, which is a Next
    // module this plain script cannot import. Same test: ask for the column and
    // see whether PostgREST knows it (42703 = undefined column).
    const probe = await supabase.from('settings').select('default_monthly_rate').limit(1)
    const hasDefaultRate = probe.error?.code !== '42703'

    const settingsPayload = {
      cut_off_date: Number(legacy.cut_off_date),
      bill_date: Number(legacy.bill_due_date),
      ...(hasDefaultRate ? { default_monthly_rate: Number(legacy.bill) } : {}),
      currency: CURRENCY ?? '(required: --currency)',
      timezone: TIMEZONE ?? '(required: --timezone)',
      sms_enabled: false,
      email_enabled: false,
    }

    console.log('  from cld_users.companies #' + CLD_COMPANY_ID)

    if (phone.dropped.length > 0) {
      console.log(
        '\n  !! phone does not fit ISPMan\'s ' + COMPANY_PHONE_MAX + '-character column.\n' +
        '     legacy : ' + JSON.stringify(String(legacy.company_phone).trim()) + '\n' +
        '     keeping: ' + JSON.stringify(phone.value) + '\n' +
        '     DROPPED: ' + phone.dropped.join(', ') + '\n' +
        '     Whole numbers only — a truncated one would look dialable and not be.'
      )
    }

    console.log('\n  companies row:')
    for (const [k, v] of Object.entries(companyPayload)) {
      console.log('    ' + k.padEnd(10) + JSON.stringify(v))
    }
    console.log('\n  settings row (everything else takes ISPMan column defaults):')
    for (const [k, v] of Object.entries(settingsPayload)) {
      console.log('    ' + k.padEnd(22) + JSON.stringify(v))
    }

    console.log('\n  NOT migrated — no legacy source, ISPMan defaults apply:')
    console.log(
      '    date_format, grace_period_days, tax_rate, expiry_warning_days,\n' +
      '    default_expiry_mode, default_billing_type, late_credit_threshold,\n' +
      '    min_payment_threshold, max_carried_balance, first_expiry_rule_enabled,\n' +
      '    prorata_first_payment_enabled, ddns_hostname, radius_secret,\n' +
      '    country, tax_id_label, account_number_prefix'
    )

    // The company cut-off is the default for NEW customers only; every migrated
    // customer carries its own, which is just as well — they disagree.
    const [spread] = await my.query(
      'SELECT cut_off_date d, COUNT(*) n FROM `' + SCHEMA + '`.customers ' +
      'GROUP BY cut_off_date ORDER BY n DESC LIMIT 5'
    )
    if (spread.length > 1) {
      console.log(
        '\n  !! the company cut-off (' + legacy.cut_off_date + ') is not what its ' +
        'customers use: ' + spread.map((r) => r.d + '×' + r.n).join(', ') + '.\n' +
        '     Each migrated customer keeps its own, so this setting only affects ' +
        'customers added later.'
      )
    }

    if (!CREATE_COMPANY) {
      console.log(
        '\n  --create-company was not given, so nothing further will run.\n' +
        '  Check the two payloads above, then re-run with:\n' +
        '    --create-company --currency=<code> --timezone=<zone>'
      )
      await my.end()
      return
    }

    if (DRY_RUN) {
      console.log('\n  would create this company and settings row (nothing written)')
      // A real id is needed for the steps below to report anything meaningful.
      // -1 is obviously not a company and cannot be mistaken for one in output.
      COMPANY_ID = -1
    } else {
      const { data: made, error: makeError } = await supabase
        .from('companies').insert(companyPayload).select('id').single()
      if (makeError) throw new Error('Could not create the company: ' + makeError.message)
      COMPANY_ID = made.id
      console.log('\n  created company #' + COMPANY_ID)

      const { error: setError } = await supabase
        .from('settings').insert({ company_id: COMPANY_ID, ...settingsPayload })
      if (setError) {
        throw new Error(
          'Company #' + COMPANY_ID + ' was created but its settings row failed: ' +
          setError.message + '. Add one before running the rest, or the company ' +
          'falls back to app defaults for cut-off and bill date.'
        )
      }
      console.log('  created its settings row')

      // Without this the company issues null account numbers, silently — the
      // defect that left Vernon's 1,276 customers unnumbered on the first run.
      const { error: ctrError } = await supabase
        .from('account_counters')
        .insert({ company_id: COMPANY_ID, next_value: ACCOUNT_SEQ_BASE + 1 })
      if (ctrError) {
        throw new Error(
          'Company #' + COMPANY_ID + ' exists but its account-number counter failed: ' +
          ctrError.message + '. Every customer below would get a null account number.'
        )
      }
      console.log('  created its account-number counter (next ' + (ACCOUNT_SEQ_BASE + 1) + ')')
    }
  }

  const { data: company, error: companyError } = await supabase
    .from('companies').select('id, name').eq('id', COMPANY_ID).maybeSingle()
  if (companyError) throw new Error('Could not read company: ' + companyError.message)
  if (!company && !(DRY_RUN && NEW_COMPANY)) {
    throw new Error('No company with id ' + COMPANY_ID + ' in ISPMan.')
  }
  console.log('  company name  : ' + (company?.name ?? '(would be created by STEP -1)'))

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
  // STEP 0 — users
  //
  // FIRST, because payments resolve their agent through the map this builds. A
  // payment migrated before its collector exists can only ever be attributed
  // by name, and re-attributing it afterwards means rewriting rows nobody
  // should be rewriting.
  // -------------------------------------------------------------------------

  // The zone every legacy wall-clock time is read in. Read from the company's
  // own settings rather than assumed: a legacy '20:14' means 20:14 where the
  // WISP is, and that is the only thing that makes it an instant.
  const companyTimeZone = await (async () => {
    const { data } = await supabase
      .from('settings').select('timezone').eq('company_id', COMPANY_ID).maybeSingle()
    return data?.timezone || TIMEZONE || 'America/Jamaica'
  })().catch(() => TIMEZONE || 'America/Jamaica')
  console.log('  legacy times read in : ' + companyTimeZone)

  rule('STEP 0  users  (cld_users company ' + CLD_COMPANY_ID + ')')

  const [legacyUsers] = await my.query(
    'SELECT id, first_name, last_name, email, role, phone FROM cld_users.users ' +
    'WHERE company_id = ? ORDER BY id',
    [CLD_COMPANY_ID]
  )
  console.log('  legacy staff rows: ' + legacyUsers.length)

  /** legacy cld_users.id -> { ispmanId, name, role } once created. */
  const userMap = new Map()
  const userPlan = []

  // Emails already in ISPMan, so a re-run or an overlapping tenant does not
  // try to create an auth account that exists.
  const { data: existingUsers } = await supabase
    .from('users').select('id, email').eq('company_id', COMPANY_ID)
  const existingByEmail = new Map(
    (existingUsers ?? []).map((u) => [String(u.email).toLowerCase(), u.id])
  )

  for (const u of legacyUsers) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
    const email = String(u.email ?? '').trim().toLowerCase()
    const role = ROLE_BY_LEGACY[String(u.role ?? '').trim().toLowerCase()]

    if (PLATFORM_OPERATOR_LEGACY_IDS.has(Number(u.id)) || SKIP_USER_IDS.has(Number(u.id))) {
      skip(
        'user', '#' + u.id + ' ' + name,
        'platform operator account — not recreated; the operator is one ' +
        'super_admin who enters the tenant through the switch'
      )
      continue
    }

    if (!role) {
      skip('user', '#' + u.id + ' ' + name, 'unmapped legacy role "' + u.role + '"')
      continue
    }

    // #51's address is "renardosmith364@gmail.com1" — a real row with a typo
    // that no validator will accept and that nobody could receive mail at. It
    // is reported and skipped rather than repaired: inventing an address for
    // somebody creates a login they cannot recover, and the fix is one edit in
    // the legacy row by whoever knows the real address.
    if (!EMAIL_RE.test(email)) {
      skip('user', '#' + u.id + ' ' + name, 'malformed email "' + u.email + '"')
      continue
    }

    if (existingByEmail.has(email)) {
      userMap.set(Number(u.id), {
        ispmanId: existingByEmail.get(email), name, role, reused: true,
      })
      skip('user', '#' + u.id + ' ' + name, 'already in ISPMan as ' + email + ' — reused, not recreated')
      continue
    }

    userPlan.push({ legacyId: Number(u.id), name, email, role, phone: u.phone ?? null })
  }

  for (const p of userPlan) {
    console.log(
      '    #' + String(p.legacyId).padEnd(5) + p.name.padEnd(24) +
      p.role.padEnd(15) + p.email
    )
  }

  // SKIPPING SOMEBODY WHO TOOK MONEY HAS A COST, and it should be visible
  // before the run rather than discovered in the payments report afterwards.
  // Every payment they collected lands as "Agent #<id>" with no account behind
  // it, which is honest but unlinkable. For the platform operator that is
  // usually right — they were not really the cashier — but it is a decision,
  // so the run states the size of it.
  const notCreated = [...PLATFORM_OPERATOR_LEGACY_IDS, ...SKIP_USER_IDS]
  if (notCreated.length > 0) {
    const [collected] = await my.query(
      'SELECT agent, COUNT(*) n, SUM(amount) total FROM `' + SCHEMA + '`.payments ' +
      'WHERE date >= ? AND agent IN (?) GROUP BY agent',
      [PAYMENTS_SINCE, notCreated.map(String)]
    )
    if (collected.length > 0) {
      console.log('\n  !! skipped accounts that DID collect in the window:')
      for (const c of collected) {
        console.log(
          '     agent ' + String(c.agent).padEnd(6) + c.n + ' payments, J$' +
          Number(c.total).toLocaleString() + ' — will read "Agent #' + c.agent +
          '", user_id null'
        )
      }
    } else {
      console.log('\n  skipped accounts collected nothing in the window — no payment loses a link')
    }
  }

  let usersCreated = 0
  const issuedPasswords = []

  if (DRY_RUN) {
    // SEEDED, exactly as STEP 1 seeds idMap for the same reason. Without this
    // the map stays empty, every agent lookup in STEP 3 misses, and the dry
    // run reports "Agent #65, name only" for collectors that a live run would
    // link to a real account — the opposite of what would actually happen,
    // which is the one thing a dry run must never do. The id is null because
    // no row exists yet; the live run fills it.
    for (const p of userPlan) {
      userMap.set(p.legacyId, { ispmanId: null, name: p.name, role: p.role, planned: true })
    }
    console.log('\n  would create ' + userPlan.length + ' ISPMan accounts (nothing written)')
  } else {
    for (const p of userPlan) {
      const password = tempPassword()

      // Auth first, then the profile — the same order and the same reasoning as
      // app/actions/users.ts#createUser: an auth account with no profile fails
      // closed at login, a profile with no auth account cannot be signed into
      // at all and is invisible until someone tries.
      const { error: authError } = await supabase.auth.admin.createUser({
        email: p.email,
        password,
        email_confirm: true,
      })
      if (authError) {
        skip('user', p.name, 'auth account failed: ' + authError.message)
        continue
      }

      const { data: row, error: rowError } = await supabase
        .from('users')
        .insert({
          company_id: COMPANY_ID,
          first_name: p.name.split(' ')[0] ?? p.name,
          last_name: p.name.split(' ').slice(1).join(' ') || '',
          email: p.email,
          role: p.role,
          is_super_admin: false,
        })
        .select('id')
        .maybeSingle()

      if (rowError || !row) {
        skip('user', p.name, 'profile failed: ' + (rowError?.message ?? 'no row returned') +
          ' — remove the auth user in Supabase before re-running')
        continue
      }

      userMap.set(p.legacyId, { ispmanId: row.id, name: p.name, role: p.role })
      issuedPasswords.push({ name: p.name, email: p.email, password })
      usersCreated += 1
    }
  }

  // -------------------------------------------------------------------------
  // STEP 1 — customers, from the export CSV
  // -------------------------------------------------------------------------

  rule('STEP 1  customers' + (FROM_DB ? '  (from ' + SCHEMA + '.customers)' : ''))

  // The legacy table already has the shape the CSV was exported into, so it is
  // turned into the same rows Papa would have produced and everything below
  // this point is identical for both sources. `id` becomes the "Legacy #<id>"
  // the CSV path parses out of a notes column — here it is the primary key,
  // so it cannot be missing or duplicated.
  let parsed
  if (FROM_DB) {
    const [dbRows] = await my.query(
      'SELECT id, name, location, phone, mac, bill, gps, username, ' +
      'date_added, cut_off_date, bill_due_date FROM `' + SCHEMA + '`.customers ORDER BY id'
    )
    parsed = {
      errors: [],
      meta: {
        fields: [
          'name', 'location', 'phone', 'mac', 'bill', 'gps', 'username',
          'date_added', 'cut_off_date', 'bill_due_date', 'notes',
        ],
      },
      data: dbRows.map((r) => ({
        name: r.name,
        location: r.location,
        phone: r.phone,
        mac: r.mac,
        bill: r.bill,
        // '1' is this table's default for "no location recorded" and is not a
        // coordinate. Passed through as blank so parseGps never sees it.
        gps: String(r.gps ?? '').trim() === '1' ? '' : r.gps,
        username: r.username,
        date_added: r.date_added,
        cut_off_date: r.cut_off_date,
        bill_due_date: r.bill_due_date,
        notes: 'Legacy #' + r.id,
      })),
    }
  } else {
    const csvText = readFileSync(CSV_PATH, 'utf8').replace(/^﻿/, '')
    parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true })
  }

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
  if (CARRY === 'none') {
    // Nothing is queried: with every balance going to zero the answer cannot
    // change the outcome, and reading it would only invite someone to believe
    // the number below was derived from it.
    console.log('  --carry=none — every customer opens at 0')
  } else if (legacyIds.length > 0) {
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
    c.carried_balance =
      CARRY === 'none' || paidRecently.has(c.legacyId) ? 0 : c.monthly_rate
    if (c.carried_balance === 0) zeroed += 1
    else {
      charged += 1
      chargedTotal += c.carried_balance
    }
  }

  console.log('  opening balance of 0               : ' + zeroed +
    (CARRY === 'none' ? '  (all of them — --carry=none)' : '  (paid since ' + PAID_SINCE + ')'))
  console.log('  not paid -> balance = monthly rate : ' + charged)
  console.log('  total carried balance to write     : ' + chargedTotal.toLocaleString())

  // -------------------------------------------------------------------------
  // STEP 1 (write) — insert customers, keeping legacy id -> new id
  // -------------------------------------------------------------------------

  /** legacy id -> ISPMan customer id. In memory only; no legacy_id column. */
  const idMap = new Map()
  let inserted = 0

  // ---------------------------------------------------------------------------
  // ACCOUNT NUMBERS, assigned here rather than left to the app.
  //
  // These customers are inserted as plain rows, so nothing calls the allocator
  // and every one of them would arrive with a null account number — which is
  // exactly what happened to Vernon, Bogue and Networking on their first runs.
  // Creating the counter was necessary and was not sufficient.
  //
  // Numbered by position in the same id order the rows are inserted in, from
  // the counter's current value, and the counter is moved past them afterwards
  // so the next customer added through the app continues the run rather than
  // colliding with it.
  // ---------------------------------------------------------------------------
  const accountPrefix = await (async () => {
    const { data } = await supabase
      .from('settings').select('account_number_prefix').eq('company_id', COMPANY_ID).maybeSingle()
    const raw = String(data?.account_number_prefix ?? '').toUpperCase().replace(/[^A-Z]/g, '')
    return raw.length >= 2 ? raw.slice(0, 3) : null
  })().catch(() => null)

  const accountBase = await (async () => {
    const { data } = await supabase
      .from('account_counters').select('next_value').eq('company_id', COMPANY_ID).maybeSingle()
    return Number(data?.next_value ?? ACCOUNT_SEQ_BASE + 1)
  })().catch(() => ACCOUNT_SEQ_BASE + 1)

  candidates.forEach((c, i) => {
    const digits = String(Math.max(ACCOUNT_SEQ_BASE + 1, accountBase + i))
    c.account_number = accountPrefix ? accountPrefix + '-' + digits : digits
  })

  console.log(
    '  account numbers  : ' +
    (candidates.length
      ? candidates[0].account_number + ' .. ' + candidates[candidates.length - 1].account_number
      : 'none') +
    (accountPrefix ? '  (prefix ' + accountPrefix + ')' : '')
  )

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

    // Assigned above, never left to the column default (there is none) or to
    // the app (nothing calls the allocator on this path).
    account_number: c.account_number,

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

  // The counter has to move past the block just issued, or the next customer
  // added through the app takes 10001 again and the unique index rejects them
  // in front of an operator.
  if (!DRY_RUN && candidates.length > 0) {
    const nextValue = accountBase + candidates.length
    const { error: bumpError } = await supabase
      .from('account_counters')
      .update({ next_value: nextValue, updated_at: new Date().toISOString() })
      .eq('company_id', COMPANY_ID)

    if (bumpError) {
      console.log(
        '  !! could not move the account counter past the migrated block: ' +
        bumpError.message + '\n' +
        '     Set account_counters.next_value for company ' + COMPANY_ID +
        ' to ' + nextValue + ' before anyone adds a customer.'
      )
    } else {
      console.log('  account counter   : next ' + nextValue)
    }
  }

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

  /**
   * Who took this payment, resolved through STEP 0's map — BY ID ONLY.
   *
   * Never by name. cld_users holds five accounts called some case-variant of
   * "haydn samuels" across four companies, and seven names are duplicated
   * across the platform in total; matching on a name would attribute one
   * company's takings to another company's operator. The legacy `agent` column
   * holds the id for every row in the six-month window of every WISP, so the
   * id is both the safe key and the available one.
   *
   * A HIT sets user_id and the person's real name. A MISS sets
   * "Agent #<id>" with user_id null — the shape ISPMan already handles
   * everywhere, because 425 of its existing payments name former staff who
   * have no account (see getAgentCollections and loadReceipt, which both fall
   * back to the name). Five such ids exist across the remaining WISPs and NONE
   * of them is nameable: they appear nowhere in this database except as an
   * integer in this column, so there is no person to create an account for.
   */
  const resolveAgent = (raw) => {
    const s = (raw ?? '').toString().trim()
    if (!s) return { agent: 'Legacy import', userId: null }

    if (!/^\d+$/.test(s)) {
      // Pre-2023 rows carry a bare name, and some of those names are shops
      // ("Reggae Blend", "Max Variety") rather than staff. Kept verbatim.
      return { agent: s, userId: null }
    }

    const hit = userMap.get(Number(s))
    return hit
      ? { agent: hit.name, userId: hit.ispmanId }
      : { agent: 'Agent #' + s, userId: null }
  }

  const agentTally = new Map()

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

    const dates = toPaymentDates(p.date, companyTimeZone)
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

      // NEVER checked off. These were not counted at an ISPMan till, and
      // marking them so would assert a reconciliation that never happened —
      // see STEP 3b, which imports the legacy handovers as history precisely
      // because they cannot be tied back to these rows.
      checked_off: false,

      // user_id is set when the legacy agent id resolves to an account created
      // in STEP 0, and left null when it does not. Both are correct answers.
      ...(() => {
        const who = resolveAgent(p.agent)
        agentTally.set(who.agent, (agentTally.get(who.agent) ?? 0) + 1)
        return { user_id: who.userId, agent: who.agent }
      })(),

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
  // STEP 3b — checkoff handovers, AS HISTORY ONLY
  //
  // The legacy checkoff table is id, amount, date, agent. There is NO payment
  // reference of any kind — it records that a sum changed hands, not which
  // payments made it up. So these rows come across as a standalone record and
  // NOTHING is inferred: no payment is marked checked_off, and no attempt is
  // made to find a set of payments by that agent that happens to sum to the
  // amount. That arithmetic would produce a reconciliation nobody performed,
  // presented with the authority of one that was.
  //
  // Only West Central has any: 498 rows there, 0 in every other WISP.
  // -------------------------------------------------------------------------

  rule('STEP 3b  checkoff handovers (history only)')

  const [checkoffTable] = await my.query(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [SCHEMA, 'checkoff']
  )

  const checkoffRows = []
  let checkoffUnreadable = 0

  if (Number(checkoffTable[0].n) === 0) {
    console.log('  no checkoff table in this schema — nothing to import')
  } else {
    const [legacyCheckoffs] = await my.query(
      'SELECT id, amount, date, agent FROM `' + SCHEMA + '`.checkoff ' +
      'WHERE date >= ? ORDER BY date ASC, id ASC',
      [PAYMENTS_SINCE]
    )
    console.log('  legacy handovers in window: ' + legacyCheckoffs.length)

    for (const c of legacyCheckoffs) {
      // checkoff.date is NOT clean the way payments.date is: 19 of West
      // Central's 498 rows are either empty or use a 'T' separator. Payments
      // can be string-compared safely; these cannot, so each one is parsed and
      // an unreadable date drops the row rather than inventing a moment.
      const dates = toPaymentDates(c.date, companyTimeZone)
      if (!dates) {
        checkoffUnreadable += 1
        skip('checkoff', 'legacy checkoff #' + c.id, 'unreadable date "' + c.date + '"')
        continue
      }

      const who = resolveAgent(c.agent)
      const amount = Number(c.amount)
      if (!Number.isFinite(amount)) {
        skip('checkoff', 'legacy checkoff #' + c.id, 'unreadable amount "' + c.amount + '"')
        continue
      }

      checkoffRows.push({
        company_id: COMPANY_ID,
        agent_id: who.userId,
        agent_name: who.agent,
        // Nobody in ISPMan performed this count, so there is no user to name as
        // having done it. Null says that; naming the importer would not.
        checked_off_by: null,

        // amount_received is what the agent handed over — the one figure the
        // legacy row actually holds. system_total is what the till said was
        // due, which this table never recorded, and discrepancy is the
        // difference between them. Both are left at 0/null rather than
        // back-filled from the handover, which would assert that the count
        // balanced exactly when nothing here knows whether it did.
        system_total: 0,
        amount_received: amount,
        discrepancy: null,
        customers_count: 0,
        is_all_agents: false,

        notes:
          'Migrated from legacy checkoff #' + c.id + ' (' + c.date + '). ' +
          'History only: the legacy table records the handover but not which ' +
          'payments made it up, so no payment is linked or marked checked off.',
        created_at: dates.paymentDate,
      })
    }
  }

  console.log('  handovers to insert       : ' + checkoffRows.length)
  if (checkoffUnreadable) {
    console.log('  dropped for unreadable date: ' + checkoffUnreadable)
  }

  let checkoffsInserted = 0
  if (DRY_RUN) {
    if (checkoffRows.length > 0) {
      console.log('\n  sample handover row (not written):')
      console.log('    ' + JSON.stringify(checkoffRows[0], null, 2).replace(/\n/g, '\n    '))
    }
  } else {
    for (const batch of chunk(checkoffRows, PAYMENT_CHUNK)) {
      const { error } = await supabase.from('checkoff_records').insert(batch)
      if (error) {
        for (const row of batch) {
          const { error: rowError } = await supabase.from('checkoff_records').insert(row)
          if (rowError) skip('checkoff', row.notes, rowError.message)
          else checkoffsInserted += 1
        }
        continue
      }
      checkoffsInserted += batch.length
    }
  }

  // -------------------------------------------------------------------------
  // STEP 4 — report
  // -------------------------------------------------------------------------

  rule('STEP 4  report')

  console.log('  mode                       : ' + (DRY_RUN ? 'DRY RUN (nothing written)' : 'LIVE'))
  console.log('  legacy schema              : ' + SCHEMA)
  console.log(
    '  target company             : ' +
    (company ? COMPANY_ID + ' (' + company.name + ')' : 'would be created by STEP -1')
  )
  console.log('')
  console.log('  CSV rows read              : ' + parsed.data.length)
  console.log('  customers inserted         : ' + inserted + (DRY_RUN ? ' (would be)' : ''))
  console.log('  balances zeroed' +
    (CARRY === 'none' ? ' (--carry=none)' : ' (paid)     ') + ': ' + zeroed)
  console.log('  balances charged (unpaid)  : ' + charged)
  console.log('  carried balance written    : ' + chargedTotal.toLocaleString())
  console.log(
    '  payments inserted          : ' +
    (DRY_RUN ? paymentRows.length + ' (would be)' : paymentsInserted)
  )
  console.log('  payments outside migration : ' + unmappedCustomer)
  console.log(
    '  users created              : ' +
    (DRY_RUN ? userPlan.length + ' (would be)' : usersCreated)
  )
  console.log(
    '  checkoff handovers         : ' +
    (DRY_RUN ? checkoffRows.length + ' (would be)' : checkoffsInserted) + ' (history only)'
  )
  console.log('')
  console.log('  radcheck                   : NOT TOUCHED')

  // Who the migrated payments end up attributed to, and how many of them
  // reach a real account rather than a name.
  if (agentTally.size > 0) {
    console.log('\n  payments by collector:')
    const linked = new Set([...userMap.values()].map((u) => u.name))
    for (const [name, n] of [...agentTally.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(
        '    ' + String(n).padStart(6) + '  ' + name.padEnd(28) +
        (linked.has(name)
          ? (DRY_RUN ? 'would link to the account STEP 0 creates' : 'linked to an ISPMan account')
          : 'name only, user_id null — nobody to link to')
      )
    }
  }

  // Printed ONCE, by the run that created them, and stored nowhere. The legacy
  // bcrypt hash cannot be carried into Supabase auth, so these are new
  // credentials that have to reach their owners out of band.
  if (issuedPasswords.length > 0) {
    console.log('\n  ' + '!'.repeat(66))
    console.log('  TEMPORARY PASSWORDS — shown once, not stored, not recoverable.')
    console.log('  Give each person theirs and have them change it at first sign-in.')
    console.log('  ' + '!'.repeat(66))
    for (const p of issuedPasswords) {
      console.log('    ' + p.name.padEnd(24) + p.email.padEnd(34) + p.password)
    }
  }

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
