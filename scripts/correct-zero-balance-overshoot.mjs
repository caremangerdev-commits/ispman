#!/usr/bin/env node
/**
 * ONE-OFF: pull back the expiries that zero-balance prepayments overshot.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/correct-zero-balance-overshoot.mjs                 dry run (default)
 *   node scripts/correct-zero-balance-overshoot.mjs --company=33    one company
 *   node scripts/correct-zero-balance-overshoot.mjs --payment=13592,13593
 *   node scripts/correct-zero-balance-overshoot.mjs --apply --user=<users.id> [--reason="..."]
 *
 * A DRY RUN PRINTS AND STOPS. It is the default; nothing is written unless
 * --apply is given, and --apply needs --user so every row written is
 * attributed to a real manager account, the way the Correct Expiry modal is.
 *
 * WHAT WENT WRONG
 *   lib/billing.ts#monthsCovered always counted one "renewal" month and then
 *   counted every whole monthly charge of credit on top. With a balance the
 *   money settled the balance and the credit was zero. With NO balance the
 *   whole payment was credit, so one month's money was priced as a renewal
 *   AND a month of prepayment: a customer holding 1 Oct who handed over one
 *   charge was written 1 Dec instead of 1 Nov. Fixed in the same commit as
 *   this script; this is the clean-up for the rows written before the fix.
 *
 * WHAT IT ASSERTS, AND HOW EACH ROW EARNS ITS CORRECTION
 *   The candidates are the service payments ISPMan priced on a zero carried
 *   balance whose months_paid came out at 2 or more. For each one:
 *
 *   1. The radius_extend log row written alongside the payment is found, and
 *      its new_expiry must equal the payment's access_granted_until. If the
 *      log and the table disagree the row is REFUSED: the history is not
 *      clean enough to correct from.
 *   2. The written expiry is REPRODUCED from the log's old_expiry: the same
 *      anchor rule and cut-off walk as lib/billing.ts#serviceExpiry, for
 *      months_paid hops, plus the company grace days. If that does not land
 *      on the written date, the inputs are not what this script thinks they
 *      are, and the row is REFUSED. Only then is the corrected date taken as
 *      the same walk one hop shorter.
 *   3. radcheck is read live. If its Expiration is not the value the log says
 *      was written, someone or something has moved it since — a manual
 *      extension, a correction, a reconnect — and the row is SKIPPED and
 *      reported, because the right answer for that customer is no longer a
 *      one-hop pull-back.
 *   4. A later service payment for the same customer also SKIPS the row: it
 *      re-anchored on the overshot date and needs its own look.
 *
 * WHAT --apply WRITES, per READY row
 *   - radcheck: one UPDATE of the Expiration value for that username, guarded
 *     by the value it is replacing so a concurrent change cannot be
 *     overwritten. No row is inserted or deleted; no other attribute is
 *     touched. This is what lib/radius-db.ts#correctExpiryInRadius does.
 *   - payments: months_paid, access_granted_until and service_active_until
 *     restated to what the money actually bought, guarded by the values
 *     being replaced.
 *   - log: a network_expiry_corrected row in the exact shape the Correct
 *     Expiry modal writes (lib/radius/operations.ts#networkEventDetails), so
 *     Network History shows it as a correction, and a payment_updated row
 *     stating the three restated columns.
 *
 * WHAT IT DOES NOT TOUCH
 *   account_credit. The money side was right all along: the credit was
 *   created and the bill run draws it down. Only the expiry was wrong.
 *
 * CUSTOMER-FACING. Every one of these customers holds a receipt printing the
 * overshot date, and expiry warnings key off the expiry. Whether to honour the
 * printed date is decided per company before this is applied, which is what
 * --company is for.
 */

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
const ONLY_COMPANY = arg('company') ? Number(arg('company')) : null
const ONLY_PAYMENTS = arg('payment') ? arg('payment').split(',').map(Number) : null
const USER_ID = arg('user') ? Number(arg('user')) : null
const REASON =
  arg('reason') ??
  'Zero-balance prepayment was priced as a renewal plus a month of prepayment ' +
  '(lib/billing.ts#monthsCovered); expiry pulled back one cut-off month to what the money bought'

