#!/usr/bin/env node
/**
 * ONE-OFF catch-up for a company already migrated: users, re-linking, the
 * payments taken since, and the checkoff handovers.
 *
 * DISPOSABLE. This is a cut-over aid, NOT a sync. Staff are still taking money
 * in the legacy app; this brings across what they took while ISPMan was being
 * set up, once. Delete it after the cut-over.
 *
 *   node scripts/catchup-company.mjs <schema> <company_id> --cld=<id> [--until=YYYY-MM-DD] [--dry-run]
 *
 *   node scripts/catchup-company.mjs COMPANY_wcnetjagmail_com 26 --cld=1 --dry-run
 *   node scripts/catchup-company.mjs COMPANY_kevinvernon11yahoo_com 31 --cld=3 --until=2026-09-14 --dry-run
 *
 * --until is the cut-off, inclusive to the end of that day in the company's
 * timezone: legacy rows dated later are left for the next run and reported.
 *
 * HOW STAFF ARE MATCHED — BY LEGACY ID, NOT BY EMAIL
 *   The original migration stamped user_id on every payment it imported. That
 *   is the durable record of "legacy agent #68 is ISPMan user 139", and it is
 *   what STEP 1 reads back: for each legacy agent id, the user_id its migrated
 *   payments carry. Email is only consulted for an agent with no migrated
 *   payments to learn from.
 *
 *   This used to match on email first and it failed silently: Chloe Graham
 *   Vernon's legacy address had a "1" appended ON PURPOSE, to stop her logging
 *   into the legacy system, so her twelve catch-up rows were about to import
 *   as "Agent #68" with no user link while her 3,451 migrated rows sat linked
 *   to user 139. Any address edited since migration would do the same.
 *
 * WHAT A CATCH-UP PAYMENT DOES TO THE CUSTOMER
 *   SETTLES THE BALANCE, by the migration's own rule: a payment since
 *   PAID_SINCE means the customer is square, so carried_balance goes to 0 and
 *   the row stamps carried_balance_before/after. Without this the customer
 *   keeps the opening balance the migration charged for a bill they have now
 *   paid, and the next bill run chases money the legacy till already took.
 *
 *   HOLDS THE SURPLUS AS CREDIT. Money beyond the balance becomes
 *   account_credit (stamped as credit_applied), which the bill run draws down
 *   before charging — the same thing ISPMan does for a prepayment at its own
 *   till. The migration zeroed flat and held nothing; that was a decision for
 *   history, not for money taken last week.
 *
 *   NEVER TOUCHES radcheck. The legacy app moved the expiry when it took the
 *   money; the expiry it holds is read and printed so nobody has to trust
 *   that, and a customer with no Expiration row is reported as unprovisioned
 *   and still recorded.
 *
 * HOW AN ALREADY-IMPORTED PAYMENT IS TOLD FROM A NEW ONE
 *   By the legacy id the migration wrote into `notes`:
 *
 *       Migrated from legacy payment #18676
 *
 *   Every existing note is read, the ids are collected, and only legacy rows
 *   whose id is absent are imported. This is a key, not a heuristic: matching
 *   on amount and date would confuse two customers paying the same figure on
 *   the same day, and there are plenty of those.
 *
 *   A payment taken in ISPMan carries notes = NULL, never matches the pattern,
 *   and is therefore never a candidate for anything this script does.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'

// ---------------------------------------------------------------------------
// Tunables — kept identical to migrate-legacy-company.mjs
// ---------------------------------------------------------------------------

const PAYMENTS_SINCE = '2026-03-04'
/** A payment on or after this date means the customer is square (migration STEP 2). */
const PAID_SINCE = '2026-08-20'
const HISTORICAL_MONTHS_PAID = 1
const PAYMENT_CHUNK = 200
const CONCURRENCY = 12

