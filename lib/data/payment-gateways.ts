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
