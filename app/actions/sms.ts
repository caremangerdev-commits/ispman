'use server'

import { revalidatePath } from 'next/cache'

import { logEvent } from '@/lib/audit'
import {
  applyFilters, describeFilters, explainNoMatch, type CustomerFilters, type FilterNames,
} from '@/lib/customer-filter'
import { listMiscCategories, listServicePlans } from '@/lib/data/catalog'
import { loadEnrichedCustomers } from '@/lib/data/customers'
import {
  canSend, DIRECT_AUDIENCE_PREFIX, enqueueSms, getSmsDevice, getSmsSettings,
} from '@/lib/data/sms'
import { CURRENCY_SYMBOL, formatCurrency } from '@/lib/format'
import { classifyPhone, PHONE_SKIP_REASON, sendablePhone, summarisePhones } from '@/lib/phone'
import { getSchemaCapabilities } from '@/lib/schema'
import { displayName, requirePermission } from '@/lib/session'
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

  const db = tenantClient()
  const { error } = await db
    .from('settings')
    .update({
      sms_enabled: bool(formData, 'sms_enabled'),
      sms_payment_receipt_enabled: bool(formData, 'sms_payment_receipt_enabled'),
      sms_expiry_warning_enabled: bool(formData, 'sms_expiry_warning_enabled'),
      sms_disconnection_enabled: bool(formData, 'sms_disconnection_enabled'),
      // Empty means "use the built-in default", so it is stored as NULL rather
      // than as an empty string that would send a blank message.
      sms_payment_receipt_template: templates.sms_payment_receipt_template || null,
      sms_expiry_warning_template: templates.sms_expiry_warning_template || null,
      sms_disconnection_template: templates.sms_disconnection_template || null,
      sms_expiry_warning_days: days,
      sms_throttle_seconds: throttle,
      sms_allow_foreign: bool(formData, 'sms_allow_foreign'),
    })
    .eq('company_id', company.id)

  if (error) return { ok: false, error: 'Could not save: ' + error.message }

  const after = await getSmsSettings(company.id)

  // The master switch is the one worth an audit row on its own: it is what an
  // owner reaches for when a SIM starts being flagged, and "when did messages
  // stop going out" is a question somebody will ask.
  if (before.enabled !== after.enabled) {
    await logEvent({
      type: 'sms_master_switch',
      details: 'SMS ' + (after.enabled ? 'enabled' : 'disabled') + ' for the company',
      tag: '[sms]',
    })
  }

  revalidatePath('/dashboard/settings/sms')
  return { ok: true, message: 'SMS settings saved.' }
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

export type AudiencePreview = {
  matched: number
  sendable: number
  optedOut: number
  /** Reason -> how many, for the "who will be skipped and why" panel. */
  skipped: { reason: string; count: number }[]
  /** Seconds, at this company's throttle. */
  estimatedSeconds: number
  audience: string
  /**
   * Why `matched` is zero, filter by filter. Empty unless it is zero and at
   * least one filter is active — see lib/customer-filter.ts#explainNoMatch.
   */
  emptyReasons: string[]
  segments: number
  encoding: string
  characters: number
}

/**
 * Who a batch would reach, and who it would not.
 *
 * READ-ONLY AND SEPARATE FROM SENDING, deliberately. This is what the operator
 * confirms; sendBulkSms recomputes it from the same filters rather than
 * trusting a list of ids posted back from the browser, so a stale tab cannot
 * message people who have since opted out.
 */
export async function previewAudience(filters: CustomerFilters, body: string) {
  const { company } = await requirePermission('send_bulk_sms')

  const [settings, customers, categories, plans] = await Promise.all([
    getSmsSettings(company.id),
    loadEnrichedCustomers(company.id),
    listMiscCategories(company.id).catch(() => []),
    listServicePlans(company.id).catch(() => []),
  ])

  const matched = applyFilters(customers, filters)

  // Opt-out is counted before the phone check, so a customer who both opted out
  // and has no phone is reported once, under the reason that is actually theirs
  // to change.
  const optedOut = matched.filter((c) => c.sms_opted_out)
  const eligible = matched.filter((c) => !c.sms_opted_out)

  const { sendable, skipped } = summarisePhones(eligible, {
    allowForeign: settings.allowForeign,
  })

  const byReason = new Map<string, number>()
  if (optedOut.length > 0) byReason.set('Opted out of SMS', optedOut.length)
  for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1)

  const seg = countSegments(body)

  const names: FilterNames = {
    status: (s) => STATUS_LABELS[s],
    miscCategory: (id) => categories.find((c) => c.id === id)?.name,
    servicePlan: (id) => plans.find((p) => p.id === id)?.name,
    currency: (n) => CURRENCY_SYMBOL + n.toLocaleString(),
  }

  const preview: AudiencePreview = {
    matched: matched.length,
    sendable: sendable.length,
    optedOut: optedOut.length,
    skipped: [...byReason.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    // Segments matter: a two-segment message takes two sends' worth of time and
    // of the tenant's credit, so the estimate multiplies by them.
    estimatedSeconds:
      sendable.length * settings.throttleSeconds * Math.max(1, seg.segments),
    audience: describeFilters(filters, names),
    emptyReasons: explainNoMatch(customers, filters, names),
    segments: seg.segments,
    encoding: seg.encoding,
    characters: seg.characters,
  }

  return preview
}

