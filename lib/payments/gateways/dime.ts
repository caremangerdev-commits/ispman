// Dime Pay — the second payment-gateway implementation.
//
// Docs: https://docs.dimepay.net (API v2). Verified against them, Nov 2026.
//
// NOT TO BE CONFUSED with dimepayments.com, an unrelated company with a
// similar name and a different API. This is dimepay.net, whose API lives on
// api.dimepay.app and whose checkout lives on pay.dimepay.app.
//
// HOW IT DIFFERS FROM FYGARO, which is why the interface changed:
//
//   * CHECKOUT NEEDS A SERVER CALL. Fygaro has one standing payment button per
//     company and we append a signed ?jwt= to it. Dime has no standing URL: we
//     POST /payments/hosted-page, it returns an order `token`, and the payer
//     goes to {payHost}/e-order/{token}. Hence the async interface.
//
//   * TWO SECRETS, NOT ONE. publicKey is the client key (X-Dime-Client);
//     secretKey is the API secret (Authorization: Bearer) and authorises the
//     order call; webhookSecret is the webhook endpoint's signing_secret and is
//     the ONLY thing that verifies an inbound delivery. Dime can rotate the
//     webhook secret without touching the API key. Migration 0048 adds the
//     column; without it Dime cannot be enabled.
//
//   * THE WEBHOOK IS A LIFECYCLE FEED, NOT A SUCCESS PING. One endpoint
//     receives payment.authorised, .succeeded, .failed, .voided, .abandoned and
//     .settled. We record on `payment.succeeded` with the transaction COMPLETE,
//     and return null for everything else so the route answers 2xx and writes
//     nothing. Returning null rather than throwing matters: a throw is a
//     non-2xx, and Dime retries a non-2xx up to 9 times.
//
//   * NO TIMESTAMP IN THE SIGNATURE. Fygaro signs t + "." + body and we enforce
//     a 5-minute window. Dime signs the raw body alone, so there is no replay
//     window to enforce here. The guard is downstream instead: idempotency on
//     the transaction token in gateway_payments (migration 0034), which is
//     where a redelivery is already discarded. event_id is identical on
//     redelivery and could dedupe too, but the transaction token is what the
//     ledger is keyed on and one key is better than two.
//
// AMOUNTS ARE SENT AND READ AS MAJOR UNITS (JMD dollars, two decimals), the
// same as CheckoutRequest.amount and as the rest of this app. Dime's field
// descriptions give `bridge.fee` as major units and state currency minimums in
// whole dollars ("200 JMD"), and its own examples use plain numbers, so major
// units is the reading. THIS IS THE ONE THING TO CONFIRM IN SANDBOX BEFORE
// GOING LIVE — if Dime actually wanted minor units, every charge is out by
// 100x in the customer's favour and every webhook reads 100x high.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  WebhookError,
  type CheckoutRequest,
  type GatewayCredentials,
  type GatewayPayment,
  type PaymentGateway,
  type WebhookRequest,
} from './types'

/**
 * The only two API hosts Dime has. An operator may put the sandbox one in the
 * gateway's checkout_url to test; blank means production.
 *
 * AN ALLOWLIST, NOT A FREE-TEXT URL, on purpose. This value decides which host
 * receives an order containing a customer's payment, so a typo or a pasted
 * wrong URL must not be able to send one somewhere else. The matching pay host
 * is derived from it and never pasted.
 */
const HOSTS = {
  'https://api.dimepay.app/dapi/v2': 'https://pay.dimepay.app',
  'https://sandbox.api.dimepay.app/dapi/v2': 'https://pay.sandbox.dimepay.app',
} as const

const LIVE_API = 'https://api.dimepay.app/dapi/v2'

/** The API base and matching pay host for a company, from its optional override. */
function hostsFor(creds: GatewayCredentials): { api: string; pay: string } {
  const override = (creds.checkoutUrl ?? '').trim().replace(/\/+$/, '')
  const api = override && override in HOSTS ? (override as keyof typeof HOSTS) : LIVE_API
  if (override && !(override in HOSTS)) {
    throw new Error(
      'Dime: the API base URL must be left blank for live, or set to ' +
        'https://sandbox.api.dimepay.app/dapi/v2 for sandbox.'
    )
  }
  return { api, pay: HOSTS[api] }
}

/** The metadata key our own reference travels under. */
const REF_KEY = 'ispman_ref'

/**
 * The metadata key the agreed surcharge travels under, when the customer has
 * agreed to carry a share of the card fee. Absent on almost every payment.
 */
const SURCHARGE_KEY = 'ispman_surcharge'

/** `companyId:customerId` — what comes back to tell us who paid. */
function encodeReference(companyId: number, customerId: number): string {
  return companyId + ':' + customerId
}

