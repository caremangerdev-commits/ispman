// Fygaro — the first payment-gateway implementation.
//
// Checkout: a single persistent Variable-Amount payment button per company,
// driven per payment by a signed JWT appended as ?jwt=. The JWT locks the
// amount so the customer cannot edit it (the reason we use JWT and not URL
// parameters), and carries our own reference so the webhook knows who paid.
//
// Webhook: Fygaro POSTs on a successful payment. We verify the Fygaro-Signature
// header with the official @fygaro/webhook package — HMAC over t + "." + raw
// body, 5-minute freshness window, a list of secrets for rotation — then read
// `reference` (its immutable transaction id, our idempotency key) and the
// `customReference` we round-tripped. The legacy `jwt` body field is ignored
// (Fygaro is removing it).
//
// Docs: help.fygaro.com/en-us/article/h78p9y/ (checkout + JWT)
//       help.fygaro.com/en-us/article/1wkui1k/ (webhook hook)

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
