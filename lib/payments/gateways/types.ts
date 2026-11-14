// The payment-gateway interface.
//
// A gateway turns one customer payment into (a) a hosted-checkout URL to send
// them to, and (b) a verified, normalised payment pulled back out of the
// provider's webhook. Everything company-specific — keys, the checkout URL —
// arrives as GatewayCredentials, read per company from payment_gateways
// (lib/data/payment-gateways.ts), the same shape as the SMS device creds.
//
// Fygaro was the first implementation; Dime is the second. A third provider is
// a new file plus one line in index.ts. The webhook route and the checkout
// orchestrator know only this interface.
//
// TWO THINGS THE SECOND PROVIDER CHANGED, both visible here:
//
//   * createCheckoutUrl IS ASYNC. Fygaro mints its URL locally — sign a JWT,
//     append it to a standing button URL — so it needed no I/O. Dime has to
//     create the order server-side first (POST /payments/hosted-page) and build
//     the URL from the token it returns. Returning a promise is the only shape
//     both fit.
//
//   * parseWebhook MAY RETURN NULL. Fygaro POSTs only on a successful payment,
//     so every delivery was a payment to record. Dime POSTs the whole lifecycle
//     — authorised, succeeded, failed, voided, abandoned, settled — on the same
//     endpoint. null means "this verified, and there is nothing to record":
//     the route answers 2xx and writes nothing. Throwing would answer non-2xx
//     and earn a retry of an event we deliberately ignored.

export type GatewayCredentials = {
  provider: string
  /** Non-secret key id (Fygaro: the JWT `kid`. Dime: the X-Dime-Client key). */
  publicKey: string | null
  /**
   * Fygaro: the one HMAC secret, signing the checkout link AND verifying the
   * webhook. Dime: the API secret only (Authorization: Bearer) — its webhook is
   * verified with webhookSecret.
   */
  secretKey: string | null
  /**
   * A separate webhook signing secret, for providers that have one. Dime: the
   * endpoint's signing_secret. Null for Fygaro, which has no second secret, and
   * null before migration 0048 is applied.
   */
  webhookSecret: string | null
  /**
   * The standing hosted checkout URL, for providers that have a per-company
   * one. Fygaro: the payment button. Dime: unused — minted per payment.
   */
  checkoutUrl: string | null
  enabled: boolean
  /**
   * What THIS gateway charges THIS company, from its own agreement (migration
   * 0049). Percentage and a fixed amount per payment: Dime's published online
   * rate is 3.7% + JMD 45.53.
   *
   * ON THE GATEWAY, NOT THE COMPANY, because a rate belongs to an agreement —
   * Fygaro's terms are not Dime's, and a company that switches provider must
   * not keep charging against the old one's numbers.
   *
   * Null means not on record, which means no surcharge can be worked out and
   * the operator absorbs the fee. The platform never guesses a rate and
   * charges a customer against the guess.
   */
  feeRate: number | null
  feeFixed: number | null
}

/**
 * The fee terms one payment was quoted under. A snapshot, not a pointer: the
 * company's current rate is no use for explaining a payment from March.
 */
export type CardFeeTerms = {
  /** Percentage, as a percentage: 3.7 means 3.7%. */
  rate: number
  /** Fixed amount per transaction, in the company's currency. */
  fixed: number
  /** The share of the fee, 0–100, the customer agreed to carry. */
  share: number
}

export type CheckoutRequest = {
  companyId: number
  customerId: number
  /**
   * What the CARD IS CHARGED, in major units (e.g. JMD dollars), two decimals.
   * Where a surcharge applies this is the bill plus the surcharge, not the
   * bill — see `surcharge`.
   */
  amount: number
  /**
   * How much of `amount` is the customer's agreed share of the card fee, and
   * therefore does NOT buy service. Zero for almost every payment.
   *
   * CARRIED THROUGH THE GATEWAY AND BACK, so the webhook can credit the bill
   * rather than the total. It is round-tripped as data rather than recomputed
   * on the way back, because the company's settings may have changed between
   * the customer agreeing and the payment landing, and what they agreed to is
   * what they are held to.
   */
  surcharge?: number
  /**
   * The fee terms the surcharge was worked out from, carried along so the
   * payment can be re-derived later. Frozen at checkout for the same reason
   * the surcharge is: the company may edit its rate afterwards, and a past
   * payment has to stay explicable in the terms it was actually charged under.
   */
  feeTerms?: CardFeeTerms | null
  /** ISO 4217, e.g. 'JMD'. */
  currency: string
  /**
   * The payer's email, where the provider demands one. Dime rejects an order
   * without it; Fygaro never asks. The orchestrator supplies the customer's own
   * address, or a per-company stand-in when the record has none
   * (lib/data/payment-gateways.ts#payerEmailFor).
   */
  email?: string | null
  /** The payer's name, for the provider's receipt. Optional everywhere. */
  name?: string | null
  /**
   * Where to send the payer after paying, for providers that take it per
   * payment. Dime: `redirectUrl`. Fygaro ignores it — its return URL is a field
   * on the payment button in Fygaro's own dashboard, not something we can set.
   */
  returnUrl?: string | null
}

/** A verified payment, normalised out of a provider's webhook. */
export type GatewayPayment = {
  /** The provider's immutable transaction id — the idempotency key. */
  reference: string
  /** What the card was charged, bill plus any surcharge. */
  amount: number
  currency: string
  /** Round-tripped through the checkout link, so we know who paid. */
  companyId: number
  customerId: number
  /**
   * The surcharge agreed at checkout, round-tripped back. The customer's
   * account is credited `amount - surcharge`; crediting the full amount would
   * hand them back the card fee they just agreed to pay, as free service.
   */
  surcharge?: number
  /**
   * What the gateway took, as the gateway itself reported it — not a figure we
   * worked out. Recorded so a bank statement reconciles. Null when unknown.
   */
  fee?: number | null
  /** The fee terms the surcharge was quoted under, round-tripped back. */
  feeTerms?: CardFeeTerms | null
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
   * Throws when the credentials are incomplete, or when the provider's own
   * order call fails.
   */
  createCheckoutUrl(req: CheckoutRequest, creds: GatewayCredentials): Promise<string>
  /**
   * Verifies a webhook's signature and parses it into a normalised payment.
   *
   * Returns null when the delivery is genuine but carries nothing to record —
   * a lifecycle event for an unrelated stage, or an event type we do not act
   * on. The caller acknowledges those with a 2xx and writes nothing.
   *
   * Throws WebhookError on a bad signature or an unparseable body; the caller
   * turns that into a non-2xx and records nothing.
   */
  parseWebhook(req: WebhookRequest): GatewayPayment | null | Promise<GatewayPayment | null>
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
