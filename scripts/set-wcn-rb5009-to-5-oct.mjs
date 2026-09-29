#!/usr/bin/env node
/**
 * ONE-OFF: every West Central Networks customer on the RB5009 router
 * (192.168.88.x) set to expire 5 Oct 2026, unless they paid after 20 Sep.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/set-wcn-rb5009-to-5-oct.mjs                                  dry run (default)
 *   node scripts/set-wcn-rb5009-to-5-oct.mjs --apply --user=<users.id>
 *
 * THE OWNER'S INSTRUCTION (2026-09-29): all RB5009 customers to 5 Oct, unless
 * they paid a bill after 20 Sep; any customer not in radcheck is added. This
 * covers a customer in all three directions, so there are three actions:
 *
 *   pullback   holds a date after 5 Oct. Most were written by the legacy till
 *              (see scripts/correct-wcn-expiries-to-5-oct.mjs).
 *   extend     holds a date before 5 Oct — expired, or about to. The owner
 *              chose to carry them to 5 Oct.
 *   provision  a customer with no radcheck row at all. Added with Auth-Type
 *              Accept and Expiration 5 Oct, the two rows
 *              lib/radius-db.ts#activateInRadius writes.
 *
 * THE LIST
 *   Stated below, not derived: the 74 leases in the RB5009 lease table
 *   (two screenshots, 2026-09-29), matched to customers by name and confirmed
 *   by the visible part of the MAC (the screenshots cut MACs short). `expect`
 *   is the exact radcheck value read on 2026-09-29.
 *
 *   NOT HERE:
 *     paid after 20 Sep   Faith Nash, Kamar Nash, Olive Bryan, Romardo Foster,
 *                         Vanessa Forrest.
 *     already 5 Oct       Charmaine Fransis (05 Oct 2026 00:00).
 *     access point        AC10 = customer #2025 "Hoges landges ap". Cutting it
 *                         on 5 Oct could take everyone behind it down. Held.
 *     infrastructure      ccr1036 (two leases).
 *     no customer         Bremo Cooper, Obrian Wright; Randiesha Clarke and
 *                         Tevona Dunkley sit on MACs belonging to customers of
 *                         other names. Nothing added for a lease that is not a
 *                         customer.
 *
 * HOW EACH ROW EARNS ITS WRITE
 *   1. Company 26, the MAC is the identity (ignoring case), and the cut-off
 *      day is still the one stated (5 unless the row says).
 *   2. No payment after 20 Sep in ISPMan or in the legacy till, re-read live.
 *      Someone who pays between now and the run keeps what they paid for.
 *   3. pullback/extend: exactly one Expiration row for that exact username,
 *      still `expect`, and an Auth-Type Accept row beside it (extend only —
 *      moving an Expiration forward means nothing without it).
 *      provision: NO radcheck row under any spelling of the MAC.
 *   4. No other spelling of the MAC (letter case, a leading space) holds an
 *      expiry past 5 Oct. radcheck matches usernames case-sensitively here.
 *
 * WHAT --apply WRITES, per READY row, all under one run id
 *   radcheck   pullback/extend: one UPDATE of Expiration, guarded by the value
 *              it replaces. provision: two INSERTs in one transaction.
 *   log        one row on the customer, in the shape the customer page's
 *              buttons write (lib/radius/operations.ts#networkEventDetails):
 *              network_expiry_corrected, network_extend or network_provision.
 *              correlation_id = the run id.
 *
 *   The customer record holds no expiry column: ISPMan reads it live from
 *   radcheck, so the radcheck write is the customer's expiry.
 *
 * WHAT IT DOES NOT TOUCH
 *   Balances, credit, payments, bill dates, cut-off days, the legacy database.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'

// --- arguments --------------------------------------------------------------

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

// --- environment --------------------------------------------------------------

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
const TARGET = '05 Oct 2026 00:00' // midnight, as lib/radius/format.ts#formatRadiusExpiration writes it
const TARGET_YMD = '2026-10-05'
const PAID_AFTER = '2026-09-20' // a payment dated after this day keeps the customer out
const RUN_ID = randomUUID()
const REASON = {
  pullback: 'RB5009: no payment after 20 Sep, held an expiry past 5 Oct; set to 5 Oct on the owner\'s instruction',
  extend: 'RB5009: set to 5 Oct on the owner\'s instruction',
  provision: 'RB5009: not in radcheck; added to 5 Oct on the owner\'s instruction',
}

/** identity: the radcheck username EXACTLY as stored. expect: radcheck Expiration read 2026-09-29. paid: last payment either system. */
const TARGETS = [
  { action: 'pullback', id: 1832, identity: '24:5A:4C:30:A1:38', expect: '05 Oct 2026 09:00', paid: '2026-08-31' }, // Adrian Barrett
  { action: 'pullback', id: 1905, identity: '6C:63:F8:C6:C1:DA', expect: '05 Jan 2027 18:23', paid: '2026-09-04' }, // Andy Blake
  { action: 'pullback', id: 1867, identity: '70:A7:41:1A:A4:95', expect: '05 Dec 2026 09:00', paid: '2026-09-01' }, // Anthonett lewis
  { action: 'extend', id: 1792, identity: '68:D7:9A:A2:B4:FD', expect: '05 Sep 2026 16:00', paid: '2025-10-10' }, // ANTHONY BARTLETT
  { action: 'pullback', id: 1791, identity: '74:AC:B9:FC:A1:F1', expect: '05 Jan 2027 17:29', paid: '2026-08-28' }, // Arlene Mccallum
  { action: 'extend', id: 1953, identity: 'F4:E2:C6:3A:12:3B', expect: '30 Sep 2026 09:00', paid: '2025-09-29' }, // Arlene Whyte
  { action: 'provision', id: 5785, identity: '6C:63:F8:D0:E6:7E', expect: null, paid: null }, // Ashanti Findlay
  { action: 'pullback', id: 1743, identity: '74:AC:B9:72:2E:9F', expect: '05 Nov 2026 13:15', paid: '2026-08-12' }, // barbara coke
  { action: 'pullback', id: 1859, identity: '70:A7:41:1A:E2:44', expect: '05 Dec 2026 09:00', paid: '2026-09-07' }, // Belva foster
  { action: 'pullback', id: 1873, identity: '70:A7:41:42:C7:5B', expect: '25 Nov 2026 03:09', paid: '2026-09-09', cut: 25 }, // berley cooper
  { action: 'pullback', id: 1768, identity: 'F4:92:BF:4C:AB:96', expect: '05 Nov 2026 09:00', paid: '2026-09-01' }, // Byron Wellington
  { action: 'extend', id: 1956, identity: 'E4:38:83:B6:8B:06', expect: '5 Sep 2026 23:16', paid: '2025-08-13' }, // chester salmon
  { action: 'pullback', id: 1893, identity: '60:22:32:BA:C6:75', expect: '13 Jul 2027 09:00', paid: '2023-11-02' }, // Christine Robinson
  { action: 'extend', id: 2027, identity: '6C:63:F8:C2:EB:AD', expect: '5 Sep 2026 16:02', paid: null }, // Darlington waton
  { action: 'pullback', id: 1817, identity: '68:D7:9A:B2:89:88', expect: '05 Nov 2026 09:00', paid: '2026-08-26' }, // Deaja roberts
  { action: 'pullback', id: 1816, identity: '68:D7:9A:B2:8F:DE', expect: '05 Nov 2026 14:54', paid: '2026-09-05' }, // Donald messam
  { action: 'extend', id: 1726, identity: '6C:63:F8:CA:96:EE', expect: '05 Jul 2026 02:57', paid: '2025-09-27', cut: 8 }, // Emileta scarlett
  { action: 'extend', id: 1730, identity: '6C:63:F8:CA:93:EA', expect: '05 Sep 2026 00:06', paid: '2022-07-10' }, // Eugene WIlliams
  { action: 'extend', id: 1941, identity: 'E4:38:83:BC:BE:7A', expect: '05 Jul 2026 16:38', paid: '2025-10-04' }, // Feoina hylton
  { action: 'extend', id: 1847, identity: '70:A7:41:1A:EF:8D', expect: '05 Sep 2026 14:58', paid: '2026-08-06' }, // Garnet Adair
  { action: 'pullback', id: 1991, identity: 'F4:92:BF:4C:BB:8B', expect: '05 Nov 2026 21:32', paid: '2026-09-10' }, // Hazel Gordon
  { action: 'pullback', id: 1850, identity: '78:45:58:AC:9D:19', expect: '05 Oct 2026 09:00', paid: '2026-08-14' }, // heather vassell
  { action: 'pullback', id: 1772, identity: '6C:63:F8:C8:08:D1', expect: '05 Nov 2026 17:55', paid: '2026-09-04' }, // Hilreth suckra
  { action: 'pullback', id: 1782, identity: 'F4:92:BF:F4:22:6F', expect: '05 Oct 2026 21:41', paid: '2026-08-26' }, // Hope brown
  { action: 'pullback', id: 1774, identity: '78:45:58:A2:C6:F1', expect: '05 Jan 2027 22:53', paid: '2026-09-10' }, // Hortense Forrester
  { action: 'pullback', id: 2005, identity: '6C:63:F8:D0:F8:3A', expect: '05 Nov 2026 14:25', paid: '2026-09-02' }, // Huriel morrison
  { action: 'pullback', id: 1916, identity: '6C:63:F8:C8:0E:FA', expect: '05 Dec 2026 09:00', paid: '2026-09-05' }, // imaine Johnson
  { action: 'provision', id: 2033, identity: '6C:63:F8:D0:E7:0F', expect: null, paid: null }, // Jenny Coley
  { action: 'provision', id: 5768, identity: 'FC:EC:DA:C8:D7:1C', expect: null, paid: null }, // Jermain Robinson
  { action: 'pullback', id: 1922, identity: 'F4:92:BF:DA:1F:58', expect: '05 Nov 2026 21:36', paid: '2026-09-12' }, // Jonathan dunkley
  { action: 'pullback', id: 1800, identity: 'B4:FB:E4:3A:B4:4C', expect: '05 Mar 2027 16:59', paid: '2026-09-03' }, // Juline Johnson
  { action: 'extend', id: 1742, identity: '74:AC:B9:72:49:47', expect: '05 Sep 2026 20:46', paid: '2025-05-29' }, // keith levy
  { action: 'extend', id: 1802, identity: '6C:63:F8:CA:97:C0', expect: '04 Sep 2026 09:00', paid: '2026-08-04' }, // Marcia Scarlet
  { action: 'pullback', id: 1781, identity: 'F4:92:BF:4C:BF:33', expect: '05 Dec 2026 02:22', paid: '2026-09-01' }, // Marsha McCallum
  { action: 'pullback', id: 1891, identity: '68:D7:9A:B2:83:A3', expect: '05 Nov 2026 18:27', paid: '2026-08-29' }, // Mishka McNeil
  { action: 'pullback', id: 1776, identity: '6C:63:F8:C8:0C:5E', expect: '05 Jan 2027 12:20', paid: '2026-09-04' }, // Naveline Brown
  { action: 'pullback', id: 2009, identity: '74:83:C2:E4:D6:A8', expect: '30 Nov 2026 09:00', paid: null }, // nickale crawford
  { action: 'extend', id: 2023, identity: '6C:63:F8:D0:E5:94', expect: '05 Sep 2026 17:41', paid: null }, // Patricia gayle
  { action: 'pullback', id: 1950, identity: 'F4:E2:C6:38:DF:72', expect: '05 Jan 2027 14:55', paid: '2026-08-22' }, // rasho Lewis
  { action: 'extend', id: 1989, identity: '6C:63:F8:D0:F7:EF', expect: '05 Sep 2026 16:31', paid: null }, // Rattary Hibbert
  { action: 'extend', id: 1773, identity: 'F4:92:BF:F2:EB:07', expect: '05 Sep 2026 00:42', paid: '2026-08-05' }, // Renae foster
  { action: 'extend', id: 1999, identity: '6C:63:F8:D0:FA:AB', expect: '04 Aug 2026 09:00', paid: null }, // Ricardo McLaughlin
  { action: 'pullback', id: 1988, identity: '6C:63:F8:D0:F8:AC', expect: '05 Dec 2026 17:25', paid: '2026-09-04' }, // Samtosh Miller
  { action: 'pullback', id: 1815, identity: '74:AC:B9:80:CC:A8', expect: '05 Nov 2026 16:39', paid: '2026-09-11' }, // Shaneka Foster
  { action: 'pullback', id: 1796, identity: 'E0:63:DA:42:A2:66', expect: '11 Jan 2027 14:50', paid: '2026-08-24', cut: 11 }, // Shanice reid
  { action: 'pullback', id: 1724, identity: '18:E8:29:8C:A8:95', expect: '05 Jan 2027 00:00', paid: '2026-09-18' }, // Sharlette Fiddis
  { action: 'pullback', id: 1799, identity: '74:83:C2:EE:A0:6D', expect: '05 Jan 2027 14:53', paid: '2026-09-01' }, // Sharon myers
  { action: 'pullback', id: 1766, identity: '74:AC:B9:FC:9C:71', expect: '05 Oct 2026 18:22', paid: '2026-08-05' }, // Sher Ricketts
  { action: 'pullback', id: 1761, identity: '74:AC:B9:F2:0C:0C', expect: '05 Dec 2026 09:00', paid: '2026-09-01' }, // Soroyley Wilson
  { action: 'extend', id: 1794, identity: 'F4:92:BF:4C:B7:86', expect: '05 Aug 2026 18:44', paid: '2025-10-07' }, // Stacy ann Lewis
  { action: 'extend', id: 1745, identity: '60:22:32:C4:DE:C9', expect: '15 Sep 2026 09:00', paid: '2024-07-02' }, // stephanie watson
  { action: 'pullback', id: 1769, identity: 'F4:E2:C6:3C:55:02', expect: '08 Oct 2026 00:00', paid: '2026-07-06' }, // Taisha Campbell
  { action: 'pullback', id: 1981, identity: '6C:63:F8:C8:0D:4B', expect: '05 Dec 2026 09:00', paid: '2026-09-04' }, // Terrain Falconer
  { action: 'extend', id: 1864, identity: 'F4:E2:C6:3A:56:49', expect: '05 Sep 2026 20:13', paid: '2026-08-04' }, // Timoy Blake
  { action: 'extend', id: 1924, identity: '9C:05:D6:86:F4:C1', expect: '05 Sep 2026 16:25', paid: '2025-06-05' }, // Trisha James
  { action: 'pullback', id: 2026, identity: 'E4:38:83:B4:26:DB', expect: '05 Nov 2026 21:50', paid: '2026-09-14' }, // Yashema Campbell
  // Matched by name where the MAC prefix alone pointed at more than one customer.
  { action: 'pullback', id: 1784, identity: 'F4:92:BF:4C:B7:49', expect: '05 Oct 2026 17:36', paid: '2026-08-07' }, // Marcia knight
  { action: 'extend', id: 1866, identity: 'F4:92:BF:4C:B2:31', expect: '5 Sep 2026 17:29', paid: '2026-07-06' }, // Mark Salmon
  { action: 'extend', id: 1735, identity: '6C:63:F8:C8:08:CE', expect: '05 Sep 2026 12:11', paid: '2026-07-31' }, // pitter
  { action: 'pullback', id: 1764, identity: '74:AC:B9:FC:A0:C9', expect: '05 Oct 2026 09:00', paid: '2026-08-05' }, // Saniquekie Forbes
  { action: 'pullback', id: 1841, identity: '70:A7:41:1A:EC:BB', expect: '05 Nov 2026 16:15', paid: '2026-08-31' }, // Karol dunkley
]

