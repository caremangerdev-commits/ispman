'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  applyFilters, describeFilters, explainNoMatch, type CustomerFilters, type FilterNames,
} from '@/lib/customer-filter'
import { listMiscCategories, listServicePlans } from '@/lib/data/catalog'
import { loadEnrichedCustomers, type CustomerListRow } from '@/lib/data/customers'
import {
  DIRECT_AUDIENCE_PREFIX, getSmsSettings, type NotifyKind,
} from '@/lib/data/sms'
import { isEmail } from '@/lib/email'
import { CURRENCY_SYMBOL, formatCurrency } from '@/lib/format'
import { channelReadiness, enqueueForRoute, enqueueMessage } from '@/lib/messaging/enqueue'
import { adapterFor } from '@/lib/messaging/registry'
import { describeSkip, resolveRoute } from '@/lib/messaging/route'
import {
  CHANNEL_LABELS, CHANNELS, channelsOf, toRoute, type Channel, type Route,
} from '@/lib/messaging/routes'
import { classifyPhone, PHONE_SKIP_REASON, sendablePhone } from '@/lib/phone'
import { getSchemaCapabilities } from '@/lib/schema'
import { displayName, requirePermission } from '@/lib/session'
import { refreshBatchCounts, syncDelivery } from '@/lib/sms/delivery'
import { verifyCredentials } from '@/lib/sms/relay'
import {
  countSegments, customerPlaceholders, renderTemplate, unknownPlaceholders,
} from '@/lib/sms/templates'
import { STATUS_LABELS } from '@/lib/status'
import { tenantClient } from '@/lib/supabase/tenant'

export type SmsActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

