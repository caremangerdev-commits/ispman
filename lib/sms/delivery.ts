import 'server-only'

import { getSmsDevice, type SmsDevice } from '@/lib/data/sms'
import { getMessageState, type RelayCredentials } from '@/lib/sms/relay'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Delivery reporting: what the PHONE did with a message the relay accepted.
 *
 * WHY THIS EXISTS. An outbox row reads 'sent' the moment the relay accepts it
 * (lib/sms/dispatch.ts#drain). That is the end of what the dispatcher can see
 * — but not the end of the message. The phone can still fail to send it: no
 * signal, a SIM the carrier has started throttling, a number the network
 * rejects. The relay records that per message, and getMessageState() in
 * lib/sms/relay.ts has read it back since the relay module was written — but
 * nothing ever called it. So a batch of 291 read "291 sent" in ISPMan while
 * the relay showed 196 of them failed on the handset, and the operator had no
 * row to retry because, as far as ISPMan knew, nothing had failed.
 *
 * This is the missing call. It moves a 'sent' row to 'delivered' or 'failed'
 * from the relay's account, so the batch page tells the truth and a failed row
 * exists to be retried.
 *
 * The relay's states, from the SMSGate server: Pending, Processed, Sent,
 * Delivered, Failed. Only the last two are final. Everything else is left as
 * 'sent' and asked about again next time.
 */

/** Rows still worth asking about: sent this recently, never resolved. */
const LOOKBACK_HOURS = 48

export type DeliverySyncResult = {
  checked: number
  delivered: number
  failed: number
  /** Still in flight at the relay. */
  pending: number
  /** The relay could not be asked, or did not know the message. */
  unknown: number
}

function credsOf(device: SmsDevice): RelayCredentials {
  return {
    username: device.apiUsername as string,
    password: device.apiPassword as string,
    deviceId: device.deviceId,
    simNumber: device.simNumber,
  }
}

/**
 * Resolves 'sent' rows against the relay.
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
  const empty: DeliverySyncResult = { checked: 0, delivered: 0, failed: 0, pending: 0, unknown: 0 }

  const device = await getSmsDevice(opts.companyId)
  if (!device?.apiUsername || !device?.apiPassword) return empty
  const creds = credsOf(device)

  const db = tenantClient()
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3_600_000).toISOString()

  let query = db
    .from('sms_outbox')
    .select('id, provider_message_id')
    .eq('company_id', opts.companyId)
    .eq('status', 'sent')
    .not('provider_message_id', 'is', null)
    .order('sent_at', { ascending: true })
    .limit(opts.limit)

  // A named batch is asked about regardless of age: the operator is standing
  // on its page. The sweep only looks back so far, so an old batch does not
  // cost a tick's worth of calls every minute forever.
  query = opts.batchId ? query.eq('batch_id', opts.batchId) : query.gte('sent_at', since)

  const { data, error } = await query
  if (error || !data) return empty

  const result = { ...empty }
  for (const row of data as { id: number; provider_message_id: string }[]) {
    result.checked += 1
    const state = await getMessageState(creds, row.provider_message_id)
    if (!state?.state) { result.unknown += 1; continue }

    const s = state.state.toLowerCase()
    if (s === 'delivered') {
      await db.from('sms_outbox').update({ status: 'delivered', error: null }).eq('id', row.id)
      result.delivered += 1
    } else if (s === 'failed') {
      // The phone's reason, when the relay has one, so the batch page can say
      // "no service" rather than just "failed".
      await db.from('sms_outbox')
        .update({ status: 'failed', error: 'Phone could not send: ' + (state.error ?? 'no reason given by the relay') })
        .eq('id', row.id)
      result.failed += 1
    } else {
      result.pending += 1
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
