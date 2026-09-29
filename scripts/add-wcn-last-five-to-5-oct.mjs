#!/usr/bin/env node
/**
 * ONE-OFF: the last five West Central Networks RB5009 leases, 2026-09-29.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/add-wcn-last-five-to-5-oct.mjs                           dry run (default)
 *   node scripts/add-wcn-last-five-to-5-oct.mjs --apply --user=<users.id>
 *
 * 1. THREE LEGACY CUSTOMERS NEVER BROUGHT INTO ISPMan — Bremo Cooper (legacy
 *    #1817), Obrian Wright (#1402), Tevona Dunkley (#2285). Created the way
 *    scripts/migrate-legacy-company.mjs creates a customer:
 *      - name split on the last word, "Legacy #<id>" in notes,
 *      - mac_address and date_added ALWAYS explicit (both have column defaults
 *        that would otherwise win silently),
 *      - account_number allocated from the company counter, which is then
 *        moved past them, because a plain insert never calls the app's allocator,
 *      - monthly_rate: legacy 3,000 becomes 3,500 (268 of 269 West Central
 *        customers were moved that way); 4,500 stays 4,500,
 *      - carried_balance = one month's rate: none has paid since 20 Aug, the
 *        migration's own "square" line,
 *      - bill_date / bill_due_date from legacy when it is a day (25); left to
 *        the column default when legacy holds 0.
 *    No customer_added log row, as the migration writes none: these are not
 *    new signups. No payment history: none has a legacy payment since March.
 *
 * 2. ALL FIVE SET TO 5 OCT 2026 IN radcheck, on the owner's instruction (no
 *    payment on or after 20 Sep):
 *      Bremo Cooper, Obrian Wright   extend  (expired in 2025)
 *      Tevona Dunkley                pullback (05 Oct 21:16 -> 00:00)
 *      Patricena Nash #1725          pullback — the lease reads "Randiesha
 *                                    clarke"; the owner confirmed the MAC
 *      Jessica Bennett #1940         pullback — the lease reads "Peaches
 *                                    Smith"; the owner says the account was
 *                                    renamed. Her cut-off day is 19 in ISPMan
 *                                    (5 in legacy under Peaches); NOT changed.
 *
 * GUARDS: a customer insert is refused if the MAC already belongs to any
 * ISPMan customer, or the legacy id is already in some customer's notes; the
 * counter must still read what it read when the plan was made. Each radcheck
 * write is guarded exactly as in scripts/set-wcn-rb5009-to-5-oct.mjs.
 *
 * WHAT --apply WRITES, under one run id: three customers rows, the counter,
 * five guarded radcheck UPDATEs, five network_* log rows.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'

const APPLY = process.argv.includes('--apply')
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : null
}
const USER_ID = arg('user') ? Number(arg('user')) : null
if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log rows name who made these changes.')
  process.exit(1)
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
const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

const COMPANY = 26 // West Central Networks
const LEGACY_SCHEMA = 'COMPANY_wcnetjagmail_com'
const ACCOUNT_SEQ_BASE = 10000 // lib/account-number.ts#ACCOUNT_SEQ_BASE
const TARGET = '05 Oct 2026 00:00'
const TARGET_YMD = '2026-10-05'
const RUN_ID = randomUUID()

/** The three legacy customers to create. legacyId keys the read; everything else comes from legacy. */
const CREATE = [
  { legacyId: 1817, mac: 'F4:92:BF:4C:B3:03' }, // Bremo Cooper
  { legacyId: 1402, mac: 'F4:E2:C6:3A:4E:68' }, // Obrian Wright
  { legacyId: 2285, mac: '6C:63:F8:D0:E6:9B' }, // Tevona Dunkley
]

/** radcheck changes. customerId null = one of CREATE, resolved by MAC after insert. */
const EXPIRY = [
  { action: 'extend', mac: 'F4:92:BF:4C:B3:03', expect: '5 Sep 2025 19:31', reason: 'Legacy customer added to ISPMan; set to 5 Oct on the owner\'s instruction' },
  { action: 'extend', mac: 'F4:E2:C6:3A:4E:68', expect: '05 Nov 2025 15:17', reason: 'Legacy customer added to ISPMan; set to 5 Oct on the owner\'s instruction' },
  { action: 'pullback', mac: '6C:63:F8:D0:E6:9B', expect: '05 Oct 2026 21:16', reason: 'Legacy customer added to ISPMan; set to 5 Oct on the owner\'s instruction' },
  { action: 'pullback', mac: '68:D7:9A:B4:95:3A', expect: '05 Nov 2026 21:31', customerId: 1725, reason: 'RB5009 lease "Randiesha clarke"; no payment on or after 20 Sep; set to 5 Oct on the owner\'s instruction' },
  { action: 'pullback', mac: '60:22:32:C4:E8:87', expect: '05 Nov 2026 18:11', customerId: 1940, reason: 'RB5009 lease "Peaches Smith" (account renamed); no payment on or after 20 Sep; set to 5 Oct on the owner\'s instruction' },
]

