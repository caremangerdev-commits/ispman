// Reading and writing a company's payment-gateway credentials and the webhook
// idempotency ledger (migration 0034).
//
// Everything here is company-scoped and goes through the service-role reader,
// the same as the rest of lib/data. A missing table (0034 not yet applied)
// reads as "no gateway configured" rather than throwing, so the app behaves
// exactly as it did before the migration — the house pattern.

import { gatewayFor } from '@/lib/payments/gateways'
import { type GatewayCredentials } from '@/lib/payments/gateways/types'
import { tenantClient } from '@/lib/supabase/tenant'

/** PostgREST codes for "table does not exist". */
const MISSING_TABLE = new Set(['PGRST205', '42P01'])

function toCredentials(row: {
  provider: string
  public_key: string | null
  secret_key: string | null
  checkout_url: string | null
  enabled: boolean | null
}): GatewayCredentials {
  return {
    provider: row.provider,
    publicKey: row.public_key,
    secretKey: row.secret_key,
    checkoutUrl: row.checkout_url,
    enabled: row.enabled ?? false,
  }
}

/**
 * A company's credentials for one named gateway, or null when the row is absent
 * or the table does not exist yet.
 */
export async function getGatewayCredentials(
  companyId: number,
  provider: string
): Promise<GatewayCredentials | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('payment_gateways')
    .select('provider, public_key, secret_key, checkout_url, enabled')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .maybeSingle()

  if (error) {
    if (MISSING_TABLE.has(error.code ?? '')) return null
    throw new Error('Could not read payment gateway credentials: ' + error.message)
  }
  if (!data) return null
  return toCredentials(data as Parameters<typeof toCredentials>[0])
}

/** What the settings page may show about a saved gateway. The secret is NEVER
 *  among these — only whether one is on record. */
export type GatewaySettingsView = {
  publicKey: string | null
  checkoutUrl: string | null
  enabled: boolean
  /** True when a secret is stored. The value itself is never read out. */
  secretSet: boolean
}

/** A gateway's non-secret settings for the UI, or null when none is saved. */
export async function getGatewaySettings(
  companyId: number,
  provider: string
): Promise<GatewaySettingsView | null> {
  const creds = await getGatewayCredentials(companyId, provider)
  if (!creds) return null
  return {
    publicKey: creds.publicKey,
    checkoutUrl: creds.checkoutUrl,
    enabled: creds.enabled,
    secretSet: Boolean(creds.secretKey && creds.secretKey.trim()),
  }
}

/**
 * Writes a company's credentials for one gateway, upserting the single
 * (company, provider) row.
 *
 * THE SECRET IS WRITE-ONLY. `secretKey` undefined means "leave the stored
 * secret as it is" — the form posts a blank field when the operator is not
 * replacing it, so a save that only flips `enabled` or edits the public key
 * cannot wipe the secret. A non-empty value replaces it. The secret is never
 * read back out to any page (see getGatewaySettings).
 *
 * A gateway cannot be enabled without a secret on record — the secret both
 * signs the checkout link and verifies the webhook, so enabling without one
 * would mint unverifiable links.
 */