// --- helpers -------------------------------------------------------------------

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

// --- main ------------------------------------------------------------------------

async function main() {
  const ids = TARGETS.map((t) => t.id)
  if (new Set(ids).size !== ids.length) throw new Error('A customer is listed twice in TARGETS.')

  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })

  const { data: custs, error } = await db
    .from('customers').select('id, company_id, first_name, last_name, mac_address, cut_off_date, notes')
    .in('id', ids)
  if (error) throw new Error('customers: ' + error.message)

  const { data: latePays, error: pe } = await db
    .from('payments').select('customer_id, paid_on').in('customer_id', ids).gt('paid_on', PAID_AFTER)
  if (pe) throw new Error('payments: ' + pe.message)

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const target = parseRadius(TARGET)
  const plan = []
  for (const t of TARGETS) {
    const c = custs.find((x) => x.id === t.id)
    const name = c ? (c.first_name + ' ' + (c.last_name ?? '')).trim() : '?'
    const row = { ...t, name, status: 'READY', why: '', live: null }
    plan.push(row)
    const skip = (why) => { row.status = 'SKIPPED'; row.why = why }

    if (!c) { skip('no customer ' + t.id); continue }
    if (c.company_id !== COMPANY) { skip('customer is company ' + c.company_id); continue }
    if ((c.mac_address ?? '').toUpperCase() !== t.identity.toUpperCase()) { skip('MAC is now ' + c.mac_address); continue }
    if (c.cut_off_date !== (t.cut ?? 5)) { skip('cut-off day is ' + c.cut_off_date + ', not ' + (t.cut ?? 5)); continue }

    const late = latePays.filter((p) => p.customer_id === t.id).map((p) => p.paid_on)
    if (late.length) { skip('paid after 20 Sep in ISPMan: ' + late.join(', ')); continue }
    const legacyId = /Legacy #(\d+)/.exec(c.notes ?? '')?.[1]
    if (legacyId) {
      const [lp] = await my.query(
        'SELECT date FROM `' + LEGACY_SCHEMA + '`.payments WHERE customer = ? AND date > ?', [legacyId, PAID_AFTER + ' 23:59:59'])
      if (lp.length) { skip('paid after 20 Sep in legacy: ' + lp.map((r) => r.date).join(', ')); continue }
    }

    const [variants] = await my.execute(
      'SELECT username, attribute, value FROM radcheck WHERE UPPER(TRIM(username)) = ?', [t.identity.toUpperCase()])

    if (t.action === 'provision') {
      if (variants.length) { skip('no longer missing: ' + variants.map((v) => '"' + v.username + '" ' + v.attribute + '=' + v.value).join(', ')); continue }
      continue
    }

    const exact = variants.filter((v) => v.username === t.identity && v.attribute === 'Expiration')
    if (exact.length !== 1) { skip(exact.length + ' Expiration rows for ' + t.identity); continue }
    row.live = exact[0].value
    if (row.live !== t.expect) { skip('radcheck moved since 2026-09-29: now ' + row.live); continue }
    const held = parseRadius(row.live)
    if (!held) { skip('unreadable expiry ' + row.live); continue }
    if (t.action === 'pullback' && held.getTime() <= target.getTime()) { skip('held ' + row.live + ' is not later than ' + TARGET); continue }
    if (t.action === 'extend' && held.getTime() >= target.getTime()) { skip('held ' + row.live + ' is not earlier than ' + TARGET); continue }
    if (t.action === 'extend') {
      const auth = variants.filter((v) => v.username === t.identity && v.attribute === 'Auth-Type')
      if (auth.length !== 1 || auth[0].value !== 'Accept') {
        skip('Auth-Type is ' + (auth.map((a) => a.value).join(',') || 'missing') + ', not Accept'); continue
      }
    }
    const later = variants.filter((v) => v.username !== t.identity && v.attribute === 'Expiration' &&
      (parseRadius(v.value)?.getTime() ?? 0) > target.getTime())
    if (later.length) { skip('another spelling holds a later expiry: ' + later.map((v) => '"' + v.username + '" ' + v.value).join(', ')); continue }
  }

  console.log('West Central Networks, RB5009: expiries to ' + TARGET + '   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  console.log(['status', 'action', 'customer', 'name', 'identity', 'last paid', 'radcheck now', '-> new'].join(' | '))
  for (const p of plan) {
    console.log([p.status, p.action, '#' + p.id, p.name, p.identity, p.paid ?? 'none', p.live ?? p.expect ?? 'no row',
      p.status === 'READY' ? TARGET : p.why].join(' | '))
  }
  const ready = plan.filter((p) => p.status === 'READY')
  const count = (a) => ready.filter((p) => p.action === a).length
  console.log('\nREADY ' + ready.length + ' (pullback ' + count('pullback') + ', extend ' + count('extend') +
    ', provision ' + count('provision') + ')   SKIPPED ' + (plan.length - ready.length))

  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> to write the READY rows.')
    await my.end()
    return
  }

  // --- apply ---------------------------------------------------------------------
  let done = 0
  for (const p of ready) {
    const tag = '#' + p.id + ' ' + p.name + ': '
    let type, details

    if (p.action === 'provision') {
      // The two rows lib/radius-db.ts#activateInRadius writes. Guarded by re-checking inside the
      // transaction that nothing exists under any spelling, so nothing is ever deleted here.
      await my.beginTransaction()
      try {
        const [again] = await my.execute('SELECT COUNT(*) n FROM radcheck WHERE UPPER(TRIM(username)) = ?', [p.identity.toUpperCase()])
        if (Number(again[0].n) !== 0) {
          await my.rollback()
          console.log(tag + 'a radcheck row appeared since the plan; nothing written.')
          continue
        }
        await my.query('INSERT INTO radcheck (username, attribute, op, value) VALUES ?',
          [[[p.identity, 'Auth-Type', ':=', 'Accept'], [p.identity, 'Expiration', ':=', TARGET]]])
        await my.commit()
      } catch (err) {
        await my.rollback()
        console.log(tag + 'provision failed: ' + (err.sqlMessage ?? err.message) + '; nothing written.')
        continue
      }
      type = 'network_provision'
      details = 'Provisioned ' + p.identity + ', expiry ' + TARGET_YMD + '. By ' + actor.email +
        ' | reason=' + safeValue(REASON.provision) + ' | run=' + RUN_ID
    } else {
      const [res] = await my.execute(
        'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
        [TARGET, p.identity, 'Expiration', p.live]
      )
      if ((res.affectedRows ?? 0) !== 1) {
        console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
        continue
      }
      const verb = p.action === 'pullback' ? 'Expiry corrected for' : 'Extended'
      type = p.action === 'pullback' ? 'network_expiry_corrected' : 'network_extend'
      details = verb + ' ' + p.identity + '. Expiry ' + ymd(parseRadius(p.live)) + ' -> ' + TARGET_YMD +
        '. By ' + actor.email + ' | reason=' + safeValue(REASON[p.action]) + ' | run=' + RUN_ID
    }

    const { error: logErr } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: p.id, type, correlation_id: RUN_ID, details,
    })
    if (logErr) console.log(tag + 'radcheck written, but the log row failed: ' + logErr.message)

    done += 1
    console.log(tag + p.action + ' ' + (p.live ?? 'no row') + ' -> ' + TARGET)
  }

  console.log('\nWrote ' + done + ' of ' + ready.length + ' READY row(s). run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
