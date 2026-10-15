import 'server-only'

import { createHash, randomInt, timingSafeEqual } from 'node:crypto'

import { getSmsDevice } from '@/lib/data/sms'
import { relayConfigured, sendMessage } from '@/lib/sms/relay'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The SMS login codes (migration 0035, customer_otp).
 *
 * The code is SENT DIRECTLY through the relay, not queued on the sms_outbox the
 * dispatcher paces — a login code the customer is waiting on at a sign-in screen
 * cannot sit behind a 400-message bulk run, so it goes at bypass priority the
 * same way a payment receipt does. The code is stored only as a hash; verifying
 * hashes the submission the same way.
 */

const CODE_TTL_SECONDS = 600 // 10 minutes
const RESEND_COOLDOWN_SECONDS = 30
const MAX_PER_HOUR = 5
const MAX_ATTEMPTS = 5

function hashCode(companyId: number, phone: string, code: string): string {
  return createHash('sha256').update(companyId + ':' + phone + ':' + code).digest('hex')
}

export type OtpResult = { ok: true } | { ok: false; error: string }

/**
 * Issues a code to `e164` (without the plus) and texts it. Rate-limited per
 * (company, phone): a short cooldown between codes and a ceiling per hour, both
 * read off the table so there is one source of truth for how many a number has
 * asked for.
 */
export async function requestOtp(
  companyId: number,
  companyName: string,
  e164: string
): Promise<OtpResult> {
  const db = tenantClient()

  const sinceHour = new Date(Date.now() - 3_600_000).toISOString()
  const { data: recent } = await db
    .from('customer_otp')
    .select('created_at')
    .eq('company_id', companyId)
    .eq('phone', e164)
    .gte('created_at', sinceHour)
    .order('created_at', { ascending: false })
  const rows = (recent ?? []) as { created_at: string }[]

  if (rows.length >= MAX_PER_HOUR) {
    return { ok: false, error: 'Too many codes requested for this number. Try again later.' }
  }
  if (rows[0] && Date.now() - new Date(rows[0].created_at).getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
    return { ok: false, error: 'Please wait a few seconds before asking for another code.' }
  }

  if (!relayConfigured()) {
    return { ok: false, error: 'Text messaging is not available right now. Contact your provider.' }
  }
  const device = await getSmsDevice(companyId)
  if (!device || !device.apiUsername || !device.apiPassword) {
    return { ok: false, error: 'Text messaging is not set up for this provider. Contact them to pay by phone.' }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const { data: inserted, error: insertError } = await db
    .from('customer_otp')
    .insert({
      company_id: companyId,
      phone: e164,
      code_hash: hashCode(companyId, e164, code),
      expires_at: new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString(),
    })
    .select('id')
    .single()

  if (insertError || !inserted) {
    return { ok: false, error: 'Could not start sign-in. Please try again.' }
  }
  const otpId = (inserted as { id: number }).id

  const sent = await sendMessage(
    {
      username: device.apiUsername,
      password: device.apiPassword,
      deviceId: device.deviceId,
      simNumber: device.simNumber,
    },
    {
      // The row id is the relay's idempotency key, as everywhere else.
      id: 'otp:' + otpId,
      text: 'Your ' + companyName + ' code is ' + code + '. It expires in 10 minutes.',
      phone: e164,
      // Bypass the relay's own pacing: a login code must not wait behind bulk.
      priority: 100,
      ttlSeconds: CODE_TTL_SECONDS,
    }
  )

  if (!sent.ok) {
    return { ok: false, error: 'We could not send the code just now. Please try again.' }
  }
  return { ok: true }
}

/**
 * Checks a submitted code against the newest one issued to this (company,
 * phone). Spends it on success so it cannot be replayed; counts a wrong guess
 * and stops honouring the code past the attempt cap.
 */
export async function verifyOtp(companyId: number, e164: string, code: string): Promise<OtpResult> {
  const db = tenantClient()
  const { data } = await db
    .from('customer_otp')
    .select('id, code_hash, expires_at, attempts, consumed_at')
    .eq('company_id', companyId)
    .eq('phone', e164)
    .order('created_at', { ascending: false })
    .limit(1)

  const row = ((data ?? [])[0]) as
    | { id: number; code_hash: string; expires_at: string; attempts: number; consumed_at: string | null }
    | undefined

  if (!row) return { ok: false, error: 'Request a code first.' }
  if (row.consumed_at) return { ok: false, error: 'That code has already been used. Request a new one.' }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'That code has expired. Request a new one.' }
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: 'Too many wrong tries. Request a new code.' }
  }

  const submitted = hashCode(companyId, e164, code.trim())
  const a = Buffer.from(submitted)
  const b = Buffer.from(row.code_hash)
  const matches = a.length === b.length && timingSafeEqual(a, b)

  if (!matches) {
    await db.from('customer_otp').update({ attempts: row.attempts + 1 }).eq('id', row.id)
    return { ok: false, error: 'That code is not right. Try again.' }
  }

  await db.from('customer_otp').update({ consumed_at: new Date().toISOString() }).eq('id', row.id)
  return { ok: true }
}
