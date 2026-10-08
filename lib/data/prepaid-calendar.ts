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
 * Whether a company runs calendar-month prepaid (migration 0028), and its
 * reconnection fee. THE one read of the switch: the till, the payment action,
 * the hourly tick and Provision all ask here, so they cannot disagree about
 * whether the model is on.
 *
 * Read on its own rather than through the schema probe: a missing column
 * (42703, the migration not applied) reads as "not available", which every
 * caller treats as the switch off — the app behaves exactly as before 0028.
 *
 * ON = migration applied AND the company is prepaid AND the switch is set.
 * Postpaid companies are never on, whatever the column says.
 */
export type PrepaidCalendar = {
  /** Migration 0028 is applied. */
  available: boolean
  /** The model applies to this company. */
  enabled: boolean
  /** The switch as stored, for the settings form. */
  switchedOn: boolean
  reconnectionFee: number
}

export const PREPAID_CALENDAR_OFF: PrepaidCalendar = {
  available: false, enabled: false, switchedOn: false, reconnectionFee: 0,
}

export async function prepaidCalendarFor(companyId: number): Promise<PrepaidCalendar> {
  const { data, error } = await tenantClient()
    .from('settings')
    .select('billing_type, prepaid_calendar_enabled, reconnection_fee')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    if (error.code === '42703') return PREPAID_CALENDAR_OFF
    throw new Error('Could not read the prepaid billing settings: ' + error.message)
  }

  const row = data as {
    billing_type: string | null
    prepaid_calendar_enabled: boolean | null
    reconnection_fee: number | string | null
  } | null

  const switchedOn = Boolean(row?.prepaid_calendar_enabled)
  return {
    available: true,
    switchedOn,
    enabled: switchedOn && row?.billing_type === 'prepaid',
    reconnectionFee: Math.max(0, Number(row?.reconnection_fee ?? 0)),
  }
}