if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log rows name who corrected these.')
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

// --- date arithmetic: the same rules as lib/expiry.ts and lib/billing.ts ------
//
// Reimplemented because a .mjs script cannot import the TypeScript, and
// VALIDATED ON EVERY ROW: step 2 above reproduces the written expiry with these
// functions before trusting them to produce the corrected one.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')

const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate()
const midnight = (y, m, d) => new Date(y, m, d, 0, 0, 0, 0)
const startOfDay = (d) => midnight(d.getFullYear(), d.getMonth(), d.getDate())
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())

/** "08 Nov 2026 00:00" — lib/radius/format.ts#formatRadiusExpiration. */
function formatRadius(d) {
  return pad(d.getDate()) + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** lib/radius/format.ts#parseRadiusExpiration. "none" and blanks give null. */
function parseRadius(value) {
  if (!value || value === 'none') return null
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase())
  if (mi === -1) return null
  const d = new Date(Number(m[3]), mi, Number(m[1]), Number(m[4] ?? 0), Number(m[5] ?? 0))
  return Number.isFinite(d.getTime()) ? d : null
}

/** lib/expiry.ts#nextCutOff. */
function nextCutOff(anchor, cutOffDay) {
  if (!cutOffDay || !Number.isFinite(cutOffDay) || cutOffDay < 1) return null
  const wanted = Math.floor(cutOffDay)
  const anchorDay = anchor.getDate()
  let month = anchor.getMonth() + (anchorDay < wanted ? 0 : 1)
  const year = anchor.getFullYear()
  let candidate = midnight(year, month, Math.min(wanted, daysInMonth(year, month)))
  if (candidate.getTime() <= midnight(year, anchor.getMonth(), anchorDay).getTime()) {
    month += 1
    candidate = midnight(year, month, Math.min(wanted, daysInMonth(year, month)))
  }
  return candidate
}

/** lib/expiry.ts#advanceCutOff. */
function advanceCutOff(anchor, cutOffDay, months) {
  let current = anchor
  for (let i = 0; i < Math.max(1, Math.floor(months)); i++) {
    const next = nextCutOff(current, cutOffDay)
    if (!next) return null
    current = next
  }
  return current
}

/** lib/expiry.ts#addMonths — the fallback when no cut-off day is recorded. */
function addMonths(from, months) {
  const count = Math.max(1, Math.floor(months))
  const year = from.getFullYear()
  const month = from.getMonth() + count
  const day = Math.min(from.getDate(), daysInMonth(year, month))
  return midnight(year, month, day)
}

/** lib/billing.ts#serviceExpiry. */
function serviceExpiry({ cutOffDay, gracePeriodDays, currentExpiry, from, months }) {
  const grace = Math.max(0, Math.floor(gracePeriodDays || 0))
  const today = startOfDay(from)
  const anchor =
    currentExpiry && startOfDay(currentExpiry).getTime() > today.getTime()
      ? startOfDay(currentExpiry)
      : today
  const next = advanceCutOff(anchor, cutOffDay, months) ?? addMonths(anchor, months)
  next.setDate(next.getDate() + grace)
  return next
}

/** lib/radius/format.ts#usernameKey — the radcheck username for an identity. */
function usernameKey(value) {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return ''
  const looksLikeMac = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/.test(trimmed)
  return looksLikeMac ? trimmed.toUpperCase().replace(/-/g, ':') : trimmed
}

/**
 * One `| name=value` field out of a log body. The pipe is escaped with TWO
 * backslashes on purpose — see lib/log-detail.ts#logField for what a single
 * one did to production. This file must be edited with a tool that does not
 * pass it through a shell.
 */
