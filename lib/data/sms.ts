import 'server-only'

import { toRoute, type Channel, type Route } from '@/lib/messaging/routes'
import { getSchemaCapabilities } from '@/lib/schema'
import {
  DEFAULT_EMAIL_BODIES, DEFAULT_EMAIL_SUBJECTS, DEFAULT_TEMPLATES, type SmsKind,
} from '@/lib/sms/templates'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Reading the messaging tables: settings, the paired SMS device, batches and
 * their rows.
 *
 * THE ONLY WRITE PATH INTO THE OUTBOX IS lib/messaging/enqueue.ts, for every
 * channel. Every rule about whether a customer may be messaged is decided
 * there and nowhere else; a second insert written by hand somewhere would
 * bypass all of them, which is the same reasoning that makes logEvent the
 * sole writer of the `log` table.
 */

export type NotifyKind = Exclude<SmsKind, 'bulk'>
export type RoutedKind = SmsKind

/**
 * A company's messaging configuration, every channel.
 *
 * The switches are in two layers on purpose. A MASTER SWITCH PER CHANNEL
 * (`smsEnabled`, `emailEnabled`) is what an owner reaches for when a SIM
 * starts being flagged or a mailbox starts bouncing; a SWITCH PER KIND
 * (`paymentReceipt`, ...) says whether that message is sent at all; and a
 * ROUTE PER KIND says by which channel, and what to do when a customer could
 * be reached both ways. The route is the company's decision — see
 * lib/messaging/routes.ts — and nothing here decides it for them.
 */
export type MessagingSettings = {
  /** settings.sms_enabled — the SMS master switch. */
  smsEnabled: boolean
  /** settings.email_enabled — the email master switch (0007, gating since 0022). */
  emailEnabled: boolean
  paymentReceipt: boolean
  expiryWarning: boolean
  disconnection: boolean
  routes: Record<RoutedKind, Route>
  smsTemplates: Record<NotifyKind, string>
  emailTemplates: Record<NotifyKind, { subject: string; body: string }>
  expiryWarningDays: number
  throttleSeconds: number
  allowForeign: boolean
  emailFromName: string | null
  emailReplyTo: string | null
  emailFromDomain: string | null
  emailFromDomainVerified: boolean
  /** For the email From header and reply-to fallbacks. */
  companyName: string
  companyEmail: string | null
  /** Whether 0022 is applied, so a caller can tell "SMS only" from "chose SMS". */
  channelsAvailable: boolean
}

/** Kept as a name: the SMS settings form and the SMS actions still say it. */
export type SmsSettings = MessagingSettings

const DEFAULT_ROUTES: Record<RoutedKind, Route> = {
  payment_receipt: 'sms', expiry_warning: 'sms', disconnection_notice: 'sms', bulk: 'sms',
}

const DEFAULT_EMAIL_TEMPLATES: Record<NotifyKind, { subject: string; body: string }> = {
  payment_receipt: { subject: DEFAULT_EMAIL_SUBJECTS.payment_receipt, body: DEFAULT_EMAIL_BODIES.payment_receipt },
  expiry_warning: { subject: DEFAULT_EMAIL_SUBJECTS.expiry_warning, body: DEFAULT_EMAIL_BODIES.expiry_warning },
  disconnection_notice: { subject: DEFAULT_EMAIL_SUBJECTS.disconnection_notice, body: DEFAULT_EMAIL_BODIES.disconnection_notice },
}

/** What a tenant looks like before they have configured anything. */
export const SMS_SETTINGS_OFF: MessagingSettings = {
  smsEnabled: false,
  emailEnabled: false,
  paymentReceipt: false,
  expiryWarning: false,
  disconnection: false,
  routes: DEFAULT_ROUTES,
  smsTemplates: DEFAULT_TEMPLATES,
  emailTemplates: DEFAULT_EMAIL_TEMPLATES,
  expiryWarningDays: 3,
  throttleSeconds: 6,
  allowForeign: false,
  emailFromName: null,
  emailReplyTo: null,
  emailFromDomain: null,
  emailFromDomainVerified: false,
  companyName: '',
  companyEmail: null,
  channelsAvailable: false,
}

// 0021's columns. The per-kind switches are selected under whichever name the
// schema has: sms_* before 0022, notify_* after — see the rename in 0022.
const BASE_COLS =
  'sms_enabled, sms_payment_receipt_template, ' +
  'sms_expiry_warning_template, sms_disconnection_template, ' +
  'sms_expiry_warning_days, sms_throttle_seconds, sms_allow_foreign'
