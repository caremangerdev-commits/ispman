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
    if (str(body.event_type) !== 'payment.succeeded') return null

    const txn = obj(obj(body.payload)?.transaction)
    if (!txn) throw new WebhookError('payment.succeeded carried no transaction.', 400)

    // A succeeded event whose transaction is not COMPLETE is a stage we do not
    // act on, not a malformed delivery.
    if (str(txn.status) !== 'COMPLETE') return null

    // The immutable transaction token is the idempotency key the ledger is
    // built on. resource_id carries the same value; prefer the transaction's own.
    const reference = str(txn.token) ?? str(body.resource_id)
    if (!reference) throw new WebhookError('Webhook carried no transaction token.', 400)

    // final_amount is what was actually taken once Dime has settled the figure;
    // amount is what was asked for. Prefer the former when present.
    const raw = typeof txn.final_amount === 'number' ? txn.final_amount : Number(txn.amount)
    const amount = round2(raw)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new WebhookError('Webhook amount was not a positive number.', 400)
    }

    const currency = str(txn.currency) ?? ''

    // Our reference comes back under the order's metadata, in the `details`
    // object — Dime's own spelling for the metadata a merchant sent.
    const order = obj(txn.order)
    const details = obj(obj(order?.metadata)?.details)
    const ref = decodeReference(details?.[REF_KEY])
    if (!ref) {
      throw new WebhookError(
        'Webhook order metadata carried no usable ' + REF_KEY + '.',
        400
      )
    }

    return {
      reference,
      amount,
      currency,
      companyId: ref.companyId,
      customerId: ref.customerId,
    }
  },
}