/**
 * Queues one message to a typed-in number: a technician, a supplier, the
 * operator's own phone to check the relay is alive.
 *
 * Same permission, same gates and the same write path as a bulk send — this
 * goes through enqueueSms like everything else, so the master switch, the
 * paired device and the phone rules all still apply. What it skips is the
 * customer lookup: the number is the recipient, not a record.
 *
 * It still gets a batch row. A message to a number that is not a customer is
 * exactly the one someone will later ask about — "who texted that supplier
 * and what did they say" — and the batch list is where that answer lives.
 */
export async function sendDirectSms(phone: string, body: string): Promise<SendBulkResult> {
  const { company, profile } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false, error: 'SMS is not set up on this system yet.' }

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

  const [settings, device] = await Promise.all([
    getSmsSettings(company.id), getSmsDevice(company.id),
  ])

  if (!canSend(settings, device)) {
    return {
      ok: false,
      error: settings.enabled
        ? 'No phone is paired for this company.'
        : 'SMS is switched off for this company.',
    }
  }

  const e164 = sendablePhone(phone, { allowForeign: settings.allowForeign })
  if (!e164) {
    const kind = classifyPhone(phone).kind
    return {
      ok: false,
      error: kind === 'jamaica'
        ? 'That number cannot be sent to.'
        : PHONE_SKIP_REASON[kind] + '.',
    }
  }

  const audience = DIRECT_AUDIENCE_PREFIX + e164
  const rendered = renderTemplate(text, { '{{company}}': company.name })

  const db = tenantClient()
  const { data: batchRow, error: batchError } = await db
    .from('sms_batches')
    .insert({
      company_id: company.id,
      sent_by: profile.id,
      sent_by_name: displayName(profile),
      body: text,
      audience,
      total: 1,
      sent: 0,
      failed: 0,
      skipped: 0,
    })
    .select('id')
    .single()

  if (batchError || !batchRow) {
    return { ok: false, error: 'Could not start the batch: ' + (batchError?.message ?? '') }
  }

  const batchId = (batchRow as { id: number }).id

  const result = await enqueueSms({
    companyId: company.id,
    kind: 'bulk',
    settings,
    device,
    dedupeKey: null,
    batchId,
    body: rendered,
    target: { customerId: null, phone: e164, values: {} },
  })

  if (!result.queued) {
    await db.from('sms_batches').update({ total: 0, skipped: 1 }).eq('id', batchId)
    return { ok: false, error: result.reason }
  }

  await logEvent({
    type: 'sms_direct_sent',
    details:
      'Direct SMS queued | batch=' + batchId + ' | to=+' + e164 +
      ' | by=' + displayName(profile),
    tag: '[sms]',
  })

  revalidatePath('/dashboard/messages')

  return {
    ok: true,
    batchId,
    queued: 1,
    skipped: 0,
    message: 'Message to +' + e164 + ' queued.',
  }
}

export type SendBulkResult =
  | { ok: true; batchId: number; queued: number; skipped: number; message: string }
  | { ok: false; error: string }

/**
 * Queues a message to everyone the filters select.
 *
 * RECOMPUTES THE AUDIENCE. The browser sends the filters, never a list of
 * customer ids: a tab left open while somebody opted out, changed their number
 * or was deleted would otherwise send to a set that no longer exists. The
 * confirmation screen and this function ask lib/customer-filter.ts the same
 * question, so what was confirmed is what is queued, as of now.
 *
 * NOTHING IS SENT HERE. Rows go into sms_outbox and the dispatcher drains them
 * at the tenant's throttle. A server action that tried to deliver 400 messages
 * would hold a request open for forty minutes and lose the lot on a deploy.
 */
