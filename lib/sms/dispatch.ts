import 'server-only'

import { loadEnrichedCustomers } from '@/lib/data/customers'
import {
  canSend, enqueueSms, getSmsDevice, getSmsSettings,
  type SmsDevice, type SmsSettings,
} from '@/lib/data/sms'
import { daysUntilDateOnly, formatCurrency } from '@/lib/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { sendMessage, relayConfigured, type RelayCredentials } from '@/lib/sms/relay'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The dispatcher: produces the scheduled messages, then drains the queue.
 *
 * HOW IT RUNS. A small ticker process under pm2 (worker/sms-ticker.mjs) POSTs
 * to /api/sms/dispatch on a loop. The logic lives here, inside the app, so it
 * reads the same settings, the same customer filters and the same phone rules
 * as every page — a standalone worker would have needed its own copy of all
 * three, and this codebase already has three separate stories about what
 * happens when one rule gets written twice.
 *
 * WHY THERE IS NO SCHEDULE. The sweep below is IDEMPOTENT because of the unique
 * index on (company_id, dedupe_key): an expiry warning for customer 4471 on
 * 2026-09-14 can only ever be inserted once, no matter how many times the sweep
 * runs. So it simply runs every tick and the database decides what is new. That
 * removes the entire class of bug where a scheduler fires twice, or misses a
 * day, or forgets which tenants it has already done — none of which can be
 * tested easily and all of which are only noticed by a customer.
 */

/** A row that has been 'sending' longer than this had its worker die. */
const STALE_CLAIM_MS = 5 * 60_000

/** Given up on after this many tries, so one poisonous row cannot loop. */
const MAX_ATTEMPTS = 3

/** Wall-clock budget for one tick, leaving room before the ticker's timeout. */
const TICK_BUDGET_MS = 50_000

/**
 * The hours, in the COMPANY'S OWN timezone, during which automated messages may
 * be created. Nothing is queued outside them.
 *
 * A disconnection notice that arrives at 03:00 is worse than one that arrives
 * at 09:00, and the sweep runs continuously, so this is the only thing standing
 * between a tenant and a phone buzzing in the middle of the night.
 */
const QUIET_START_HOUR = 8
const QUIET_END_HOUR = 20