const ROLE_BY_LEGACY = {
  admin: 'company_admin',
  manager: 'manager',
  billing: 'cashier',
  'technical support': 'technician',
  'customer support': 'csr',
}
/**
 * Kept in step with lib/email.ts by hand — a .mjs script cannot import the TS.
 *
 * This was once stricter than the app, which accepted any non-empty TLD and so
 * let "renardosmith364@gmail.com1" through. That address is a real typo in
 * cld_users #51: nobody can receive mail at it, and an account created on it
 * would have had a login its owner could never recover. The app now rejects it
 * too, and both patterns say the same thing.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[A-Za-z]{2,63}$/
const PLATFORM_OPERATOR_LEGACY_IDS = new Set([40, 61, 67, 73, 74])
const LEGACY_NOTE = /^Migrated from legacy payment #(\d+)$/

/**
 * COPIED VERBATIM from migrate-legacy-company.mjs, and it has to stay that way.
 *
 * The legacy `type` column holds phrases, not keywords — "Cash Deposit",
 * "Bank Deposit", "Wire Transfer". A map written from memory with keys like
 * `cash` and `bank` matches none of them, and every payment silently becomes
 * method "other". That is exactly what the first run of this script did to all
 * 35 catch-up rows, against 516 "Cash Deposit" rows in the same window that the
 * original migration read correctly.
 */
const METHOD_BY_LEGACY_TYPE = {
  'cash deposit': 'cash',
  'bank deposit': 'bank_transfer',
  'wire transfer': 'wire_transfer',
  'cashapp': 'cashapp',
  'zelle': 'zelle',
  'bill express': 'other',
}

function legacyPaymentType(method) {
  if (method === 'cash') return 'cash'
  if (method === 'card' || method === 'cheque') return 'card'
  return 'online'
}

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
const CLD_COMPANY_ID = Number(opts.cld)
const DRY_RUN = flags.has('--dry-run')
const UNTIL = opts.until ?? null

if (!SCHEMA || !Number.isInteger(COMPANY_ID) || !Number.isInteger(CLD_COMPANY_ID)) {
  console.error('Usage: node scripts/catchup-company.mjs <schema> <company_id> --cld=<id> [--until=YYYY-MM-DD] [--dry-run]')
  process.exit(1)
}
if (UNTIL !== null && !/^\d{4}-\d{2}-\d{2}$/.test(UNTIL)) {
  console.error('--until must be YYYY-MM-DD'); process.exit(1)
}
for (const k of Object.keys(opts)) {
  if (!['cld', 'until'].includes(k)) { console.error('Unknown option --' + k); process.exit(1) }
}
for (const f of flags) {
  if (f !== '--dry-run') { console.error('Unknown flag ' + f); process.exit(1) }
}

function loadEnv(file = '.env.local') {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}
loadEnv()
const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error('Missing ' + n); process.exit(1) }
  return v
}

const tempPassword = () => randomBytes(18).toString('base64url')
const rule = (t) => { console.log('\n' + '-'.repeat(74)); console.log(t); console.log('-'.repeat(74)) }
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o }

/** See migrate-legacy-company.mjs — same rule, same reason. */
function zonedWallClockToUtc(y, mo, d, h, mi, timeZone) {
  const wanted = Date.UTC(y, mo - 1, d, h, mi, 0)
  const offsetAt = (instant) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant))
    const f = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    return Date.UTC(f('year'), f('month') - 1, f('day'), f('hour') % 24, f('minute'), f('second')) - instant
  }
  let g = wanted - offsetAt(wanted)
  g = wanted - offsetAt(g)
  const out = new Date(g)
  return Number.isFinite(out.getTime()) ? out : null
}

function toPaymentDates(legacyDate, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(legacyDate ?? '').trim())
  if (!m) return null
  const h = Number(m[4]); const mi = Number(m[5])
  if (h > 23 || mi > 59) return null
  const utc = zonedWallClockToUtc(Number(m[1]), Number(m[2]), Number(m[3]), h, mi, tz)
  if (!utc) return null
  return { paidOn: m[1] + '-' + m[2] + '-' + m[3], paymentDate: utc.toISOString() }
}

const skipped = []
const skip = (stage, what, why) => skipped.push({ stage, what, why })

