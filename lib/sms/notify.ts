import 'server-only'

import { billEmail } from '@/lib/bill/email'
import { loadBill } from '@/lib/data/bill'
import { portalUrlForCompany } from '@/lib/data/portal'
import { getSmsSettings } from '@/lib/data/sms'
import { formatCurrency } from '@/lib/format'
import type { RecipientSource } from '@/lib/messaging/adapter'
import { channelReadiness, enqueueForRoute } from '@/lib/messaging/enqueue'
import { adapterFor } from '@/lib/messaging/registry'
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

/**
 * Emails a customer their bill: the cover note, and the bill itself attached
 * as the PDF the portal and the staff record produce.
 *
 * THE ONE STAFF-INITIATED MESSAGE HERE, and so the one that REPORTS rather
 * than swallows: the person who pressed "Email bill" is waiting to be told it
 * went to a@b.com, or why it did not. It still never throws.
 *
 * Off unless the company has switched it on (settings.notify_bill_enabled,
 * migration 0042), and by email only — the route is the document kind's (see
 * lib/sms/templates.ts#DocumentKind) — through the same outbox, master switch,
 * opt-out and dispatcher as every other message.
 *
 * The cover note is written now from the bill as it stands now
 * (lib/bill/email.ts); the PDF is drawn when the dispatcher sends, a minute or
 * so later, in the template pinned here. The dedupe key is the bill's number
 * and the minute, so a double click sends one email and a resend later sends
 * another.
 */
export async function emailBill(opts: {
  companyId: number
  customerId: number
}): Promise<{ ok: true; to: string; title: string } | { ok: false; error: string }> {
  try {
    const caps = await getSchemaCapabilities()
    if (!caps.emailBills) return { ok: false, error: 'Emailing bills is not set up on this system yet (migration 0042).' }

    const ready = await prepare(opts.companyId, opts.customerId)
    if (!ready) return { ok: false, error: 'That customer could not be found, or messaging is not set up.' }
    const { settings, readiness, customer, portalUrl } = ready
    if (!settings.billEmail) {
      return { ok: false, error: 'Emailing bills is switched off. A manager can turn it on under Settings > Bill Design.' }
    }

    const bill = await loadBill(opts.companyId, opts.customerId)
    if (!bill) return { ok: false, error: 'That customer could not be found.' }
    const text = billEmail(bill, { firstName: customer.first_name })

    const outcome = await enqueueForRoute({
      companyId: opts.companyId,
      kind: 'customer_bill',
      settings,
      readiness,
      customer,
      // The wording is already final; these fill nothing in it, and are here so
      // a placeholder typed into a company name is left as typed.
      values: baseValues(customer, bill.company.name, portalUrl),
      text: { sms: '', email: text },
      dedupeKey: 'bill:' + bill.number + ':' + Math.floor(Date.now() / 60_000),
      attachment: { kind: 'bill', id: opts.customerId, template: bill.template },
    })

    // outcome.skipped holds both why a channel was not used (no address,
    // opted out, email switched off) and why a row was not written (already
    // queued a moment ago).
    const sent = outcome.queued.find((q) => q.channel === 'email')
    if (!sent) {
      return { ok: false, error: outcome.skipped.map((s) => s.reason).join('; ') || 'Not reachable by email.' }
    }
    const to = outcome.resolution.targets.find((t) => t.channel === 'email')?.address ?? 'their email address'
    return { ok: true, to, title: bill.title }
  } catch (err) {
    console.error('[messaging] bill email not queued:', (err as Error).message)
    return { ok: false, error: 'The bill could not be queued: ' + (err as Error).message }
  }
}

/**
 * Whether the record shows "Email bill", and if it cannot go, why — asked of
 * the email adapter's own rules, the ones the send above goes through, so the
 * button is not offered for a customer the send would refuse. Hidden entirely
 * while the company has bill emails off.
 */
export async function billEmailOffer(
  companyId: number,
  customer: RecipientSource
): Promise<{ shown: false } | { shown: true; blocked: string | null }> {
  const caps = await getSchemaCapabilities()
  if (!caps.emailBills || !caps.sms) return { shown: false }
  const settings = await getSmsSettings(companyId)
  if (!settings.billEmail) return { shown: false }
  if (!settings.channelsAvailable) return { shown: true, blocked: 'Email needs migration 0022.' }

  const email = adapterFor('email')
  const ready = await email.tenantReady(companyId, settings)
  if (!ready.ready) return { shown: true, blocked: ready.reason }
  const verdict = email.recipientFor(customer, settings)
  return { shown: true, blocked: verdict.ok ? null : verdict.reason }
}