// --- helpers: the migration's own rules (scripts/migrate-legacy-company.mjs) ---

function splitFullName(raw) {
  const cleaned = (raw ?? '').toString().replace(/\s+/g, ' ').trim().replace(/\s*\d+$/, '').trim()
  if (!cleaned) return { first: '', last: '' }
  const words = cleaned.split(' ')
  if (words.length === 1) return { first: '', last: words[0] }
  return { first: words.slice(0, -1).join(' '), last: words[words.length - 1] }
}
const blank = (v) => { const s = (v ?? '').toString().trim(); return s && s !== '1' ? s : null }
const rateFor = (legacyBill) => (Number(legacyBill) === 3000 ? 3500 : Number(legacyBill))
const dayOrNull = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 28 ? n : null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** lib/radius/format.ts#parseRadiusExpiration. */
function parseRadius(value) {
  if (!value) return null
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase())
  if (mi === -1) return null
  const d = new Date(Number(m[3]), mi, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0))
  return Number.isFinite(d.getTime()) ? d : null
}
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
const safeValue = (s) => String(s ?? '').replace(/\|/g, '/').trim()

async function main() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })
  const problems = []

  // --- plan the three customers --------------------------------------------------
  const [legacyRows] = await my.query(
    'SELECT id, name, location, phone, mac, bill, gps, date_added, cut_off_date, bill_due_date FROM `' +
    LEGACY_SCHEMA + '`.customers WHERE id IN (?)', [CREATE.map((c) => c.legacyId)])

  const { data: counter, error: ce } = await db.from('account_counters').select('next_value').eq('company_id', COMPANY).maybeSingle()
  if (ce) throw new Error('counter: ' + ce.message)
  const base = Number(counter?.next_value ?? ACCOUNT_SEQ_BASE + 1)

  const payloads = []
  for (const [i, want] of CREATE.entries()) {
    const L = legacyRows.find((r) => r.id === want.legacyId)
    if (!L) { problems.push('legacy #' + want.legacyId + ' not found'); continue }
    if ((L.mac ?? '').toUpperCase().trim() !== want.mac) { problems.push('legacy #' + want.legacyId + ' MAC is now ' + L.mac); continue }
    const { data: macTaken } = await db.from('customers').select('id, company_id').eq('mac_address', want.mac)
    if (macTaken?.length) { problems.push(want.mac + ' already belongs to customer ' + macTaken.map((c) => '#' + c.id).join(',')); continue }
    const { data: idTaken } = await db.from('customers').select('id').eq('company_id', COMPANY).ilike('notes', 'Legacy #' + want.legacyId)
    if (idTaken?.length) { problems.push('Legacy #' + want.legacyId + ' already on customer #' + idTaken[0].id); continue }

    let { first, last } = splitFullName(L.name)
    if (!last && first) { last = first; first = '' }
    const rate = rateFor(L.bill)
    const billDay = dayOrNull(L.bill_due_date)
    payloads.push({
      company_id: COMPANY,
      first_name: first,
      last_name: last,
      phone: blank(L.phone),
      address: blank(L.location),
      gps: blank(L.gps),
      notes: 'Legacy #' + L.id,
      pppoe_username: null,
      mac_address: want.mac,
      date_added: L.date_added ? String(L.date_added).slice(0, 10) : null,
      account_number: String(Math.max(ACCOUNT_SEQ_BASE + 1, base + i)),
      monthly_rate: rate,
      balance: 0,
      carried_balance: rate,
      account_credit: 0,
      cut_off_date: Number(L.cut_off_date),
      ...(billDay ? { bill_due_date: billDay, bill_date: billDay } : {}),
    })
  }

  // --- plan the five radcheck writes ---------------------------------------------
  const target = parseRadius(TARGET)
  for (const e of EXPIRY) {
    const [variants] = await my.execute('SELECT username, attribute, value FROM radcheck WHERE UPPER(TRIM(username)) = ?', [e.mac])
    const exp = variants.filter((v) => v.username === e.mac && v.attribute === 'Expiration')
    const auth = variants.filter((v) => v.username === e.mac && v.attribute === 'Auth-Type')
    e.live = exp[0]?.value ?? null
    if (exp.length !== 1) { problems.push(e.mac + ': ' + exp.length + ' Expiration rows'); continue }
    if (e.live !== e.expect) { problems.push(e.mac + ': radcheck moved, now ' + e.live); continue }
    const held = parseRadius(e.live).getTime()
    if (e.action === 'pullback' && held <= target.getTime()) problems.push(e.mac + ': not later than 5 Oct')
    if (e.action === 'extend' && held >= target.getTime()) problems.push(e.mac + ': not earlier than 5 Oct')
    if (auth.length !== 1 || auth[0].value !== 'Accept') problems.push(e.mac + ': Auth-Type is ' + (auth.map((a) => a.value).join(',') || 'missing'))
    if (variants.some((v) => v.username !== e.mac)) problems.push(e.mac + ': another spelling exists in radcheck')
    if (e.customerId) {
      const { data: c } = await db.from('customers').select('id, company_id, mac_address').eq('id', e.customerId).single()
      if (!c || c.company_id !== COMPANY || c.mac_address !== e.mac) problems.push(e.mac + ': customer #' + e.customerId + ' no longer holds it')
      const { data: late } = await db.from('payments').select('paid_on').eq('customer_id', e.customerId).gte('paid_on', '2026-09-20')
      if (late?.length) problems.push(e.mac + ': paid on/after 20 Sep')
    }
  }

  console.log('West Central Networks: last five RB5009 leases   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  for (const p of payloads) {
    console.log('  CREATE ' + [p.first_name, p.last_name].join(' ') + ' | ' + p.notes + ' | ' + p.mac_address + ' | acct ' + p.account_number +
      ' | rate ' + p.monthly_rate + ' | balance ' + p.carried_balance + ' | cut ' + p.cut_off_date + ' | bill ' + (p.bill_date ?? 'default') +
      ' | added ' + p.date_added + ' | ' + (p.phone ?? '-') + ' | ' + (p.address ?? '-'))
  }
  for (const e of EXPIRY) console.log('  ' + e.action.toUpperCase() + ' ' + e.mac + ' ' + (e.live ?? '?') + ' -> ' + TARGET + (e.customerId ? '  (#' + e.customerId + ')' : ''))
  if (problems.length) {
    console.log('\nREFUSED — nothing written:\n  ' + problems.join('\n  '))
    await my.end()
    process.exit(1)
  }
  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id>.')
    await my.end()
    return
  }

  const { data: actor } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
  if (!actor) { console.error('No users row ' + USER_ID); process.exit(1) }

  // --- write: customers, then the counter ----------------------------------------
  const { data: made, error: ie } = await db.from('customers').insert(payloads).select('id, first_name, last_name, mac_address, account_number')
  if (ie) throw new Error('customer insert failed, nothing else written: ' + ie.message)
  for (const c of made) console.log('  created #' + c.id + ' ' + c.first_name + ' ' + c.last_name + ' acct ' + c.account_number)
  const next = base + payloads.length
  const { error: be } = await db.from('account_counters').update({ next_value: next, updated_at: new Date().toISOString() })
    .eq('company_id', COMPANY).eq('next_value', base)
  if (be) console.log('  !! counter not moved: ' + be.message + ' — set account_counters.next_value for company 26 to ' + next)
  else console.log('  account counter: next ' + next)

  // --- write: radcheck + log -------------------------------------------------------
  let done = 0
  for (const e of EXPIRY) {
    const customerId = e.customerId ?? made.find((c) => c.mac_address === e.mac)?.id
    const [res] = await my.execute('UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [TARGET, e.mac, 'Expiration', e.live])
    if ((res.affectedRows ?? 0) !== 1) { console.log('  ' + e.mac + ': radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row'); continue }
    const verb = e.action === 'pullback' ? 'Expiry corrected for' : 'Extended'
    const { error: le } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: customerId,
      type: e.action === 'pullback' ? 'network_expiry_corrected' : 'network_extend', correlation_id: RUN_ID,
      details: verb + ' ' + e.mac + '. Expiry ' + ymd(parseRadius(e.live)) + ' -> ' + TARGET_YMD + '. By ' + actor.email +
        ' | reason=' + safeValue(e.reason) + ' | run=' + RUN_ID,
    })
    if (le) console.log('  ' + e.mac + ': radcheck written, log row failed: ' + le.message)
    done += 1
    console.log('  #' + customerId + ' ' + e.mac + ': ' + e.live + ' -> ' + TARGET)
  }
  console.log('\nCreated ' + made.length + ' customers; set ' + done + ' of ' + EXPIRY.length + ' expiries. run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
