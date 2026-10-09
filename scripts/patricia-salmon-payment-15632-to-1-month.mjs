#!/usr/bin/env node
/**
 * ONE-OFF: Patricia Salmon's payment #15632 (West Central, customer #1949)
 * recorded as 1 month, not 6. Owner, 9 Oct 2026.
 *
 * DISPOSABLE. Delete once it has run. Nothing in the app imports it.
 *
 *   node scripts/patricia-salmon-payment-15632-to-1-month.mjs                        dry run (default)
 *   node scripts/patricia-salmon-payment-15632-to-1-month.mjs --apply --user=<users.id>
 *
 * The payment was typed as J$35,000 and bought six months; the amount was
 * corrected to J$3,500 on 6 Oct but months_paid stayed 6. Her expiry was
 * already set to 7 Dec 2026 (run 10f97fd1), so this corrects the RECORD only:
 * months_paid 6 -> 1, and the two dates the payment says it granted
 * (access_granted_until, service_active_until — the receipt prints the
 * second) 7 May 2027 -> 7 Dec 2026, as the edit fix now does.
 *
 * NOT TOUCHED: the amount, the balance (J$3,500 for West Central to collect),
 * credit, RADIUS.
 *
 * GUARDED: written only if the row still reads months_paid 6 and amount 3500.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import process from 'node:process'

import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const userArg = process.argv.find((x) => x.startsWith('--user='))
const USER_ID = userArg ? Number(userArg.slice('--user='.length)) : null
if (APPLY && !USER_ID) {
  console.error('--apply needs --user=<users.id> so the log row names who changed this.')
  process.exit(1)
}

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const eq = line.indexOf('=')
  if (eq > 0) {
    const key = line.slice(0, eq).trim()
    if (!process.env[key]) process.env[key] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const COMPANY = 26
const CUSTOMER = 1949
const PAYMENT = 15632
const RUN_ID = randomUUID()
const TO_DAY = '2026-12-07'

const { data: p, error } = await db.from('payments')
  .select('id, company_id, customer_id, amount, months_paid, access_granted_until, service_active_until, payment_date')
  .eq('company_id', COMPANY).eq('id', PAYMENT).maybeSingle()
if (error || !p) { console.error('Payment #' + PAYMENT + ' not found' + (error ? ': ' + error.message : '')); process.exit(1) }

console.log('Payment #' + PAYMENT + '  customer #' + p.customer_id + '  run=' + RUN_ID + (APPLY ? '   APPLY' : '   DRY RUN'))
console.log('  now:   amount ' + p.amount + '  months_paid ' + p.months_paid +
  '  access_granted_until ' + p.access_granted_until + '  service_active_until ' + p.service_active_until)
if (p.customer_id !== CUSTOMER || Number(p.months_paid) !== 6 || Number(p.amount) !== 3500) {
  console.log('SKIPPED: expected customer #' + CUSTOMER + ', months_paid 6, amount 3500. Nothing written.')
  process.exit(0)
}
console.log('  READY: months_paid 6 -> 1, access_granted_until and service_active_until -> ' + TO_DAY)
if (!APPLY) { console.log('Dry run: nothing was written.'); process.exit(0) }

const { data: u, error: ue } = await db.from('users').select('id, email').eq('id', USER_ID).maybeSingle()
if (ue || !u) { console.error('No users row ' + USER_ID); process.exit(1) }

const { data: upd, error: e2 } = await db.from('payments')
  .update({ months_paid: 1, access_granted_until: TO_DAY, service_active_until: TO_DAY })
  .eq('company_id', COMPANY).eq('id', PAYMENT).eq('months_paid', 6).eq('amount', 3500)
  .select('id')
if (e2 || !upd?.length) { console.log('Not written' + (e2 ? ': ' + e2.message : ' (changed meanwhile)')); process.exit(1) }

const { error: le } = await db.from('log').insert({
  company_id: COMPANY, user_id: u.id, customer_id: CUSTOMER, correlation_id: RUN_ID,
  type: 'payment_updated',
  details:
    'Payment #' + PAYMENT + ' edited | customer=Patricia Salmon #' + CUSTOMER +
    ' | amount_removed=0.00 | amount_old=3500.00 | amount_new=3500.00' +
    ' | months_old=6 | months_new=1' +
    ' | access_granted_until_old=' + p.access_granted_until + ' | access_granted_until_new=' + TO_DAY +
    ' | expiry_action=none (expiry already 07 Dec 2026 13:00, run 10f97fd1)' +
    ' | reason=paid one month; the J$35,000 was a typo (owner, 9 Oct 2026)' +
    ' | by=' + u.email + ' | run=' + RUN_ID,
})
console.log(le ? 'Written, but the log row failed: ' + le.message : 'Written. Logged. run=' + RUN_ID)
process.exit(0)