export async function sendBulkSms(
  filters: CustomerFilters,
  body: string
): Promise<SendBulkResult> {
  const { company, profile } = await requirePermission('send_bulk_sms')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false, error: 'SMS is not set up on this system yet.' }

  const text = body.trim()
  if (!text) return { ok: false, error: 'The message is empty.' }
  if (unknownPlaceholders(text).length > 0) {
    return {
      ok: false,
      error: 'Unknown placeholder: ' + unknownPlaceholders(text).join(', '),
    }
  }

  const [settings, device] = await Promise.all([
    getSmsSettings(company.id), getSmsDevice(company.id),
  ])

  if (!canSend(settings, device)) {
    return {
      ok: false,
      error: settings.enabled
        ? 'No phone is paired for this company.'
        : 'SMS is switched off for this company.',
    }
  }

  const preview = await previewAudience(filters, text)
  if (preview.sendable === 0) {
    return { ok: false, error: 'No one in this selection has a usable phone number.' }
  }

  const customers = applyFilters(await loadEnrichedCustomers(company.id), filters)

  // The batch row first. If it fails, nothing is queued — better than messages
  // going out with no record of who sent them or why.
  const db = tenantClient()
  const { data: batchRow, error: batchError } = await db
    .from('sms_batches')
    .insert({
      company_id: company.id,
      sent_by: profile.id,
      // Stamped, not joined. A staff member who leaves and is deleted must not
      // erase who sent a message to 400 customers — the same reasoning as the
      // payment segment in migration 0018.
      sent_by_name: displayName(profile),
      body: text,
      audience: preview.audience,
      total: preview.sendable,
      sent: 0,
      failed: 0,
      skipped: preview.matched - preview.sendable,
    })
    .select('id')
    .single()

  if (batchError || !batchRow) {
    return { ok: false, error: 'Could not start the batch: ' + (batchError?.message ?? '') }
  }

  const batchId = (batchRow as { id: number }).id

  let queued = 0
  let skipped = 0
  for (const c of customers) {
    const result = await enqueueSms({
      companyId: company.id,
      kind: 'bulk',
      settings,
      device,
      // Null: two different messages to one customer on one day is the
      // operator's business, and deduping bulk would silently drop the second.
      dedupeKey: null,
      batchId,
      body: renderTemplate(text, {
        '{{name}}': [c.first_name, c.last_name].filter(Boolean).join(' '),
        '{{first_name}}': c.first_name ?? '',
        '{{account}}': c.account_number ?? '',
        '{{balance}}': formatCurrency(c.carried_balance ?? 0),
        '{{expiry}}': c.radiusExpiryDate ?? '',
        '{{company}}': company.name,
      }),
      target: {
        customerId: c.id,
        phone: c.phone,
        optedOut: c.sms_opted_out,
        values: {},
      },
    })
    if (result.queued) queued += 1
    else skipped += 1
  }

  await db.from('sms_batches')
    .update({ total: queued, skipped })
    .eq('id', batchId)

  await logEvent({
    type: 'sms_bulk_sent',
    details:
      'Bulk SMS queued | batch=' + batchId +
      ' | recipients=' + queued +
      ' | skipped=' + skipped +
      ' | audience=' + preview.audience,
    tag: '[sms]',
  })

  revalidatePath('/dashboard/messages')

  return {
    ok: true,
    batchId,
    queued,
    skipped,
    message: queued + ' message' + (queued === 1 ? '' : 's') + ' queued.',
  }
}

/** A customer's own choice, from their record. Outranks every company switch. */
export async function setSmsOptOut(customerId: number, optedOut: boolean) {
  const { company } = await requirePermission('edit_customer')

  const caps = await getSchemaCapabilities()
  if (!caps.sms) return { ok: false as const, error: 'SMS is not set up on this system yet.' }

  const db = tenantClient()
  const { error } = await db
    .from('customers')
    .update({ sms_opted_out: optedOut })
    .eq('company_id', company.id)
    .eq('id', customerId)

  if (error) return { ok: false as const, error: 'Could not save: ' + error.message }

  await logEvent({
    type: 'sms_opt_out',
    details: optedOut ? 'Customer opted out of SMS' : 'Customer opted back in to SMS',
    customerId,
    tag: '[sms]',
  })

  revalidatePath('/dashboard/customers/' + customerId)
  return { ok: true as const }
}