const str = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const bool = (fd: FormData, k: string) => fd.get(k) === 'on' || fd.get(k) === 'true'
const num = (fd: FormData, k: string) => {
  const v = str(fd, k)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Saves a company's SMS configuration.
 *
 * SETTINGS ARE manage_company_settings; SENDING IS send_bulk_sms. Turning the
 * feature on and using it are different acts, and a role that may configure a
 * tenant is not automatically a role that should be speaking to its customers.
 */
export async function saveSmsSettings(
  _prev: SmsActionResult | null,
  formData: FormData
): Promise<SmsActionResult> {
  const { company } = await requirePermission('manage_company_settings')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) {
    return { ok: false, error: 'SMS is not set up on this system yet.' }
  }

  const fieldErrors: Record<string, string> = {}

  const days = num(formData, 'sms_expiry_warning_days') ?? 3
  if (days < 1 || days > 30) {
    fieldErrors.sms_expiry_warning_days = 'Choose between 1 and 30 days.'
  }

  const throttle = num(formData, 'sms_throttle_seconds') ?? 6
  if (throttle < 1 || throttle > 600) {
    fieldErrors.sms_throttle_seconds = 'Choose between 1 and 600 seconds.'
  }

  // Templates are validated, not silently accepted. A placeholder this app
  // cannot fill reaches the customer as the literal text "{{blance}}", and the
  // moment to catch that is before 1,276 people receive it.
  const templates = {
    sms_payment_receipt_template: str(formData, 'sms_payment_receipt_template'),
    sms_expiry_warning_template: str(formData, 'sms_expiry_warning_template'),
    sms_disconnection_template: str(formData, 'sms_disconnection_template'),
  }
  for (const [field, text] of Object.entries(templates)) {
    if (!text) continue
    const unknown = unknownPlaceholders(text)
    if (unknown.length > 0) {
      fieldErrors[field] = 'Unknown placeholder: ' + unknown.join(', ')
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  const before = await getSmsSettings(company.id)

  // The per-kind switches are named sms_* before 0022 and notify_* after —
  // one switch per kind either way, under whichever name the schema has.
  const prefix = caps.messaging ? 'notify_' : 'sms_'

  const patch: Record<string, unknown> = {
    sms_enabled: bool(formData, 'sms_enabled'),
    // Empty means "use the built-in default", so it is stored as NULL rather
    // than as an empty string that would send a blank message.
    sms_payment_receipt_template: templates.sms_payment_receipt_template || null,
    sms_expiry_warning_template: templates.sms_expiry_warning_template || null,
    sms_disconnection_template: templates.sms_disconnection_template || null,
    sms_expiry_warning_days: days,
    sms_throttle_seconds: throttle,
    sms_allow_foreign: bool(formData, 'sms_allow_foreign'),
  }
  patch[prefix + 'payment_receipt_enabled'] = bool(formData, 'sms_payment_receipt_enabled')
  patch[prefix + 'expiry_warning_enabled'] = bool(formData, 'sms_expiry_warning_enabled')
  patch[prefix + 'disconnection_enabled'] = bool(formData, 'sms_disconnection_enabled')

  const db = tenantClient()
  const { error } = await db
    .from('settings')
    .update(patch)
    .eq('company_id', company.id)

  if (error) return { ok: false, error: 'Could not save: ' + error.message }

  const after = await getSmsSettings(company.id)

  // The master switch is the one worth an audit row on its own: it is what an
  // owner reaches for when a SIM starts being flagged, and "when did messages
  // stop going out" is a question somebody will ask.
  if (before.smsEnabled !== after.smsEnabled) {
    await logEvent({
      type: 'sms_master_switch',
      details: 'SMS ' + (after.smsEnabled ? 'enabled' : 'disabled') + ' for the company',
      tag: '[sms]',
    })
  }

  revalidatePath('/dashboard/settings/sms')
  return { ok: true, message: 'SMS settings saved.' }
}

/**
 * Saves the email sender and, per message kind, WHICH CHANNEL IT GOES BY and
 * the email wording. The company's decision — see lib/messaging/routes.ts.
 */
export async function saveNotificationRoutes(
  _prev: SmsActionResult | null,
  formData: FormData
): Promise<SmsActionResult> {
  const { company } = await requirePermission('manage_company_settings')

  const caps = await getSchemaCapabilities()
  if (!caps.messaging) return { ok: false, error: 'Email needs migration 0022. Ask your administrator.' }

  const fieldErrors: Record<string, string> = {}

  const replyTo = str(formData, 'email_reply_to').toLowerCase()
  if (replyTo && !isEmail(replyTo)) fieldErrors.email_reply_to = 'Enter a valid email address.'

  const kinds: NotifyKind[] = ['payment_receipt', 'expiry_warning', 'disconnection_notice']
  const routes: Record<string, Route> = {}
  for (const kind of [...kinds, 'bulk' as const]) {
    const raw = str(formData, 'route_' + kind)
    routes[kind] = toRoute(raw)
    if (raw && routes[kind] !== raw) fieldErrors['route_' + kind] = 'Choose one of the listed options.'
  }

  const emailFields: Record<string, string | null> = {}
  for (const kind of kinds) {
    const col = kind === 'disconnection_notice' ? 'disconnection' : kind
    for (const part of ['subject', 'body'] as const) {
      const field = 'email_' + kind + '_' + part
      const text = str(formData, field)
      const unknown = unknownPlaceholders(text)
      if (unknown.length > 0) fieldErrors[field] = 'Unknown placeholder: ' + unknown.join(', ')
      emailFields['email_' + col + '_' + part] = text || null
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  const before = await getSmsSettings(company.id)

  const { error } = await tenantClient()
    .from('settings')
    .update({
      email_enabled: bool(formData, 'email_enabled'),
      email_from_name: str(formData, 'email_from_name') || null,
      email_reply_to: replyTo || null,
      route_payment_receipt: routes.payment_receipt,
      route_expiry_warning: routes.expiry_warning,
      route_disconnection_notice: routes.disconnection_notice,
      route_bulk: routes.bulk,
      ...emailFields,
    })
    .eq('company_id', company.id)

  if (error) return { ok: false, error: 'Could not save: ' + error.message }

  const after = await getSmsSettings(company.id)
  if (before.emailEnabled !== after.emailEnabled) {
    await logEvent({
      type: 'email_master_switch',
      details: 'Email ' + (after.emailEnabled ? 'enabled' : 'disabled') + ' for the company',
      tag: '[messaging]',
    })
  }

  revalidatePath('/dashboard/settings/sms')
  revalidatePath('/dashboard/messages')
  return { ok: true, message: 'Notification settings saved.' }
}

/**
 * Stores the relay credentials a phone generated when it registered.
 *
 * These are the DEVICE'S credentials from the relay, not the relay's private
 * token — see supabase/migrations/0021_sms.sql. The token never reaches this
 * app, because it is the same for every tenant on the box and a company admin
 * holding it could register a device against another tenant's relay.
 */
export async function pairSmsDevice(
  _prev: SmsActionResult | null,
  formData: FormData
): Promise<SmsActionResult> {
  const { company } = await requirePermission('manage_company_settings')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false, error: 'SMS is not set up on this system yet.' }

  const username = str(formData, 'api_username')
  const password = str(formData, 'api_password')
  const label = str(formData, 'label')
  const simRaw = num(formData, 'sim_number')

  const fieldErrors: Record<string, string> = {}
  if (!username) fieldErrors.api_username = 'Enter the username the app shows.'
  if (!password) fieldErrors.api_password = 'Enter the password the app shows.'
  if (simRaw !== null && (simRaw < 1 || simRaw > 3)) {
    fieldErrors.sim_number = 'SIM must be 1, 2 or 3.'
  }
  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  // VERIFIED BEFORE IT IS STORED. Saving credentials that do not work leaves a
  // tenant with a settings page that says "paired" and a queue that silently
  // fails every message, which is the worst of both.
  const check = await verifyCredentials({ username, password })
  if (!check.ok) return { ok: false, error: check.message }

  const device = check.devices[0]

  const db = tenantClient()
  const { error } = await db
    .from('sms_devices')
    .upsert({
      company_id: company.id,
      label: label || device?.name || null,
      device_id: device?.id ?? null,
      api_username: username,
      api_password: password,
      sim_number: simRaw,
      last_seen_at: device?.lastSeen ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id' })

  if (error) return { ok: false, error: 'Could not save the device: ' + error.message }

  await logEvent({
    type: 'sms_device_paired',
    details: 'SMS device paired' + (label ? ' | label=' + label : '') +
      ' | user=' + username,
    tag: '[sms]',
  })

  revalidatePath('/dashboard/settings/sms')
  return { ok: true, message: check.message }
}

export async function unpairSmsDevice(): Promise<SmsActionResult> {
  const { company } = await requirePermission('manage_company_settings')

  const db = tenantClient()
  const { error } = await db.from('sms_devices').delete().eq('company_id', company.id)
  if (error) return { ok: false, error: 'Could not remove the device: ' + error.message }

  await logEvent({ type: 'sms_device_unpaired', details: 'SMS device removed', tag: '[sms]' })

  revalidatePath('/dashboard/settings/sms')
  return { ok: true, message: 'Device removed. Nothing will send until one is paired again.' }
}

// ---------------------------------------------------------------------------
// Bulk messaging
// ---------------------------------------------------------------------------

export type ChannelCount = { channel: Channel; label: string; count: number }

export type AudiencePreview = {
  matched: number
  /** Customers who get at least one message. */
  sendable: number
  /** Messages per channel — a customer on a `both` route counts on each. */
  byChannel: ChannelCount[]
  optedOut: number
  /** Reason -> how many, for the "who will be skipped and why" panel. */
  skipped: { reason: string; count: number }[]
  /** Seconds, at the slowest channel's throttle. */
  estimatedSeconds: number
  audience: string
  /** The route this preview was computed for, in words. */
  routeLabel: string
  /** Channels the route wants that this company cannot send on right now, with why. */
  unavailable: { channel: Channel; reason: string }[]
  /**
   * Why `matched` is zero, filter by filter. Empty unless it is zero and at
   * least one filter is active — see lib/customer-filter.ts#explainNoMatch.
   */
  emptyReasons: string[]
  segments: number
  encoding: string
  characters: number
}

async function filterNames(companyId: number): Promise<FilterNames> {
  const [categories, plans] = await Promise.all([
    listMiscCategories(companyId).catch(() => []),
    listServicePlans(companyId).catch(() => []),
  ])
  return {
    status: (s) => STATUS_LABELS[s],
    miscCategory: (id) => categories.find((c) => c.id === id)?.name,
    servicePlan: (id) => plans.find((p) => p.id === id)?.name,
    currency: (n) => CURRENCY_SYMBOL + n.toLocaleString(),
  }
}

/** The route a send uses: the operator's choice if one was made, else the company's bulk route. */
function bulkRoute(requested: string | null | undefined, stored: Route, channelsAvailable: boolean): Route {
  if (!channelsAvailable) return 'sms'
  return requested ? toRoute(requested) : stored
}

function recipientBits(c: CustomerListRow) {
  return {
    id: c.id, phone: c.phone, email: c.email,
    sms_opted_out: c.sms_opted_out, email_opted_out: c.email_opted_out,
  }
}

/**
 * Who a batch would reach, and who it would not — PER CHANNEL, by the route.
 *
 * READ-ONLY AND SEPARATE FROM SENDING, deliberately. This is what the operator
 * confirms; sendBulkSms recomputes it from the same filters and the same route
 * resolver rather than trusting a list of ids posted back from the browser, so
 * a stale tab cannot message people who have since opted out.
 */
export async function previewAudience(
  filters: CustomerFilters,
  body: string,
  route?: string
): Promise<AudiencePreview> {
  const { company } = await requirePermission('send_bulk_sms')

  const [settings, customers, names] = await Promise.all([
    getSmsSettings(company.id),
    loadEnrichedCustomers(company.id),
    filterNames(company.id),
  ])
  const readiness = await channelReadiness(company.id, settings)
  const chosen = bulkRoute(route, settings.routes.bulk, settings.channelsAvailable)

  const matched = applyFilters(customers, filters)

  const perChannel: Record<Channel, number> = { sms: 0, email: 0 }
  const byReason = new Map<string, number>()
  let sendable = 0
  let optedOut = 0

  for (const c of matched) {
    const r = resolveRoute({ route: chosen, customer: recipientBits(c), settings, ready: readiness })
    if (r.targets.length > 0) {
      sendable += 1
      for (const t of r.targets) perChannel[t.channel] += 1
      continue
    }
    if (r.skipped.some((s) => s.reason.startsWith('Opted out'))) optedOut += 1
    const reason = describeSkip(r)
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }

  const seg = countSegments(body)
  const used = channelsOf(chosen).filter((ch) => perChannel[ch] > 0)
  // The slowest channel decides how long the run takes; SMS segments multiply
  // its own share only.
  const estimatedSeconds = Math.max(0, ...used.map((ch) =>
    perChannel[ch] * adapterFor(ch).throttleSeconds(settings) * (ch === 'sms' ? Math.max(1, seg.segments) : 1)
  ))

  return {
    matched: matched.length,
    sendable,
    byChannel: CHANNELS.filter((ch) => channelsOf(chosen).includes(ch))
      .map((ch) => ({ channel: ch, label: CHANNEL_LABELS[ch], count: perChannel[ch] })),
    optedOut,
    skipped: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    estimatedSeconds,
    audience: describeFilters(filters, names),
    routeLabel: chosen,
    unavailable: channelsOf(chosen)
      .filter((ch) => !readiness[ch].ready)
      .map((ch) => ({ channel: ch, reason: (readiness[ch] as { reason: string }).reason })),
    emptyReasons: explainNoMatch(customers, filters, names),
    segments: seg.segments,
    encoding: seg.encoding,
    characters: seg.characters,
  }
}

export type SendBulkResult =
  | { ok: true; batchId: number; queued: number; skipped: number; message: string }
  | { ok: false; error: string }

async function startBatch(opts: {
  companyId: number
  profile: { id: number; first_name: string | null; last_name: string | null; email: string }
  body: string
  audience: string
  total: number
  skipped: number
}): Promise<{ id: number } | { error: string }> {
  const { data, error } = await tenantClient()
    .from('sms_batches')
    .insert({
      company_id: opts.companyId,
      sent_by: opts.profile.id,
      // Stamped, not joined. A staff member who leaves and is deleted must not
      // erase who sent a message to 400 customers.
      sent_by_name: displayName(opts.profile),
      body: opts.body,
      audience: opts.audience,
      total: opts.total,
      sent: 0,
      failed: 0,
      skipped: opts.skipped,
    })
    .select('id')
    .single()
  if (error || !data) return { error: 'Could not start the batch: ' + (error?.message ?? '') }
  return { id: (data as { id: number }).id }
}

/**
 * Queues a message to everyone the filters select, by the chosen route.
 *
 * RECOMPUTES THE AUDIENCE. The browser sends the filters and the route, never
 * a list of customer ids or channels: the confirmation screen and this
 * function ask the same resolver the same question, so what was confirmed is
 * what is queued, as of now.
 *
 * NOTHING IS SENT HERE. Rows go into the outbox and the dispatcher drains them
 * at each channel's throttle.
 */
export async function sendBulkSms(
  filters: CustomerFilters,
  body: string,
  route?: string,
  subject?: string
): Promise<SendBulkResult> {
  const { company, profile } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false, error: 'Messaging is not set up on this system yet.' }

  const text = body.trim()
  if (!text) return { ok: false, error: 'The message is empty.' }
  const unknown = unknownPlaceholders(text)
  if (unknown.length > 0) return { ok: false, error: 'Unknown placeholder: ' + unknown.join(', ') }

  const settings = await getSmsSettings(company.id)
  const readiness = await channelReadiness(company.id, settings)
  const chosen = bulkRoute(route, settings.routes.bulk, settings.channelsAvailable)

  if (!channelsOf(chosen).some((ch) => readiness[ch].ready)) {
    const first = readiness[channelsOf(chosen)[0]]
    return { ok: false, error: first.ready ? 'Nothing can be sent right now.' : first.reason }
  }

  const emailSubject = (subject ?? '').trim()
  if (channelsOf(chosen).includes('email') && readiness.email.ready && !emailSubject) {
    return { ok: false, error: 'An email needs a subject line.' }
  }

  const preview = await previewAudience(filters, text, chosen)
  if (preview.sendable === 0) {
    return { ok: false, error: 'No one in this selection can be reached by ' + chosen.replace(/_/g, ' ') + '.' }
  }

  const customers = applyFilters(await loadEnrichedCustomers(company.id), filters)

  // The batch row first. If it fails, nothing is queued — better than messages
  // going out with no record of who sent them or why.
  const batch = await startBatch({
    companyId: company.id, profile, body: text, audience: preview.audience,
    total: preview.sendable, skipped: preview.matched - preview.sendable,
  })
  if ('error' in batch) return { ok: false, error: batch.error }

  let queued = 0
  let skipped = 0
  for (const c of customers) {
    const result = await enqueueForRoute({
      companyId: company.id,
      kind: 'bulk',
      settings,
      readiness,
      route: chosen,
      customer: recipientBits(c),
      values: {
        '{{name}}': [c.first_name, c.last_name].filter(Boolean).join(' '),
        '{{first_name}}': c.first_name ?? '',
        '{{account}}': c.account_number ?? '',
        '{{balance}}': formatCurrency(c.carried_balance ?? 0),
        '{{expiry}}': c.radiusExpiryDate ?? '',
        '{{company}}': company.name,
      },
      text: { sms: text, email: { subject: emailSubject, body: text } },
      // Null: two different messages to one customer on one day is the
      // operator's business, and deduping bulk would silently drop the second.
      dedupeKey: null,
      batchId: batch.id,
    })
    if (result.queued.length > 0) queued += 1
    else skipped += 1
  }

  await tenantClient().from('sms_batches').update({ total: queued, skipped }).eq('id', batch.id)

  await logEvent({
    type: 'sms_bulk_sent',
    details:
      'Bulk message queued | batch=' + batch.id + ' | route=' + chosen +
      ' | recipients=' + queued + ' | skipped=' + skipped + ' | audience=' + preview.audience,
    tag: '[messaging]',
  })

  revalidatePath('/dashboard/messages')

  return {
    ok: true,
    batchId: batch.id,
    queued,
    skipped,
    message: queued + ' customer' + (queued === 1 ? '' : 's') + ' queued.',
  }
}

/**
 * Queues one message to a typed-in number OR email address: a technician, a
 * supplier, the operator's own phone or inbox to check a channel is alive.
 *
 * Same permission, same gates and the same write path as a bulk send. What it
 * skips is the customer lookup: the address is the recipient, not a record.
 * It still gets a batch row, because a message to someone who is not a
 * customer is exactly the one someone will later ask about.
 */
export async function sendDirectSms(to: string, body: string, subject?: string): Promise<SendBulkResult> {
  const { company, profile } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false, error: 'Messaging is not set up on this system yet.' }

  const text = body.trim()
  if (!text) return { ok: false, error: 'The message is empty.' }

  const unknown = unknownPlaceholders(text)
  if (unknown.length > 0) return { ok: false, error: 'Unknown placeholder: ' + unknown.join(', ') }

  // Refused rather than filled with blanks: there is no customer to fill them
  // from, and "Hi , your account  expires " is not a message anyone meant.
  const needsCustomer = customerPlaceholders(text)
  if (needsCustomer.length > 0) {
    return {
      ok: false,
      error:
        'This message uses ' + needsCustomer.join(', ') + ', which can only be filled ' +
        'in from a customer record. Remove it or send to customers instead.',
    }
  }

  const settings = await getSmsSettings(company.id)
  const readiness = await channelReadiness(company.id, settings)

  // An address with an @ is an email; anything else is judged as a phone.
  const raw = to.trim()
  const channel: Channel = raw.includes('@') ? 'email' : 'sms'
  let recipient: string
  if (channel === 'email') {
    recipient = raw.toLowerCase()
    if (!isEmail(recipient)) return { ok: false, error: 'That is not a valid email address.' }
    if (!(subject ?? '').trim()) return { ok: false, error: 'An email needs a subject line.' }
  } else {
    const e164 = sendablePhone(raw, { allowForeign: settings.allowForeign })
    if (!e164) {
      const kind = classifyPhone(raw).kind
      return { ok: false, error: (kind === 'jamaica' ? 'That number cannot be sent to' : PHONE_SKIP_REASON[kind]) + '.' }
    }
    recipient = e164
  }

  const ready = readiness[channel]
  if (!ready.ready) return { ok: false, error: ready.reason }

  const audience = DIRECT_AUDIENCE_PREFIX + (channel === 'sms' ? recipient : '') + (channel === 'email' ? recipient : '')
  const rendered = renderTemplate(text, { '{{company}}': company.name })

  const batch = await startBatch({
    companyId: company.id, profile, body: text, audience, total: 1, skipped: 0,
  })
  if ('error' in batch) return { ok: false, error: batch.error }

  const result = await enqueueMessage({
    companyId: company.id,
    channel,
    kind: 'bulk',
    customerId: null,
    recipient,
    subject: channel === 'email' ? renderTemplate((subject ?? '').trim(), { '{{company}}': company.name }) : null,
    body: rendered,
    dedupeKey: null,
    batchId: batch.id,
  })

  if (!result.queued) {
    await tenantClient().from('sms_batches').update({ total: 0, skipped: 1 }).eq('id', batch.id)
    return { ok: false, error: result.reason }
  }

  await logEvent({
    type: 'sms_direct_sent',
    details:
      'Direct ' + CHANNEL_LABELS[channel] + ' queued | batch=' + batch.id + ' | to=' +
      (channel === 'sms' ? '+' : '') + recipient + ' | by=' + displayName(profile),
    tag: '[messaging]',
  })

  revalidatePath('/dashboard/messages')

  return {
    ok: true,
    batchId: batch.id,
    queued: 1,
    skipped: 0,
    message: 'Message to ' + (channel === 'sms' ? '+' : '') + recipient + ' queued.',
  }
}

/** A customer's own choice, per channel, from their record. Outranks every company switch. */
export async function setOptOut(customerId: number, channel: Channel, optedOut: boolean) {
  const { company } = await requirePermission('edit_customer')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false as const, error: 'Messaging is not set up on this system yet.' }
  if (channel === 'email' && !caps.messaging) {
    return { ok: false as const, error: 'Email needs migration 0022.' }
  }

  const patch: Record<string, unknown> = {}
  patch[channel === 'email' ? 'email_opted_out' : 'sms_opted_out'] = optedOut
  const { error } = await tenantClient()
    .from('customers')
    .update(patch)
    .eq('company_id', company.id)
    .eq('id', customerId)

  if (error) return { ok: false as const, error: 'Could not save: ' + error.message }

  await logEvent({
    type: channel === 'email' ? 'email_opt_out' : 'sms_opt_out',
    details: optedOut
      ? 'Customer opted out of ' + CHANNEL_LABELS[channel]
      : 'Customer opted back in to ' + CHANNEL_LABELS[channel],
    customerId,
    tag: '[messaging]',
  })

  revalidatePath('/dashboard/customers/' + customerId)
  return { ok: true as const }
}

/** The SMS opt-out under its original name, for the existing caller. */
export async function setSmsOptOut(customerId: number, optedOut: boolean) {
  return setOptOut(customerId, 'sms', optedOut)
}

// ---------------------------------------------------------------------------
// Batch delivery and retry
// ---------------------------------------------------------------------------

export type BatchActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string }

/** The batch, if it belongs to this company. Scoping is what makes the id safe to take from a form. */
async function ownBatch(companyId: number, batchId: number) {
  const { data } = await tenantClient()
    .from('sms_batches').select('id, total').eq('company_id', companyId).eq('id', batchId).maybeSingle()
  return data as { id: number; total: number } | null
}

/**
 * Asks the providers what became of every message in a batch that ISPMan
 * still has as merely 'sent'.
 *
 * The dispatcher does this on its own for recent rows, a few dozen a tick; this
 * is the same call for one batch, all at once, for the operator standing on
 * its page who wants the answer now.
 */
export async function checkBatchDelivery(batchId: number): Promise<BatchActionResult> {
  const { company } = await requirePermission('send_bulk_sms')

  const batch = await ownBatch(company.id, batchId)
  if (!batch) return { ok: false, error: 'That batch does not exist.' }

  const r = await syncDelivery({ companyId: company.id, batchId, limit: 2000 })
  await refreshBatchCounts(batchId)
  revalidatePath('/dashboard/messages/' + batchId)
  revalidatePath('/dashboard/messages')

  if (r.checked === 0) {
    return { ok: true, message: 'Nothing left to check: every message in this batch is already resolved.' }
  }
  return {
    ok: true,
    message:
      'Checked ' + r.checked + ': ' + r.delivered + ' delivered, ' + r.failed + ' failed, ' +
      r.pending + ' still in progress' + (r.unknown ? ', ' + r.unknown + ' the provider could not answer for' : '') + '.',
  }
}

/**
 * Re-queues a batch's failed messages — and only those.
 *
 * NEW ROWS, NOT THE OLD ONES REOPENED. The outbox id is the idempotency key
 * every provider is given, and a provider treats a repeated id as the same
 * message. That is exactly right for the dispatcher's own retries, where a
 * timeout may have hidden an acceptance — but it means a row the provider
 * already holds and marked failed would be REFUSED as a duplicate if sent
 * again under its own id. So each failed row is copied to a fresh row, which
 * gets a fresh id, and the original is marked cancelled with a pointer to its
 * replacement. A message that actually went out is not among them: only
 * status 'failed' is copied, and a delivered or sent row is neither.
 */
export async function retryFailedInBatch(batchId: number): Promise<BatchActionResult> {
  const { company, profile } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false, error: 'Messaging is not set up on this system yet.' }

  const batch = await ownBatch(company.id, batchId)
  if (!batch) return { ok: false, error: 'That batch does not exist.' }

  const db = tenantClient()
  const { data: failedRows, error: readError } = await db
    .from('sms_outbox')
    .select('id, customer_id, kind, phone, body' + (caps.messaging ? ', channel, recipient, subject, attachment' : ''))
    .eq('company_id', company.id)
    .eq('batch_id', batchId)
    .eq('status', 'failed')
    .order('id')

  if (readError) return { ok: false, error: 'Could not read the batch: ' + readError.message }

  const failed = (failedRows ?? []) as unknown as {
    id: number; customer_id: number | null; kind: string; phone: string | null; body: string
    channel?: string; recipient?: string; subject?: string | null; attachment?: string | null
  }[]
  if (failed.length === 0) return { ok: false, error: 'Nothing in this batch is marked failed. Check delivery first.' }

  let requeued = 0
  for (const row of failed) {
    // Insert the copy first, then cancel the original. If the insert fails the
    // original stays 'failed' and can be retried again; the other order could
    // cancel a row and then lose its replacement.
    const copyRow: Record<string, unknown> = {
      company_id: company.id,
      customer_id: row.customer_id,
      batch_id: batchId,
      kind: row.kind,
      phone: row.phone,
      body: row.body,
      status: 'queued',
      dedupe_key: null,
    }
    if (caps.messaging) {
      copyRow.channel = row.channel ?? 'sms'
      copyRow.recipient = row.recipient ?? row.phone
      copyRow.subject = row.subject ?? null
      copyRow.attachment = row.attachment ?? null
    }
    const { data: copy, error: insertError } = await db
      .from('sms_outbox').insert(copyRow).select('id').single()

    if (insertError || !copy) continue

    await db.from('sms_outbox')
      .update({ status: 'cancelled', error: 'Retried as message #' + (copy as { id: number }).id })
      .eq('id', row.id)
    requeued += 1
  }

  await refreshBatchCounts(batchId)

  await logEvent({
    type: 'sms_batch_retried',
    details:
      'Retried ' + requeued + ' failed message' + (requeued === 1 ? '' : 's') +
      ' of batch #' + batchId + ' | by=' + displayName(profile),
    tag: '[messaging]',
  })

  revalidatePath('/dashboard/messages/' + batchId)
  revalidatePath('/dashboard/messages')

  return {
    ok: true,
    message:
      requeued + ' message' + (requeued === 1 ? '' : 's') + ' re-queued' +
      (requeued < failed.length ? ' (' + (failed.length - requeued) + ' could not be copied and stay failed)' : '') +
      '. They go out at your configured rate; the rows below update as they send.',
  }
}
