// Fygaro — the first payment-gateway implementation.
//
// TWO DIFFERENT JWTs, DO NOT CONFLATE THEM (verified against the live docs,
// Jan 2026):
//
//   * The CHECKOUT ?jwt= link parameter — CURRENT and supported. It is the
//     documented way to lock the amount on a Variable-Amount payment button so
//     the customer cannot edit it, and to carry our own reference. NOT the
//     deprecated field. (help.fygaro.com/en-us/article/h78p9y/)
//
//   * The WEBHOOK body `jwt` field — DEPRECATED, "present for backward
//     compatibility only; future API versions will omit it". We never read it:
//     parseWebhook reads `reference`, `amount`, `currency` and `customReference`
//     from the body, none of which is `jwt`. (…/article/1wkui1k/)
//
// Checkout: a single persistent Variable-Amount payment button per company,
// signed per payment into a ?jwt= HS256 token whose payload uses Fygaro's claim
// names — amount and currency as two-decimal STRINGS, and custom_reference
// (snake_case) for our round-tripped reference.
//
// Webhook: Fygaro POSTs on a successful payment. We verify the Fygaro-Signature
// header with the official @fygaro/webhook package (NOT hand-rolled) — HMAC-
// SHA-256 over t + "." + raw body, 5-minute freshness window, a list of secrets
// for rotation, via the options-object constructor (the positional one is
// deprecated). The verified body echoes our reference back as `customReference`
// (camelCase — Fygaro's own spelling on the webhook side, distinct from the
// snake_case claim we sent).

import { createHmac } from 'node:crypto'

import { FygaroWebhookValidator } from '@fygaro/webhook'

import {
  WebhookError,
  type CheckoutRequest,
  type GatewayCredentials,
  type GatewayPayment,
  type PaymentGateway,
  type WebhookRequest,
} from './types'

/** JWT base64url: standard base64, '+/' → '-_', padding stripped. */
function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/** A compact HS256 JWT: the shape Fygaro's payment button accepts. */
function signHs256(payload: Record<string, unknown>, secret: string, kid: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid }))
  const body = base64url(JSON.stringify(payload))
  const signingInput = header + '.' + body
  const signature = base64url(createHmac('sha256', secret).update(signingInput).digest())
  return signingInput + '.' + signature
}

/** `companyId:customerId` — short, URL-safe, well within Fygaro's limit. */
function encodeReference(companyId: number, customerId: number): string {
  return companyId + ':' + customerId
}

function decodeReference(raw: unknown): { companyId: number; customerId: number } | null {
  if (typeof raw !== 'string') return null
  const m = /^(\d+):(\d+)$/.exec(raw.trim())
  if (!m) return null
  return { companyId: Number(m[1]), customerId: Number(m[2]) }
}

export const fygaro: PaymentGateway = {
  provider: 'fygaro',
  label: 'Fygaro',

  createCheckoutUrl(req: CheckoutRequest, creds: GatewayCredentials): string {
    if (!creds.publicKey || !creds.secretKey || !creds.checkoutUrl) {
      throw new Error('Fygaro is not fully configured for this company.')
    }
    const now = Math.floor(Date.now() / 1000)
    const token = signHs256(
      {
        // Strings with two decimals, as Fygaro expects.
        amount: req.amount.toFixed(2),
        currency: req.currency,
        custom_reference: encodeReference(req.companyId, req.customerId),
        nbf: now,
        // The link is minted when the customer presses Pay, so a short life is
        // enough and a stale link cannot be paid against.
        exp: now + 60 * 60,
      },
      creds.secretKey,
      creds.publicKey
    )
    // No return URL is set here: per Fygaro's docs it is a field on the payment
    // BUTTON (set in their dashboard), not a JWT claim or a link parameter —
    // Fygaro redirects to it on success and appends `reference` and
    // `customReference`. The Online Payments settings page shows the exact URL
    // to paste there (the portal's /pay/complete), which serves both the account
    // and reconnection flows off the one button.
    const sep = creds.checkoutUrl.includes('?') ? '&' : '?'
    return creds.checkoutUrl + sep + 'jwt=' + token
  },

  parseWebhook({ rawBody, headers, credentials }: WebhookRequest): GatewayPayment {
    if (!credentials.secretKey) {
      throw new WebhookError('Fygaro secret is not configured for this company.', 503)
    }
    const signature = headers.get('Fygaro-Signature')
    if (!signature) throw new WebhookError('Missing Fygaro-Signature header.', 400)

    // A list of secrets so a rotation window (old + new) still verifies. Only
    // the one secret for now.
    const validator = new FygaroWebhookValidator({ secrets: [credentials.secretKey] })
    if (!validator.verifySignature(signature, rawBody)) {
      throw new WebhookError('Fygaro-Signature did not verify.', 401)
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      throw new WebhookError('Webhook body was not valid JSON.', 400)
    }

    const reference = typeof body.reference === 'string' ? body.reference : null
    const amount = Number(body.amount)
    const currency = typeof body.currency === 'string' ? body.currency : ''
    const ref = decodeReference(body.customReference)

    if (!reference) throw new WebhookError('Webhook carried no reference.', 400)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new WebhookError('Webhook amount was not a positive number.', 400)
    }
    if (!ref) throw new WebhookError('Webhook customReference was missing or malformed.', 400)

    return {
      reference,
      amount,
      currency,
      companyId: ref.companyId,
      customerId: ref.customerId,
    }
  },
}
