#!/usr/bin/env node
/**
 * ONE-OFF catch-up for a company already migrated: users, re-linking, the
 * payments taken since, and the checkoff handovers.
 *
 * DISPOSABLE. This is a cut-over aid, NOT a sync. Staff are still taking money
 * in the legacy app; this brings across what they took while ISPMan was being
 * set up, once. Delete it after the cut-over.
 *
 *   node scripts/catchup-company.mjs <schema> <company_id> --cld=<id> [--dry-run]
 *
 *   node scripts/catchup-company.mjs COMPANY_wcnetjagmail_com 26 --cld=1 --dry-run
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
 * Stricter than the app's own check, deliberately.
 *
 * app/actions/users.ts accepts `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, where the TLD
 * only has to be non-empty — so "renardosmith364@gmail.com1" passes it. That
 * address is a real typo in cld_users #51, nobody can receive mail at it, and
 * the earlier migration would have created an account whose owner could never
 * recover the login. The TLD has to be letters.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/
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

if (!SCHEMA || !Number.isInteger(COMPANY_ID) || !Number.isInteger(CLD_COMPANY_ID)) {
  console.error('Usage: node scripts/catchup-company.mjs <schema> <company_id> --cld=<id> [--dry-run]')
  process.exit(1)
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
    if (!role) { skip('user', '#' + u.id + ' ' + name, 'unmapped role "' + u.role + '"'); continue }
    if (!EMAIL_RE.test(email)) {
      skip('user', '#' + u.id + ' ' + name, 'malformed email "' + u.email + '"'); continue
    }
    if (byEmail.has(email)) {
      const hit = byEmail.get(email)
      userMap.set(Number(u.id), { ispmanId: hit.id, name })
      skip('user', '#' + u.id + ' ' + name, 'already in ISPMan — reused')
      continue
    }
    plan.push({ legacyId: Number(u.id), name, email, role })
  }

  console.log('  legacy staff rows : ' + legacyUsers.length)
  console.log('  already in ISPMan : ' + userMap.size)
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

  const existingPayments = await page('payments', 'id, agent, user_id, notes')
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

  // The customer map. Legacy id lives in the customer's notes, same key.
  const customers = await page('customers', 'id, notes')
  const customerByLegacy = new Map()
  for (const c of customers) {
    const m = /legacy\s*#\s*(\d+)/i.exec(String(c.notes ?? ''))
    if (m) customerByLegacy.set(Number(m[1]), c.id)
  }
  console.log('  customers keyed by legacy id: ' + customerByLegacy.size + ' of ' + customers.length)

  const [legacyPayments] = await my.query(
    'SELECT id, customer, amount, type, date, agent FROM `' + SCHEMA + '`.payments ' +
    'WHERE date >= ? ORDER BY date ASC, id ASC', [PAYMENTS_SINCE]
  )
  const missing = legacyPayments.filter((p) => !alreadyHave.has(Number(p.id)))
  console.log('  legacy rows in window       : ' + legacyPayments.length)
  console.log('  not yet in ISPMan           : ' + missing.length)

  const rows = []
  let noCustomer = 0
  const methodCounts = {}
  const catchAgents = {}

  for (const p of missing) {
    const customerId = customerByLegacy.get(Number(p.customer))
    if (customerId === undefined) { noCustomer += 1; continue }

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

    rows.push({
      company_id: COMPANY_ID,
      customer_id: customerId,
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
    })
  }

  console.log('  customer not in ISPMan      : ' + noCustomer)
  console.log('  to insert                   : ' + rows.length)
  console.log('  by method                   : ' +
    (Object.entries(methodCounts).map(([m, n]) => m + '=' + n).join(', ') || 'none'))
  console.log('  by collector                : ' +
    (Object.entries(catchAgents).map(([a, n]) => a + '=' + n).join(', ') || 'none'))
  if (rows.length > 0) {
    console.log('  date range                  : ' + rows[0].paid_on + ' .. ' + rows[rows.length - 1].paid_on)
  }

  let inserted = 0
  if (DRY_RUN) {
    if (rows.length) console.log('\n  sample:\n    ' + JSON.stringify(rows[0], null, 2).replace(/\n/g, '\n    '))
  } else {
    for (const batch of chunk(rows, PAYMENT_CHUNK)) {
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
  console.log('  handovers imported  : ' + (DRY_RUN ? coRows.length + ' (would be)' : coInserted))
  console.log('  native payments     : ' + native.length + ' — untouched')
  console.log('  radcheck            : NOT TOUCHED')

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
