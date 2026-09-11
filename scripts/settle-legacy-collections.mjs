#!/usr/bin/env node
/**
 * ONE-OFF: settle the collections that were reconciled on the previous system.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/settle-legacy-collections.mjs [--dry-run] [--company=26]
 *
 * WHAT IS WRONG WITHOUT IT
 *   Every migrated payment was written with checked_off = false, because the
 *   legacy checkoff table is (id, amount, date, agent) and carries NO reference
 *   to the payments a handover was made up of. So the checkoff page — which
 *   derives "who is holding company cash" from unchecked payments — reports
 *   money that was handed over months ago under the old system. For West
 *   Central that is J$1.7m; across the three bulk-migrated companies it is
 *   J$41m.
 *
 * WHY NOT RECONSTRUCT WHICH PAYMENTS EACH HANDOVER COVERED
 *   Because it does not work, and that was measured rather than assumed. For
 *   each of West Central's 479 clean handovers, summing that agent's legacy
 *   payments since their previous handover reproduces the handover amount
 *   139 times — 29%. In the six-month import window it is 6 of 16, and the
 *   failures are not marginal: one handover of J$500,000 against J$141,000
 *   collected, another of J$10,000 against J$118,000. Agent 87 alone is 4 right
 *   and 5 wrong, so it is not a name-matching problem — the model is wrong.
 *   Two handovers by one agent 78 minutes apart cannot both be "collections
 *   since the last handover".
 *
 *   Marking payments on that basis would write a reconciliation nobody
 *   performed, and present it with the authority of one that was.
 *
 * WHAT IT ASSERTS INSTEAD — two modes, both claiming only what was recorded.
 *
 *   WATERMARK (a company whose legacy system recorded handovers)
 *     Each agent's OWN last handover date is their line. Everything they
 *     collected up to it was part of some handover; everything after is
 *     genuinely outstanding. This claims only "this agent handed over at this
 *     time", which the legacy table does record reliably — it says nothing
 *     about which payments made up which handover.
 *
 *   CUT-OVER (a company whose legacy system recorded none)
 *     One line per company at migration. Their staff collected in the old
 *     system right up to cut-over and none of it was handed over through
 *     ISPMan, because ISPMan did not exist yet. The line says "everything
 *     before this was settled on the old system" — it is NOT a handover and is
 *     labelled so.
 *
 * ONLY MIGRATED PAYMENTS ARE TOUCHED, in both modes. A payment taken in ISPMan
 * cannot have been part of a legacy handover, whatever its date. That is also
 * what keeps the genuinely-outstanding figure honest: for West Central the
 * J$111,800 collected here since cut-over stays outstanding, as it should.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'
import mysql from 'mysql2/promise'

const DRY_RUN = process.argv.includes('--dry-run')
const ONLY = (() => {
  const a = process.argv.find((x) => x.startsWith('--company='))
  return a ? Number(a.slice('--company='.length)) : null
})()

/** Rows are updated in batches of this many ids. */
const CHUNK = 200

/** ISPMan company id -> the legacy schema its payments came from. */
const SCHEMA_BY_COMPANY = {
  26: 'COMPANY_wcnetjagmail_com',
  31: 'COMPANY_kevinvernon11yahoo_com',
  32: 'COMPANY_simogamecity85gmail_com',
  33: 'COMPANY_smartcommnetworkingsolutionsltdgmail_com',
}

/** Only a note of exactly this shape identifies a migrated payment. */
const LEGACY_NOTE = /^Migrated from legacy payment #\d+$/
/** The clean legacy datetime format. 19 of 498 checkoff rows are malformed. */
const CLEAN_DATE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/

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

const money = (n) => 'J$' + Math.round(n).toLocaleString()

/** See scripts/fix-payment-times.mjs — same rule, same reason. */
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
  return new Date(guess)
}

const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function allPayments(companyId) {
  let out = []
  let from = 0
  for (;;) {
    const { data, error } = await db
      .from('payments')
      .select('id, agent, user_id, amount, checked_off, payment_date, notes')
      .eq('company_id', companyId).order('id').range(from, from + 999)
    if (error) throw new Error('payments: ' + error.message)
    out = out.concat(data)
    if (data.length < 1000) break
    from += 1000
  }
  return out
}

