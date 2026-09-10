#!/usr/bin/env node
/**
 * ONE-OFF: repair payment_date on migrated payments.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/fix-payment-times.mjs [--dry-run]
 *
 * WHAT WAS WRONG
 *   The migration folded a legacy wall-clock time into payment_date as
 *
 *     date + 'T12:' + hour + ':' + minute + 'Z'
 *
 *   which put the legacy HOUR in the minutes field and the legacy MINUTE in
 *   the seconds field. Ordering within a day survived and no digit was lost,
 *   but the app renders h:mm without seconds, so every payment taken in the
 *   same legacy hour displayed as the same minute — it read as "rounded to the
 *   hour" — and the time shown was meaningless anyway: 18:31 stored as 12:18Z
 *   and displayed as 7:18 AM.
 *
 * WHAT IT DOES
 *   Reads the legacy timestamp back from the legacy table, keyed on the legacy
 *   id in the payment's notes, and rewrites payment_date as the instant that
 *   wall-clock time actually names in the company's own timezone.
 *
 * WHY THE LEGACY LOOKUP RATHER THAN DECODING THE STORED VALUE
 *   The stored value can be decoded — hour is in the minutes field, minute in
 *   the seconds field — and that needs no second database. But it is NOT
 *   IDEMPOTENT: once a row is fixed, a legacy time of 07:00-07:59 Jamaica lands
 *   at 12:00-12:59 UTC, which is indistinguishable from a packed value. A
 *   second run would "fix" those a second time and corrupt them. Reading the
 *   source is exact and can be run as many times as it needs to be.
 *
 * ONLY MIGRATED ROWS ARE TOUCHED. A payment taken in ISPMan carries no legacy
 * note, is never matched, and is never written to.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'

const DRY_RUN = process.argv.includes('--dry-run')
const CONCURRENCY = 12

/** ISPMan company id -> the legacy schema its payments came from. */
const SCHEMA_BY_COMPANY = {
  26: 'COMPANY_wcnetjagmail_com',
  31: 'COMPANY_kevinvernon11yahoo_com',
  32: 'COMPANY_simogamecity85gmail_com',
  33: 'COMPANY_smartcommnetworkingsolutionsltdgmail_com',
}

/** Only a note of exactly this shape identifies a migrated row. */
const LEGACY_NOTE = /^Migrated from legacy payment #(\d+)$/

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

/** See migrate-legacy-company.mjs#zonedWallClockToUtc — same rule, same reason. */
function zonedWallClockToUtc(y, mo, d, h, mi, timeZone) {
  const wanted = Date.UTC(y, mo - 1, d, h, mi, 0)
  const offsetAt = (instant) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant))
    const f = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0)
    return Date.UTC(f('year'), f('month') - 1, f('day'), f('hour') % 24, f('minute'), f('second')) - instant
  }
  let guess = wanted - offsetAt(wanted)
  guess = wanted - offsetAt(guess)
  const out = new Date(guess)
  return Number.isFinite(out.getTime()) ? out : null
}

