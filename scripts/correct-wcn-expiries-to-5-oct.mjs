#!/usr/bin/env node
/**
 * ONE-OFF: West Central Networks (company 26) customers who paid for the
 * 5 Sep - 5 Oct period but hold an expiry one to four months later.
 * Pulls each back to 5 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/correct-wcn-expiries-to-5-oct.mjs                          dry run (default)
 *   node scripts/correct-wcn-expiries-to-5-oct.mjs --groups=september,august
 *   node scripts/correct-wcn-expiries-to-5-oct.mjs --ids=1805,1930,1739
 *   node scripts/correct-wcn-expiries-to-5-oct.mjs --apply --user=<users.id> [--reason="..."]
 *
 * A DRY RUN PRINTS AND STOPS. Nothing is written without --apply, and --apply
 * needs --user so every log row names a real manager account, the way the
 * Correct Expiry modal does.
 *
 * WHAT WROTE THE WRONG DATES — NOT ISPMan
 *   Investigated 2026-09-29. Every payment these customers have is a
 *   "Migrated from legacy payment #n" row: the money was taken at the legacy
 *   till, and the legacy app moved radcheck when it took it. ISPMan's log has
 *   no radius_extend / network_extend row for any of them, the migration and
 *   catch-up scripts never touch radcheck, and several identities are stored
 *   lowercase ("f4:92:BF:..."), which ISPMan never writes. None of the ISPMan
 *   causes applies: no ISPMan payment (double-extension guard), no day offset
 *   (grace), no moved day — every date is still the 5th.
 *
 * THE LIST
 *   Stated below, not derived: the rows highlighted in the West Central
 *   router's lease table on 2026-09-29, matched to customers by MAC. `expect`
 *   is the exact radcheck value read on 2026-09-29.
 *
 *   NOT HERE: the "Peaches Smith" lease, 60:22:32:C4:E8:87. In legacy that MAC
 *   is on two customers, Peaches smith (#1832, paying, last 3 Sep 2026) and
 *   Jessica Bennett (#2037, last paid Sep 2025). ISPMan migrated only Jessica
 *   Bennett (#1940, cut-off 19), so a correction here would log against the
 *   wrong person. Held for the owner.
 *
 *   september     paid at the legacy till 1-16 Sep.
 *   august        paid 29-31 Aug, most likely for the 5 Sep period.
 *   lapsed        last paid early-late August, or no payment since May, yet
 *                 holding 31 Oct - 5 Dec.
 *   other-cutoff  on cut-off day 1, 11 or 15, holding a date past 5 Oct.
 *
 *   All four run by default: the owner asked (2026-09-29) for every one of
 *   these to disconnect at 5 Oct. --groups=a,b narrows a run.
 *
 * HOW EACH ROW EARNS ITS CORRECTION
 *   1. The customer is company 26 and its MAC is the identity (ignoring case).
 *      Its cut-off day is still the one stated (5 unless the row says).
 *   2. radcheck holds exactly one Expiration row for that exact username, and
 *      its value is `expect`. Anything else means someone moved it since
 *      2026-09-29, and the row is SKIPPED for its own look.
 *   3. 5 Oct is earlier than what is held. A correction only moves back.
 *   4. No other spelling of the MAC in radcheck (another letter case, a
 *      leading space) holds an expiry past 5 Oct. radcheck matches usernames
 *      case-sensitively here, so such a row could keep the customer online
 *      after this correction; the row is SKIPPED rather than half-done.
 *
 * WHAT --apply WRITES, per READY row, all under one run id
 *   - radcheck: one UPDATE of the Expiration value, guarded by the value it
 *     replaces (lib/radius-db.ts#correctExpiryInRadius does the same). No row
 *     is inserted or deleted; no other attribute is touched.
 *   - log: one network_expiry_corrected row on the customer, in the shape the
 *     Correct Expiry modal writes (lib/radius/operations.ts#networkEventDetails),
 *     so the customer's Network History shows it. correlation_id = the run id.
 *
 *   THE CUSTOMER RECORD HOLDS NO EXPIRY COLUMN. ISPMan reads expiry live from
 *   radcheck, so the radcheck write IS the customer's expiry; the log row is
 *   the customer-side record of the change. These customers' payment rows
 *   carry no access_granted_until (legacy rows never did), so none is restated.
 *
 * WHAT IT DOES NOT TOUCH
 *   Balances, credit, payments, bill dates, cut-off days, the legacy database,
 *   the stray " F4:92:BF:D8:79:54" (leading space) row expired in 2024.
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
/** The log row's reason, per group, unless --reason overrides it for the whole run. */
const REASONS = {
  september: 'Paid for the 5 Sep - 5 Oct period at the legacy till, which wrote a later expiry; set to 5 Oct',
  august: 'Paid end of August for the 5 Sep - 5 Oct period at the legacy till, which wrote a later expiry; set to 5 Oct',
  lapsed: 'No payment for a period past 5 Oct, yet held a later expiry written by the legacy app; set to 5 Oct on the owner\'s instruction',
  'other-cutoff': 'Held an expiry past 5 Oct written by the legacy app; set to 5 Oct on the owner\'s instruction',
  rb5009: 'No payment after 20 Sep, yet held an expiry past 5 Oct; set to 5 Oct on the owner\'s instruction',
}
const GROUPS = (arg('groups') ?? Object.keys(REASONS).join(',')).split(',').map((s) => s.trim())
/** --ids=1805,1930 narrows a run to those customers, within the chosen groups. */
const ONLY_IDS = arg('ids') ? arg('ids').split(',').map(Number) : null

