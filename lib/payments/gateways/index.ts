// The gateway registry: the one place that knows which providers exist.
//
// Adding a provider is a new implementation file and one line here. The webhook
// route and the checkout orchestrator resolve a gateway by id and never name a
// concrete provider.

import { fygaro } from './fygaro'
import { type PaymentGateway } from './types'

const GATEWAYS: Record<string, PaymentGateway> = {
  [fygaro.provider]: fygaro,
}

/** The implementation for a provider id, or null when none is registered. */
export function gatewayFor(provider: string): PaymentGateway | null {
  return GATEWAYS[provider] ?? null
}

export {
  WebhookError,
  type CheckoutRequest,
  type GatewayCredentials,
  type GatewayPayment,
  type PaymentGateway,
  type WebhookRequest,
} from './types'
