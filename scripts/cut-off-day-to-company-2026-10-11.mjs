#!/usr/bin/env node
/**
 * ONE-OFF: customers still on the 5th — the legacy app's default cut-off day,
 * copied over on migration day — moved to their company's own cut-off day.
 * Owner, 11 Oct 2026: Vernon's 191 and Tkl's 98, both companies on the 1st.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/cut-off-day-to-company-2026-10-11.mjs --company=31                dry run
 *   node scripts/cut-off-day-to-company-2026-10-11.mjs --company=31 --apply --expect=191 --user=<users.id>
 *
 * ONLY THE TWO THE OWNER NAMED. Other companies have customers on the 5th
 * too, and some on other days that may be arrangements; they were counted and
 * reported, not written. This refuses any company not listed below.
 *
 * WHAT --apply WRITES
 *   customers.cut_off_date 5 -> the company's day, guarded by the 5 it
 *   replaces, and only for the ids the dry run would list. --expect must match
 *   that count: what is written is the set somebody read.
 *   One customer_updated row each, in the shape the edit form writes (and
 *   Chloe's 270 by hand), so it shows in the customer's history.
 *
 * NOT THE EXPIRY. Each customer's expiry stays where it is and moves to the
 * new day at their next payment (owner: "Expiries stay as they are and
 * correct at their next payment").
 *
 * correlation_id on every log row = the run id.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

// company -> the cut-off day the owner confirmed for it.
const ALLOWED = new Map([
  [31, 1], // Vernon Communications
  [35, 1], // Tkl Wireless
])
const FROM_DAY = 5

const APPLY = process.argv.includes('--apply')
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : null
}
const COMPANY = Number(arg('company'))
const USER_ID = arg('user') ? Number(arg('user')) : null
const EXPECT = arg('expect') === null ? null : Number(arg('expect'))
if (!ALLOWED.has(COMPANY)) {
  console.error('--company must be one of ' + [...ALLOWED.keys()].join(', ') + ' (the companies the owner named).')
  process.exit(1)
}
if (APPLY && (!USER_ID || EXPECT === null)) {
  console.error('--apply needs --user=<users.id> and --expect=<count from the dry run>.')
  process.exit(1)
}

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0) {
    const key = line.slice(0, eq).trim()
    if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
}
const need = (n) => {
  const v = process.env[n]
  if (!v) { console.error('Missing ' + n); process.exit(1) }
  return v
}
const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

const RUN_ID = randomUUID()
const REASON = "the 5th was the legacy app's default; the company's cut-off day is the " + ALLOWED.get(COMPANY) +
  'st (owner, 11 Oct 2026). Expiry unchanged until the next payment'

async function main() {
  const toDay = ALLOWED.get(COMPANY)
  const { data: s, error: se } = await db.from('settings').select('cut_off_date').eq('company_id', COMPANY).maybeSingle()
  if (se) throw new Error(se.message)
  if (s?.cut_off_date !== toDay) {
    console.error('Company ' + COMPANY + "'s cut-off day is " + s?.cut_off_date + ', not ' + toDay + '. Nothing written.')
    process.exit(1)
  }
  const { data: co } = await db.from('companies').select('name').eq('id', COMPANY).maybeSingle()

  let actor = null
  if (APPLY) {
    const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
    if (ue || !u) { console.error('No users row ' + USER_ID + (ue ? ': ' + ue.message : '')); process.exit(1) }
    actor = u
  }

  const rows = []
  for (let f = 0; ; f += 1000) {
    const { data, error } = await db.from('customers').select('id, first_name, last_name')
      .eq('company_id', COMPANY).eq('cut_off_date', FROM_DAY).order('id').range(f, f + 999)
    if (error) throw new Error(error.message)
    rows.push(...data)
    if (data.length < 1000) break
  }
  const name = (c) => ((c.first_name ?? '') + ' ' + (c.last_name ?? '')).trim()

  console.log((co?.name ?? COMPANY) + ': cut-off day ' + FROM_DAY + ' -> ' + toDay + '   run=' + RUN_ID +
    (APPLY ? '   APPLY' : '   DRY RUN') + '\n')
  for (const c of rows) console.log('  #' + String(c.id).padEnd(6) + name(c))
  console.log('\n' + rows.length + ' customers on the ' + FROM_DAY + 'th.')

  if (!APPLY) {
    console.log('Dry run: nothing was written. Re-run with --apply --expect=' + rows.length + ' --user=<users.id>.')
    return
  }
  if (rows.length !== EXPECT) {
    console.error('Found ' + rows.length + ', --expect said ' + EXPECT + '. Something changed since the dry run; nothing written.')
    process.exit(1)
  }

  let done = 0
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    const { data: changed, error } = await db.from('customers').update({ cut_off_date: toDay })
      .eq('company_id', COMPANY).eq('cut_off_date', FROM_DAY).in('id', chunk.map((c) => c.id)).select('id')
    if (error) { console.error('Update failed at row ' + i + ': ' + error.message); break }
    const ids = new Set((changed ?? []).map((r) => r.id))
    const logs = chunk.filter((c) => ids.has(c.id)).map((c) => ({
      company_id: COMPANY, user_id: actor.id, customer_id: c.id, correlation_id: RUN_ID, type: 'customer_updated',
      details: name(c) + ' updated | changes=cut_off_date: ' + FROM_DAY + ' → ' + toDay + ' | by=' + actor.email +
        ' | reason=' + REASON + ' | run=' + RUN_ID + ' | via=super_admin:#' + actor.id,
    }))
    if (logs.length) {
      const { error: le } = await db.from('log').insert(logs)
      if (le) console.error('Customers ' + [...ids].join(', ') + ' moved, but their log rows failed: ' + le.message)
    }
    done += ids.size
  }
  console.log('\nMoved ' + done + ' of ' + rows.length + '. run=' + RUN_ID)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
