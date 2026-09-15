import 'server-only'

import type { MessagingSettings } from '@/lib/data/sms'
import type { RecipientSource } from '@/lib/messaging/adapter'
import { adapterFor } from '@/lib/messaging/registry'
import { channelsOf, isFallbackRoute, type Channel, type Route } from '@/lib/messaging/routes'

/**
 * THE ONE PLACE A ROUTE IS TURNED INTO ADDRESSES.
 *
 * Given the company's route for a message kind and one customer, decides
 * which channels get a row and where each goes. Every caller — the receipt
 * and disconnection notifiers, the expiry sweep, the messaging page's preview
 * and its send — asks this, so the company's choice means the same thing
 * everywhere and the preview counts are the rows that get queued.
 *
 * `ready` is which channels the company can send on right now (its master
 * switches and credentials), computed once by the caller through the
 * adapters. A channel that is not ready is not "the customer has no address":
 * it is reported as its own reason, so an operator can see "email is switched
 * off" rather than wonder why nobody with an email got one.
 */

export type ResolvedTarget = { channel: Channel; address: string }
export type ResolvedSkip = { channel: Channel; reason: string }

export type Resolution = {
  targets: ResolvedTarget[]
  /** Every channel the route considered and did not use, with why. */
  skipped: ResolvedSkip[]
}

export function resolveRoute(opts: {
  route: Route
  customer: RecipientSource
  settings: MessagingSettings
  ready: Record<Channel, { ready: true } | { ready: false; reason: string }>
}): Resolution {
  const targets: ResolvedTarget[] = []
  const skipped: ResolvedSkip[] = []

  for (const channel of channelsOf(opts.route)) {
    const readiness = opts.ready[channel]
    if (!readiness.ready) {
      skipped.push({ channel, reason: readiness.reason })
      continue
    }
    const verdict = adapterFor(channel).recipientFor(opts.customer, opts.settings)
    if (!verdict.ok) {
      skipped.push({ channel, reason: verdict.reason })
      continue
    }
    targets.push({ channel, address: verdict.address })
    // A fallback route stops at the first channel that works.
    if (isFallbackRoute(opts.route)) break
  }

  return { targets, skipped }
}

/**
 * One line for the operator when a customer will get nothing: the reasons per
 * channel, joined. "No email address on file; no phone number on file".
 */
export function describeSkip(resolution: Resolution): string {
  return resolution.skipped.map((s) => s.reason).join('; ') || 'Not reachable'
}
