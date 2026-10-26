import 'server-only'

import { headers } from 'next/headers'

import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Throttling for the account-details login.
 *
 * WHY IT NEEDS ONE AT ALL. The SMS login is self-limiting: a code has to be
 * received on the number, and lib/portal/otp.ts caps how many are sent. Phone
 * number plus account number has no such ceiling — both are guessable, and
 * account numbers in particular may run in sequence — so without a limit the
 * pair is open to being tried until it lands.
 *
 * IN MEMORY, AND HONESTLY SO. The counter lives in this process, which means a
 * deploy or a restart clears it, and a second app instance would keep its own.
 * That is a real weakness and it is the right trade here: the alternative is a
 * table and a migration for data that is worthless after fifteen minutes. What
 * it defends against is a run of guesses in one sitting, which is the actual
 * threat; it is not a defence against a patient attacker over days, and the
 * log rows below are what would show that.
 *
 * TWO KEYS, BOTH NEEDED. Per address stops one machine working through many
 * accounts. Per phone stops many machines working through one account.
 */

const WINDOW_MS = 15 * 60 * 1000
const MAX_PER_IP = 12
const MAX_PER_PHONE = 8
/** Beyond this many tracked keys the oldest are dropped, so memory is bounded. */
const MAX_KEYS = 5000

type Hits = { times: number[] }
const hits = new Map<string, Hits>()

function recent(key: string, now: number): number[] {
  const entry = hits.get(key)
  if (!entry) return []
  const live = entry.times.filter((t) => now - t < WINDOW_MS)
  if (live.length === 0) {
    hits.delete(key)
    return []
  }
  entry.times = live
  return live
}

function note(key: string, now: number): void {
  const live = recent(key, now)
  live.push(now)
  hits.set(key, { times: live })
  if (hits.size > MAX_KEYS) {
    const oldest = hits.keys().next()
    if (!oldest.done) hits.delete(oldest.value)
  }
}

/** The caller's address, as far behind the reverse proxy as can be trusted. */
export async function callerAddress(): Promise<string> {
  const h = await headers()
  const forwarded = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim()
  return forwarded || h.get('x-real-ip') || 'unknown'
}

/** True when this attempt should be refused before any lookup happens. */
export async function loginThrottled(companyId: number, phone: string): Promise<boolean> {
  const now = Date.now()
  const ip = await callerAddress()
  return (
    recent('ip:' + ip, now).length >= MAX_PER_IP ||
    recent('ph:' + companyId + ':' + phone, now).length >= MAX_PER_PHONE
  )
}

/**
 * Records a failure against both keys and writes an audit line.
 *
 * The log row is best-effort on purpose: a login that cannot be audited is
 * still a login that must be refused, and throwing here would turn a failed
 * sign-in into a 500. The counting above is what actually stops the attempt.
 */
export async function noteLoginFailure(
  companyId: number,
  phone: string,
  reason: string
): Promise<void> {
  const now = Date.now()
  const ip = await callerAddress()
  note('ip:' + ip, now)
  note('ph:' + companyId + ':' + phone, now)

  try {
    await tenantClient().from('log').insert({
      company_id: companyId,
      user_id: null,
      customer_id: null,
      type: 'portal_login_failed',
      details:
        '[portal] Account-details sign-in refused: ' + reason +
        ' | phone=' + phone.slice(0, -4).replace(/\d/g, 'x') + phone.slice(-4) +
        ' | from=' + ip,
    })
  } catch (err) {
    console.error('[portal] could not log a failed sign-in:', (err as Error).message)
  }
}

/** Clears the phone's counter once a sign-in succeeds. */
export function clearPhoneAttempts(companyId: number, phone: string): void {
  hits.delete('ph:' + companyId + ':' + phone)
}