function decodeReference(raw: unknown): { companyId: number; customerId: number } | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d+):(\d+)$/.exec(raw.trim())
  if (!m) return null
  return { companyId: Number(m[1]), customerId: Number(m[2]) }
}

/** A plain object, or null. Narrows the webhook body without trusting it. */
function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Constant-time hex digest comparison. Unequal lengths are simply unequal. */
function hexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length === 0 || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Two decimals, as a number — never a float with a tail of noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export const dime: PaymentGateway = {
  provider: 'dime',
  label: 'Dime Pay',

  async createCheckoutUrl(req: CheckoutRequest, creds: GatewayCredentials): Promise<string> {
    if (!creds.publicKey || !creds.secretKey) {
      throw new Error('Dime is not fully configured for this company.')
    }
    // Dime rejects an order with no payer email. The orchestrator always has
    // one to give (the customer's, or the company's stand-in), so an empty one
    // here is a bug upstream rather than something to paper over with a
    // fabricated address.
    const email = str(req.email)
    if (!email) {
      throw new Error('Dime needs a payer email address, and none was supplied.')
    }

    const { api, pay } = hostsFor(creds)
    const amount = round2(req.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Dime: the payment amount must be greater than zero.')
    }

    const body: Record<string, unknown> = {
      // Our order id. Dime requires a UUID, returns it as order.origin_id, and
      // explicitly does NOT reject a repeat — so it buys us no idempotency and
      // a fresh one per attempt is correct.
      id: randomUUID(),
      currency: req.currency,
      subtotal: amount,
      total: amount,
      email,
      // Stored by Dime for reconciliation. NOT readable back out of the API, so
      // it is a convenience for their dashboard only — never the round-trip.
      referenceTransactionId: encodeReference(req.companyId, req.customerId),
      description: 'Internet service',
      // THE ROUND-TRIP. Dime does not read metadata; it hands it back under
      // order.metadata.details on the webhook, which is where parseWebhook
      // looks for it. Nothing else in the payload identifies our customer.
      metadata: { [REF_KEY]: encodeReference(req.companyId, req.customerId) },
    }
    // Only present when the customer agreed to carry a share of the card fee,
    // so the webhook can credit the bill rather than the whole charge.
    const surcharge = Number(req.surcharge)
    if (Number.isFinite(surcharge) && surcharge > 0) {
      ;(body.metadata as Record<string, unknown>)[SURCHARGE_KEY] = round2(surcharge).toFixed(2)
      body.description = 'Internet service (includes card fee)'
    }
    if (req.returnUrl) body.redirectUrl = req.returnUrl
    if (req.name) body.billingPerson = { name: req.name, email }

    // The payer is waiting on this call behind the portal's Pay button, so it
    // gets a short leash rather than the platform default.
    let res: Response
    try {
      res = await fetch(api + '/payments/hosted-page', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Dime-Client': creds.publicKey,
          Authorization: 'Bearer ' + creds.secretKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
        cache: 'no-store',
      })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error('Dime could not be reached to start the payment: ' + why)
    }

    const text = await res.text()
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = obj(JSON.parse(text))
    } catch {
      parsed = null
    }

    if (!res.ok) {
      // Dime's errors are { error: { type, code, message, param } }. Surface
      // its own message — it names the offending field — and never the keys.
      const error = obj(parsed?.error)
      const message = str(error?.message) ?? 'HTTP ' + res.status
      const param = str(error?.param)
      throw new Error('Dime refused the payment: ' + message + (param ? ' (' + param + ')' : ''))
    }

    const token = str(parsed?.token)
    if (!token) {
      throw new Error('Dime accepted the order but returned no token to pay against.')
    }

    // NOT parsed.checkout_url: when we send a checkoutUrl of our own Dime
    // echoes it straight back there, so it is our cart URL and not a payment
    // page. The documented way to collect the money is the order token.
    return pay + '/e-order/' + encodeURIComponent(token)
  },

  parseWebhook({ rawBody, headers, credentials }: WebhookRequest): GatewayPayment | null {
    if (!credentials.webhookSecret) {
      throw new WebhookError(
        'Dime webhook secret is not configured for this company (migration 0048).',
        503
      )
    }

    const header = headers.get('X-Dime-Signature')
    if (!header) throw new WebhookError('Missing X-Dime-Signature header.', 400)

    // "v1=<hex>". The version is also its own header; trust the one we parse.
    const m = /^v1=([0-9a-f]+)$/i.exec(header.trim())
    if (!m) throw new WebhookError('X-Dime-Signature was not in the v1=<hex> form.', 400)

    const expected = createHmac('sha256', credentials.webhookSecret).update(rawBody).digest('hex')
    if (!hexEquals(m[1].toLowerCase(), expected)) {
      throw new WebhookError('X-Dime-Signature did not verify.', 401)
    }

    let body: Record<string, unknown> | null
    try {
      body = obj(JSON.parse(rawBody))
    } catch {
      throw new WebhookError('Webhook body was not valid JSON.', 400)
    }
    if (!body) throw new WebhookError('Webhook body was not a JSON object.', 400)

    // Only a captured payment is money we can record. Everything else on this
    // endpoint — authorised, failed, voided, abandoned, settled, and any event
    // type Dime adds later — is acknowledged and dropped.
    //
    // THE EVENT TYPE IS THE SIGNAL, NOT THE TRANSACTION'S STATUS. Verified
    // against a live sandbox payment, 13 Nov 2026: payment.succeeded was
    // delivered at 00:26:17 and the transaction only reached COMPLETE at
    // 00:26:30, when payment.settled fired. Gating on COMPLETE here therefore
    // dropped a real payment on the floor — answered 200, recorded nothing.
    // Dime sends succeeded when the money is taken; settled is its own later
    // event about the payout, which we ignore.
    //
    // LOGGED, NOT SILENT. A delivery we drop looks identical to one we never
    // received: 200, no row, no trace. One line per ignored event is the
    // difference between "working" and "quietly losing money", and it costs a
    // log line per lifecycle event.
    const eventType = str(body.event_type)
    if (eventType !== 'payment.succeeded') {
      console.log(
        '[dime webhook] ignored ' + (eventType ?? 'an event with no event_type') +
          ' (' + (str(body.event_id) ?? 'no id') + '); body keys: ' + Object.keys(body).join(',')
      )
      return null
    }

    const txn = obj(obj(body.payload)?.transaction)
    if (!txn) throw new WebhookError('payment.succeeded carried no transaction.', 400)

    // A payment that failed or was reversed never reaches us as `succeeded`,
    // but if Dime ever sends one, these are not money in hand.
    const status = str(txn.status)
    if (status === 'FAILED' || status === 'VOID' || status === 'ABANDONED') {
      console.log('[dime webhook] ignored a succeeded event whose transaction read ' + status)
      return null
    }

    // The immutable transaction token is the idempotency key the ledger is
    // built on. resource_id carries the same value; prefer the transaction's own.
    const reference = str(txn.token) ?? str(body.resource_id)
    if (!reference) throw new WebhookError('Webhook carried no transaction token.', 400)

    // WHAT THE CUSTOMER PAID — `amount`, never `final_amount`.
    //
    // final_amount is the NET figure after Dime's fee, not a corrected total.
    // The sandbox payment of 13 Nov 2026 read amount 1900, fees 126.71,
    // final_amount 1773.29. Crediting final_amount would have short-changed the
    // customer by the processor's fee on every single payment and cut their
    // service off early. The fee is Dime's business with the operator; what the
    // customer handed over is what buys them service.
    const amount = round2(Number(txn.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new WebhookError('Webhook amount was not a positive number.', 400)
    }

    const currency = str(txn.currency) ?? ''

    // Our reference comes back under the order's metadata. Dime spells the
    // order two ways depending on which view you are looking at — `order` in
    // the webhook payload, `entity` on GET /transactions — and nests what we
    // sent under `metadata.details`. Check every shape rather than trust one:
    // losing this means a paid customer we cannot identify, which is worse than
    // any amount of defensive code.
    const payload = obj(body.payload)
    const containers = [obj(txn.order), obj(txn.entity), obj(payload?.order), txn, payload]
    let ref: { companyId: number; customerId: number } | null = null
    let surcharge = 0
    for (const c of containers) {
      if (!c) continue
      const meta = obj(c.metadata)
      for (const source of [obj(meta?.details), meta, obj(c.details)]) {
        ref = decodeReference(source?.[REF_KEY])
        if (ref) {
          const s = Number(source?.[SURCHARGE_KEY])
          if (Number.isFinite(s) && s > 0) surcharge = round2(s)
          break
        }
      }
      if (ref) break
    }
    if (!ref) {
      // Loud, and non-2xx: Dime retries, and the delivery shows as failed on
      // their side instead of looking like a payment we chose to ignore.
      console.error(
        '[dime webhook] no ' + REF_KEY + ' in event ' + str(body.event_id) +
          ' for transaction ' + reference + '; payload keys: ' +
          Object.keys(txn).join(',')
      )
      throw new WebhookError('Webhook order metadata carried no usable ' + REF_KEY + '.', 400)
    }

    // Dime's own fee on this transaction, for reconciliation. Its figure, not
    // ours — and never used to decide what the customer is credited.
    const reported = Number(txn.fees)
    const fee = Number.isFinite(reported) && reported >= 0 ? round2(reported) : null

    return {
      reference,
      amount,
      currency,
      companyId: ref.companyId,
      customerId: ref.customerId,
      surcharge,
      fee,
    }
  },
}
