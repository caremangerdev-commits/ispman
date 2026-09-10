import 'server-only'

import { sendablePhone } from '@/lib/phone'
import { getSchemaCapabilities } from '@/lib/schema'
import {
  DEFAULT_TEMPLATES, renderTemplate, type PlaceholderValues, type SmsKind,
} from '@/lib/sms/templates'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Reading and writing the SMS tables.
 *
 * THE ENQUEUE FUNCTION AT THE BOTTOM IS THE ONLY WRITE PATH INTO sms_outbox.
 * Every rule about whether a customer may be messaged — the master switch, the
 * per-type toggle, a paired device, the opt-out, a usable phone number — is
 * decided there and nowhere else. A second insert written by hand somewhere
 * would bypass all five, which is the same reasoning that makes logEvent the
 * sole writer of the `log` table.
 */

export type SmsSettings = {
  /** settings.sms_enabled — the MASTER SWITCH. Off kills everything for the
   *  tenant regardless of the per-type toggles. */
  enabled: boolean
  paymentReceipt: boolean
  expiryWarning: boolean
  disconnection: boolean
  templates: Record<Exclude<SmsKind, 'bulk'>, string>
  expiryWarningDays: number
  throttleSeconds: number
  allowForeign: boolean
}

/** What a tenant looks like before they have configured anything. */
export const SMS_SETTINGS_OFF: SmsSettings = {
  enabled: false,
  paymentReceipt: false,
  expiryWarning: false,
  disconnection: false,
  templates: DEFAULT_TEMPLATES,
  expiryWarningDays: 3,
  throttleSeconds: 6,
  allowForeign: false,
}

const SETTING_COLS =
  'sms_enabled, sms_payment_receipt_enabled, sms_expiry_warning_enabled, ' +
  'sms_disconnection_enabled, sms_payment_receipt_template, ' +
  'sms_expiry_warning_template, sms_disconnection_template, ' +
  'sms_expiry_warning_days, sms_throttle_seconds, sms_allow_foreign'

type SettingRow = {
  sms_enabled: boolean | null
  sms_payment_receipt_enabled: boolean | null
  sms_expiry_warning_enabled: boolean | null
  sms_disconnection_enabled: boolean | null
  sms_payment_receipt_template: string | null
  sms_expiry_warning_template: string | null
  sms_disconnection_template: string | null
  sms_expiry_warning_days: number | null
  sms_throttle_seconds: number | null
  sms_allow_foreign: boolean | null
}

function toSettings(s: SettingRow | null): SmsSettings {
  return {
    enabled: Boolean(s?.sms_enabled),
    paymentReceipt: Boolean(s?.sms_payment_receipt_enabled),
    expiryWarning: Boolean(s?.sms_expiry_warning_enabled),
    disconnection: Boolean(s?.sms_disconnection_enabled),
    // A NULL TEMPLATE MEANS "use the built-in", not "send an empty message".
    // A company that switches a type on without ever opening the template box
    // still gets a sensible message.
    templates: {
      payment_receipt: s?.sms_payment_receipt_template || DEFAULT_TEMPLATES.payment_receipt,
      expiry_warning: s?.sms_expiry_warning_template || DEFAULT_TEMPLATES.expiry_warning,
      disconnection_notice:
        s?.sms_disconnection_template || DEFAULT_TEMPLATES.disconnection_notice,
    },
    expiryWarningDays: Number(s?.sms_expiry_warning_days ?? 3),
    throttleSeconds: Number(s?.sms_throttle_seconds ?? 6),
    allowForeign: Boolean(s?.sms_allow_foreign),
  }
}

export async function getSmsSettings(companyId: number): Promise<SmsSettings> {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return SMS_SETTINGS_OFF

  const db = tenantClient()
  const { data, error } = await db
    .from('settings').select(SETTING_COLS).eq('company_id', companyId).maybeSingle()

  if (error) throw new Error('Failed to load SMS settings: ' + error.message)
  return toSettings(data as unknown as SettingRow | null)
}