if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log rows name who corrected these.')
  process.exit(1)
}
for (const g of GROUPS) {
  if (!(g in REASONS)) { console.error('Unknown group ' + g); process.exit(1) }
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
const TARGET = '05 Oct 2026 00:00' // midnight, as lib/radius/format.ts#formatRadiusExpiration writes it
const TARGET_YMD = '2026-10-05'
const RUN_ID = randomUUID()

/**
 * id: customers.id   identity: the radcheck username EXACTLY as stored (case matters on this table)
 * expect: radcheck Expiration read 2026-09-29   paid: last legacy payment date
 */
const TARGETS = [
  { group: 'september', id: 1810, identity: '68:D7:9A:A8:40:83', expect: '05 Feb 2027 09:00', paid: '2026-09-02' },
  { group: 'september', id: 1744, identity: '74:AC:B9:72:23:65', expect: '05 Jan 2027 21:19', paid: '2026-09-08' },
  { group: 'september', id: 1762, identity: '74:AC:B9:FC:42:25', expect: '05 Jan 2027 17:13', paid: '2026-09-04' },
  { group: 'september', id: 1748, identity: '74:83:C2:50:F9:A5', expect: '05 Jan 2027 16:53', paid: '2026-09-05' },
  { group: 'september', id: 1972, identity: '6C:63:F8:C8:09:14', expect: '05 Jan 2027 15:28', paid: '2026-09-03' },
  { group: 'september', id: 1862, identity: 'E0:63:DA:46:7D:A4', expect: '05 Jan 2027 15:07', paid: '2026-09-08' },
  { group: 'september', id: 1807, identity: '68:D7:9A:B2:4B:05', expect: '05 Jan 2027 13:24', paid: '2026-09-08' },
  { group: 'september', id: 1740, identity: '74:AC:B9:80:CE:AD', expect: '05 Dec 2026 23:51', paid: '2026-09-01' },
  { group: 'september', id: 1806, identity: '68:D7:9A:B2:2F:BC', expect: '05 Dec 2026 21:27', paid: '2026-09-02' },
  { group: 'september', id: 1818, identity: '68:D7:9A:B2:68:37', expect: '05 Dec 2026 19:23', paid: '2026-09-05' },
  { group: 'september', id: 1786, identity: 'E0:63:DA:FA:17:D0', expect: '05 Dec 2026 18:06', paid: '2026-09-02' },
  { group: 'september', id: 1886, identity: '6C:63:F8:C6:BE:6E', expect: '05 Dec 2026 09:00', paid: '2026-09-04' },
  { group: 'september', id: 1823, identity: '6C:63:F8:C8:08:22', expect: '05 Dec 2026 09:00', paid: '2026-09-01' },
  { group: 'september', id: 1917, identity: '74:AC:B9:FC:A2:E6', expect: '05 Dec 2026 09:00', paid: '2026-09-02' },
  { group: 'september', id: 1746, identity: 'f4:92:BF:D8:79:54', expect: '05 Dec 2026 09:00', paid: '2026-09-03' },
  { group: 'september', id: 1755, identity: '74:AC:B9:72:24:68', expect: '05 Nov 2026 19:18', paid: '2026-09-05' },
  { group: 'september', id: 1945, identity: '38:D4:A5:8B:22:20', expect: '05 Nov 2026 18:06', paid: '2026-09-02' },
  { group: 'september', id: 1733, identity: '70:2E:22:0B:70:AC', expect: '05 Nov 2026 16:20', paid: '2026-09-16' },
  { group: 'september', id: 1826, identity: 'E0:63:DA:FC:71:59', expect: '05 Nov 2026 09:00', paid: '2026-09-05' },
  { group: 'september', id: 1840, identity: '78:45:58:A2:C5:4B', expect: '05 Nov 2026 09:00', paid: '2026-09-03' },
  { group: 'september', id: 1844, identity: '24:5A:4C:40:14:D4', expect: '05 Nov 2026 09:00', paid: '2026-09-07' },
  { group: 'september', id: 1936, identity: '18:E8:29:D4:FA:19', expect: '05 Nov 2026 00:11', paid: '2026-09-14' },
  // Read off the screenshot with one character wrong; radcheck and legacy hold these spellings.
  { group: 'september', id: 1805, identity: '68:D7:9A:B2:2F:AE', expect: '05 Jan 2027 15:47', paid: '2026-09-07' },
  { group: 'september', id: 1930, identity: '28:70:4E:B8:8B:3A', expect: '05 Dec 2026 09:00', paid: '2026-09-01' },
  { group: 'september', id: 1739, identity: '74:AC:B9:F2:16:3A', expect: '05 Dec 2026 09:00', paid: '2026-09-01' },
  // Already pulled back by hand on 2026-09-29 (log 4897, "reason=mistaek") — to the 6th, not the 5th.
  { group: 'september', id: 1753, identity: '74:AC:B9:72:10:99', expect: '06 Oct 2026 00:00', paid: '2026-09-05' },

  { group: 'august', id: 1829, identity: '68:D7:9A:B8:5E:81', expect: '05 Jan 2027 22:36', paid: '2026-08-31' },
  { group: 'august', id: 1778, identity: 'F4:92:BF:DA:1D:94', expect: '05 Dec 2026 20:30', paid: '2026-08-31' },
  { group: 'august', id: 1804, identity: '68:D7:9A:B2:4A:BE', expect: '05 Dec 2026 14:50', paid: '2026-08-31' },
  { group: 'august', id: 1795, identity: '74:AC:B9:80:CA:C2', expect: '05 Nov 2026 00:13', paid: '2026-08-29' },
  { group: 'august', id: 1732, identity: '74:54:6b:02:ad:1d', expect: '05 Feb 2027 15:52', paid: '2026-08-31' },

  { group: 'lapsed', id: 1813, identity: '68:D7:9A:B2:6F:6B', expect: '05 Dec 2026 09:00', paid: '2026-08-07' },
  { group: 'lapsed', id: 1777, identity: 'F4:92:BF:DA:22:BB', expect: '05 Dec 2026 09:00', paid: '2026-08-25' },
  { group: 'lapsed', id: 1830, identity: '6C:63:F8:C8:09:48', expect: '05 Nov 2026 09:00', paid: '2026-08-20' },
  { group: 'lapsed', id: 1747, identity: '74:AC:B9:FC:9F:4C', expect: '05 Nov 2026 14:54', paid: '2026-08-04' },
  { group: 'lapsed', id: 1752, identity: '74:AC:B9:72:20:9B', expect: '05 Nov 2026 14:51', paid: '2026-08-05' },
  { group: 'lapsed', id: 1899, identity: '70:A7:41:40:29:2B', expect: '05 Nov 2026 11:48', paid: '2026-08-04' },
  { group: 'lapsed', id: 1779, identity: 'F4:92:BF:DA:16:B8', expect: '05 Nov 2026 09:00', paid: '2026-08-05' },
  { group: 'lapsed', id: 1884, identity: '9C:05:D6:86:F4:5C', expect: '05 Dec 2026 09:00', paid: null },
  { group: 'lapsed', id: 2035, identity: '70:2E:22:0B:16:9F', expect: '05 Dec 2026 00:00', paid: null },
  { group: 'lapsed', id: 1820, identity: '68:D7:9A:AE:73:93', expect: '05 Nov 2026 17:18', paid: null },
  { group: 'lapsed', id: 1986, identity: 'E4:38:83:B4:22:15', expect: '31 Oct 2026 09:00', paid: null },

  { group: 'other-cutoff', id: 1843, identity: '70:A7:41:40:38:88', expect: '15 Oct 2026 00:00', paid: null, cut: 15 },
  { group: 'other-cutoff', id: 1955, identity: 'F4:E2:C6:38:D8:ED', expect: '01 Dec 2026 09:00', paid: '2026-09-05', cut: 1 },
  { group: 'other-cutoff', id: 1803, identity: 'f4:E2:C6:38:AB:9E', expect: '11 Oct 2026 22:36', paid: '2026-08-06', cut: 11 },

  // Second router (RB5009, 192.168.88.x), screenshot 2026-09-29. Rule from the owner: 5 Oct unless a
  // payment after 20 Sep. Matched by name, confirmed by the visible MAC prefix; `paid` is the last
  // payment in either system. Left out: paid after 20 Sep (Faith Nash, Kamar Nash, Olive Bryan,
  // Romardo Foster, Vanessa Forrest); expired before 5 Oct, where 5 Oct would ADD access (14 + Mark
  // Salmon, pitter); no radcheck row (Jenny Coley, Jermain Robinson); no customer by name
  // (Randiesha Clarke, Tevona Dunkley, Obrian Wright).
  { group: 'rb5009', id: 1991, identity: 'F4:92:BF:4C:BB:8B', expect: '05 Nov 2026 21:32', paid: '2026-09-10' },
  { group: 'rb5009', id: 1850, identity: '78:45:58:AC:9D:19', expect: '05 Oct 2026 09:00', paid: '2026-08-14' },
  { group: 'rb5009', id: 1772, identity: '6C:63:F8:C8:08:D1', expect: '05 Nov 2026 17:55', paid: '2026-09-04' },
  { group: 'rb5009', id: 1782, identity: 'F4:92:BF:F4:22:6F', expect: '05 Oct 2026 21:41', paid: '2026-08-26' },
  { group: 'rb5009', id: 1774, identity: '78:45:58:A2:C6:F1', expect: '05 Jan 2027 22:53', paid: '2026-09-10' },
  { group: 'rb5009', id: 2005, identity: '6C:63:F8:D0:F8:3A', expect: '05 Nov 2026 14:25', paid: '2026-09-02' },
  { group: 'rb5009', id: 1916, identity: '6C:63:F8:C8:0E:FA', expect: '05 Dec 2026 09:00', paid: '2026-09-05' },
  { group: 'rb5009', id: 1922, identity: 'F4:92:BF:DA:1F:58', expect: '05 Nov 2026 21:36', paid: '2026-09-12' },
  { group: 'rb5009', id: 1800, identity: 'B4:FB:E4:3A:B4:4C', expect: '05 Mar 2027 16:59', paid: '2026-09-03' },
  { group: 'rb5009', id: 1781, identity: 'F4:92:BF:4C:BF:33', expect: '05 Dec 2026 02:22', paid: '2026-09-01' },
  { group: 'rb5009', id: 1891, identity: '68:D7:9A:B2:83:A3', expect: '05 Nov 2026 18:27', paid: '2026-08-29' },
  { group: 'rb5009', id: 1776, identity: '6C:63:F8:C8:0C:5E', expect: '05 Jan 2027 12:20', paid: '2026-09-04' },
  { group: 'rb5009', id: 2009, identity: '74:83:C2:E4:D6:A8', expect: '30 Nov 2026 09:00', paid: null },
  { group: 'rb5009', id: 1950, identity: 'F4:E2:C6:38:DF:72', expect: '05 Jan 2027 14:55', paid: '2026-08-22' },
  { group: 'rb5009', id: 1988, identity: '6C:63:F8:D0:F8:AC', expect: '05 Dec 2026 17:25', paid: '2026-09-04' },
  { group: 'rb5009', id: 1815, identity: '74:AC:B9:80:CC:A8', expect: '05 Nov 2026 16:39', paid: '2026-09-11' },
  { group: 'rb5009', id: 1796, identity: 'E0:63:DA:42:A2:66', expect: '11 Jan 2027 14:50', paid: '2026-08-24', cut: 11 },
  { group: 'rb5009', id: 1724, identity: '18:E8:29:8C:A8:95', expect: '05 Jan 2027 00:00', paid: '2026-09-18' },
  { group: 'rb5009', id: 1799, identity: '74:83:C2:EE:A0:6D', expect: '05 Jan 2027 14:53', paid: '2026-09-01' },
  { group: 'rb5009', id: 1766, identity: '74:AC:B9:FC:9C:71', expect: '05 Oct 2026 18:22', paid: '2026-08-05' },
  { group: 'rb5009', id: 1761, identity: '74:AC:B9:F2:0C:0C', expect: '05 Dec 2026 09:00', paid: '2026-09-01' },
  { group: 'rb5009', id: 1769, identity: 'F4:E2:C6:3C:55:02', expect: '08 Oct 2026 00:00', paid: '2026-07-06' },
  { group: 'rb5009', id: 1981, identity: '6C:63:F8:C8:0D:4B', expect: '05 Dec 2026 09:00', paid: '2026-09-04' },
  { group: 'rb5009', id: 2026, identity: 'E4:38:83:B4:26:DB', expect: '05 Nov 2026 21:50', paid: '2026-09-14' },
  { group: 'rb5009', id: 1784, identity: 'F4:92:BF:4C:B7:49', expect: '05 Oct 2026 17:36', paid: '2026-08-07' },
  { group: 'rb5009', id: 1764, identity: '74:AC:B9:FC:A0:C9', expect: '05 Oct 2026 09:00', paid: '2026-08-05' },
  { group: 'rb5009', id: 1841, identity: '70:A7:41:1A:EC:BB', expect: '05 Nov 2026 16:15', paid: '2026-08-31' },
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
  const targets = TARGETS.filter((t) => GROUPS.includes(t.group) && (!ONLY_IDS || ONLY_IDS.includes(t.id)))
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })

  const { data: custs, error } = await db
    .from('customers').select('id, company_id, first_name, last_name, mac_address, cut_off_date')
    .in('id', targets.map((t) => t.id))
  if (error) throw new Error('customers: ' + error.message)

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const target = parseRadius(TARGET)
  const plan = []
  for (const t of targets) {
    const c = custs.find((x) => x.id === t.id)
    const name = c ? (c.first_name + ' ' + (c.last_name ?? '')).trim() : '?'
    const row = { ...t, name, status: 'READY', why: '' }
    plan.push(row)
    const skip = (why) => { row.status = 'SKIPPED'; row.why = why }

    if (!c) { skip('no customer ' + t.id); continue }
    if (c.company_id !== COMPANY) { skip('customer is company ' + c.company_id); continue }
    if ((c.mac_address ?? '').toUpperCase() !== t.identity.toUpperCase()) { skip('MAC is now ' + c.mac_address); continue }
    if (c.cut_off_date !== (t.cut ?? 5)) { skip('cut-off day is ' + c.cut_off_date + ', not ' + (t.cut ?? 5)); continue }

    const [rows] = await my.execute(
      'SELECT username, value FROM radcheck WHERE username = ? AND attribute = ?', [t.identity, 'Expiration'])
    const exact = rows.filter((r) => r.username === t.identity)
    if (exact.length !== 1) { skip(exact.length + ' Expiration rows for ' + t.identity); continue }
    row.live = exact[0].value
    if (row.live !== t.expect) { skip('radcheck moved since 2026-09-29: now ' + row.live); continue }
    const held = parseRadius(row.live)
    if (!held || held.getTime() <= target.getTime()) { skip('held ' + row.live + ' is not later than ' + TARGET); continue }

    const [variants] = await my.execute(
      'SELECT username, value FROM radcheck WHERE UPPER(TRIM(username)) = ? AND attribute = ?',
      [t.identity.toUpperCase(), 'Expiration'])
    const live = variants.filter((v) => v.username !== t.identity && (parseRadius(v.value)?.getTime() ?? 0) > target.getTime())
    if (live.length) {
      skip('another spelling holds a later expiry: ' + live.map((v) => '"' + v.username + '" ' + v.value).join(', '))
      continue
    }
  }

  console.log('West Central Networks: expiries back to ' + TARGET + '   groups=' + GROUPS.join(',') +
    '   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  console.log(['status', 'group', 'customer', 'name', 'identity', 'paid', 'radcheck now', '-> new'].join(' | '))
  for (const p of plan) {
    console.log([p.status, p.group, '#' + p.id, p.name, p.identity, p.paid ?? 'none', p.live ?? p.expect,
      p.status === 'READY' ? TARGET : p.why].join(' | '))
  }
  const ready = plan.filter((p) => p.status === 'READY')
  console.log('\nREADY ' + ready.length + '   SKIPPED ' + (plan.length - ready.length))
  const other = TARGETS.filter((t) => !GROUPS.includes(t.group))
  if (other.length) console.log('Not in this run (group ' + [...new Set(other.map((t) => t.group))].join(',') + '): ' + other.length)

  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> to correct the READY rows.')
    await my.end()
    return
  }

  // --- apply ---------------------------------------------------------------------
  let done = 0
  for (const p of ready) {
    const tag = '#' + p.id + ' ' + p.name + ': '

    // radcheck first, guarded by the value being replaced.
    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [TARGET, p.identity, 'Expiration', p.live]
    )
    if ((res.affectedRows ?? 0) !== 1) {
      console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.')
      continue
    }

    // The correction, in the shape the Correct Expiry modal writes.
    const { error: logErr } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: p.id,
      type: 'network_expiry_corrected',
      correlation_id: RUN_ID,
      details:
        'Expiry corrected for ' + p.identity + '. Expiry ' + ymd(parseRadius(p.live)) + ' -> ' + TARGET_YMD +
        '. By ' + actor.email + ' | reason=' + safeValue(arg('reason') ?? REASONS[p.group]) + ' | run=' + RUN_ID,
    })
    if (logErr) console.log(tag + 'radcheck corrected, but the log row failed: ' + logErr.message)

    done += 1
    console.log(tag + p.live + ' -> ' + TARGET)
  }

  console.log('\nCorrected ' + done + ' of ' + ready.length + ' READY row(s). run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
