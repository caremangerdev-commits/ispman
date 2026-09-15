import 'server-only'

import { getSmsSettings } from '@/lib/data/sms'
import { adapterFor, allAdapters } from '@/lib/messaging/registry'
import type { Channel } from '@/lib/messaging/routes'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Delivery reporting: what the PROVIDER did with a message after accepting it.
 *
 * WHY THIS EXISTS. An outbox row reads 'sent' the moment the provider accepts
 * it (lib/sms/dispatch.ts#drain). That is the end of what the dispatcher can
 * see — but not the end of the message. A phone can fail to send an SMS; a
 * mailbox can bounce an email. Each provider records that per message, and
 * for a while nothing read it back: a batch of 291 read "291 sent" in ISPMan
 * while the relay showed 196 failed on the handset, and the operator had no
 * row to retry because, as far as ISPMan knew, nothing had failed.
 *
 * This is the missing call, per channel through the adapter registry. It moves
 * a 'sent' row to 'delivered' or 'failed' from the provider's account, so the
 * batch page tells the truth and a failed row exists to be retried.
 */

/** Rows still worth asking about: sent this recently, never resolved. */
const LOOKBACK_HOURS = 48

export type DeliverySyncResult = {
  checked: number
  delivered: number
  failed: number
  /** Still in flight at the provider. */
  pending: number
  /** The provider could not be asked, or did not know the message. */
  unknown: number
}

const EMPTY: DeliverySyncResult = { checked: 0, delivered: 0, failed: 0, pending: 0, unknown: 0 }

/**
 * Resolves 'sent' rows against their providers.
 *
 * Bounded by `limit` because every row is one HTTP call: the dispatcher runs
 * this every tick with a small cap, and the batch page runs it on demand for
 * one batch with a larger one. Either way a row asked about and still pending
 * is simply asked again later.
 */
export async function syncDelivery(opts: {
  companyId: number
  batchId?: number
  limit: number
}): Promise<DeliverySyncResult> {
  const caps = await getSchemaCapabilities()
  const settings = await getSmsSettings(opts.companyId)
  const db = tenantClient()
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString()
  const result = { ...EMPTY }

  for (const adapter of allAdapters()) {
    if (adapter.channel !== 'sms' && !caps.messaging) continue
    const readiness = await adapter.tenantReady(opts.companyId, settings)
    if (!readiness.ready) continue

    let query = db
      .from('sms_outbox')
      .select('id, provider_message_id')
      .eq('company_id', opts.companyId)
      .eq('status', 'sent')
      .not('provider_message_id', 'is', null)
      .order('sent_at', { ascending: true })
      .limit(opts.limit)
    if (caps.messaging) query = query.eq('channel', adapter.channel)

    // A named batch is asked about regardless of age: the operator is standing
    // on its page. The sweep only looks back so far, so an old batch does not
    // cost a tick's worth of calls every minute forever.
    query = opts.batchId ? query.eq('batch_id', opts.batchId) : query.gte('sent_at', since)

    const { data, error } = await query
    if (error || !data) continue

    for (const row of data as { id: number; provider_message_id: string }[]) {
      result.checked += 1
      const verdict = await adapter.deliveryState(readiness.context, row.provider_message_id)
      if (verdict.state === 'unknown') { result.unknown += 1; continue }
      if (verdict.state === 'pending') { result.pending += 1; continue }
      await db.from('sms_outbox')
        .update({ status: verdict.state, error: verdict.state === 'failed' ? verdict.error : null })
        .eq('id', row.id)
      if (verdict.state === 'delivered') result.delivered += 1
      else result.failed += 1
    }
  }

  return result
}

/**
 * Keeps one batch's tallies in step with its rows.
 *
 * `total` is left alone: it is how many were queued when the batch was made,
 * and a retry re-queues within that number rather than adding to it. Rows
 * cancelled by a retry are neither sent nor failed, so they drop out of both
 * counts and the row that replaced them is what gets counted.
 */
export async function refreshBatchCounts(batchId: number): Promise<void> {
  const db = tenantClient()
  const { data } = await db.from('sms_outbox').select('status').eq('batch_id', batchId)
  if (!data) return
  const list = data as { status: string }[]
  await db.from('sms_batches').update({
    sent: list.filter((r) => r.status === 'sent' || r.status === 'delivered').length,
    failed: list.filter((r) => r.status === 'failed').length,
  }).eq('id', batchId)
}

/** The label an adapter gives its channel, for pages that show one. */
export function channelLabel(channel: Channel): string {
  return adapterFor(channel).label
}
