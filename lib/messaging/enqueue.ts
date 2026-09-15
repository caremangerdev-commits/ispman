import 'server-only'

import type { MessagingSettings, RoutedKind } from '@/lib/data/sms'
import type { RecipientSource } from '@/lib/messaging/adapter'
import { serialiseAttachmentRef, type AttachmentRef } from '@/lib/messaging/attachments'
import { adapterFor, allAdapters } from '@/lib/messaging/registry'
import { resolveRoute, type Resolution } from '@/lib/messaging/route'
import type { Channel, Route } from '@/lib/messaging/routes'
import { getSchemaCapabilities } from '@/lib/schema'
import { renderTemplate, type PlaceholderValues, type SmsKind } from '@/lib/sms/templates'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * THE ONLY WRITE PATH INTO THE OUTBOX, for every channel.
 *
 * Every rule about whether a customer may be messaged is decided here and
 * nowhere else: the channel's master switch, the per-kind switch, the route,
 * the per-channel opt-out, a usable address. A second insert written by hand
 * somewhere would bypass all of them — the same reasoning that makes logEvent
 * the sole writer of the `log` table.
 *
 * Two layers. enqueueMessage() writes ONE row for ONE channel and is what an
 * adapter-aware caller uses. enqueueForRoute() is what everything else uses:
 * it asks lib/messaging/route.ts which channels this customer gets, renders
 * the right template per channel, and writes a row for each. Callers never
 * name a channel.
 */

/** Which channels this company can send on right now. Computed once per caller, not per customer. */
export type Readiness = Record<Channel, { ready: true } | { ready: false; reason: string }>

export async function channelReadiness(companyId: number, settings: MessagingSettings): Promise<Readiness> {
  const out = {} as Readiness
  for (const adapter of allAdapters()) {
    // Before 0022 there is no channel column and the queue is SMS-shaped, so
    // only SMS can be ready, whatever the adapter says.
    if (adapter.channel !== 'sms' && !settings.channelsAvailable) {
      out[adapter.channel] = { ready: false, reason: 'Email needs migration 0022.' }
      continue
    }
    const r = await adapter.tenantReady(companyId, settings)
    out[adapter.channel] = r.ready ? { ready: true } : { ready: false, reason: r.reason }
  }
  return out
}

export type EnqueueOutcome =
  | { queued: true; id: number }
  | { queued: false; reason: string }

/**
 * Queues one message on one channel, or explains why it did not.
 *
 * `dedupeKey` is per channel (the unique index is on company, channel, key):
 * a re-run of the daily sweep or a double-submitted form cannot produce a
 * second message on the same channel. A rejected duplicate is NOT an error —
 * it is the mechanism working — so it comes back as `queued: false`.
 */
export async function enqueueMessage(opts: {
  companyId: number
  channel: Channel
  kind: SmsKind
  customerId: number | null
  recipient: string
  subject: string | null
  body: string
  dedupeKey: string | null
  batchId?: number | null
  attachment?: AttachmentRef | null
}): Promise<EnqueueOutcome> {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { queued: false, reason: 'Messaging is not set up on this system.' }
  if (opts.channel !== 'sms' && !caps.messaging) {
    return { queued: false, reason: 'Email needs migration 0022.' }
  }
  if (!opts.body.trim()) return { queued: false, reason: 'The message is empty.' }
  if (opts.attachment && !adapterFor(opts.channel).supportsAttachments) {
    return { queued: false, reason: 'Attachments cannot be sent by ' + adapterFor(opts.channel).label + '.' }
  }

  const row: Record<string, unknown> = {
    company_id: opts.companyId,
    customer_id: opts.customerId,
    batch_id: opts.batchId ?? null,
    kind: opts.kind,
    body: opts.body,
    status: 'queued',
    dedupe_key: opts.dedupeKey,
  }
  if (caps.messaging) {
    row.channel = opts.channel
    row.recipient = opts.recipient
    row.subject = opts.subject
    row.attachment = opts.attachment ? serialiseAttachmentRef(opts.attachment) : null
    // Until every reader has moved to `recipient` — see 0022.
    if (opts.channel === 'sms') row.phone = opts.recipient
  } else {
    row.phone = opts.recipient
  }

  const { data, error } = await tenantClient()
    .from('sms_outbox')
    .insert(row)
    .select('id')
    .maybeSingle()

  if (error) {
    // 23505 is the unique index on dedupe_key doing its job.
    if (error.code === '23505') return { queued: false, reason: 'Already queued for this event.' }
    return { queued: false, reason: 'Could not queue the message: ' + error.message }
  }
  return { queued: true, id: (data as { id: number }).id }
}

export type RouteOutcome = {
  /** One entry per channel the route reached. */
  queued: { channel: Channel; id: number }[]
  /** Per channel the route considered and did not queue on, with why. */
  skipped: { channel: Channel; reason: string }[]
  resolution: Resolution
}

/**
 * Queues a message to one customer BY THE COMPANY'S ROUTE for its kind.
 *
 * `route` may be given to override the company's stored one — the messaging
 * page lets the operator choose per send — and defaults to the setting.
 * Templates are per channel: `text.sms` is the SMS wording and `text.email`
 * the subject and body; each is rendered with the same placeholder values.
 */
export async function enqueueForRoute(opts: {
  companyId: number
  kind: RoutedKind
  settings: MessagingSettings
  readiness: Readiness
  route?: Route
  customer: RecipientSource & { id: number | null }
  values: PlaceholderValues
  text: { sms: string; email: { subject: string; body: string } }
  dedupeKey: string | null
  batchId?: number | null
  attachment?: AttachmentRef | null
}): Promise<RouteOutcome> {
  const route = opts.route ?? opts.settings.routes[opts.kind]
  const resolution = resolveRoute({
    route, customer: opts.customer, settings: opts.settings, ready: opts.readiness,
  })

  const queued: RouteOutcome['queued'] = []
  const skipped: RouteOutcome['skipped'] = [...resolution.skipped]

  for (const target of resolution.targets) {
    const outcome = await enqueueMessage({
      companyId: opts.companyId,
      channel: target.channel,
      kind: opts.kind,
      customerId: opts.customer.id,
      recipient: target.address,
      subject: target.channel === 'email' ? renderTemplate(opts.text.email.subject, opts.values) : null,
      body: renderTemplate(target.channel === 'email' ? opts.text.email.body : opts.text.sms, opts.values),
      dedupeKey: opts.dedupeKey,
      batchId: opts.batchId,
      // Only where the channel can carry it; SMS simply goes without.
      attachment: adapterFor(target.channel).supportsAttachments ? opts.attachment ?? null : null,
    })
    if (outcome.queued) queued.push({ channel: target.channel, id: outcome.id })
    else skipped.push({ channel: target.channel, reason: outcome.reason })
  }

  return { queued, skipped, resolution }
}