export type SmsDevice = {
  companyId: number
  label: string | null
  deviceId: string | null
  apiUsername: string | null
  /** Present so the dispatcher can authenticate. NEVER send this to a client
   *  component — see the note in getSmsDevice. */
  apiPassword: string | null
  simNumber: number | null
  lastSeenAt: string | null
  /**
   * Minutes since the relay last heard from the phone, or null if it never has.
   *
   * COMPUTED HERE, not in the page. Reading the clock inside a render — server
   * component or client — makes what the page says depend on when React happens
   * to run it, which is exactly what react-hooks/purity forbids. A data
   * function is allowed to know what time it is; a render is not.
   */
  lastSeenMinutesAgo: number | null
}

export async function getSmsDevice(companyId: number): Promise<SmsDevice | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return null

  const db = tenantClient()
  const { data, error } = await db
    .from('sms_devices')
    .select('company_id, label, device_id, api_username, api_password, sim_number, last_seen_at')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) throw new Error('Failed to load SMS device: ' + error.message)
  if (!data) return null

  const d = data as unknown as {
    company_id: number
    label: string | null
    device_id: string | null
    api_username: string | null
    api_password: string | null
    sim_number: number | null
    last_seen_at: string | null
  }

  return {
    companyId: d.company_id,
    label: d.label,
    deviceId: d.device_id,
    apiUsername: d.api_username,
    apiPassword: d.api_password,
    simNumber: d.sim_number,
    lastSeenAt: d.last_seen_at,
    lastSeenMinutesAgo: d.last_seen_at
      ? Math.round((Date.now() - new Date(d.last_seen_at).getTime()) / 60000)
      : null,
  }
}

/**
 * The device with its password removed, for anything that renders.
 *
 * A server component that passes a device object into a client component
 * serialises every field into the HTML payload. This is the shape that may
 * cross that boundary.
 */
export type SafeSmsDevice = Omit<SmsDevice, 'apiPassword'> & { hasPassword: boolean }

export function stripSecret(d: SmsDevice | null): SafeSmsDevice | null {
  if (!d) return null
  const { apiPassword, ...rest } = d
  return { ...rest, hasPassword: Boolean(apiPassword) }
}

/** Whether the tenant could send anything at all right now. */
export function canSend(settings: SmsSettings, device: SmsDevice | null): boolean {
  return settings.enabled && Boolean(device?.apiUsername && device?.apiPassword)
}

// ---------------------------------------------------------------------------
// Enqueue — the only write path into sms_outbox
// ---------------------------------------------------------------------------

export type EnqueueTarget = {
  customerId: number | null
  phone: string | null
  /** Migration 0021. Undefined reads as "not opted out". */
  optedOut?: boolean
  values: PlaceholderValues
}

export type EnqueueOutcome =
  | { queued: true; id: number }
  | { queued: false; reason: string }

/**
 * Queues one message, or explains why it did not.
 *
 * THE FIVE GATES, in the order they are cheapest to check:
 *   1. the migration is applied at all
 *   2. the master switch (settings.sms_enabled) is on
 *   3. a device is paired with usable credentials
 *   4. the customer has not opted out
 *   5. the customer has a phone this app is willing to text
 *
 * `dedupeKey` is what makes "no customer gets a message twice for the same
 * event" a guarantee: the unique index on (company_id, dedupe_key) rejects the
 * second insert, so a re-run of the daily sweep or a double-submitted form
 * cannot produce a second message. A rejected duplicate is NOT an error — it is
 * the mechanism working — so it comes back as `queued: false` with a reason,
 * and callers must not treat it as a failure.
 */
