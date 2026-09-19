import 'server-only'

import type { Brand } from '@/lib/brand'
import { brandFor } from '@/lib/data/brand'
import { loadEnrichedCustomers } from '@/lib/data/customers'
import { getSmsSettings, type MessagingSettings } from '@/lib/data/sms'
import { daysUntilDateOnly, formatCurrency } from '@/lib/format'
import type { ChannelAdapter, OutboundMessage } from '@/lib/messaging/adapter'
import { parseAttachmentRef, renderAttachment } from '@/lib/messaging/attachments'
import { channelReadiness, enqueueForRoute, type Readiness } from '@/lib/messaging/enqueue'
import { presentMessage } from '@/lib/messaging/present'
import { allAdapters } from '@/lib/messaging/registry'
import { CHANNELS, type Channel } from '@/lib/messaging/routes'
import { getSchemaCapabilities } from '@/lib/schema'
import { refreshBatchCounts, syncDelivery } from '@/lib/sms/delivery'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The dispatcher: produces the scheduled messages, then drains the queue —
 * ONE CHANNEL AT A TIME, EACH THROUGH ITS ADAPTER.
 *
 * HOW IT RUNS. A small ticker process under pm2 (worker/sms-ticker.mjs) POSTs
 * to /api/sms/dispatch on a loop. The logic lives here, inside the app, so it
 * reads the same settings, the same customer filters and the same recipient
 * rules as every page — a standalone worker would have needed its own copy of
 * all three, and this codebase already has three separate stories about what
 * happens when one rule gets written twice.
 *
 * WHAT IT KNOWS ABOUT CHANNELS: nothing. It asks the registry for every
 * adapter, asks each whether this company is ready on it, and drains that
 * channel's rows at that adapter's throttle. A third channel changes nothing
 * in this file.
 *
 * WHY THERE IS NO SCHEDULE. The sweep below is IDEMPOTENT because of the unique
 * index on (company_id, channel, dedupe_key): an expiry warning for customer
 * 4471 on 2026-09-14 can only ever be inserted once per channel, no matter how
 * many times the sweep runs. So it simply runs every tick and the database
 * decides what is new. That removes the entire class of bug where a scheduler
 * fires twice, or misses a day, or forgets which tenants it has already done.
 */

/** A row that has been 'sending' longer than this had its worker die. */
const STALE_CLAIM_MS = 5 * 60_000

/** Given up on after this many tries, so one poisonous row cannot loop. */
const MAX_ATTEMPTS = 3

/** Wall-clock budget for one tick, leaving room before the ticker's timeout. */
const TICK_BUDGET_MS = 50_000

/**
 * The hours, in the COMPANY'S OWN timezone, during which automated messages may
 * be created. Nothing is queued outside them: a disconnection notice that
 * arrives at 03:00 is worse than one that arrives at 09:00.
 */
const QUIET_START_HOUR = 8
const QUIET_END_HOUR = 20

/**
 * How many 'sent' rows one tick asks the providers about. Each is one HTTP
 * call, and the tick has a time budget; 60 a minute clears a 291-row batch in
 * five ticks without crowding out the sending.
 */
const DELIVERY_CHECKS_PER_TICK = 60

export type DispatchSummary = {
  companyId: number
  companyName: string
  /** The channels this company was drained on. */
  channels: Channel[]
  enqueued: number
  sent: number
  failed: number
  recovered: number
  skipped: string | null
}

/** The local hour in a timezone, right now. */
function localHour(timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, hour: '2-digit',
  }).formatToParts(new Date())
  return Number(parts.find((p) => p.type === 'hour')?.value ?? '12') % 24
}

/** Today's date in a timezone, as YYYY-MM-DD — the dedupe key's day part. */
function localDate(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '01'
  return get('year') + '-' + get('month') + '-' + get('day')
}

/**
 * Creates the expiry warnings that are due today, by the company's route.
 *
 * DISCONNECTION NOTICES ARE NOT HERE. Being disconnected is an event, not a
 * state discovered by scanning — lib/sms/notify.ts enqueues one at the moment
 * a customer is cut off, where it knows the act was deliberate.
 */
async function sweepExpiryWarnings(
  companyId: number,
  companyName: string,
  timezone: string,
  settings: MessagingSettings,
  readiness: Readiness
): Promise<number> {
  if (!settings.expiryWarning) return 0

  const hour = localHour(timezone)
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return 0

  const today = localDate(timezone)
  const customers = await loadEnrichedCustomers(companyId)

  let queued = 0
  for (const c of customers) {
    // The NETWORK expiry, not the billing one. "Days before cut-off" means the
    // day they actually lose service, which is what radcheck holds.
    const days = daysUntilDateOnly(c.radiusExpiryDate ?? null)
    if (days === null) continue

    // Exactly the configured day, not "within N days". A window would send a
    // warning every day of that window, and the dedupe key — which is per day
    // of the CUT-OFF, not per day of sending — would not stop it.
    if (days !== settings.expiryWarningDays) continue

    const result = await enqueueForRoute({
      companyId,
      kind: 'expiry_warning',
      settings,
      readiness,
      customer: {
        id: c.id, phone: c.phone, email: c.email,
        sms_opted_out: c.sms_opted_out, email_opted_out: c.email_opted_out,
      },
      values: {
        '{{name}}': [c.first_name, c.last_name].filter(Boolean).join(' '),
        '{{first_name}}': c.first_name ?? '',
        '{{account}}': c.account_number ?? '',
        '{{balance}}': formatCurrency(c.carried_balance ?? 0),
        '{{expiry}}': c.radiusExpiryDate ?? '',
        '{{days}}': String(days),
        '{{company}}': companyName,
      },
      text: { sms: settings.smsTemplates.expiry_warning, email: settings.emailTemplates.expiry_warning },
      dedupeKey: 'expiry:' + c.id + ':' + (c.radiusExpiryDate ?? today),
    })
    queued += result.queued.length
  }

  return queued
}