export type DispatchSummary = {
  companyId: number
  companyName: string
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
 * Creates the expiry warnings that are due today.
 *
 * DISCONNECTION NOTICES ARE NOT HERE. Being disconnected is an event, not a
 * state discovered by scanning — app/actions/customers.ts enqueues one at the
 * moment it cuts a customer off, where it knows the act was deliberate. A sweep
 * would have to infer it from a status, and could not tell a deliberate cut-off
 * from an ordinary lapse.
 */
async function sweepExpiryWarnings(
  companyId: number,
  companyName: string,
  timezone: string,
  settings: SmsSettings,
  device: SmsDevice | null
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
    // of the CUT-OFF, not per day of sending — would not stop it because each
    // day's key differs.
    if (days !== settings.expiryWarningDays) continue

    const result = await enqueueSms({
      companyId,
      kind: 'expiry_warning',
      settings,
      device,
      dedupeKey: 'expiry:' + c.id + ':' + (c.radiusExpiryDate ?? today),
      target: {
        customerId: c.id,
        phone: c.phone,
        optedOut: c.sms_opted_out,
        values: {
          '{{name}}': [c.first_name, c.last_name].filter(Boolean).join(' '),
          '{{first_name}}': c.first_name ?? '',
          '{{account}}': c.account_number ?? '',
          '{{balance}}': formatCurrency(c.carried_balance ?? 0),
          '{{expiry}}': c.radiusExpiryDate ?? '',
          '{{days}}': String(days),
          '{{company}}': companyName,
        },
      },
    })
    if (result.queued) queued += 1
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
 * How many more messages this company may send in the next minute.
 *
 * COUNTED FROM WHAT WAS ACTUALLY SENT, not held in memory. Two overlapping
 * ticks, a restarted worker, or a manual run all see the same number, because
 * it is derived from rows rather than from a counter someone has to remember to
 * reset. The compare-and-swap claim already stops a row going twice; this stops
 * the SIM going too fast.
 */
async function remainingBudget(companyId: number, throttleSeconds: number): Promise<number> {
  const perMinute = Math.max(1, Math.floor(60 / Math.max(1, throttleSeconds)))
  const db = tenantClient()
  const since = new Date(Date.now() - 60_000).toISOString()

  const { count, error } = await db
    .from('sms_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('sent_at', since)

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

/** Drains one company's queue, within the throttle and the time budget. */
async function drain(
  companyId: number,
  settings: SmsSettings,
  device: SmsDevice,
  deadline: number
): Promise<{ sent: number; failed: number }> {
  const db = tenantClient()
  let sent = 0
  let failed = 0

  const creds: RelayCredentials = {
    username: device.apiUsername as string,
    password: device.apiPassword as string,
    deviceId: device.deviceId,
    simNumber: device.simNumber,
  }

  let budget = await remainingBudget(companyId, settings.throttleSeconds)

  while (budget > 0 && Date.now() < deadline) {
    // PAYMENT RECEIPTS FIRST. A customer standing at a counter must not wait
    // behind a 400-message blast. The relay priority below is the second half
    // of the same promise.
    //
    // DESCENDING, and this relies on the kind names: payment_receipt >
    // expiry_warning > disconnection_notice > bulk alphabetically, so Z-to-A
    // is receipts first and bulk last. This was ascending for a while, which
    // is the exact opposite — bulk first, receipts last — and nobody noticed
    // until an outage blast was about to go out. PostgREST cannot express a
    // CASE ordering, so if a kind is ever added whose name breaks this order,
    // sort in memory here instead of renaming it.
    const { data, error } = await db
      .from('sms_outbox')
      .select('id, attempts, phone, body, kind')
      .eq('company_id', companyId)
      .eq('status', 'queued')
      .lt('attempts', MAX_ATTEMPTS)
      .order('kind', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1)

    if (error || !data || data.length === 0) break

    const row = data[0] as unknown as {
      id: number; attempts: number; phone: string; body: string; kind: string
    }

    if (!(await claim(row.id, row.attempts))) continue

    const result = await sendMessage(creds, {
      id: String(row.id),
      text: row.body,
      phone: row.phone,
      // 100+ bypasses the relay's own rate limiting. ONLY for a payment
      // receipt, and never for bulk — using it everywhere would defeat the
      // throttle that protects the SIM.
      priority: row.kind === 'payment_receipt' ? 100 : 0,
      // Six hours. A disconnection notice that could not be delivered today is
      // not worth delivering tomorrow.
      ttlSeconds: 6 * 60 * 60,
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
      // terminal ones (bad credentials, a rejected number) stop here with the
      // reason visible on the settings page rather than blocking the queue.
      await db.from('sms_outbox').update({
        status: result.retryable && row.attempts + 1 < MAX_ATTEMPTS ? 'queued' : 'failed',
        error: result.error,
      }).eq('id', row.id)
      failed += 1
    }

    budget -= 1
    if (budget > 0 && Date.now() < deadline) {
      await sleep(settings.throttleSeconds * 1000)
    }
  }

  return { sent, failed }
}

/** Keeps the batch tallies in step with the rows they describe. */
async function refreshBatchCounts(companyId: number): Promise<void> {
  const db = tenantClient()

  const { data } = await db
    .from('sms_batches')
    .select('id')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(20)

  for (const b of (data ?? []) as { id: number }[]) {
    const { data: rows } = await db
      .from('sms_outbox').select('status').eq('batch_id', b.id)
    if (!rows) continue
    const list = rows as { status: string }[]
    await db.from('sms_batches').update({
      sent: list.filter((r) => r.status === 'sent' || r.status === 'delivered').length,
      failed: list.filter((r) => r.status === 'failed').length,
    }).eq('id', b.id)
  }
}

/**
 * One tick: every company, or one if named.
 *
 * A company that cannot send is not an error. It is the overwhelmingly common
 * case — nine of ten tenants have SMS off — and the summary says so rather than
 * logging a failure every minute for each of them.
 */
export async function runDispatch(only?: number): Promise<DispatchSummary[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return []
  if (!relayConfigured()) return []

  const db = tenantClient()
  const { data: companies, error } = await db
    .from('companies').select('id, name').order('id')
  if (error) throw new Error('Failed to list companies: ' + error.message)

  const rows = (companies ?? []) as { id: number; name: string }[]
  const targets = only ? rows.filter((c) => c.id === only) : rows

  const deadline = Date.now() + TICK_BUDGET_MS
  const out: DispatchSummary[] = []

  for (const co of targets) {
    const [settings, device] = await Promise.all([
      getSmsSettings(co.id), getSmsDevice(co.id),
    ])

    if (!canSend(settings, device)) {
      out.push({
        companyId: co.id, companyName: co.name,
        enqueued: 0, sent: 0, failed: 0, recovered: 0,
        skipped: !settings.enabled ? 'SMS off' : 'no device paired',
      })
      continue
    }

    const { data: setting } = await db
      .from('settings').select('timezone').eq('company_id', co.id).maybeSingle()
    const timezone = (setting as { timezone?: string } | null)?.timezone || 'America/Jamaica'

    const recovered = await recoverStale(co.id)
    const enqueued = await sweepExpiryWarnings(co.id, co.name, timezone, settings, device)
    const { sent, failed } = await drain(co.id, settings, device as SmsDevice, deadline)

    out.push({
      companyId: co.id, companyName: co.name,
      enqueued, sent, failed, recovered, skipped: null,
    })
  }

  for (const co of targets) await refreshBatchCounts(co.id)

  return out
}