async function main() {
  const supabase = createClient(
    need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'),
    password: need('RADIUS_DB_PASSWORD'), port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    dateStrings: true,
  })

  console.log('\n' + '='.repeat(74))
  console.log('CATCH-UP' + (DRY_RUN ? '  [DRY RUN — nothing will be written]' : '  [LIVE]'))
  console.log('='.repeat(74))
  console.log('  legacy schema : ' + SCHEMA)
  console.log('  company       : ' + COMPANY_ID + '   cld_users company ' + CLD_COMPANY_ID)

  const { data: company } = await supabase
    .from('companies').select('id, name').eq('id', COMPANY_ID).maybeSingle()
  if (!company) throw new Error('No ISPMan company #' + COMPANY_ID)
  const { data: st } = await supabase
    .from('settings').select('timezone').eq('company_id', COMPANY_ID).maybeSingle()
  const tz = st?.timezone || 'America/Jamaica'
  console.log('  name          : ' + company.name)
  console.log('  legacy times  : read in ' + tz)

  const page = async (table, cols) => {
    let out = [], from = 0
    for (;;) {
      const { data, error } = await supabase
        .from(table).select(cols).eq('company_id', COMPANY_ID).order('id').range(from, from + 999)
      if (error) throw new Error(table + ': ' + error.message)
      out = out.concat(data); if (data.length < 1000) break; from += 1000
    }
    return out
  }

  // -------------------------------------------------------------------------
  // STEP 1 — users
  // -------------------------------------------------------------------------
  rule('STEP 1  users')

  const [legacyUsers] = await my.query(
    'SELECT id, first_name, last_name, email, role FROM cld_users.users WHERE company_id = ? ORDER BY id',
    [CLD_COMPANY_ID]
  )
  const { data: existingUsers } = await supabase
    .from('users').select('id, first_name, last_name, email').eq('company_id', COMPANY_ID)
  const byEmail = new Map((existingUsers ?? []).map((u) => [String(u.email).toLowerCase(), u]))
  const userById = new Map((existingUsers ?? []).map((u) => [u.id, u]))

  // THE LINK THE MIGRATION WROTE. Every migrated payment carries the ISPMan
  // user_id of its legacy agent, and the legacy row still carries the agent
  // id, so joining the two on the legacy payment id says which ISPMan user
  // each legacy agent id IS. Read before the loop so it decides first.
  const allPayments = await page('payments', 'id, agent, user_id, notes')
  const importedByLegacyId = new Map()
  for (const p of allPayments) {
    const m = LEGACY_NOTE.exec(String(p.notes ?? ''))
    if (m) importedByLegacyId.set(Number(m[1]), p)
  }
  const [legacyAgentRows] = await my.query(
    'SELECT id, agent FROM `' + SCHEMA + '`.payments WHERE date >= ? AND agent REGEXP ?',
    [PAYMENTS_SINCE, '^[0-9]+$']
  )
  /** legacy agent id -> { user_id -> count of migrated payments stamped with it }. */
  const seen = new Map()
  for (const lp of legacyAgentRows) {
    const isp = importedByLegacyId.get(Number(lp.id))
    if (!isp || !isp.user_id) continue
    const agentId = Number(lp.agent)
    const tally = seen.get(agentId) ?? new Map()
    tally.set(isp.user_id, (tally.get(isp.user_id) ?? 0) + 1)
    seen.set(agentId, tally)
  }
  const linkedByLegacyId = new Map()
  for (const [agentId, tally] of seen) {
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1])
    if (ranked.length > 1) {
      skip('user', 'legacy agent #' + agentId,
        'migrated payments point at more than one ISPMan user: ' +
        ranked.map(([id, n]) => '#' + id + ' x' + n).join(', ') + ' — using the majority')
    }
    linkedByLegacyId.set(agentId, ranked[0][0])
  }

  /** legacy cld id -> { ispmanId, name }. Also keyed by name for the re-link. */
  const userMap = new Map()
  const plan = []

  for (const u of legacyUsers) {
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
    const email = String(u.email ?? '').trim().toLowerCase()
    const role = ROLE_BY_LEGACY[String(u.role ?? '').trim().toLowerCase()]

    if (PLATFORM_OPERATOR_LEGACY_IDS.has(Number(u.id))) {
      skip('user', '#' + u.id + ' ' + name, 'platform operator account — not recreated')
      continue
    }

    // 1. By legacy id, from what the migration stamped. Email is not looked at:
    //    it may have been edited on either side since, deliberately or not.
    const linked = linkedByLegacyId.get(Number(u.id))
    if (linked !== undefined) {
      const isp = userById.get(linked)
      userMap.set(Number(u.id), { ispmanId: linked, name })
      skip('user', '#' + u.id + ' ' + name,
        'linked by legacy id to ISPMan user #' + linked + (isp ? ' ' + isp.email : '') +
        (isp && String(isp.email).toLowerCase() !== email ? ' (legacy email differs: ' + u.email + ')' : ''))
      continue
    }

    // 2. No migrated payments to learn from: fall back to email, then create.
    if (!role) { skip('user', '#' + u.id + ' ' + name, 'unmapped role "' + u.role + '"'); continue }
    if (!EMAIL_RE.test(email)) {
      skip('user', '#' + u.id + ' ' + name, 'malformed email "' + u.email + '" and no migrated payments to link by'); continue
    }
    if (byEmail.has(email)) {
      const hit = byEmail.get(email)
      userMap.set(Number(u.id), { ispmanId: hit.id, name })
      skip('user', '#' + u.id + ' ' + name, 'no migrated payments; matched by email — reused')
      continue
    }
    plan.push({ legacyId: Number(u.id), name, email, role })
  }

  console.log('  legacy staff rows : ' + legacyUsers.length)
  console.log('  already in ISPMan : ' + userMap.size +
    ' (' + linkedByLegacyId.size + ' linked by legacy id from migrated payments)')
  console.log('  to create         : ' + plan.length)
  for (const p of plan) {
    console.log('    #' + String(p.legacyId).padEnd(5) + p.name.padEnd(24) + p.role.padEnd(15) + p.email)
  }

  // What skipping the platform operator costs, measured before it is skipped.
  const skippedIds = [...PLATFORM_OPERATOR_LEGACY_IDS]
  const [collected] = await my.query(
    'SELECT agent, COUNT(*) n, SUM(amount) total FROM `' + SCHEMA + '`.payments ' +
    'WHERE date >= ? AND agent IN (?) GROUP BY agent', [PAYMENTS_SINCE, skippedIds.map(String)]
  )
  if (collected.length > 0) {
    console.log('\n  !! SKIP COST — platform-operator accounts that DID collect:')
    for (const c of collected) {
      console.log('     agent ' + String(c.agent).padEnd(5) + c.n + ' legacy payments, J$' +
        Number(c.total).toLocaleString() + ' — stay as text, user_id null')
    }
  } else {
    console.log('\n  skip cost: none — no skipped account collected in the window')
  }

  const issued = []
  if (DRY_RUN) {
    for (const p of plan) userMap.set(p.legacyId, { ispmanId: null, name: p.name, planned: true })
    console.log('\n  would create ' + plan.length + ' accounts (nothing written)')
  } else {
    for (const p of plan) {
      const password = tempPassword()
      const { error: authError } = await supabase.auth.admin.createUser({
        email: p.email, password, email_confirm: true,
      })
      if (authError) { skip('user', p.name, 'auth failed: ' + authError.message); continue }
      const { data: row, error: rowError } = await supabase.from('users').insert({
        company_id: COMPANY_ID,
        first_name: p.name.split(' ')[0] ?? p.name,
        last_name: p.name.split(' ').slice(1).join(' ') || '',
        email: p.email, role: p.role, is_super_admin: false,
      }).select('id').maybeSingle()
      if (rowError || !row) { skip('user', p.name, 'profile failed: ' + (rowError?.message ?? '?')); continue }
      userMap.set(p.legacyId, { ispmanId: row.id, name: p.name })
      issued.push({ ...p, password })
    }
    console.log('\n  created ' + issued.length + ' accounts')
  }

  // Name -> ispman id, for the re-link. Safe HERE and only here: this map holds
  // one company's staff, and within cld_users company 1 every name is distinct.
  // Across companies it would not be — five accounts share "haydn samuels" —
  // which is why every other lookup in this migration is by id.
  const idByName = new Map()
  for (const v of userMap.values()) {
    // The whole entry, not just the id: in a dry run the id is null because no
    // row exists yet, and keying on the id would report every collector as
    // unlinkable — the opposite of what a live run does.
    if (v.name) idByName.set(v.name.trim().toLowerCase(), v)
  }

  // -------------------------------------------------------------------------
  // STEP 2 — re-link existing payments
  // -------------------------------------------------------------------------
  rule('STEP 2  re-link existing payments')

  const existingPayments = allPayments
  const migrated = existingPayments.filter((p) => LEGACY_NOTE.test(String(p.notes ?? '')))
  const native = existingPayments.filter((p) => !LEGACY_NOTE.test(String(p.notes ?? '')))

  console.log('  payments in company : ' + existingPayments.length)
  console.log('  migrated (notes)    : ' + migrated.length)
  console.log('  native (ISPMan)     : ' + native.length + '  — never touched')

  const relink = []
  const unlinkable = {}
  for (const p of migrated) {
    if (p.user_id) continue
    const hit = idByName.get(String(p.agent ?? '').trim().toLowerCase())
    if (hit === undefined) {
      unlinkable[p.agent ?? '(none)'] = (unlinkable[p.agent ?? '(none)'] ?? 0) + 1
      continue
    }
    relink.push({ id: p.id, userId: hit.ispmanId, agent: p.agent })
  }

  const byAgent = {}
  for (const r of relink) byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1
  console.log('\n  would link:')
  for (const [a, n] of Object.entries(byAgent).sort((x, y) => y[1] - x[1])) {
    console.log('    ' + String(n).padStart(5) + '  ' + a)
  }
  console.log('  staying unlinked:')
  for (const [a, n] of Object.entries(unlinkable).sort((x, y) => y[1] - x[1])) {
    console.log('    ' + String(n).padStart(5) + '  ' + a)
  }
  console.log('  total to re-link    : ' + relink.length)

  let relinked = 0
  if (!DRY_RUN) {
    for (let i = 0; i < relink.length; i += CONCURRENCY) {
      const slice = relink.slice(i, i + CONCURRENCY)
      const res = await Promise.all(slice.map((r) =>
        supabase.from('payments').update({ user_id: r.userId }).eq('id', r.id)
      ))
      for (const r of res) { if (r.error) skip('relink', 'payment', r.error.message); else relinked += 1 }
    }
    console.log('  re-linked           : ' + relinked)
  }

  // -------------------------------------------------------------------------
  // STEP 3 — catch-up payments
  // -------------------------------------------------------------------------
  rule('STEP 3  catch-up payments')

  const alreadyHave = new Set(migrated.map((p) => Number(LEGACY_NOTE.exec(p.notes)[1])))
  console.log('  legacy ids already imported : ' + alreadyHave.size)

  // The customer map. Legacy id lives in the customer's notes, same key. The
  // balance columns are what a catch-up payment settles; the identity is what
  // radcheck is read by, for the report only.
  const customers = await page('customers',
    'id, notes, first_name, last_name, carried_balance, account_credit, monthly_rate, ' +
    'customer_type, mac_address, pppoe_username')
  const customerByLegacy = new Map()
  for (const c of customers) {
    const m = /legacy\s*#\s*(\d+)/i.exec(String(c.notes ?? ''))
    if (m) customerByLegacy.set(Number(m[1]), c)
  }
  console.log('  customers keyed by legacy id: ' + customerByLegacy.size + ' of ' + customers.length)

  const [legacyPayments] = await my.query(
    'SELECT id, customer, amount, type, date, agent FROM `' + SCHEMA + '`.payments ' +
    'WHERE date >= ? ORDER BY date ASC, id ASC', [PAYMENTS_SINCE]
  )
  const notImported = legacyPayments.filter((p) => !alreadyHave.has(Number(p.id)))
  // The cut-off is inclusive to the end of the day. Legacy `date` is
  // 'YYYY-MM-DD HH:MM', so a string compare against 'YYYY-MM-DD 23:59' holds.
  const beyond = UNTIL ? notImported.filter((p) => String(p.date) > UNTIL + ' 23:59') : []
  const missing = UNTIL ? notImported.filter((p) => String(p.date) <= UNTIL + ' 23:59') : notImported
  console.log('  legacy rows in window       : ' + legacyPayments.length)
  console.log('  not yet in ISPMan           : ' + notImported.length)
  if (UNTIL) {
    console.log('  cut-off                     : end of ' + UNTIL + '  (' + beyond.length + ' later row(s) left for next time' +
      (beyond.length ? ', J$' + beyond.reduce((s, p) => s + Number(p.amount), 0).toLocaleString() : '') + ')')
  }

  const rows = []
  let noCustomer = 0
  const methodCounts = {}
  const catchAgents = {}
  /** ISPMan customer id -> the balance and credit as this run leaves them. */
  const ledger = new Map()
  let settledTotal = 0
  let creditTotal = 0

  for (const p of missing) {
    const customer = customerByLegacy.get(Number(p.customer))
    if (customer === undefined) { noCustomer += 1; continue }

    const dates = toPaymentDates(p.date, tz)
    if (!dates) { skip('payment', 'legacy #' + p.id, 'unreadable date "' + p.date + '"'); continue }

    const amount = Number(p.amount)
    if (!Number.isFinite(amount)) { skip('payment', 'legacy #' + p.id, 'bad amount'); continue }

    const legacyType = String(p.type ?? '').trim().toLowerCase()
    const method = METHOD_BY_LEGACY_TYPE[legacyType] ?? 'other'
    methodCounts[method] = (methodCounts[method] ?? 0) + 1

    const raw = String(p.agent ?? '').trim()
    const hit = /^\d+$/.test(raw) ? userMap.get(Number(raw)) : null
    const agent = hit ? hit.name : (/^\d+$/.test(raw) ? 'Agent #' + raw : raw || 'Legacy import')
    catchAgents[agent] = (catchAgents[agent] ?? 0) + 1

    // THE MIGRATION'S RULE, APPLIED TO THE ROWS IT DID NOT SEE. A payment on or
    // after PAID_SINCE means the customer is square: the balance goes to 0.
    // Money beyond the balance is held as credit, which is where ISPMan's own
    // till puts a prepayment. A second row for the same customer in this run
    // starts from where the first left them, not from the stored column.
    const state = ledger.get(customer.id) ?? {
      balance: Number(customer.carried_balance ?? 0),
      credit: Number(customer.account_credit ?? 0),
      openingBalance: Number(customer.carried_balance ?? 0),
      openingCredit: Number(customer.account_credit ?? 0),
    }
    const before = state.balance
    const square = dates.paidOn >= PAID_SINCE
    const after = square ? 0 : Math.max(0, before - amount)
    const credit = Math.max(0, amount - before)
    state.balance = after
    state.credit += credit
    ledger.set(customer.id, state)
    settledTotal += before - after
    creditTotal += credit

    rows.push({
      company_id: COMPANY_ID,
      customer_id: customer.id,
      amount,
      months_paid: HISTORICAL_MONTHS_PAID,
      paid_on: dates.paidOn,
      payment_date: dates.paymentDate,
      payment_method: method,
      payment_type: legacyPaymentType(method),
      payment_kind: 'service',
      payment_category_id: null,
      checked_off: false,
      user_id: hit ? hit.ispmanId : null,
      agent,
      notes: 'Migrated from legacy payment #' + p.id,
      // What this payment did, stamped the way app/actions/payments.ts stamps
      // it, so the receipt and a later correction read the same columns.
      amount_due: before,
      carried_balance_before: before,
      carried_balance_after: after,
      credit_applied: credit,
      // access_granted_until stays null: the legacy till moved the expiry and
      // this script does not restate what it did not do.
      _legacyId: Number(p.id),
      _legacyDate: String(p.date),
      _customerName: [customer.first_name, customer.last_name].filter(Boolean).join(' '),
      _identity: customer.customer_type === 'pppoe' ? customer.pppoe_username : customer.mac_address,
    })
  }

  // What the legacy till already did to access, read for the report and never
  // written. A customer with no Expiration row is recorded and reported.
  const identities = [...new Set(rows.map((r) => r._identity).filter(Boolean))]
  const radcheck = new Map()
  if (identities.length) {
    const [rc] = await my.query(
      'SELECT username, value FROM `' + need('RADIUS_DB_NAME') + '`.radcheck ' +
      'WHERE attribute = ? AND username IN (?)', ['Expiration', identities]
    )
    for (const r of rc) radcheck.set(r.username, r.value)
  }
  const unprovisioned = rows.filter((r) => !r._identity || !radcheck.has(r._identity))

  console.log('  customer not in ISPMan      : ' + noCustomer)
  console.log('  to insert                   : ' + rows.length)
  console.log('  by method                   : ' +
    (Object.entries(methodCounts).map(([m, n]) => m + '=' + n).join(', ') || 'none'))
  console.log('  by collector                : ' +
    (Object.entries(catchAgents).map(([a, n]) => a + '=' + n).join(', ') || 'none'))
  if (rows.length > 0) {
    console.log('  date range                  : ' + rows[0].paid_on + ' .. ' + rows[rows.length - 1].paid_on)
  }
  console.log('  balance settled             : J$' + settledTotal.toLocaleString() +
    ' across ' + [...ledger.values()].filter((s) => s.openingBalance !== s.balance).length + ' customers')
  console.log('  credit held                 : J$' + creditTotal.toLocaleString() +
    ' across ' + [...ledger.values()].filter((s) => s.credit !== s.openingCredit).length + ' customers')
  console.log('  unprovisioned (no radcheck) : ' + unprovisioned.length)

  if (rows.length) {
    console.log('\n  every row:')
    console.log('  ' + ['legacy', 'date', 'amount', 'collector', 'cust', 'name', 'before', 'after', 'credit', 'radcheck expiry'].join(' | '))
    for (const r of rows) {
      console.log('  ' + [
        '#' + r._legacyId, r._legacyDate, r.amount,
        r.agent + (r.user_id ? ' (#' + r.user_id + ')' : ' (NO USER LINK)'),
        r.customer_id, r._customerName,
        r.carried_balance_before, r.carried_balance_after, r.credit_applied,
        r._identity ? (radcheck.get(r._identity) ?? 'NOT PROVISIONED') : 'NO IDENTITY',
      ].join(' | '))
    }
  }
  for (const r of unprovisioned) {
    skip('payment', 'legacy #' + r._legacyId + ' ' + r._customerName,
      'recorded, but no Expiration row in radcheck — customer is not provisioned')
  }

  // The customer writes this run would make: one per customer, from the ledger.
  const customerPatches = [...ledger.entries()]
    .filter(([, s]) => s.balance !== s.openingBalance || s.credit !== s.openingCredit)
    .map(([id, s]) => ({ id, carried_balance: s.balance, account_credit: s.credit, openingBalance: s.openingBalance, openingCredit: s.openingCredit }))

  let inserted = 0
  let settled = 0
  if (DRY_RUN) {
    console.log('\n  would insert ' + rows.length + ' payment row(s) and update ' + customerPatches.length + ' customer balance(s) (nothing written)')
  } else {
    const clean = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))))
    for (const batch of chunk(clean, PAYMENT_CHUNK)) {
      const { error } = await supabase.from('payments').insert(batch)
      if (error) {
        for (const row of batch) {
          const { error: e } = await supabase.from('payments').insert(row)
          if (e) skip('payment', row.notes, e.message); else inserted += 1
        }
        continue
      }
      inserted += batch.length
    }
    console.log('  inserted                    : ' + inserted)

    // Guarded by the opening values, so a balance that moved between the read
    // above and this write (a till payment, a bill run) is not overwritten.
    for (const c of customerPatches) {
      const { error, count } = await supabase
        .from('customers')
        .update({ carried_balance: c.carried_balance, account_credit: c.account_credit }, { count: 'exact' })
        .eq('company_id', COMPANY_ID).eq('id', c.id)
        .eq('carried_balance', c.openingBalance).eq('account_credit', c.openingCredit)
      if (error) skip('settle', 'customer #' + c.id, error.message)
      else if ((count ?? 0) !== 1) skip('settle', 'customer #' + c.id, 'balance moved since it was read — not settled; check by hand')
      else settled += 1
    }
    console.log('  customers settled           : ' + settled + ' of ' + customerPatches.length)
  }

  // -------------------------------------------------------------------------
  // STEP 4 — checkoff handovers, history only
  // -------------------------------------------------------------------------
  rule('STEP 4  checkoff handovers (history only)')

  const [hasTable] = await my.query(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=? AND table_name=?',
    [SCHEMA, 'checkoff']
  )

  const coRows = []
  let coSkipped = 0

  if (Number(hasTable[0].n) === 0) {
    console.log('  no checkoff table in this schema')
  } else {
    const [all] = await my.query('SELECT id, amount, date, agent FROM `' + SCHEMA + '`.checkoff')
    const CLEAN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/
    const inWindow = all.filter((r) => CLEAN.test(String(r.date)) && String(r.date) >= PAYMENTS_SINCE)

    console.log('  checkoff rows total   : ' + all.length)
    console.log('  malformed (T or empty): ' +
      all.filter((r) => !CLEAN.test(String(r.date))).length + ' — all outside the window, excluded')
    console.log('  in window             : ' + inWindow.length)

    // Already imported? Same key idea, on the note.
    const existingCo = await page('checkoff_records', 'id, notes')
    const haveCo = new Set()
    for (const c of existingCo) {
      const m = /legacy checkoff #(\d+)/i.exec(String(c.notes ?? ''))
      if (m) haveCo.add(Number(m[1]))
    }
    console.log('  already imported      : ' + haveCo.size)

    for (const c of inWindow) {
      if (haveCo.has(Number(c.id))) { coSkipped += 1; continue }
      const dates = toPaymentDates(c.date, tz)
      if (!dates) { skip('checkoff', '#' + c.id, 'unreadable date'); continue }
      const raw = String(c.agent ?? '').trim()
      const hit = /^\d+$/.test(raw) ? userMap.get(Number(raw)) : null
      coRows.push({
        company_id: COMPANY_ID,
        agent_id: hit ? hit.ispmanId : null,
        agent_name: hit ? hit.name : (/^\d+$/.test(raw) ? 'Agent #' + raw : raw || 'Legacy'),
        checked_off_by: null,
        system_total: 0,
        amount_received: Number(c.amount),
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
    console.log('  to insert             : ' + coRows.length + (coSkipped ? '  (' + coSkipped + ' already there)' : ''))
  }

  let coInserted = 0
  if (!DRY_RUN && coRows.length) {
    const { error } = await supabase.from('checkoff_records').insert(coRows)
    if (error) skip('checkoff', 'batch', error.message)
    else coInserted = coRows.length
    console.log('  inserted              : ' + coInserted)
  }

  await my.end()

  // -------------------------------------------------------------------------
  rule('REPORT')
  console.log('  mode                : ' + (DRY_RUN ? 'DRY RUN (nothing written)' : 'LIVE'))
  console.log('  users created       : ' + (DRY_RUN ? plan.length + ' (would be)' : issued.length))
  console.log('  payments re-linked  : ' + (DRY_RUN ? relink.length + ' (would be)' : relinked))
  console.log('  payments imported   : ' + (DRY_RUN ? rows.length + ' (would be)' : inserted))
  console.log('  balances settled    : ' + (DRY_RUN ? customerPatches.length + ' customers (would be)' : settled) +
    ', J$' + settledTotal.toLocaleString() + ' cleared, J$' + creditTotal.toLocaleString() + ' held as credit')
  console.log('  handovers imported  : ' + (DRY_RUN ? coRows.length + ' (would be)' : coInserted))
  console.log('  native payments     : ' + native.length + ' — untouched')
  console.log('  radcheck            : NOT TOUCHED (read for the report only)')

  if (issued.length) {
    console.log('\n  ' + '!'.repeat(66))
    console.log('  TEMPORARY PASSWORDS — shown once, not stored, not recoverable.')
    console.log('  ' + '!'.repeat(66))
    for (const p of issued) {
      console.log('    ' + p.name.padEnd(24) + p.email.padEnd(34) + p.password)
    }
  }

  if (skipped.length) {
    console.log('\n  skipped / flagged (' + skipped.length + '):')
    const byStage = {}
    for (const s of skipped) (byStage[s.stage] ??= []).push(s)
    for (const [stage, items] of Object.entries(byStage)) {
      console.log('\n    [' + stage + '] ' + items.length)
      for (const s of items.slice(0, 20)) console.log('      ' + s.what + ' — ' + s.why)
      if (items.length > 20) console.log('      ... and ' + (items.length - 20) + ' more')
    }
  }
  console.log('')
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message)
  process.exit(1)
})
