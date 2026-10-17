import 'server-only'

import { portalUrlForCompany } from '@/lib/data/portal'
import { getSmsSettings } from '@/lib/data/sms'
import { formatCurrency } from '@/lib/format'
import { channelReadiness, enqueueForRoute } from '@/lib/messaging/enqueue'
import { getSchemaCapabilities } from '@/lib/schema'
import { SERVICE_RESTORED_EMAIL, SERVICE_RESTORED_SMS } from '@/lib/sms/templates'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The event-driven messages: one call from the action that causes them.
 *
 * NEVER THROWS, and never blocks the thing it is reporting on. The payment has
 * already been taken and the customer has already been disconnected by the time
 * these run; failing the operator's action because a message could not be
 * queued would undo something real to protect something cosmetic. Every
 * failure is logged to the console and swallowed — the same trade logEvent
 * makes, for the same reason.
 *
 * CHANNEL-NEUTRAL. Neither function names a channel: each asks
 * enqueueForRoute() to apply the company's route for its kind, which is where
 * "email if they have one, otherwise SMS" is decided. A receipt goes with the
 * receipt PDF attached wherever the channel can carry one.
 *
 * WHY NOT IN THE SWEEP. A disconnection is an act, not a state to be discovered
 * by scanning: the sweep would have to infer it from a status, and radcheck
 * cannot tell a deliberate cut-off from an ordinary lapse — which is exactly
 * why lib/data/network-events.ts exists. Enqueuing here, where the code knows
 * it just disconnected somebody on purpose, needs no inference at all.
 */

type CustomerBits = {
  id: number
  first_name: string | null
  last_name: string | null
  phone: string | null
  email: string | null
  account_number?: string | null
  carried_balance?: number | null
  sms_opted_out?: boolean | null
  email_opted_out?: boolean | null
}

async function loadCustomerBits(
  companyId: number,
  customerId: number
): Promise<CustomerBits | null> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  let cols = 'id, first_name, last_name, phone, email'
  if (caps.accountNumbers) cols += ', account_number'
  if (caps.billing) cols += ', carried_balance'
  if (caps.sms) cols += ', sms_opted_out'
  if (caps.messaging) cols += ', email_opted_out'

  const { data, error } = await db
    .from('customers').select(cols)
    .eq('company_id', companyId).eq('id', customerId).maybeSingle()

  if (error || !data) return null
  return data as unknown as CustomerBits
}

/** Shared preamble: the settings, the channels, the customer, and the portal link. */
async function prepare(companyId: number, customerId: number) {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return null

  const [settings, customer, portalUrl] = await Promise.all([
    getSmsSettings(companyId),
    loadCustomerBits(companyId, customerId),
    portalUrlForCompany(companyId),
  ])
  if (!customer) return null

  const readiness = await channelReadiness(companyId, settings)
  return { settings, readiness, customer, portalUrl }
}

/** "17 Oct 2026", or empty for null — safe to drop straight into a template. */
function formatDay(d: Date | null): string {
  if (!d || !Number.isFinite(d.getTime())) return ''
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

function baseValues(customer: CustomerBits, companyName: string, portalUrl: string | null) {
  return {
    '{{name}}': [customer.first_name, customer.last_name].filter(Boolean).join(' '),
    '{{first_name}}': customer.first_name ?? '',
    '{{account}}': customer.account_number ?? '',
    '{{balance}}': formatCurrency(customer.carried_balance ?? 0),
    '{{portal}}': portalUrl ?? '',
    '{{company}}': companyName,
  }
}

/**
 * Sends a customer their receipt.
 *
 * The dedupe key is the PAYMENT id, so a payment that is submitted twice — a
 * double-clicked button, a retried form post — cannot produce two messages on
 * a channel even though it would produce two payment rows for a manager to
 * correct. By email, the receipt PDF rides along.
 */
export async function notifyPaymentReceipt(opts: {
  companyId: number
  companyName: string
  customerId: number
  paymentId: number
  amount: number | string
  /** The expiry the payment leaves the customer with, for "{{expiry}}". */
  expiry?: Date | null
  /** The payment date, for "{{date}}". Defaults to today. */
  paidOn?: Date | null
}): Promise<void> {
  try {
    const ready = await prepare(opts.companyId, opts.customerId)
    if (!ready) return
    const { settings, readiness, customer, portalUrl } = ready
    if (!settings.paymentReceipt) return

    await enqueueForRoute({
      companyId: opts.companyId,
      kind: 'payment_receipt',
      settings,
      readiness,
      customer,
      values: {
        ...baseValues(customer, opts.companyName, portalUrl),
        '{{amount}}': formatCurrency(opts.amount),
        '{{date}}': formatDay(opts.paidOn ?? new Date()),
        '{{expiry}}': formatDay(opts.expiry ?? null),
      },
      text: { sms: settings.smsTemplates.payment_receipt, email: settings.emailTemplates.payment_receipt },
      dedupeKey: 'payment:' + opts.paymentId,
      attachment: { kind: 'receipt', id: opts.paymentId },
    })
  } catch (err) {
    console.error('[messaging] payment receipt not queued:', (err as Error).message)
  }
}

/**
 * Tells a customer who was cut off that a payment has put them back online.
 *
 * Distinct from the receipt (which answers "did my money land?"): this answers
 * "am I back on?", the other top trust question for a reconnecting prepaid
 * customer. Called only when a payment actually restored a disconnected one.
 * Reuses the payment-receipt route so it travels at the same bypass priority,
 * with its own dedupe key so it is one message per payment.
 */
export async function notifyServiceRestored(opts: {
  companyId: number
  companyName: string
  customerId: number
  paymentId: number
  expiry?: Date | null
}): Promise<void> {
  try {
    const ready = await prepare(opts.companyId, opts.customerId)
    if (!ready) return
    const { settings, readiness, customer, portalUrl } = ready
    if (!settings.paymentReceipt) return

    await enqueueForRoute({
      companyId: opts.companyId,
      kind: 'payment_receipt',
      settings,
      readiness,
      customer,
      values: {
        ...baseValues(customer, opts.companyName, portalUrl),
        '{{expiry}}': formatDay(opts.expiry ?? null),
      },
      text: { sms: SERVICE_RESTORED_SMS, email: SERVICE_RESTORED_EMAIL },
      dedupeKey: 'restored:' + opts.paymentId,
    })
  } catch (err) {
    console.error('[messaging] restoration notice not queued:', (err as Error).message)
  }
}

/**
 * Tells a customer that they have been cut off.
 *
 * The dedupe key carries the DATE, so disconnecting the same customer twice in
 * one day sends one message, while a genuine second disconnection next month
 * sends another.
 */
export async function notifyDisconnection(opts: {
  companyId: number
  companyName: string
  customerId: number
  /** The company's timezone, so "today" is the tenant's day and not UTC's. */
  timezone: string
}): Promise<void> {
  try {
    const ready = await prepare(opts.companyId, opts.customerId)
    if (!ready) return
    const { settings, readiness, customer, portalUrl } = ready
    if (!settings.disconnection) return

    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: opts.timezone || 'America/Jamaica',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())

    await enqueueForRoute({
      companyId: opts.companyId,
      kind: 'disconnection_notice',
      settings,
      readiness,
      customer,
      values: baseValues(customer, opts.companyName, portalUrl),
      text: { sms: settings.smsTemplates.disconnection_notice, email: settings.emailTemplates.disconnection_notice },
      dedupeKey: 'disconnect:' + opts.customerId + ':' + today,
    })
  } catch (err) {
    console.error('[messaging] disconnection notice not queued:', (err as Error).message)
  }
}
