#!/usr/bin/env node
/**
 * ONE-OFF: West Central (company 26) checkoff clean-up, 6 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/settle-wcn-checkoffs.mjs                                   dry run
 *   node scripts/settle-wcn-checkoffs.mjs --apply --user=<users.id> --received=<J$>
 *
 * A DRY RUN PRINTS EVERYTHING AND STOPS. --apply needs --user (who is recorded as
 * having checked off Part B and named on every log row) and --received (what
 * Michelle actually handed over for Part B; it is compared to the system total
 * and the difference recorded, exactly as the Checkoff screen does).
 *
 * WHY. When West Central moved across (5 Sep) its legacy payments came in
 * marked checked_off = false, and its legacy handovers came in as
 * checkoff_records — but the legacy system never recorded WHICH payments a
 * handover covered, so nothing linked the two. Every legacy payment therefore
 * still reads as outstanding, and an agent's "since checkoff" total includes
 * money handed over months ago: Michelle Bennett showed J$1,039,550, of which
 * J$716,100 is dated before her last legacy handover.
 *
 * PART A — legacy payments the legacy handovers already covered. Every agent.
 *   A payment qualifies when ALL of:
 *     - it is a migrated legacy payment (notes "Migrated from legacy payment"),
 *       never one taken in ISPMan;
 *     - it is still checked_off = false;
 *     - it belongs to an agent (user_id, else the agent name) who has at least
 *       one MIGRATED handover;
 *     - its payment_date is at or before that agent's latest migrated handover.
 *   It is marked checked off AS OF the earliest migrated handover of that agent
 *   at or after the payment — the handover that would have covered it — with
 *   that handover's checked_off_by (NULL for legacy rows). Times compare
 *   exactly: payment_date and the handover's created_at were both converted
 *   from legacy Jamaica wall-clock by the migration.
 *   NO NEW HANDOVER IS WRITTEN. The money is already in the legacy handovers;
 *   writing another would count it twice in Past handovers.
 *   Agents with legacy payments but NO migrated handover are left alone and
 *   listed: there is no evidence they ever handed over.
 *
 * PART B — Michelle Bennett (#160), on the owner's instruction (6 Oct 2026):
 *   everything still outstanding after Part A and dated up to and including
 *   30 Sep 2026 (business date: paid_on, else payment_date on the Jamaica
 *   clock — the same rule the Checkoff screen's period uses) is checked off now,
 *   as ONE handover: system total, --received, the difference, and the period
 *   in its notes, like a checkoff done on the screen.
 *
 * WHAT --apply WRITES
 *   payments: checked_off, checked_off_at, checked_off_by — guarded by
 *     checked_off = false, so a payment checked off meanwhile is not touched.
 *   checkoff_records: one row, Part B only.
 *   log: one 'checkoff' row per agent in Part A, one for Part B.
 *   correlation_id on every log row = the run id.
 *
 * WHAT IT DOES NOT TOUCH
 *   Amounts, balances, expiries, payments taken in ISPMan (except Michelle's in
 *   Part B), any other company.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='))
  return a ? a.slice(name.length + 3) : null
}
const USER_ID = arg('user') ? Number(arg('user')) : null
const RECEIVED = arg('received') !== null ? Number(arg('received')) : null

if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id>.')
  process.exit(1)
}
if (APPLY && (RECEIVED === null || !Number.isFinite(RECEIVED) || RECEIVED < 0)) {
  console.error('--apply needs --received=<amount Michelle handed over for Part B>, zero or more.')
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

const COMPANY = 26
const ZONE = 'America/Jamaica'
const MICHELLE = 160
// Owner's instruction, 6 Oct 2026: MICHELLE ONLY, and her payments dated 30 Sep
// onward stay outstanding. Jerome Cole's legacy payments (116, J$377,500, also
// covered by his legacy handovers) are deliberately NOT in this run — add his
// id here only if the owner asks for it.
const PART_A_AGENTS = new Set([MICHELLE])
const PART_B_TO = '2026-09-29'
const PART_B_LABEL = 'up to 29 Sep 2026'
const RUN_ID = randomUUID()

const fmt = (n) => 'J$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })
const sum = (a) => Math.round(a.reduce((s, p) => s + Number(p.amount), 0) * 100) / 100
const isLegacyPayment = (p) => String(p.notes ?? '').startsWith('Migrated from legacy payment')
const isLegacyHandover = (h) => String(h.notes ?? '').startsWith('Migrated from legacy checkoff')
const jamaicaDate = (iso) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso))
const businessDate = (p) => p.paid_on ?? jamaicaDate(p.payment_date)

async function all(build) {
  let out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999)
    if (error) throw new Error(error.message)
    out = out.concat(data)
    if (data.length < 1000) break
  }
  return out
}

async function markChecked(ids, at, by) {
  let done = []
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from('payments')
      .update({ checked_off: true, checked_off_at: at, checked_off_by: by })
      .eq('company_id', COMPANY).eq('checked_off', false).in('id', ids.slice(i, i + 200))
      .select('id, amount, customer_id')
    if (error) throw new Error('payments update: ' + error.message)
    done = done.concat(data)
  }
  return done
}

async function main() {
  const users = await all(() => db.from('users').select('id, first_name, last_name, email').eq('company_id', COMPANY).order('id'))
  const nameOf = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
  const byName = new Map(users.map((u) => [nameOf(u).trim().toLowerCase(), u.id]))

  const outstanding = await all(() => db.from('payments')
    .select('id, amount, paid_on, payment_date, notes, user_id, agent, customer_id, payment_kind')
    .eq('company_id', COMPANY).eq('checked_off', false).order('id'))
  const handovers = await all(() => db.from('checkoff_records')
    .select('id, created_at, agent_id, agent_name, checked_off_by, is_all_agents, notes')
    .eq('company_id', COMPANY).order('created_at'))

  // Whose payment is it: user_id, else the free-text agent name matched to a user.
  const ownerOf = (p) => p.user_id ?? byName.get(String(p.agent ?? '').trim().toLowerCase()) ?? null
  const handoverOwner = (h) => h.agent_id ?? byName.get(String(h.agent_name ?? '').trim().toLowerCase()) ?? null

  // Legacy handovers per agent, oldest first.
  const legacyHandovers = new Map()
  for (const h of handovers) {
    if (!isLegacyHandover(h) || h.is_all_agents) continue
    const who = handoverOwner(h)
    if (who === null) continue
    legacyHandovers.set(who, [...(legacyHandovers.get(who) ?? []), h])
  }

  // ---------------------------------------------------------------- Part A
  const partA = new Map() // handover id -> { handover, payments[] }
  const noHandover = new Map() // owner label -> payments[]
  const outOfScope = new Map() // agent id -> payments[] a legacy handover covers, not in this run
  for (const p of outstanding) {
    if (!isLegacyPayment(p)) continue
    const who = ownerOf(p)
    if (who !== null && !PART_A_AGENTS.has(who)) {
      const covered = (legacyHandovers.get(who) ?? []).some(
        (h) => new Date(p.payment_date).getTime() <= new Date(h.created_at).getTime())
      if (covered) outOfScope.set(who, [...(outOfScope.get(who) ?? []), p])
      continue
    }
    const list = who === null ? [] : legacyHandovers.get(who) ?? []
    const covering = list.find((h) => new Date(p.payment_date).getTime() <= new Date(h.created_at).getTime())
    if (covering) {
      const g = partA.get(covering.id) ?? { handover: covering, owner: who, payments: [] }
      g.payments.push(p)
      partA.set(covering.id, g)
    } else if (list.length === 0) {
      const label = who === null ? (p.agent ?? 'unknown') + ' (no user)' : '#' + who + ' ' + (users.find((u) => u.id === who) ? nameOf(users.find((u) => u.id === who)) : '')
      noHandover.set(label, [...(noHandover.get(label) ?? []), p])
    }
  }
  const aIds = new Set([...partA.values()].flatMap((g) => g.payments.map((p) => p.id)))

  // ---------------------------------------------------------------- Part B
  const partB = outstanding.filter((p) =>
    !aIds.has(p.id) && ownerOf(p) === MICHELLE && businessDate(p) <= PART_B_TO)
  const michelleLeft = outstanding.filter((p) =>
    !aIds.has(p.id) && ownerOf(p) === MICHELLE && businessDate(p) > PART_B_TO)

  // ---------------------------------------------------------------- report
  console.log('West Central checkoff clean-up   run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN') + '\n')
  console.log('PART A — legacy payments already covered by a legacy handover (no new handover written)')
  const perAgentA = new Map()
  for (const g of partA.values()) {
    const k = g.owner
    perAgentA.set(k, [...(perAgentA.get(k) ?? []), g])
  }
  for (const [who, groups] of perAgentA) {
    const u = users.find((x) => x.id === who)
    const ps = groups.flatMap((g) => g.payments)
    console.log('  #' + who + ' ' + (u ? nameOf(u) : '?') + ': ' + ps.length + ' payments, ' + fmt(sum(ps)))
    for (const g of groups) {
      console.log('      handover #' + g.handover.id + ' ' + g.handover.created_at.slice(0, 16) + 'Z  <- ' +
        g.payments.length + ' payments, ' + fmt(sum(g.payments)))
    }
  }
  const allA = [...partA.values()].flatMap((g) => g.payments)
  console.log('  PART A TOTAL: ' + allA.length + ' payments, ' + fmt(sum(allA)) + '\n')

  console.log('  Left alone — covered by a legacy handover but NOT in this run (owner: Michelle only):')
  for (const [who, ps] of outOfScope) {
    const u = users.find((x) => x.id === who)
    console.log('      #' + who + ' ' + (u ? nameOf(u) : '?') + ': ' + ps.length + ' payments, ' + fmt(sum(ps)))
  }
  if (noHandover.size > 0) {
    console.log('  Left alone — in scope but no legacy handover on record:')
    for (const [label, ps] of noHandover) console.log('      ' + label + ': ' + ps.length + ' payments, ' + fmt(sum(ps)))
  }
  console.log('')

  console.log('PART B — Michelle Bennett, still outstanding after Part A, dated ' + PART_B_LABEL)
  const bDates = partB.map(businessDate).sort()
  console.log('  ' + partB.length + ' payments, ' + fmt(sum(partB)) + ', ' +
    new Set(partB.map((p) => p.customer_id)).size + ' customers' +
    (bDates.length ? ', dated ' + bDates[0] + ' to ' + bDates[bDates.length - 1] : ''))
  console.log('    of which taken in ISPMan: ' + partB.filter((p) => !isLegacyPayment(p)).length +
    ' (' + fmt(sum(partB.filter((p) => !isLegacyPayment(p)))) + '), legacy till: ' +
    partB.filter(isLegacyPayment).length + ' (' + fmt(sum(partB.filter(isLegacyPayment))) + ')')
  const leftDates = michelleLeft.map(businessDate).sort()
  console.log('  Michelle stays outstanding after this: ' + michelleLeft.length + ' payments, ' + fmt(sum(michelleLeft)) +
    (leftDates.length ? ' (dated ' + leftDates[0] + ' to ' + leftDates[leftDates.length - 1] + ')' : ''))
  if (RECEIVED !== null) {
    console.log('  --received ' + fmt(RECEIVED) + ' against system ' + fmt(sum(partB)) +
      ' -> difference ' + fmt(RECEIVED - sum(partB)))
  }

  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> --received=<J$>.')
    return
  }

  // ---------------------------------------------------------------- apply
  const { data: actor, error: ae } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
  if (ae || !actor) { console.error('No users row ' + USER_ID); process.exit(1) }

  let aDone = 0
  for (const [who, groups] of perAgentA) {
    const u = users.find((x) => x.id === who)
    let n = 0
    let total = 0
    for (const g of groups) {
      const done = await markChecked(g.payments.map((p) => p.id), g.handover.created_at, g.handover.checked_off_by ?? null)
      n += done.length
      total += sum(done)
    }
    aDone += n
    await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, correlation_id: RUN_ID, type: 'checkoff',
      details:
        'Legacy handovers applied | agent=' + (u ? nameOf(u) : '#' + who) +
        ' | payments=' + n + ' | total=' + fmt(total) +
        ' | handovers=' + groups.map((g) => '#' + g.handover.id).join(',') +
        ' | no new handover: already counted in the legacy handovers' +
        ' | by=' + actor.email + ' | run=' + RUN_ID,
    })
    console.log('Part A #' + who + ': ' + n + ' payments checked off (' + fmt(total) + ')')
  }

  const now = new Date().toISOString()
  const bDone = await markChecked(partB.map((p) => p.id), now, actor.id)
  const bTotal = sum(bDone)
  if (bDone.length > 0) {
    const discrepancy = Math.round((RECEIVED - bTotal) * 100) / 100
    const { error: re } = await db.from('checkoff_records').insert({
      company_id: COMPANY,
      agent_id: MICHELLE,
      agent_name: 'Michelle Bennett',
      checked_off_by: actor.id,
      system_total: bTotal,
      amount_received: RECEIVED,
      discrepancy,
      customers_count: new Set(bDone.map((p) => p.customer_id ?? 'anon-' + p.id)).size,
      is_all_agents: false,
      notes: 'Period: ' + PART_B_LABEL + ' · recorded on the owner\'s instruction, 6 Oct 2026',
    })
    if (re) console.log('Part B: payments checked off but the handover row failed: ' + re.message)
    await db.from('log').insert({
      company_id: COMPANY, user_id: actor.id, correlation_id: RUN_ID, type: 'checkoff',
      details:
        'Checkoff | agent=Michelle Bennett | period=' + PART_B_LABEL +
        ' | system_total=' + fmt(bTotal) + ' | received=' + fmt(RECEIVED) +
        ' | discrepancy=' + fmt(discrepancy) + ' | payments=' + bDone.length +
        ' | by=' + actor.email + ' | run=' + RUN_ID,
    })
  }
  console.log('Part B: ' + bDone.length + ' payments checked off (' + fmt(bTotal) + ')')
  console.log('\nDone. Part A ' + aDone + ' of ' + allA.length + ', Part B ' + bDone.length + ' of ' + partB.length + '. run=' + RUN_ID)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
