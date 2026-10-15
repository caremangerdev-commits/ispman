import { NextResponse, type NextRequest } from 'next/server'

import { toPaymentMethod } from '@/lib/data/checkoff'
import {
  claimGatewayPayment, getGatewayCredentials, markGatewayFailed, markGatewayRecorded,
} from '@/lib/data/payment-gateways'
import { gatewayFor, WebhookError } from '@/lib/payments/gateways'
import { recordServicePayment } from '@/lib/payments/service-payment'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * A payment gateway's server-to-server webhook.
 *
 *   POST /api/payments/{provider}/{company}/webhook
 *
 * NOT A SESSION ROUTE. There is no signed-in user behind a payment callback;
 * the gateway's signature over the raw body is what authenticates it, verified
 * against the company's own secret (lib/payments/gateways). The company is in
 * the URL — not a secret, it only selects which key verifies — and is checked
 * against the signed body so a link or key cannot cross companies.
 *
 * It records the payment through the SAME core the till uses
 * (recordServicePayment), with an "Online payment" actor and no staff user, so
 * an online payment does exactly what Record Payment does: same extension, same
 * receipt, same log. What the money buys is recomputed in the core from the
 * customer's record; the gateway is trusted only for "this much money arrived".
 *
 * REPLIES 2xx WHENEVER THE EVENT IS DURABLY ON RECORD — Fygaro suspends a hook
 * that answers non-2xx. A bad signature or an unparseable body (which a real
 * gateway never sends) is the only non-2xx: those are loud misconfigurations,
 * not deliveries to acknowledge. A delivery that verifies but then fails to
 * record is stored as 'failed' for reprocessing and still answered 200.
 */
export const dynamic = 'force-dynamic'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string; company: string }> }
) {
  const { provider, company: companyParam } = await params
  const companyId = /^\d+$/.test(companyParam) ? Number(companyParam) : null

  const gateway = gatewayFor(provider)
  if (!gateway || companyId === null) {
    return NextResponse.json({ error: 'Unknown payment gateway.' }, { status: 404 })
  }

  const credentials = await getGatewayCredentials(companyId, provider)
  if (!credentials || !credentials.enabled) {
    return NextResponse.json(
      { error: provider + ' is not configured for this company.' },
      { status: 503 }
    )
  }

  // The RAW body, read before any parsing — the signature is computed over it.
  const rawBody = await req.text()

  let event
  try {
    event = gateway.parseWebhook({ rawBody, headers: req.headers, credentials })
  } catch (err) {
    const status = err instanceof WebhookError ? err.status : 400
    const message = err instanceof Error ? err.message : String(err)
    console.error('[' + provider + ' webhook] rejected:', message)
    return NextResponse.json({ error: message }, { status })
  }

  // Defence in depth: the signed body's company must match the URL the hook was
  // configured with. A mismatch means a checkout link or a key crossed tenants.
  if (event.companyId !== companyId) {
    console.error(
      '[' + provider + ' webhook] company mismatch: url=' + companyId + ' body=' + event.companyId
    )
    return NextResponse.json({ error: 'Company mismatch.' }, { status: 400 })
  }

  // Idempotency on the gateway's immutable transaction id.
  const claim = await claimGatewayPayment({
    companyId,
    provider,
    reference: event.reference,
    customReference: event.companyId + ':' + event.customerId,
    amount: event.amount,
    currency: event.currency,
  })
  if (claim.action === 'duplicate') {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  try {
    const db = tenantClient()
    const { data: companyRow } = await db
      .from('companies')
      .select('name')
      .eq('id', companyId)
      .maybeSingle()
    const name = (companyRow as { name: string | null } | null)?.name ?? ''

    const caps = await getSchemaCapabilities()

    const result = await recordServicePayment({
      company: { id: companyId, name },
      caps,
      actor: {
        agent: 'Online payment (' + gateway.label + ')',
        userId: null,
        email: provider,
      },
      customerId: event.customerId,
      paidAmount: event.amount,
      // Paid now. The core stamps the instant in the company's zone, as the till does.
      paymentDate: new Date(),
      method: toPaymentMethod('online'),
      notes: '',
      // Online payments make none of the cashier's short-payment choices and
      // pay no one-off charges or reconnection fee: service only.
      accessDecisionRaw: '',
      chosenDate: null,
      checked: [],
      chargeFee: false,
    })

    if (!result.ok) {
      await markGatewayFailed(claim.rowId, result.error)
      console.error('[' + provider + ' webhook] record failed:', result.error)
      // 200 so the hook is not suspended; the 'failed' row is the reprocess list.
      return NextResponse.json({ ok: false, recorded: false, error: result.error })
    }

    await markGatewayRecorded(claim.rowId, result.paymentId ?? null)
    return NextResponse.json({ ok: true, paymentId: result.paymentId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await markGatewayFailed(claim.rowId, message).catch(() => {})
    console.error('[' + provider + ' webhook] error:', message)
    // Durably stored as 'failed'; 200 keeps the hook alive for later deliveries.
    return NextResponse.json({ ok: false, recorded: false, error: message })
  }
}
