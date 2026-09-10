import 'server-only'

import { enqueueSms, getSmsDevice, getSmsSettings } from '@/lib/data/sms'
import { formatCurrency } from '@/lib/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The event-driven messages: one call from the action that causes them.
 *
 * NEVER THROWS, and never blocks the thing it is reporting on. The payment has
 * already been taken and the customer has already been disconnected by the time
 * these run; failing the operator's action because a text could not be queued
 * would undo something real to protect something cosmetic. Every failure is
 * logged to the console and swallowed — the same trade logEvent makes, for the
 * same reason.
 *
 * WHY NOT IN THE SWEEP. A disconnection is an act, not a state to be discovered
 * by scanning: the sweep would have to infer it from a status, and radcheck
 * cannot tell a deliberate cut-off from an ordinary lapse — which is exactly
 * why lib/data/network-events.ts exists. Enqueuing here, where the code knows
 * it just disconnected somebody on purpose, needs no inference at all.
 */

type CustomerBits = {
  first_name: string | null
  last_name: string | null
  phone: string | null
  account_number?: string | null
  carried_balance?: number | null
  sms_opted_out?: boolean | null
}

async function loadCustomerBits(
  companyId: number,
  customerId: number
): Promise<CustomerBits | null> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  let cols = 'first_name, last_name, phone'
  if (caps.accountNumbers) cols += ', account_number'
  if (caps.billing) cols += ', carried_balance'
  if (caps.sms) cols += ', sms_opted_out'

  const { data, error } = await db
    .from('customers').select(cols)
    .eq('company_id', companyId).eq('id', customerId).maybeSingle()

  if (error || !data) return null
  return data as unknown as CustomerBits
}

/** Shared preamble: is this tenant able to send anything at all? */
async function prepare(companyId: number, customerId: number) {
  const caps = await getSchemaCapabilities()
  if (!caps.sms) return null

  const [settings, device, customer] = await Promise.all([
    getSmsSettings(companyId),
    getSmsDevice(companyId),
    loadCustomerBits(companyId, customerId),
  ])

  if (!settings.enabled || !device || !customer) return null
  return { settings, device, customer }
}

/**
 * Texts a customer their receipt.
 *
 * The dedupe key is the PAYMENT id, so a payment that is submitted twice — a
 * double-clicked button, a retried form post — cannot produce two texts even
 * though it would produce two payment rows for a manager to correct.
 */
export async function notifyPaymentReceipt(opts: {
  companyId: number
  companyName: string
  customerId: number
  paymentId: number
  amount: number | string
}): Promise<void> {
  try {
    const ready = await prepare(opts.companyId, opts.customerId)
    if (!ready) return

    const { settings, device, customer } = ready

    await enqueueSms({
      companyId: opts.companyId,
      kind: 'payment_receipt',
      settings,
      device,
      dedupeKey: 'payment:' + opts.paymentId,
      target: {
        customerId: opts.customerId,
        phone: customer.phone,
        optedOut: Boolean(customer.sms_opted_out),
        values: {
          '{{name}}': [customer.first_name, customer.last_name].filter(Boolean).join(' '),
          '{{first_name}}': customer.first_name ?? '',
          '{{account}}': customer.account_number ?? '',
          '{{amount}}': formatCurrency(opts.amount),
          '{{balance}}': formatCurrency(customer.carried_balance ?? 0),
          '{{company}}': opts.companyName,
        },
      },
    })
  } catch (err) {
    console.error('[sms] payment receipt not queued:', (err as Error).message)
  }
}

/**
 * Texts a customer that they have been cut off.
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

    const { settings, device, customer } = ready

    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: opts.timezone || 'America/Jamaica',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date())

    await enqueueSms({
      companyId: opts.companyId,
      kind: 'disconnection_notice',
      settings,
      device,
      dedupeKey: 'disconnect:' + opts.customerId + ':' + today,
      target: {
        customerId: opts.customerId,
        phone: customer.phone,
        optedOut: Boolean(customer.sms_opted_out),
        values: {
          '{{name}}': [customer.first_name, customer.last_name].filter(Boolean).join(' '),
          '{{first_name}}': customer.first_name ?? '',
          '{{account}}': customer.account_number ?? '',
          '{{balance}}': formatCurrency(customer.carried_balance ?? 0),
          '{{company}}': opts.companyName,
        },
      },
    })
  } catch (err) {
    console.error('[sms] disconnection notice not queued:', (err as Error).message)
  }
}
