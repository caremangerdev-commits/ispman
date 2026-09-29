#!/usr/bin/env node
/**
 * ONE-OFF: the rest of West Central Networks (company 26), after the
 * router-by-router corrections of 2026-09-29. A read of every customer's
 * radcheck expiry against the owner's rule found 50 holding later than it
 * allows; the owner decided each group:
 *
 *   left alone   access points and complimentary accounts: spurtree AP,
 *                Leonard slipe AP, Retrive ap, MalvernaP, travis hodges,
 *                Ritchie ellis, Reggae Blend, KADIE, Hoges landges ap.
 *                Dirk Brown (cut-off 1) was already set to 5 Oct on request.
 *   NOV (5 Nov)  paid at ISPMan's till on or after 20 Sep: Patrick Dockery,
 *                Carroda Jones, Jodian Johnson. ISPMan's till extended from
 *                the date the legacy till had already pushed out, so each
 *                landed months past what was paid. The owner chose 5 Nov for
 *                all three, whatever the number of months paid.
 *   OCT (5 Oct)  no payment on or after 20 Sep: 36 customers, plus Kamar
 *                Campbell (cut-off 18, held 18 Nov; cut-off NOT changed).
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/set-wcn-remaining-expiries.mjs                          dry run (default)
 *   node scripts/set-wcn-remaining-expiries.mjs --apply --user=<users.id>
 *
 * GUARDS, per row: company 26, MAC is the identity (ignoring case), cut-off
 * day as stated (5 unless the row says), exactly one Expiration row for that
 * exact username still holding `expect`, the new date earlier than it (every
 * row here is a pull-back), no other spelling of the MAC holding a later
 * date, and for OCT rows no payment on or after 20 Sep in ISPMan or legacy,
 * re-read live.
 *
 * WHAT --apply WRITES, per READY row, under one run id: one guarded UPDATE of
 * the radcheck Expiration, and one network_expiry_corrected log row in the
 * shape the Correct Expiry modal writes. Nothing else.
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
  console.error('--apply needs --user=<users.id> so the log rows name who corrected these.')
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
const PAID_FROM = '2026-09-20'
const RUN_ID = randomUUID()
const OCT = { value: '05 Oct 2026 00:00', ymd: '2026-10-05', reason: 'No payment on or after 20 Sep; set to 5 Oct on the owner\'s instruction' }
const NOV = { value: '05 Nov 2026 00:00', ymd: '2026-11-05', reason: 'Paid on or after 20 Sep; set to 5 Nov on the owner\'s instruction' }

/** identity: the radcheck username EXACTLY as stored. expect: radcheck Expiration read 2026-09-29. paid: last payment either system. */
const TARGETS = [
  { to: NOV, id: 1848, identity: '80:2A:A8:A8:DD:AD', expect: '05 Mar 2027 00:00', paid: '2026-09-29' }, // Patrick Dockery
  { to: NOV, id: 1722, identity: '38:D4:A5:8B:09:80', expect: '05 May 2027 00:00', paid: '2026-09-23' }, // Carroda Jones
  { to: NOV, id: 1842, identity: '24:5A:4C:40:14:B2', expect: '05 Jan 2027 00:00', paid: '2026-09-24' }, // Jodian Johnson
  { to: OCT, id: 1944, identity: '74:83:C2:A6:61:02', expect: '18 Nov 2026 09:00', paid: '2026-09-10', cut: 18 }, // Kamar Campbell
  { to: OCT, id: 1855, identity: '70:A7:41:1A:A3:60', expect: '05 Apr 2027 16:35', paid: '2026-09-02' }, // Shaneka Dennis
  { to: OCT, id: 1849, identity: '80:2A:A8:A8:DD:56', expect: '05 Feb 2027 09:00', paid: '2026-09-01' }, // Winston Dockery (also " 80:2A:A8:A8:DD:56" = 05 Jan 2024 13:20)
  { to: OCT, id: 1738, identity: '74:AC:B9:80:D1:05', expect: '05 Jan 2027 00:21', paid: '2026-08-26' }, // mark campbell
  { to: OCT, id: 1809, identity: '68:D7:9A:B4:95:BA', expect: '05 Jan 2027 00:00', paid: '2026-09-12' }, // Neville William
  { to: OCT, id: 1852, identity: '70:A7:41:1A:B5:D2', expect: '05 Jan 2027 09:00', paid: '2026-09-07' }, // Altaus wright
  { to: OCT, id: 1870, identity: '70:A7:41:42:C8:5B', expect: '05 Jan 2027 13:55', paid: '2026-08-31' }, // Jackeline smith
  { to: OCT, id: 1938, identity: '9C:05:D6:96:4E:D4', expect: '05 Jan 2027 00:23', paid: '2026-08-28' }, // Linton Brown
  { to: OCT, id: 1996, identity: 'F4:E2:C6:8E:59:A8', expect: '05 Jan 2027 21:25', paid: '2026-08-27' }, // Zelophia foster
  { to: OCT, id: 1734, identity: '6C:63:F8:CA:97:91', expect: '10 Dec 2026 09:00', paid: null }, // Fox Gordon
  { to: OCT, id: 1737, identity: 'B4:FB:E4:62:15:C1', expect: '05 Dec 2026 00:00', paid: null }, // Besika Nemhard
  { to: OCT, id: 1785, identity: '6C:63:F8:CA:8D:15', expect: '05 Dec 2026 18:37', paid: '2026-08-17' }, // Natasha Gordon
  { to: OCT, id: 1894, identity: '74:AC:B9:FA:F1:3B', expect: '05 Dec 2026 09:00', paid: '2026-09-07' }, // melford Morgan
  { to: OCT, id: 1925, identity: 'fc:EC:DA:C4:84:3C', expect: '05 Dec 2026 09:00', paid: '2026-08-04' }, // Avon jones
  { to: OCT, id: 1964, identity: '74:AC:B9:F2:16:4E', expect: '05 Dec 2026 09:00', paid: null }, // Thelma Foster
  { to: OCT, id: 1970, identity: '68:D7:9A:B2:78:0F', expect: '05 Dec 2026 09:00', paid: '2026-09-02' }, // Jannet Huggins
  { to: OCT, id: 1971, identity: '50:5B:1D:E7:82:6F', expect: '05 Dec 2026 00:00', paid: '2026-09-07' }, // kemroy Mckenzie
  { to: OCT, id: 2004, identity: 'F4:E2:C6:38:98:90', expect: '05 Dec 2026 00:21', paid: '2026-09-03' }, // Austin Francis
  { to: OCT, id: 1750, identity: '74:AC:B9:72:05:37', expect: '05 Nov 2026 00:00', paid: '2026-09-11' }, // julian dunkley
  { to: OCT, id: 1770, identity: '98:c7:a4:17:22:e3', expect: '05 Nov 2026 09:00', paid: '2026-09-02' }, // Lynette Kerr
  { to: OCT, id: 1814, identity: '50:5B:1D:E7:40:27', expect: '05 Nov 2026 09:00', paid: '2026-09-07' }, // Kevin shields
  { to: OCT, id: 1824, identity: '68:D7:9A:B2:70:65', expect: '05 Nov 2026 00:16', paid: '2026-09-04' }, // Ishena Campbell
  { to: OCT, id: 1839, identity: '6c:68:a4:7e:f6:c8', expect: '05 Nov 2026 16:31', paid: '2026-09-04' }, // Venessa Smith
  { to: OCT, id: 1869, identity: '70:A7:41:1A:B5:CF', expect: '05 Nov 2026 00:00', paid: '2026-09-14' }, // Donnette dunkley
  { to: OCT, id: 1903, identity: '74:83:C2:E4:B1:F9', expect: '05 Nov 2026 23:31', paid: '2026-08-05' }, // Bryan brooks
  { to: OCT, id: 1934, identity: '68:D7:9A:B2:72:22', expect: '05 Nov 2026 01:34', paid: '2026-09-02' }, // Janice Dennis
  { to: OCT, id: 1966, identity: 'F4:E2:C6:3A:07:DB', expect: '05 Nov 2026 00:00', paid: null }, // Joseph Thomas
  { to: OCT, id: 2014, identity: '6C:63:F8:D0:F7:E8', expect: '05 Nov 2026 00:00', paid: '2026-09-10' }, // Errol Dickens
  { to: OCT, id: 2016, identity: '70:2E:22:0B:78:BE', expect: '05 Nov 2026 09:00', paid: '2026-08-23' }, // Yvonne Drackett
  { to: OCT, id: 2061, identity: '74:83:C2:E2:75:20', expect: '05 Nov 2026 00:00', paid: '2026-09-10' }, // Sophia Findlay
  { to: OCT, id: 5775, identity: 'F4:E2:C6:3A:02:68', expect: '05 Nov 2026 00:00', paid: null }, // John Muir
  { to: OCT, id: 1904, identity: '34:58:40:D1:21:57', expect: '04 Nov 2026 09:00', paid: null }, // Sullen vassel
  { to: OCT, id: 1901, identity: '68:D7:9A:B4:C3:7B', expect: '01 Nov 2026 00:00', paid: null }, // Monicea Robinson
  { to: OCT, id: 1885, identity: '98:c7:a4:27:75:78', expect: '31 Oct 2026 00:00', paid: null }, // Kemar Thomas
  { to: OCT, id: 1946, identity: '70:2E:22:0B:E8:59', expect: '09 Oct 2026 00:00', paid: null }, // Romell Gayle
  { to: OCT, id: 1926, identity: '70:2E:22:0B:37:86', expect: '08 Oct 2026 00:00', paid: '2026-08-04' }, // Errol jones
  { to: OCT, id: 1831, identity: '98:c7:a4:4a:f5:e8', expect: '07 Oct 2026 00:00', paid: '2026-08-05' }, // Thelma Williams
]

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
  const ids = TARGETS.map((t) => t.id)
  if (new Set(ids).size !== ids.length) throw new Error('A customer is listed twice in TARGETS.')

  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'), password: need('RADIUS_DB_PASSWORD'),
    database: need('RADIUS_DB_NAME'), port: Number(process.env.RADIUS_DB_PORT ?? 3306), dateStrings: true,
  })
  const { data: custs, error } = await db.from('customers')
    .select('id, company_id, first_name, last_name, mac_address, cut_off_date, notes').in('id', ids)
  if (error) throw new Error('customers: ' + error.message)
  const { data: latePays, error: pe } = await db.from('payments')
    .select('customer_id, paid_on').in('customer_id', ids).gte('paid_on', PAID_FROM)
  if (pe) throw new Error('payments: ' + pe.message)

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const plan = []
  for (const t of TARGETS) {
    const c = custs.find((x) => x.id === t.id)
    const row = { ...t, name: c ? (c.first_name + ' ' + (c.last_name ?? '')).trim() : '?', status: 'READY', why: '', live: null }
    plan.push(row)
    const skip = (why) => { row.status = 'SKIPPED'; row.why = why }
    const target = parseRadius(t.to.value)

    if (!c) { skip('no customer'); continue }
    if (c.company_id !== COMPANY) { skip('customer is company ' + c.company_id); continue }
    if ((c.mac_address ?? '').toUpperCase() !== t.identity.toUpperCase()) { skip('MAC is now ' + c.mac_address); continue }
    if (c.cut_off_date !== (t.cut ?? 5)) { skip('cut-off day is ' + c.cut_off_date + ', not ' + (t.cut ?? 5)); continue }

    if (t.to === OCT) {
      const late = latePays.filter((p) => p.customer_id === t.id).map((p) => p.paid_on)
      if (late.length) { skip('paid on/after 20 Sep in ISPMan: ' + late.join(', ')); continue }
      const legacyId = /Legacy #(\d+)/.exec(c.notes ?? '')?.[1]
      if (legacyId) {
        const [lp] = await my.query('SELECT date FROM `' + LEGACY_SCHEMA + '`.payments WHERE customer = ? AND date >= ?', [legacyId, PAID_FROM])
        if (lp.length) { skip('paid on/after 20 Sep in legacy: ' + lp.map((r) => r.date).join(', ')); continue }
      }
    }

    const [variants] = await my.execute('SELECT username, value FROM radcheck WHERE UPPER(TRIM(username)) = ? AND attribute = ?',
      [t.identity.toUpperCase(), 'Expiration'])
    const exact = variants.filter((v) => v.username === t.identity)
    if (exact.length !== 1) { skip(exact.length + ' Expiration rows for ' + t.identity); continue }
    row.live = exact[0].value
    if (row.live !== t.expect) { skip('radcheck moved since 2026-09-29: now ' + row.live); continue }
    if ((parseRadius(row.live)?.getTime() ?? 0) <= target.getTime()) { skip('not later than ' + t.to.value); continue }
    const later = variants.filter((v) => v.username !== t.identity && (parseRadius(v.value)?.getTime() ?? 0) > target.getTime())
    if (later.length) { skip('another spelling holds a later expiry: ' + later.map((v) => '"' + v.username + '" ' + v.value).join(', ')); continue }
  }

  console.log('West Central Networks: remaining expiries   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
  for (const p of plan) {
    console.log([p.status, '#' + p.id, p.name, p.identity, p.paid ?? 'none', p.live ?? p.expect, p.status === 'READY' ? p.to.value : p.why].join(' | '))
  }
  const ready = plan.filter((p) => p.status === 'READY')
  console.log('\nREADY ' + ready.length + ' (to 5 Nov ' + ready.filter((p) => p.to === NOV).length + ', to 5 Oct ' +
    ready.filter((p) => p.to === OCT).length + ')   SKIPPED ' + (plan.length - ready.length))
  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> to correct the READY rows.')
    await my.end()
    return
  }

  let done = 0
  for (const p of ready) {
    const tag = '#' + p.id + ' ' + p.name + ': '
    const [res] = await my.execute('UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [p.to.value, p.identity, 'Expiration', p.live])
    if ((res.affectedRows ?? 0) !== 1) { console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; no log row written.'); continue }
    const { error: logErr } = await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, customer_id: p.id, type: 'network_expiry_corrected', correlation_id: RUN_ID,
      details: 'Expiry corrected for ' + p.identity + '. Expiry ' + ymd(parseRadius(p.live)) + ' -> ' + p.to.ymd +
        '. By ' + actor.email + ' | reason=' + safeValue(p.to.reason) + ' | run=' + RUN_ID,
    })
    if (logErr) console.log(tag + 'radcheck corrected, but the log row failed: ' + logErr.message)
    done += 1
    console.log(tag + p.live + ' -> ' + p.to.value)
  }
  console.log('\nCorrected ' + done + ' of ' + ready.length + ' READY row(s). run=' + RUN_ID)
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