/**
 * Each agent's last handover, from the legacy checkoff table.
 *
 * `checkoff.agent` holds either a cld_users id or a free-text name, so numeric
 * values are resolved through cld_users and the rest taken as written. Both
 * forms can refer to one person — West Central has handovers under "Haydn
 * Samuels" AND under `40` — so the two collapse onto one key and the LATEST of
 * them wins. Taking anything less would settle less than the agent had actually
 * handed over.
 */
async function watermarks(my, schema) {
  const [rows] = await my.query(
    'SELECT id, date, agent FROM `' + schema + '`.checkoff'
  )
  if (rows.length === 0) return null

  const [users] = await my.query('SELECT id, first_name, last_name FROM cld_users.users')
  const nameById = new Map(users.map((u) => [
    String(u.id), (u.first_name + ' ' + (u.last_name ?? '')).replace(/\s+/g, ' ').trim(),
  ]))

  const out = new Map()
  for (const r of rows) {
    const date = String(r.date ?? '')
    if (!CLEAN_DATE.test(date)) continue
    const raw = String(r.agent ?? '').trim()
    if (!raw) continue
    const name = /^\d+$/.test(raw) ? (nameById.get(raw) ?? 'Agent #' + raw) : raw
    const key = name.toLowerCase()
    const cur = out.get(key)
    if (!cur || date > cur.date) out.set(key, { name, date, checkoffId: r.id })
  }

  for (const v of out.values()) {
    const m = CLEAN_DATE.exec(v.date)
    v.instant = zonedWallClockToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], 'America/Jamaica').getTime()
  }
  return out
}