/**
 * Returns rows abandoned by a dead worker to the queue.
 *
 * Bounded by attempts, which was already incremented when the row was claimed,
 * so a message that crashes the sender is retried twice and then left `failed`
 * with its error visible rather than cycling forever.
 */
async function recoverStale(companyId: number): Promise<number> {
  const db = tenantClient()
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString()

  const { data, error } = await db
    .from('sms_outbox')
    .update({ status: 'queued' })
    .eq('company_id', companyId)
    .eq('status', 'sending')
    .lt('created_at', cutoff)
    .lt('attempts', MAX_ATTEMPTS)
    .select('id')

  if (error) return 0
  return (data ?? []).length
}

/**
 * How many more messages this company may send on one channel in the next
 * minute.
 *
 * COUNTED FROM WHAT WAS ACTUALLY SENT, not held in memory. Two overlapping
 * ticks, a restarted worker, or a manual run all see the same number, because
 * it is derived from rows rather than from a counter someone has to remember
 * to reset.
 */
async function remainingBudget(
  companyId: number,
  channel: Channel,
  throttleSeconds: number,
  channelColumn: boolean
): Promise<number> {
  const perMinute = Math.max(1, Math.floor(60 / Math.max(1, throttleSeconds)))
  const db = tenantClient()
  const since = new Date(Date.now() - 60_000).toISOString()

  let query = db
    .from('sms_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('sent_at', since)
  if (channelColumn) query = query.eq('channel', channel)

  const { count, error } = await query
  if (error) return perMinute
  return Math.max(0, perMinute - (count ?? 0))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Claims one row, atomically.
 *
 * PostgREST cannot express SELECT ... FOR UPDATE SKIP LOCKED, so this is a
 * conditional update that only succeeds if the row is still queued — the same
 * compare-and-swap shape as bumpCounter() in lib/data/account-numbers.ts. Two
 * workers racing the same row: one gets it, the other gets nothing.
 */
async function claim(id: number, attempts: number): Promise<boolean> {
  const db = tenantClient()
  const { data, error } = await db
    .from('sms_outbox')
    .update({ status: 'sending', attempts: attempts + 1 })
    .eq('id', id)
    .eq('status', 'queued')
    .select('id')
    .maybeSingle()

  return !error && Boolean(data)
}

type QueuedRow = {
  id: number
  attempts: number
  phone: string | null
  recipient?: string
  subject?: string | null
  attachment?: string | null
  body: string
  kind: string
}

/** Drains one company's queue on one channel, within its throttle and the time budget. */
async function drain(
  companyId: number,
  adapter: ChannelAdapter,
  context: unknown,
  settings: MessagingSettings,
  deadline: number,
  channelColumn: boolean
): Promise<{ sent: number; failed: number }> {
  const db = tenantClient()
  let sent = 0
  let failed = 0

  const throttle = adapter.throttleSeconds(settings)
  let budget = await remainingBudget(companyId, adapter.channel, throttle, channelColumn)

  // The company's brand, for a channel that carries HTML. Loaded on the first
  // row that needs it and once per drain: a tick with nothing queued downloads
  // no logo, and a 400-message send downloads it once.
  let brand: Brand | null = null

  while (budget > 0 && Date.now() < deadline) {
    // PAYMENT RECEIPTS FIRST. A customer standing at a counter must not wait
    // behind a 400-message blast. DESCENDING, and this relies on the kind
    // names: payment_receipt > expiry_warning > disconnection_notice > bulk
    // alphabetically, so Z-to-A is receipts first and bulk last. PostgREST
    // cannot express a CASE ordering; if a kind is ever added whose name
    // breaks this order, sort in memory here instead of renaming it.
    let query = db
      .from('sms_outbox')
      .select('id, attempts, phone, body, kind' + (channelColumn ? ', recipient, subject, attachment' : ''))
      .eq('company_id', companyId)
      .eq('status', 'queued')
      .lt('attempts', MAX_ATTEMPTS)
      .order('kind', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)
    if (channelColumn) query = query.eq('channel', adapter.channel)

    const { data, error } = await query
    if (error || !data || data.length === 0) break

    const row = data[0] as unknown as QueuedRow
    if (!(await claim(row.id, row.attempts))) continue

    // The attachment is rendered now, from the record it names. A record that
    // has gone is a terminal failure with a reason, not a stale copy sent.
    let attachment: OutboundMessage['attachment'] = null
    const ref = parseAttachmentRef(row.attachment)
    if (ref) {
      const rendered = await renderAttachment(companyId, ref)
      if ('error' in rendered) {
        await db.from('sms_outbox').update({ status: 'failed', error: 'Attachment: ' + rendered.error }).eq('id', row.id)
        failed += 1
        continue
      }
      attachment = rendered
    }

    // The stored body is words. Where the channel takes HTML it is dressed in
    // the company's shell now — see lib/messaging/present.ts. brandFor() does
    // not throw for a missing logo or colour, so this cannot fail a send.
    let presented: Pick<OutboundMessage, 'body' | 'html' | 'inlineImages'> =
      { body: row.body, html: null, inlineImages: [] }
    if (adapter.supportsHtml) {
      brand ??= await brandFor(companyId)
      presented = presentMessage(brand, { kind: row.kind, subject: row.subject ?? null, body: row.body })
    }

    const result = await adapter.send(context, {
      id: row.id,
      kind: row.kind,
      recipient: row.recipient ?? row.phone ?? '',
      subject: row.subject ?? null,
      ...presented,
      urgent: row.kind === 'payment_receipt',
      attachment,
    })

    if (result.ok) {
      await db.from('sms_outbox').update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        provider_message_id: result.providerId,
        error: null,
      }).eq('id', row.id)
      sent += 1
    } else {
      // Retryable failures go back to 'queued' so the next tick tries again;
      // terminal ones stop here with the reason visible rather than blocking
      // the queue.
      await db.from('sms_outbox').update({
        status: result.retryable && row.attempts + 1 < MAX_ATTEMPTS ? 'queued' : 'failed',
        error: result.error,
      }).eq('id', row.id)
      failed += 1
    }

    budget -= 1
    if (budget > 0 && Date.now() < deadline) {
      await sleep(throttle * 1000)
    }
  }

  return { sent, failed }
}