const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function main() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'),
    password: need('RADIUS_DB_PASSWORD'), port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    dateStrings: true,
  })

  console.log('\n' + '='.repeat(74))
  console.log('FIX MIGRATED PAYMENT TIMES' + (DRY_RUN ? '  [DRY RUN — nothing written]' : '  [LIVE]'))
  console.log('='.repeat(74))

  let grandTotal = 0
  let grandChanged = 0
  let grandSkipped = 0

  for (const [companyIdRaw, schema] of Object.entries(SCHEMA_BY_COMPANY)) {
    const companyId = Number(companyIdRaw)

    const { data: co } = await db.from('companies').select('name').eq('id', companyId).maybeSingle()
    const { data: st } = await db.from('settings').select('timezone').eq('company_id', companyId).maybeSingle()
    const tz = st?.timezone || 'America/Jamaica'

    // Every payment for the company, paged past PostgREST's 1000-row ceiling.
    let rows = []
    let from = 0
    for (;;) {
      const { data, error } = await db
        .from('payments').select('id, notes, payment_date, paid_on')
        .eq('company_id', companyId).order('id').range(from, from + 999)
      if (error) throw new Error('payments: ' + error.message)
      rows = rows.concat(data)
      if (data.length < 1000) break
      from += 1000
    }

    const migrated = rows
      .map((r) => ({ row: r, m: LEGACY_NOTE.exec(String(r.notes ?? '')) }))
      .filter((x) => x.m)
      .map((x) => ({ ...x.row, legacyId: Number(x.m[1]) }))

    console.log('\n' + '-'.repeat(74))
    console.log(companyId + '  ' + (co?.name ?? '?') + '   [' + schema + ']   tz ' + tz)
    console.log('-'.repeat(74))
    console.log('  payments in company : ' + rows.length)
    console.log('  carrying legacy note: ' + migrated.length)
    console.log('  native, untouched   : ' + (rows.length - migrated.length))

    if (migrated.length === 0) { continue }

    // One read of the legacy timestamps rather than a query per row.
    const [legacyRows] = await my.query(
      'SELECT id, date FROM `' + schema + '`.payments WHERE id IN (?)',
      [migrated.map((r) => r.legacyId)]
    )
    const legacyDate = new Map(legacyRows.map((r) => [Number(r.id), String(r.date)]))
    console.log('  legacy rows found   : ' + legacyDate.size + ' of ' + migrated.length)

    const plan = []
    let unreadable = 0
    let missing = 0

    for (const r of migrated) {
      const src = legacyDate.get(r.legacyId)
      if (src === undefined) { missing += 1; continue }

      const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(src.trim())
      if (!m) { unreadable += 1; continue }

      const utc = zonedWallClockToUtc(
        Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz
      )
      if (!utc) { unreadable += 1; continue }

      const next = utc.toISOString()
      if (new Date(r.payment_date).getTime() !== utc.getTime()) {
        plan.push({ id: r.id, legacyId: r.legacyId, src, from: r.payment_date, to: next })
      }
    }

    console.log('  already correct     : ' + (migrated.length - plan.length - unreadable - missing))
    console.log('  to rewrite          : ' + plan.length)
    if (missing) console.log('  !! legacy row gone  : ' + missing + ' (left alone)')
    if (unreadable) console.log('  !! unreadable date  : ' + unreadable + ' (left alone)')

    for (const p of plan.slice(0, 3)) {
      console.log('    #' + String(p.id).padEnd(7) + 'legacy ' + p.src +
        '   ' + p.from + '  ->  ' + p.to)
    }

    grandTotal += migrated.length
    grandChanged += plan.length
    grandSkipped += missing + unreadable

    if (DRY_RUN) continue

    let done = 0
    let failed = 0
    for (let i = 0; i < plan.length; i += CONCURRENCY) {
      const slice = plan.slice(i, i + CONCURRENCY)
      const res = await Promise.all(slice.map((p) =>
        db.from('payments').update({ payment_date: p.to }).eq('id', p.id)
      ))
      for (const r of res) {
        if (r.error) { failed += 1; if (failed <= 3) console.log('    !! ' + r.error.message) }
        else done += 1
      }
    }
    console.log('  rewritten           : ' + done + (failed ? '   FAILED ' + failed : ''))
  }

  await my.end()

  console.log('\n' + '='.repeat(74))
  console.log('  mode            : ' + (DRY_RUN ? 'DRY RUN (nothing written)' : 'LIVE'))
  console.log('  migrated rows   : ' + grandTotal)
  console.log('  rewritten       : ' + grandChanged + (DRY_RUN ? ' (would be)' : ''))
  console.log('  left alone      : ' + grandSkipped)
  console.log('='.repeat(74) + '\n')
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message)
  process.exit(1)
})
