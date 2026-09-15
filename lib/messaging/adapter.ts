import 'server-only'

import type { MessagingSettings } from '@/lib/data/sms'
import type { Channel } from '@/lib/messaging/routes'

/**
 * THE ADAPTER INTERFACE. SMS and email are both implementations of this; a
 * third channel is a third file in ./adapters and one line in ./registry.ts.
 *
 * WHAT AN ADAPTER OWNS: how to reach its provider, what a usable recipient
 * looks like for its channel, how fast it may send, and how to read delivery
 * back. WHAT IT DOES NOT OWN: the queue, the batches, the templates, the
 * routing decision, the audit trail — those are shared and channel-neutral.
 *
 * Every method that talks to a provider takes the `context` that tenantReady()
 * produced, so credentials are resolved once per company per tick and never
 * re-read per message.
 */

/** The fields of a customer an adapter may look at to decide reachability. */
export type RecipientSource = {
  phone?: string | null
  email?: string | null
  sms_opted_out?: boolean | null
  email_opted_out?: boolean | null
}

/** A usable address, or the reason there is none. Reasons are shown to operators verbatim. */
export type RecipientVerdict =
  | { ok: true; address: string }
  | { ok: false; reason: string }

/** What the dispatcher hands an adapter. Already rendered; nothing left to decide. */
export type OutboundMessage = {
  /** The outbox row id — the idempotency key for every provider. */
  id: number
  kind: string
  recipient: string
  /** Email only. */
  subject: string | null
  body: string
  /**
   * A payment receipt is urgent: a customer at a counter must not queue
   * behind a bulk send. Each adapter maps this onto whatever its provider
   * offers (the relay's priority, nothing at all for email).
   */
  urgent: boolean
  /** A rendered document to attach, or null. Email only today. */
  attachment: { filename: string; bytes: Uint8Array; contentType: string } | null
}

export type SendOutcome =
  | { ok: true; providerId: string; state: string | null }
  | { ok: false; error: string; retryable: boolean }

export type DeliveryVerdict = {
  /** Final states move the row; pending leaves it; unknown means "could not ask". */
  state: 'delivered' | 'failed' | 'pending' | 'unknown'
  error: string | null
}

export type TenantReadiness<C> =
  | { ready: true; context: C }
  | { ready: false; reason: string }

export interface ChannelAdapter<C = unknown> {
  readonly channel: Channel
  readonly label: string

  /** Whether the PLATFORM can send on this channel at all — a relay URL, an API key. */
  configured(): boolean

  /**
   * Whether THIS COMPANY can send on this channel right now: its master switch,
   * its credentials or paired device. The context is what send() needs.
   */
  tenantReady(companyId: number, settings: MessagingSettings): Promise<TenantReadiness<C>>

  /** The address to send to for this customer, or why there is none. Pure. */
  recipientFor(customer: RecipientSource, settings: MessagingSettings): RecipientVerdict

  /** Seconds between messages for this company on this channel. */
  throttleSeconds(settings: MessagingSettings): number

  /** Whether documents may be attached on this channel. */
  readonly supportsAttachments: boolean

  send(context: C, message: OutboundMessage): Promise<SendOutcome>

  deliveryState(context: C, providerId: string): Promise<DeliveryVerdict>
}