export async function saveGatewayCredentials(input: {
  companyId: number
  provider: string
  publicKey: string | null
  checkoutUrl: string | null
  /** undefined = keep the stored secret; a value = replace it. */
  secretKey?: string
  enabled: boolean
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = tenantClient()

  const { data: existing, error: readError } = await db
    .from('payment_gateways')
    .select('secret_key')
    .eq('company_id', input.companyId)
    .eq('provider', input.provider)
    .maybeSingle()
  if (readError && !MISSING_TABLE.has(readError.code ?? '')) {
    return { ok: false, error: 'Could not read the gateway: ' + readError.message }
  }
  if (readError) {
    return { ok: false, error: 'Online payments are not set up on this system yet. Apply migration 0034.' }
  }

  const priorSecret = (existing as { secret_key: string | null } | null)?.secret_key ?? null
  const nextSecret = input.secretKey && input.secretKey.trim() ? input.secretKey.trim() : priorSecret

  if (input.enabled && !(nextSecret && nextSecret.trim())) {
    return { ok: false, error: 'Add the Fygaro secret before turning online payments on.' }
  }

  const row = {
    company_id: input.companyId,
    provider: input.provider,
    public_key: input.publicKey,
    checkout_url: input.checkoutUrl,
    secret_key: nextSecret,
    enabled: input.enabled,
    updated_at: new Date().toISOString(),
  }

  const { error } = existing
    ? await db
        .from('payment_gateways')
        .update(row)
        .eq('company_id', input.companyId)
        .eq('provider', input.provider)
    : await db.from('payment_gateways').insert(row)
  if (error) return { ok: false, error: 'Could not save the gateway: ' + error.message }

  return { ok: true }
}

export type GatewayPaymentStatus = 'received' | 'recorded' | 'failed'

/**
 * The status of a webhook-recorded payment by its provider reference, or null
 * when no webhook has landed for it yet.
 *
 * For the return-from-checkout page: Fygaro redirects the customer back the
 * instant they pay, which is usually BEFORE the server-to-server webhook has
 * been processed — so `null` here means "still confirming", not "failed".
 */
export async function getGatewayPaymentStatus(
  companyId: number,
  provider: string,
  reference: string
): Promise<GatewayPaymentStatus | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('gateway_payments')
    .select('status')
    .eq('company_id', companyId)
    .eq('provider', provider)
    .eq('reference', reference)
    .maybeSingle()

  if (error) {
    if (MISSING_TABLE.has(error.code ?? '')) return null
    throw new Error('Could not read gateway payment status: ' + error.message)
  }
  const row = data as { status: string } | null
  return (row?.status as GatewayPaymentStatus) ?? null
}

/** The company's one enabled gateway, or null. First come, first served. */
export async function getEnabledGateway(
  companyId: number
): Promise<GatewayCredentials | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('payment_gateways')
    .select('provider, public_key, secret_key, checkout_url, enabled')
    .eq('company_id', companyId)
    .eq('enabled', true)
    .limit(1)

  if (error) {
    if (MISSING_TABLE.has(error.code ?? '')) return null
    throw new Error('Could not read payment gateways: ' + error.message)
  }
  const rows = (data ?? []) as Parameters<typeof toCredentials>[0][]
  return rows.length ? toCredentials(rows[0]) : null
}

/**
 * Builds a hosted-checkout URL for the company's enabled gateway. The portal's
 * Pay button calls this; it never names a provider.
 */
