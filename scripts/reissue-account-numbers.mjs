#!/usr/bin/env node
/**
 * ONE-OFF: reissue every account number under the 10001-based format, and give
 * every company a counter.
 *
 * DISPOSABLE. Delete once it has run everywhere. Nothing in the app imports it.
 *
 *   node scripts/reissue-account-numbers.mjs [--dry-run]
 *
 * WHY
 *   Migration 0020 issued zero-padded six-digit numbers from 1, so a company's
 *   first customer was "000001" — which reads as a placeholder rather than an
 *   issued number, and has to be said as "zero zero zero zero zero one" over a
 *   phone. The format is now prefix + a plain five-digit number counted from
 *   10001. None of the old numbers has been printed on paper, so they are
 *   reissued rather than kept.
 *
 *   0020 also seeded a counter only for the companies that existed the day it
 *   ran, and nothing created one afterwards — so Vernon Communications was
 *   migrated with 1,276 customers and no account numbers at all, silently,
 *   because the allocator returns null when there is no counter to take from.
 *
 * SAFE TO RE-RUN. Numbers are derived from position, not from what a row
 * already holds, so a second run over the same data produces the same answer.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

/** Mirrors lib/account-number.ts. Change both together. */
const ACCOUNT_SEQ_BASE = 10000
const PREFIX_MIN = 2
const PREFIX_MAX = 3

const DRY_RUN = process.argv.includes('--dry-run')

/** How many updates are in flight at once. */
const CONCURRENCY = 12

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

const normalisePrefix = (raw) => {
  const p = String(raw ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, PREFIX_MAX)
  return p.length >= PREFIX_MIN ? p : null
}

const formatAccountNumber = (seq, prefix) => {
  const digits = String(Math.max(ACCOUNT_SEQ_BASE + 1, Math.floor(seq)))
  const p = normalisePrefix(prefix)
  return p ? p + '-' + digits : digits
}

const db = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Every row of a table for one company, paged past PostgREST's 1000 ceiling. */
async function allFor(table, cols, companyId) {
  let out = []
  let from = 0
  for (;;) {
    const { data, error } = await db
      .from(table).select(cols).eq('company_id', companyId)
      .order('id', { ascending: true }).range(from, from + 499)
    if (error) throw new Error(table + ': ' + error.message)
    out = out.concat(data)
    if (data.length < 500) break
    from += 500
  }
  return out
}

async function main() {
  console.log('\n' + '='.repeat(72))
  console.log('REISSUE ACCOUNT NUMBERS' + (DRY_RUN ? '  [DRY RUN — nothing written]' : '  [LIVE]'))
  console.log('='.repeat(72))

  const { data: companies, error: coError } = await db
    .from('companies').select('id, name').order('id')
  if (coError) throw new Error('companies: ' + coError.message)

  const { data: counters } = await db.from('account_counters').select('company_id, next_value')
  const hasCounter = new Set((counters ?? []).map((c) => c.company_id))

  let totalChanged = 0
  let totalUnchanged = 0

  for (const co of companies) {
    const { data: settings } = await db
      .from('settings').select('account_number_prefix').eq('company_id', co.id).maybeSingle()
    const prefix = normalisePrefix(settings?.account_number_prefix)

    const customers = await allFor('customers', 'id, account_number', co.id)

    // ORDERED BY id, the same rule 0020's backfill used and the same rule the
    // migration script uses: it is the only key every row has, it never ties,
    // and it approximates the order customers were created.
    const plan = customers.map((c, i) => ({
      id: c.id,
      from: c.account_number,
      to: formatAccountNumber(ACCOUNT_SEQ_BASE + 1 + i, prefix),
    }))
    const changed = plan.filter((p) => p.from !== p.to)
    const nextValue = ACCOUNT_SEQ_BASE + 1 + customers.length

    console.log('\n' + '-'.repeat(72))
    console.log(co.id + '  ' + co.name)
    console.log('-'.repeat(72))
    console.log('  customers        : ' + customers.length)
    console.log('  prefix           : ' + (prefix ?? '(none)'))
    console.log('  counter row      : ' + (hasCounter.has(co.id) ? 'exists' : 'MISSING — will be created'))
    console.log('  numbers to change: ' + changed.length + ' of ' + plan.length)
    if (plan.length > 0) {
      console.log('  first            : ' + JSON.stringify(plan[0].from) + ' -> ' + plan[0].to)
      console.log('  last             : ' +
        JSON.stringify(plan[plan.length - 1].from) + ' -> ' + plan[plan.length - 1].to)
    }
    console.log('  counter seeded to: ' + nextValue)

    totalChanged += changed.length
    totalUnchanged += plan.length - changed.length

    if (DRY_RUN) continue

    // The counter first. If this fails the company keeps its old numbers rather
    // than ending up renumbered with no way to issue the next one.
    const { error: ctrError } = hasCounter.has(co.id)
      ? await db.from('account_counters')
        .update({ next_value: nextValue, updated_at: new Date().toISOString() })
        .eq('company_id', co.id)
      : await db.from('account_counters')
        .insert({ company_id: co.id, next_value: nextValue })

    if (ctrError) {
      console.log('  !! counter failed: ' + ctrError.message + ' — company skipped, numbers unchanged')
      continue
    }

    // Row by row, because every row gets a different value. Bounded concurrency
    // rather than one at a time; the unique index is on (company_id,
    // account_number) and the old and new formats cannot collide with each
    // other, so the order updates land in does not matter.
    let done = 0
    let failed = 0
    for (let i = 0; i < changed.length; i += CONCURRENCY) {
      const slice = changed.slice(i, i + CONCURRENCY)
      const results = await Promise.all(slice.map((p) =>
        db.from('customers').update({ account_number: p.to }).eq('id', p.id)
      ))
      for (const r of results) {
        if (r.error) { failed += 1; console.log('    !! ' + r.error.message) }
        else done += 1
      }
    }
    console.log('  updated          : ' + done + (failed ? '  FAILED ' + failed : ''))
  }

  console.log('\n' + '='.repeat(72))
  console.log('  mode           : ' + (DRY_RUN ? 'DRY RUN (nothing written)' : 'LIVE'))
  console.log('  numbers changed: ' + totalChanged + (DRY_RUN ? ' (would be)' : ''))
  console.log('  already correct: ' + totalUnchanged)
  console.log('='.repeat(72) + '\n')
}

main().catch((err) => {
  console.error('\nFAILED: ' + err.message)
  process.exit(1)
})
