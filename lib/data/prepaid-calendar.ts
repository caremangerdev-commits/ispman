import 'server-only'

import type { MonthCharge } from '@/lib/prepaid-calendar'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * A customer's recent month charges, newest first: what the till's breakdown
 * spreads the balance over (lib/prepaid-calendar.ts#tillBreakdown). A year is
 * far more than any balance spans.
 */
export async function readMonthCharges(companyId: number, customerId: number): Promise<MonthCharge[]> {
  const { data, error } = await tenantClient()
    .from('bill_charges')
    .select('period_start, amount, service_days')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('period_start', { ascending: false })
    .limit(12)
  if (error) throw new Error('Could not read the month charges: ' + error.message)
  return ((data ?? []) as { period_start: string; amount: number | string; service_days: number | null }[])
    .map((r) => ({ periodStart: r.period_start, amount: Number(r.amount), serviceDays: r.service_days }))
}

/**
 * Whether calendar-month prepaid applies to a company, and its reconnection
 * fee. THE one read of it: the till, the payment action, the hourly tick, the
 * receipt and Provision all ask here, so they cannot disagree.
 *
 * THERE IS NO SWITCH (owner, 8 Oct 2026: "the model is simply how prepaid
 * works now"). It applies to a company that is PREPAID and whose billing
 * engine is LIVE — the engine is what charges the months the model reduces,
 * recomputes and settles. A prepaid company whose engine is off is not billed
 * by ISPMan at all: its balances are raised by hand, by bill-date periods the
 * model knows nothing about, and recomputing a month at the till on top of
 * them would charge days twice. It joins the model the day its engine goes
 * live. Postpaid companies never do.
 *
 * Before migration 0028 (42703 on reconnection_fee) it reads as not applying,
 * so the app behaves exactly as before 0028.
 */
export type PrepaidCalendar = {
  /** Migration 0028 is applied. */
  available: boolean
  /** The model applies to this company. */
  enabled: boolean
  reconnectionFee: number
}

export const PREPAID_CALENDAR_OFF: PrepaidCalendar = {
  available: false, enabled: false, reconnectionFee: 0,
}

export async function prepaidCalendarFor(companyId: number): Promise<PrepaidCalendar> {
  const { data, error } = await tenantClient()
    .from('settings')
    .select('billing_type, billing_engine_mode, reconnection_fee')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    if (error.code === '42703') return PREPAID_CALENDAR_OFF
    throw new Error('Could not read the prepaid billing settings: ' + error.message)
  }

  const row = data as {
    billing_type: string | null
    billing_engine_mode: string | null
    reconnection_fee: number | string | null
  } | null

  return {
    available: true,
    enabled: row?.billing_type === 'prepaid' && row?.billing_engine_mode === 'live',
    reconnectionFee: Math.max(0, Number(row?.reconnection_fee ?? 0)),
  }
}