const SWITCH_COLS_0021 =
  'sms_payment_receipt_enabled, sms_expiry_warning_enabled, sms_disconnection_enabled'
const SWITCH_COLS_0022 =
  'notify_payment_receipt_enabled, notify_expiry_warning_enabled, notify_disconnection_enabled'
const MESSAGING_COLS =
  'email_enabled, email_from_name, email_reply_to, email_from_domain, email_from_domain_verified, ' +
  'route_payment_receipt, route_expiry_warning, route_disconnection_notice, route_bulk, ' +
  'email_payment_receipt_subject, email_payment_receipt_body, ' +
  'email_expiry_warning_subject, email_expiry_warning_body, ' +
  'email_disconnection_subject, email_disconnection_body'

type SettingRow = {
  sms_enabled: boolean | null
  sms_payment_receipt_enabled?: boolean | null
  sms_expiry_warning_enabled?: boolean | null
  sms_disconnection_enabled?: boolean | null
  notify_payment_receipt_enabled?: boolean | null
  notify_expiry_warning_enabled?: boolean | null
  notify_disconnection_enabled?: boolean | null
  sms_payment_receipt_template: string | null
  sms_expiry_warning_template: string | null
  sms_disconnection_template: string | null
  sms_expiry_warning_days: number | null
  sms_throttle_seconds: number | null
  sms_allow_foreign: boolean | null
  email_enabled?: boolean | null
  email_from_name?: string | null
  email_reply_to?: string | null
  email_from_domain?: string | null
  email_from_domain_verified?: boolean | null
  route_payment_receipt?: string | null
  route_expiry_warning?: string | null
  route_disconnection_notice?: string | null
  route_bulk?: string | null
  email_payment_receipt_subject?: string | null
  email_payment_receipt_body?: string | null
  email_expiry_warning_subject?: string | null
  email_expiry_warning_body?: string | null
  email_disconnection_subject?: string | null
  email_disconnection_body?: string | null
}

function toSettings(
  s: SettingRow | null,
  company: { name: string; email: string | null },
  channelsAvailable: boolean
): MessagingSettings {
  return {
    smsEnabled: Boolean(s?.sms_enabled),
    emailEnabled: channelsAvailable && Boolean(s?.email_enabled),
    paymentReceipt: Boolean(s?.notify_payment_receipt_enabled ?? s?.sms_payment_receipt_enabled),
    expiryWarning: Boolean(s?.notify_expiry_warning_enabled ?? s?.sms_expiry_warning_enabled),
    disconnection: Boolean(s?.notify_disconnection_enabled ?? s?.sms_disconnection_enabled),
    routes: {
      payment_receipt: toRoute(s?.route_payment_receipt),
      expiry_warning: toRoute(s?.route_expiry_warning),
      disconnection_notice: toRoute(s?.route_disconnection_notice),
      bulk: toRoute(s?.route_bulk),
    },
    // A NULL TEMPLATE MEANS "use the built-in", not "send an empty message".
    // A company that switches a type on without ever opening the template box
    // still gets a sensible message.
    smsTemplates: {
      payment_receipt: s?.sms_payment_receipt_template || DEFAULT_TEMPLATES.payment_receipt,
      expiry_warning: s?.sms_expiry_warning_template || DEFAULT_TEMPLATES.expiry_warning,
      disconnection_notice:
        s?.sms_disconnection_template || DEFAULT_TEMPLATES.disconnection_notice,
    },
    emailTemplates: {
      payment_receipt: {
        subject: s?.email_payment_receipt_subject || DEFAULT_EMAIL_SUBJECTS.payment_receipt,
        body: s?.email_payment_receipt_body || DEFAULT_EMAIL_BODIES.payment_receipt,
      },
      expiry_warning: {
        subject: s?.email_expiry_warning_subject || DEFAULT_EMAIL_SUBJECTS.expiry_warning,
        body: s?.email_expiry_warning_body || DEFAULT_EMAIL_BODIES.expiry_warning,
      },
      disconnection_notice: {
        subject: s?.email_disconnection_subject || DEFAULT_EMAIL_SUBJECTS.disconnection_notice,
        body: s?.email_disconnection_body || DEFAULT_EMAIL_BODIES.disconnection_notice,
      },
    },
    expiryWarningDays: Number(s?.sms_expiry_warning_days ?? 3),
    throttleSeconds: Number(s?.sms_throttle_seconds ?? 6),
    allowForeign: Boolean(s?.sms_allow_foreign),
    emailFromName: s?.email_from_name || null,
    emailReplyTo: s?.email_reply_to || null,
    emailFromDomain: s?.email_from_domain || null,
    emailFromDomainVerified: Boolean(s?.email_from_domain_verified),
    companyName: company.name,
    companyEmail: company.email,
    channelsAvailable,
  }
}