/**
 * Learns what the providers did with recently sent messages, then keeps the
 * batch tallies in step with the rows. See lib/sms/delivery.ts.
 */
async function settleRecent(companyId: number): Promise<void> {
  await syncDelivery({ companyId, limit: DELIVERY_CHECKS_PER_TICK })

  const db = tenantClient()
  const { data } = await db
    .from('sms_batches')
    .select('id')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(20)

  for (const b of (data ?? []) as { id: number }[]) await refreshBatchCounts(b.id)
}

/**
 * One tick: every company, or one if named.
 *
 * A company that cannot send on any channel is not an error. It is the
 * overwhelmingly common case, and the summary says so rather than logging a
 * failure every minute for each of them.
 */
export async function runDispatch(only?: number): Promise<DispatchSummary[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return []
  if (!allAdapters().some((a) => a.configured())) return []

  const db = tenantClient()
  const { data: companies, error } = await db
    .from('companies').select('id, name').order('id')
  if (error) throw new Error('Failed to list companies: ' + error.message)

  const rows = (companies ?? []) as { id: number; name: string }[]
  const targets = only ? rows.filter((c) => c.id === only) : rows

  const deadline = Date.now() + TICK_BUDGET_MS
  const out: DispatchSummary[] = []

  for (const co of targets) {
    const settings = await getSmsSettings(co.id)
    const readiness = await channelReadiness(co.id, settings)

    // Resolved once per company per tick: the context an adapter's send()
    // needs, for each channel this company can send on.
    const live: { adapter: ChannelAdapter; context: unknown }[] = []
    for (const adapter of allAdapters()) {
      if (!readiness[adapter.channel].ready) continue
      const r = await adapter.tenantReady(co.id, settings)
      if (r.ready) live.push({ adapter, context: r.context })
    }

    if (live.length === 0) {
      out.push({
        companyId: co.id, companyName: co.name, channels: [],
        enqueued: 0, sent: 0, failed: 0, recovered: 0,
        skipped: CHANNELS.map((c) => {
          const r = readiness[c]
          return c + ': ' + (r.ready ? 'ready' : r.reason)
        }).join('; '),
      })
      continue
    }

    const { data: setting } = await db
      .from('settings').select('timezone').eq('company_id', co.id).maybeSingle()
    const timezone = (setting as { timezone?: string } | null)?.timezone || 'America/Jamaica'

    const recovered = await recoverStale(co.id)
    const enqueued = await sweepExpiryWarnings(co.id, co.name, timezone, settings, readiness)

    let sent = 0
    let failed = 0
    for (const { adapter, context } of live) {
      const r = await drain(co.id, adapter, context, settings, deadline, caps.messaging)
      sent += r.sent
      failed += r.failed
    }

    out.push({
      companyId: co.id, companyName: co.name,
      channels: live.map((l) => l.adapter.channel),
      enqueued, sent, failed, recovered, skipped: null,
    })
  }

  for (const co of targets) await settleRecent(co.id)

  return out
}