export async function enqueueSms(opts: {
  companyId: number
  kind: SmsKind
  target: EnqueueTarget
  settings: SmsSettings
  device: SmsDevice | null
  /** Null for bulk, where two messages to one customer in a day is the
   *  operator's business and not a bug. */
  dedupeKey: string | null
  batchId?: number | null
  /** Overrides the template. Used by the messaging page, which composes its own
   *  body rather than reading one from settings. */
  body?: string
}): Promise<EnqueueOutcome> {
  const { companyId, kind, target, settings, device, dedupeKey } = opts

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { queued: false, reason: 'SMS is not set up on this system.' }

  if (!settings.enabled) return { queued: false, reason: 'SMS is switched off for this company.' }

  if (!device?.apiUsername || !device?.apiPassword) {
    return { queued: false, reason: 'No phone is paired.' }
  }

  // The per-type switch. Bulk has no toggle of its own: sending it is already
  // gated by the send_bulk_sms permission and a confirmation screen, and a
  // manager who has been shown exactly who will receive a message has made a
  // more deliberate decision than any checkbox represents.
  if (kind === 'payment_receipt' && !settings.paymentReceipt) {
    return { queued: false, reason: 'Payment receipt messages are off.' }
  }
  if (kind === 'expiry_warning' && !settings.expiryWarning) {
    return { queued: false, reason: 'Expiry warning messages are off.' }
  }
  if (kind === 'disconnection_notice' && !settings.disconnection) {
    return { queued: false, reason: 'Disconnection notices are off.' }
  }

  if (target.optedOut) return { queued: false, reason: 'Customer has opted out of SMS.' }

  const phone = sendablePhone(target.phone, { allowForeign: settings.allowForeign })
  if (!phone) return { queued: false, reason: 'No usable phone number.' }

  const body = opts.body ?? renderTemplate(
    settings.templates[kind as Exclude<SmsKind, 'bulk'>] ?? '',
    target.values
  )
  if (!body.trim()) return { queued: false, reason: 'The message is empty.' }

  const db = tenantClient()
  const { data, error } = await db
    .from('sms_outbox')
    .insert({
      company_id: companyId,
      customer_id: target.customerId,
      batch_id: opts.batchId ?? null,
      kind,
      phone,
      body,
      status: 'queued',
      dedupe_key: dedupeKey,
    })
    .select('id')
    .maybeSingle()

  if (error) {
    // 23505 is the unique index on dedupe_key doing its job. Reported as a
    // skip, not an error: the message was already queued, which is the correct
    // outcome and not something for a caller to retry or surface as a fault.
    if (error.code === '23505') {
      return { queued: false, reason: 'Already queued for this event.' }
    }
    return { queued: false, reason: 'Could not queue the message: ' + error.message }
  }

  return { queued: true, id: (data as { id: number }).id }
}

// ---------------------------------------------------------------------------
// Batch history
// ---------------------------------------------------------------------------

export type SmsBatchRow = {
  id: number
  sentByName: string
  body: string
  audience: string | null
  total: number
  sent: number
  failed: number
  skipped: number
  createdAt: string
}

export async function listSmsBatches(
  companyId: number,
  limit = 50
): Promise<SmsBatchRow[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('sms_batches')
    .select('id, sent_by_name, body, audience, total, sent, failed, skipped, created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error('Failed to load message history: ' + error.message)

  return (data ?? []).map((r) => {
    const b = r as unknown as {
      id: number
      sent_by_name: string
      body: string
      audience: string | null
      total: number
      sent: number
      failed: number
      skipped: number
      created_at: string
    }
    return {
      id: b.id,
      sentByName: b.sent_by_name,
      body: b.body,
      audience: b.audience,
      total: b.total,
      sent: b.sent,
      failed: b.failed,
      skipped: b.skipped,
      createdAt: b.created_at,
    }
  })
}

export type SmsOutboxRow = {
  id: number
  customerId: number | null
  phone: string
  status: string
  attempts: number
  error: string | null
  createdAt: string
  sentAt: string | null
}

/** The individual messages of one batch — the delivery detail behind the counts. */
export async function getSmsBatchMessages(
  companyId: number,
  batchId: number
): Promise<SmsOutboxRow[]> {
  const db = tenantClient()
  const { data, error } = await db
    .from('sms_outbox')
    .select('id, customer_id, phone, status, attempts, error, created_at, sent_at')
    .eq('company_id', companyId)
    .eq('batch_id', batchId)
    .order('id', { ascending: true })

  if (error) throw new Error('Failed to load batch messages: ' + error.message)

  return (data ?? []).map((r) => {
    const m = r as unknown as {
      id: number
      customer_id: number | null
      phone: string
      status: string
      attempts: number
      error: string | null
      created_at: string
      sent_at: string | null
    }
    return {
      id: m.id,
      customerId: m.customer_id,
      phone: m.phone,
      status: m.status,
      attempts: m.attempts,
      error: m.error,
      createdAt: m.created_at,
      sentAt: m.sent_at,
    }
  })
}