async function run() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'),
    password: need('RADIUS_DB_PASSWORD'), port: Number(process.env.RADIUS_DB_PORT ?? 3306),
    dateStrings: true,
  })

  console.log('\n' + '='.repeat(76))
  console.log('SETTLE LEGACY COLLECTIONS' + (DRY_RUN ? '   [DRY RUN — nothing written]' : '   [LIVE]'))
  console.log('='.repeat(76))

  let grandSettled = 0
  let grandAmount = 0

  for (const [idRaw, schema] of Object.entries(SCHEMA_BY_COMPANY)) {
    const companyId = Number(idRaw)
    if (ONLY !== null && companyId !== ONLY) continue

    const { data: co } = await db.from('companies').select('name').eq('id', companyId).maybeSingle()
    const pays = await allPayments(companyId)
    const open = pays.filter((p) => !p.checked_off && LEGACY_NOTE.test(String(p.notes ?? '')))
    const openNative = pays.filter((p) => !p.checked_off && !LEGACY_NOTE.test(String(p.notes ?? '')))

    const marks = await watermarks(my, schema)
    const mode = marks ? 'WATERMARK' : 'CUT-OVER'

    console.log('\n' + '-'.repeat(76))
    console.log(companyId + '  ' + (co?.name ?? '?') + '        mode: ' + mode)
    console.log('-'.repeat(76))
    console.log('  migrated, unchecked : ' + String(open.length).padStart(6) + '   ' + money(open.reduce((s, p) => s + Number(p.amount), 0)))
    console.log('  native, unchecked   : ' + String(openNative.length).padStart(6) + '   ' + money(openNative.reduce((s, p) => s + Number(p.amount), 0)) + '   — never touched')

    let toSettle = []
    let lineIso = null
    let note = ''

    if (marks) {
      console.log('\n  each agent\'s own last handover:')
      for (const v of [...marks.values()].sort((a, b) => (a.date < b.date ? 1 : -1))) {
        console.log('    ' + v.name.padEnd(24) + v.date + '   (legacy checkoff #' + v.checkoffId + ')')
      }
      toSettle = open.filter((p) => {
        const w = marks.get(String(p.agent ?? '').trim().toLowerCase())
        return w && new Date(p.payment_date).getTime() <= w.instant
      })
      // The latest line used, so the record carries a date that means something.
      lineIso = new Date(Math.max(...[...marks.values()].map((v) => v.instant))).toISOString()
      note =
        'Opening reconciliation — NOT a handover. ' +
        toSettle.length + ' payments collected on or before each agent\'s last ' +
        'handover in the previous system have been marked settled. The legacy ' +
        'records show WHEN each agent handed over but not WHICH payments made ' +
        'up each handover, so no payment is linked to any individual handover.'
    } else {
      // The line is the latest migrated payment: the last thing the old system
      // took in before cut-over. Derived from the data rather than typed in.
      const latest = open.reduce((a, p) => (p.payment_date > a ? p.payment_date : a), '')
      lineIso = latest || new Date().toISOString()
      toSettle = open
      console.log('\n  cut-over line: ' + lineIso.slice(0, 16) + '   (latest migrated payment)')
      note =
        'Cut-over line — NOT a handover. Everything collected before migration ' +
        'was settled on the previous system; none of it passed through ISPMan, ' +
        'which did not exist yet. ' + toSettle.length + ' payments marked settled.'
    }

    const amount = toSettle.reduce((s, p) => s + Number(p.amount), 0)
    const remain = open.filter((p) => !toSettle.includes(p))

    console.log('\n  to mark settled     : ' + String(toSettle.length).padStart(6) + '   ' + money(amount))
    console.log('  migrated, still open: ' + String(remain.length).padStart(6) + '   ' + money(remain.reduce((s, p) => s + Number(p.amount), 0)))

    if (remain.length > 0) {
      const byAgent = {}
      for (const p of remain) {
        const k = p.agent ?? '(none)'
        byAgent[k] = byAgent[k] ?? { n: 0, s: 0 }
        byAgent[k].n += 1
        byAgent[k].s += Number(p.amount)
      }
      console.log('\n  still outstanding, by agent (migrated only):')
      for (const [a, v] of Object.entries(byAgent).sort((x, y) => y[1].s - x[1].s)) {
        const w = marks?.get(String(a).trim().toLowerCase())
        console.log('    ' + String(a).slice(0, 24).padEnd(26) + String(v.n).padStart(5) + '  ' +
          money(v.s).padStart(13) + '   ' + (w ? 'after ' + w.date : 'no handover on record'))
      }
    }

    grandSettled += toSettle.length
    grandAmount += amount

    if (DRY_RUN || toSettle.length === 0) continue

    // The record FIRST. If it fails, nothing is marked — better than payments
    // silently going settled with nothing on the page to explain why.
    const { error: recError } = await db.from('checkoff_records').insert({
      company_id: companyId,
      agent_id: null,
      agent_name: mode === 'WATERMARK' ? 'Opening reconciliation' : 'Cut-over from previous system',
      checked_off_by: null,
      system_total: amount,
      amount_received: amount,
      discrepancy: 0,
      customers_count: new Set(toSettle.map((p) => p.id)).size,
      is_all_agents: true,
      notes: note,
      created_at: lineIso,
    })
    if (recError) {
      console.log('  !! record failed: ' + recError.message + ' — company skipped, nothing marked')
      continue
    }

    let done = 0
    let failed = 0
    for (let i = 0; i < toSettle.length; i += CHUNK) {
      const ids = toSettle.slice(i, i + CHUNK).map((p) => p.id)
      const { error } = await db.from('payments').update({
        checked_off: true,
        checked_off_at: lineIso,
        // NULL on purpose: nobody in ISPMan performed this. A user id here
        // would name someone as having received money they never received.
        checked_off_by: null,
      }).in('id', ids)
      if (error) { failed += ids.length; if (failed <= CHUNK) console.log('    !! ' + error.message) }
      else done += ids.length
    }
    console.log('\n  marked settled      : ' + done + (failed ? '   FAILED ' + failed : ''))
  }

  await my.end()

  console.log('\n' + '='.repeat(76))
  console.log('  mode          : ' + (DRY_RUN ? 'DRY RUN (nothing written)' : 'LIVE'))
  console.log('  payments settled: ' + grandSettled + (DRY_RUN ? ' (would be)' : ''))
  console.log('  value settled   : ' + money(grandAmount))
  console.log('='.repeat(76) + '\n')
}

run().catch((err) => {
  console.error('\nFAILED: ' + err.message)
  process.exit(1)
})