export async function createGatewayCheckout(input: {
  companyId: number
  customerId: number
  amount: number
  currency?: string
}): Promise<{ ok: true; url: string; provider: string } | { ok: false; error: string }> {
  const creds = await getEnabledGateway(input.companyId)
  if (!creds) return { ok: false, error: 'No online payment method is set up.' }

  const gateway = gatewayFor(creds.provider)
  if (!gateway) return { ok: false, error: 'Unknown payment gateway: ' + creds.provider }

  try {
    const url = gateway.createCheckoutUrl(
      {
        companyId: input.companyId,
        customerId: input.customerId,
        amount: input.amount,
        currency: input.currency ?? 'JMD',
      },
      creds
    )
    return { ok: true, url, provider: creds.provider }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export type GatewayClaim = { action: 'record'; rowId: number } | { action: 'duplicate' }

/**
 * Claims a webhook for recording, idempotent on (company, provider, reference).
 *
 * 'record'    — this delivery owns the payment and should record it now (the
 *               row was just inserted, or a previously 'failed' row reclaimed).
 * 'duplicate' — already recorded, or a concurrent delivery is recording it;
 *               acknowledge without doing it twice.
 */
export async function claimGatewayPayment(input: {
  companyId: number
  provider: string
  reference: string
  customReference: string | null
  amount: number
  currency: string
}): Promise<GatewayClaim> {
  const db = tenantClient()
  const { data, error } = await db
    .from('gateway_payments')
    .insert({
      company_id: input.companyId,
      provider: input.provider,
      reference: input.reference,
      custom_reference: input.customReference,
      amount: input.amount,
      currency: input.currency,
      status: 'received',
    })
    .select('id')
    .single()

  if (!error && data) return { action: 'record', rowId: (data as { id: number }).id }

  // 23505 = unique violation on (company, provider, reference): already seen.
  if (error?.code === '23505') {
    const { data: existing } = await db
      .from('gateway_payments')
      .select('id, status')
      .eq('company_id', input.companyId)
      .eq('provider', input.provider)
      .eq('reference', input.reference)
      .maybeSingle()
    const row = existing as { id: number; status: string } | null
    if (!row) return { action: 'duplicate' }
    // A row stuck at 'failed' is reclaimed so this delivery retries it; one
    // already 'recorded' or still 'received' is left alone.
    if (row.status === 'failed') {
      await db.from('gateway_payments').update({ status: 'received', error: null }).eq('id', row.id)
      return { action: 'record', rowId: row.id }
    }
    return { action: 'duplicate' }
  }

  throw new Error('Could not claim gateway payment: ' + (error?.message ?? 'unknown error'))
}

export async function markGatewayRecorded(rowId: number, paymentId: number | null): Promise<void> {
  const db = tenantClient()
  await db
    .from('gateway_payments')
    .update({
      status: 'recorded',
      payment_id: paymentId,
      recorded_at: new Date().toISOString(),
      error: null,
    })
    .eq('id', rowId)
}

export async function markGatewayFailed(rowId: number, message: string): Promise<void> {
  const db = tenantClient()
  await db
    .from('gateway_payments')
    .update({ status: 'failed', error: message.slice(0, 500) })
    .eq('id', rowId)
}

/**
 * Raises a staff notification (the navbar bell) when an online payment arrives
 * but the customer is left unsettled — the money was taken but either could not
 * be recorded, or was recorded without extending access. A customer who paid
 * and stayed cut off has to reach a person, not sit in a table.
 *
 * Best-effort: the gateway_payments row and the audit log are the durable
 * record; this is the human-facing nudge on top, so a failure to raise it is
 * logged and swallowed rather than allowed to fail the webhook.
 */
export async function alertUnsettledOnlinePayment(input: {
  companyId: number
  customerId: number
  amount: number
  reference: string
  /** A full sentence describing what went wrong. */
  reason: string
}): Promise<void> {
  const db = tenantClient()
  try {
    const { data } = await db
      .from('customers')
      .select('first_name, last_name, phone, email')
      .eq('company_id', input.companyId)
      .eq('id', input.customerId)
      .maybeSingle()
    const c = data as {
      first_name: string | null
      last_name: string | null
      phone: string | null
      email: string | null
    } | null
    const name = c
      ? [c.first_name, c.last_name].filter(Boolean).join(' ') || 'A customer'
      : 'Customer #' + input.customerId

    const message =
      name + ' paid J$' + input.amount.toFixed(2) + ' online. ' + input.reason +
      ' They may be cut off — contact them. (ref ' + input.reference + ')'

    // notifications_queue is the in-app staff bell — nothing is ever delivered
    // from it (migration 0021). Shape verified against the live table: company_id,
    // type, channel, recipient and message are NOT NULL; channel defaults to 'sms'
    // and recipient has no default, so both are set here to real values; status
    // 'pending' is what the bell counts as unread; id and created_at default.
    const { error } = await db.from('notifications_queue').insert({
      company_id: input.companyId,
      customer_id: input.customerId,
      type: 'payment',
      channel: c?.email ? 'email' : 'sms',
      recipient: c?.email || c?.phone || name,
      message,
      status: 'pending',
    })
    if (error) console.error('[online payment alert] could not raise the bell:', error.message)
  } catch (err) {
    console.error('[online payment alert] could not raise the bell:', (err as Error).message)
  }
}