function logField(body, name) {
  const m = new RegExp('\\| ' + name + '=([^|]+)').exec(body)
  return m && m[1] !== undefined ? m[1].trim() : null
}

/** Free text going into a `| name=value` field must not contain the separator. */
const safeValue = (s) => String(s ?? '').replace(/\|/g, '/').trim()

// --- data ---------------------------------------------------------------------

async function all(table, cols, shape) {
  const out = []
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(cols).order('id').range(from, from + 999)
    if (shape) q = shape(q)
    const { data, error } = await q
    if (error) throw new Error(table + ': ' + error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}
const n = (v) => Number(v ?? 0)

async function main() {
  const my = await mysql.createConnection({
    host: need('RADIUS_DB_HOST'), user: need('RADIUS_DB_USER'),
    password: need('RADIUS_DB_PASSWORD'), database: need('RADIUS_DB_NAME'),
    port: Number(process.env.RADIUS_DB_PORT ?? 3306),
  })

  const companies = Object.fromEntries(
    (await all('companies', 'id, name')).map((c) => [c.id, c.name])
  )
  const grace = {}
  for (const s of await all('settings', 'id, company_id, grace_period_days')) {
    grace[s.company_id] = n(s.grace_period_days)
  }

  let actor = null
  if (APPLY) {
    const { data: u, error } = await db
      .from('users').select('id, email, first_name, last_name').eq('id', USER_ID).maybeSingle()
    if (error || !u) { console.error('No users row with id ' + USER_ID); process.exit(1) }
    actor = u
  }

  // --- 0. the candidates: what the analysis counted -----------------------
  const rows = (await all(
    'payments',
    'id, company_id, customer_id, amount, months_paid, payment_date, paid_on, created_at, ' +
      'carried_balance_before, amount_due, service_charge, access_granted_until, ' +
      'service_active_until, payment_kind',
    (q) => q.not('carried_balance_before', 'is', null).eq('carried_balance_before', 0)
  )).filter((r) =>
    (r.payment_kind ?? 'service') === 'service' &&
    n(r.amount) > 0 &&
    (r.amount_due == null || n(r.amount_due) <= 0) &&
    n(r.months_paid) >= 2 &&
    (ONLY_COMPANY === null || r.company_id === ONLY_COMPANY) &&
    (ONLY_PAYMENTS === null || ONLY_PAYMENTS.includes(r.id))
  )

  const customerIds = [...new Set(rows.map((r) => r.customer_id))]
  const customers = {}
  if (customerIds.length > 0) {
    const { data, error } = await db
      .from('customers')
      .select('id, first_name, last_name, cut_off_date, customer_type, pppoe_username, mac_address')
      .in('id', customerIds)
    if (error) throw new Error('customers: ' + error.message)
    for (const c of data) customers[c.id] = c
  }
  const laterPayments = customerIds.length > 0
    ? await all('payments', 'id, customer_id, payment_kind',
        (q) => q.in('customer_id', customerIds))
    : []
  const extendLogs = customerIds.length > 0
    ? await all('log', 'id, customer_id, details, created_at',
        (q) => q.in('customer_id', customerIds).eq('type', 'radius_extend'))
    : []

  // --- 1..4. earn the correction, row by row --------------------------------
  const plan = []
  for (const r of rows) {
    const c = customers[r.customer_id]
    const name = c ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '#' + r.customer_id
    const item = {
      payment: r.id, customer: name, customer_id: r.customer_id,
      company: companies[r.company_id] ?? '#' + r.company_id,
      date: r.paid_on ?? String(r.payment_date).slice(0, 10),
      amount: n(r.amount), months: r.months_paid, written: r.access_granted_until,
      identity: null, radcheck_now: null, corrected: null, status: null, why: null,
      _row: r, _logOld: null, _logNew: null,
    }
    plan.push(item)

    const refuse = (why) => { item.status = 'REFUSED'; item.why = why }
    const skip = (why) => { item.status = 'SKIPPED'; item.why = why }

    if (!c) { refuse('customer row not found'); continue }
    const identity = usernameKey(c.customer_type === 'pppoe' ? c.pppoe_username : c.mac_address)
    item.identity = identity
    if (!identity) { refuse('customer has no network identity'); continue }

    // 1. the log row written with this payment
    const at = new Date(r.created_at).getTime()
    const logs = extendLogs.filter((l) =>
      l.customer_id === r.customer_id &&
      Math.abs(new Date(l.created_at).getTime() - at) < 60_000 &&
      /^RADIUS extend \|/.test(l.details ?? '')
    )
    if (logs.length !== 1) { refuse(logs.length + ' radius_extend log rows within 60s of the payment'); continue }
    const body = logs[0].details
    const logIdentity = usernameKey(logField(body, 'identity'))
    const logOld = logField(body, 'old_expiry')
    const logNew = logField(body, 'new_expiry')
    if (logIdentity !== identity) { refuse('log identity ' + logIdentity + ' is not the customer\'s ' + identity); continue }
    if (!logNew || !parseRadius(logNew)) { refuse('log new_expiry unreadable: ' + logNew); continue }
    if (ymd(parseRadius(logNew)) !== r.access_granted_until) {
      refuse('log wrote ' + logNew + ' but the table says ' + r.access_granted_until); continue
    }
    if (/SKIPPED/.test(body)) { refuse('log says the network write was skipped'); continue }
    item._logOld = logOld
    item._logNew = logNew

    // 2. reproduce the written expiry, then take the walk one hop shorter
    const paidOn = item.date
    const pm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(paidOn)
    if (!pm) { refuse('payment date unreadable: ' + paidOn); continue }
    const from = midnight(Number(pm[1]), Number(pm[2]) - 1, Number(pm[3]))
    const inputs = {
      cutOffDay: c.cut_off_date ?? null,
      gracePeriodDays: grace[r.company_id] ?? 0,
      currentExpiry: parseRadius(logOld),
      from,
    }
    const reproduced = serviceExpiry({ ...inputs, months: n(r.months_paid) })
    if (ymd(reproduced) !== r.access_granted_until) {
      refuse('cannot reproduce written expiry from log old_expiry ' + logOld +
        ' (got ' + ymd(reproduced) + ', cut-off ' + inputs.cutOffDay + ', grace ' + inputs.gracePeriodDays + ')')
      continue
    }
    const corrected = serviceExpiry({ ...inputs, months: n(r.months_paid) - 1 })
    item.corrected = ymd(corrected)
    item._correctedRadius = formatRadius(corrected)

    // 3. has radcheck moved since?
    const [rc] = await my.execute(
      'SELECT username, value FROM radcheck WHERE (username = ? OR TRIM(username) = ?) AND attribute = ?',
      [identity, identity, 'Expiration']
    )
    const clean = rc.filter((x) => x.username === identity)
    const live = (clean.length > 0 ? clean : rc)[0]?.value ?? null
    item.radcheck_now = live
    if (live === null) { skip('no Expiration row in radcheck'); continue }
    if (live.trim() !== logNew.trim()) { skip('radcheck has moved since: now ' + live); continue }

    // 4. a later service payment re-anchored on the overshot date
    const later = laterPayments.filter((p) =>
      p.customer_id === r.customer_id && p.id > r.id && (p.payment_kind ?? 'service') === 'service')
    if (later.length > 0) { skip('later service payment(s) #' + later.map((p) => p.id).join(', #')); continue }

    item.status = 'READY'
  }

  // --- report ------------------------------------------------------------------
  console.log((APPLY ? 'APPLY' : 'DRY RUN') + ' — ' + plan.length + ' candidate payment(s)' +
    (ONLY_COMPANY !== null ? ' in company ' + ONLY_COMPANY : '') + '\n')
  console.table(plan.map((p) => ({
    payment: p.payment, customer: p.customer, company: p.company, date: p.date,
    amount: p.amount, months: p.months, written: p.written, identity: p.identity,
    radcheck_now: p.radcheck_now, corrected: p.corrected, status: p.status, why: p.why,
  })))

  const ready = plan.filter((p) => p.status === 'READY')
  const tally = (s) => plan.filter((p) => p.status === s).length
  console.log('\nREADY ' + ready.length + '   SKIPPED ' + tally('SKIPPED') + '   REFUSED ' + tally('REFUSED'))
  for (const p of plan.filter((p) => p.status !== 'READY')) {
    console.log('  ' + p.status + ' #' + p.payment + ' ' + p.customer + ' (' + p.company + '): ' + p.why)
  }

  if (!APPLY) {
    console.log('\nDry run: nothing was written. Re-run with --apply --user=<users.id> to correct the READY rows.')
    await my.end()
    return
  }

  // --- apply ---------------------------------------------------------------------
  const actorLabel = actor.email
  let done = 0
  for (const p of ready) {
    const r = p._row
    const tag = '#' + p.payment + ' ' + p.customer + ': '

    // radcheck first, guarded by the value being replaced.
    const [res] = await my.execute(
      'UPDATE radcheck SET value = ? WHERE username = ? AND attribute = ? AND value = ?',
      [p._correctedRadius, p.identity, 'Expiration', p._logNew]
    )
    if ((res.affectedRows ?? 0) !== 1) {
      console.log(tag + 'radcheck update matched ' + (res.affectedRows ?? 0) + ' rows; nothing else written for this customer.')
      continue
    }

    // Then the payment row, guarded the same way.
    const { error: payErr, count } = await db
      .from('payments')
      .update({
        months_paid: n(r.months_paid) - 1,
        access_granted_until: p.corrected,
        service_active_until: p.corrected,
      }, { count: 'exact' })
      .eq('id', r.id)
      .eq('company_id', r.company_id)
      .eq('access_granted_until', r.access_granted_until)
      .eq('months_paid', r.months_paid)
    if (payErr || (count ?? 0) !== 1) {
      console.log(tag + 'radcheck corrected to ' + p._correctedRadius + ' but the payment row did not update' +
        (payErr ? ': ' + payErr.message : ' (matched ' + count + ')') + '. Restate it by hand.')
    }

    // The correction, in the shape the Correct Expiry modal writes.
    const oldIso = ymd(parseRadius(p._logNew))
    const network = {
      company_id: r.company_id, user_id: actor.id, customer_id: r.customer_id,
      type: 'network_expiry_corrected',
      details:
        'Expiry corrected for ' + p.identity + '. Expiry ' + oldIso + ' -> ' + p.corrected +
        '. By ' + actorLabel + ' | reason=' + safeValue(REASON) + ' | payment_id=' + r.id,
    }
    // The restatement of what the payment bought.
    const payment = {
      company_id: r.company_id, user_id: actor.id, customer_id: r.customer_id,
      type: 'payment_updated',
      details:
        'Payment #' + r.id + ' restated | payment_id=' + r.id +
        ' | customer_id=' + r.customer_id + ' | customer=' + safeValue(p.customer) +
        ' | months_paid=' + r.months_paid + '->' + (n(r.months_paid) - 1) +
        ' | access_granted_until=' + r.access_granted_until + '->' + p.corrected +
        ' | service_active_until=' + (r.service_active_until ?? 'none') + '->' + p.corrected +
        ' | by=' + actorLabel + ' | reason=' + safeValue(REASON),
    }
    const { error: logErr } = await db.from('log').insert([network, payment])
    if (logErr) console.log(tag + 'corrected, but the log rows failed: ' + logErr.message)

    done += 1
    console.log(tag + p._logNew + ' -> ' + p._correctedRadius + ', months_paid ' + r.months_paid + ' -> ' + (n(r.months_paid) - 1))
  }

  console.log('\nCorrected ' + done + ' of ' + ready.length + ' READY row(s).')
  await my.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