export async function getSmsSettings(companyId: number): Promise<MessagingSettings> {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return SMS_SETTINGS_OFF

  const cols = BASE_COLS + ', ' +
    (caps.messaging ? SWITCH_COLS_0022 + ', ' + MESSAGING_COLS : SWITCH_COLS_0021)

  const db = tenantClient()
  const [{ data, error }, { data: co }] = await Promise.all([
    db.from('settings').select(cols).eq('company_id', companyId).maybeSingle(),
    db.from('companies').select('name, email').eq('id', companyId).maybeSingle(),
  ])

  if (error) throw new Error('Failed to load messaging settings: ' + error.message)
  const company = (co as { name: string; email: string | null } | null) ?? { name: '', email: null }
  return toSettings(data as unknown as SettingRow | null, company, caps.messaging)
}

/** getSmsSettings under its channel-neutral name. Same function. */
export const getMessagingSettings = getSmsSettings

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

/**
 * The audience stamp of a batch sent to a typed-in number rather than to a
 * customer selection. The batch pages use it to tell "this row never had a
 * customer" from "this customer has since been deleted", which the outbox row
 * alone cannot: both have a null customer_id.
 */
export const DIRECT_AUDIENCE_PREFIX = 'Direct to +'

export function isDirectAudience(audience: string | null | undefined): boolean {
  return (audience ?? '').startsWith(DIRECT_AUDIENCE_PREFIX)
}

/** Whether the tenant could send SMS at all right now. Email readiness is the email adapter's. */
export function canSend(settings: SmsSettings, device: SmsDevice | null): boolean {
  return settings.smsEnabled && Boolean(device?.apiUsername && device?.apiPassword)
}

// Enqueue lives in lib/messaging/enqueue.ts — the only write path into the
// outbox, for every channel.

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
  /**
   * A one-number send rather than a customer selection. Same table, same
   * shape — one batch row, one outbox row — but the messaging page lists them
   * apart, because twenty test messages to the operator's own phone are not
   * twenty batches and must not read as one batch broken into pieces.
   */
  direct: boolean
  /** The E.164 number of a direct send, without the plus. Null otherwise. */
  directTo: string | null
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
    const direct = isDirectAudience(b.audience)
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
      direct,
      directTo: direct ? (b.audience ?? '').slice(DIRECT_AUDIENCE_PREFIX.length) : null,
    }
  })
}

export type SmsOutboxRow = {
  id: number
  customerId: number | null
  channel: Channel
  /** The address on the wire: E.164 for SMS, an address for email. */
  recipient: string
  subject: string | null
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
  const caps = await getSchemaCapabilities()
  const db = tenantClient()
  const { data, error } = await db
    .from('sms_outbox')
    .select(
      'id, customer_id, phone, status, attempts, error, created_at, sent_at' +
      (caps.messaging ? ', channel, recipient, subject' : '')
    )
    .eq('company_id', companyId)
    .eq('batch_id', batchId)
    .order('id', { ascending: true })

  if (error) throw new Error('Failed to load batch messages: ' + error.message)

  return (data ?? []).map((r) => {
    const m = r as unknown as {
      id: number
      customer_id: number | null
      phone: string | null
      channel?: string
      recipient?: string
      subject?: string | null
      status: string
      attempts: number
      error: string | null
      created_at: string
      sent_at: string | null
    }
    return {
      id: m.id,
      customerId: m.customer_id,
      channel: (m.channel === 'email' ? 'email' : 'sms') as Channel,
      recipient: m.recipient ?? m.phone ?? '',
      subject: m.subject ?? null,
      status: m.status,
      attempts: m.attempts,
      error: m.error,
      createdAt: m.created_at,
      sentAt: m.sent_at,
    }
  })
}
