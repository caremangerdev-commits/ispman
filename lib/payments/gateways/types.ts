// The payment-gateway interface.
//
// A gateway turns one customer payment into (a) a hosted-checkout URL to send
// them to, and (b) a verified, normalised payment pulled back out of the
// provider's webhook. Everything company-specific — keys, the checkout URL —
// arrives as GatewayCredentials, read per company from payment_gateways
// (lib/data/payment-gateways.ts), the same shape as the SMS device creds.
//
// Fygaro is the first implementation; a second provider is a new file that
// implements this interface plus a row with a different `provider`. The webhook
// route and the checkout orchestrator know only this interface.

export type GatewayCredentials = {
  provider: string
  /** Non-secret key id (Fygaro: the API public key / JWT `kid`). */
  publicKey: string | null
  /** The secret that signs the checkout link and verifies the webhook. */
  secretKey: string | null
  /** The hosted checkout URL a customer is sent to. */
  checkoutUrl: string | null
  enabled: boolean
}

export type CheckoutRequest = {
  companyId: number
  customerId: number
  /** Amount in major units (e.g. JMD dollars), two decimals. */
  amount: number
  /** ISO 4217, e.g. 'JMD'. */
  currency: string
}

/** A verified payment, normalised out of a provider's webhook. */
export type GatewayPayment = {
  /** The provider's immutable transaction id — the idempotency key. */
  reference: string
  amount: number
  currency: string
  /** Round-tripped through the checkout link, so we know who paid. */
  companyId: number
  customerId: number
}

export type WebhookRequest = {
  /** The request body EXACTLY as received — the signature is computed over it. */
  rawBody: string
  headers: Headers
  credentials: GatewayCredentials
}

export interface PaymentGateway {
  /** Stable id: stored in payment_gateways.provider and used in the webhook URL. */
  readonly provider: string
  /** Human label for the payment row's agent and the receipt, e.g. 'Fygaro'. */
  readonly label: string
  /**
   * Builds the hosted-checkout URL a customer is sent to for one payment.
   * Throws when the credentials are incomplete.
   */
  createCheckoutUrl(req: CheckoutRequest, creds: GatewayCredentials): string
  /**
   * Verifies a webhook's signature and parses it into a normalised payment.
   * Throws WebhookError on a bad signature or an unparseable body; the caller
   * turns that into a non-2xx and records nothing.
   */
  parseWebhook(req: WebhookRequest): GatewayPayment
}

/** A rejection carrying the HTTP status the webhook route should answer with. */
export class WebhookError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'WebhookError'
    this.status = status
  }
}
