import 'server-only'

import { instantToDateOnly } from '@/lib/format'
import type { MonthCharge } from '@/lib/prepaid-calendar'
import { getSchemaCapabilities } from '@/lib/schema'
import { fetchAllRows } from '@/lib/supabase/paging'
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
 * customers.billed_through for a company (migration 0030): the last day each
 * customer was charged by hand before the engine took them over. Only the
 * customers that have one; empty before 0030. The engine, the hourly service
 * pass and the till all read it here.
 */
export async function readBilledThrough(companyId: number): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!(await getSchemaCapabilities()).handover) return out
  const db = tenantClient()
  const rows = await fetchAllRows(
    (from, to) =>
      db
        .from('customers')
        .select('id, billed_through')
        .eq('company_id', companyId)
        .not('billed_through', 'is', null)
        .order('id')
        .range(from, to),
    'billed_through'
  )
  for (const r of rows as { id: number; billed_through: string }[]) out.set(r.id, r.billed_through)
  return out
}

/**
 * THE CONNECTION MONTH (migration 0032, owner 11 Oct 2026), prepaid and
 * postpaid alike. On: a customer connected mid-month is charged for that month
 * from connection day to month end, at the daily rate, rounded — prepaid at
 * Provision, postpaid on the next bill day. Off: no charge for the connection
 * month; they start on the 1st of the following month.
 *
 * THE one read of it. Before 0032, it answers what the app did then: the
 * connection month was charged only at Provision, and only where calendar-month
 * prepaid ran.
 */
export async function chargesConnectionMonth(companyId: number): Promise<boolean> {
  if (!(await getSchemaCapabilities()).connectionMonth) return (await prepaidCalendarFor(companyId)).enabled
  const { data, error } = await tenantClient()
    .from('settings')
    .select('charge_connection_month')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error('Could not read the connection-month setting: ' + error.message)
  return Boolean((data as { charge_connection_month: boolean | null } | null)?.charge_connection_month)
}

/**
 * settings.flex_month (migration 0043): whether this company's billing periods
 * run from each customer's own bill day to the day before the next one, rather
 * than the calendar month. False before 0043, which is how every company
 * billed until it was applied.
 */
export async function flexMonthFor(companyId: number): Promise<boolean> {
  if (!(await getSchemaCapabilities()).flexMonth) return false
  const { data, error } = await tenantClient()
    .from('settings')
    .select('flex_month')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error('Could not read the flex-month setting: ' + error.message)
  return Boolean((data as { flex_month: boolean | null } | null)?.flex_month)
}

/**
 * customers.connected_on for a company (migration 0032): the day each customer
 * was first provisioned. Only those that have one; empty before 0032.
 */
export async function readConnectedOn(companyId: number): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (!(await getSchemaCapabilities()).connectionMonth) return out
  const db = tenantClient()
  const rows = await fetchAllRows(
    (from, to) =>
      db
        .from('customers')
        .select('id, connected_on')
        .eq('company_id', companyId)
        .not('connected_on', 'is', null)
        .order('id')
        .range(from, to),
    'connected_on'
  )
  for (const r of rows as { id: number; connected_on: string }[]) out.set(r.id, r.connected_on)
  return out
}

/** One customer's billed_through, or null (and null before 0030). */
export async function billedThroughOf(companyId: number, customerId: number): Promise<string | null> {
  if (!(await getSchemaCapabilities()).handover) return null
  const { data, error } = await tenantClient()
    .from('customers')
    .select('billed_through')
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()
  if (error) throw new Error('Could not read billed_through: ' + error.message)
  return (data as { billed_through: string | null } | null)?.billed_through ?? null
}

/**
 * Whether calendar-month prepaid applies to a company, and its reconnection
 * fee. THE one read of it: the till, the payment action, the hourly tick, the
 * receipt and Provision all ask here, so they cannot disagree.
 *
 * THERE IS NO SWITCH (owner, 8 Oct 2026: "the model is simply how prepaid
 * works now"). It applies to a company that is PREPAID, whose billing engine
 * is LIVE, and whose engine START DATE has come — the engine is what charges
 * the months the model reduces, recomputes and settles. Before that, a
 * company's balances are raised by hand, by bill-date periods the model knows
 * nothing about, and recomputing a month at the till on top of them would
 * charge days twice. JMEDIA goes live with a start date of 1 November: through
 * October it is billed by hand as before, even with the engine set to live.
 * Postpaid companies never use the model.
 *
 * Before migration 0028 (42703 on reconnection_fee) it reads as not applying,
 * so the app behaves exactly as before 0028.
 */
export type PrepaidCalendar = {
  /** Migration 0028 is applied. */
  available: boolean
  /** The model applies to this company. */
  enabled: boolean
  /**
   * The company is billed by calendar month by the engine — calendar-month
   * prepaid, or postpaid's day-based model (owner, 11 Oct 2026): live and past
   * its start date. Payments are then named by the calendar month they settle.
   */
  calendarMonths: boolean
  reconnectionFee: number
}

export const PREPAID_CALENDAR_OFF: PrepaidCalendar = {
  available: false, enabled: false, calendarMonths: false, reconnectionFee: 0,
}

export async function prepaidCalendarFor(companyId: number): Promise<PrepaidCalendar> {
  const { data, error } = await tenantClient()
    .from('settings')
    .select('billing_type, billing_engine_mode, billing_engine_start_date, timezone, reconnection_fee')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) {
    if (error.code === '42703') return PREPAID_CALENDAR_OFF
    throw new Error('Could not read the prepaid billing settings: ' + error.message)
  }

  const row = data as {
    billing_type: string | null
    billing_engine_mode: string | null
    billing_engine_start_date: string | null
    timezone: string | null
    reconnection_fee: number | string | null
  } | null

  // The company's own date, as the engine reads it.
  const today = instantToDateOnly(new Date(), row?.timezone || 'America/Jamaica')
  const started = row?.billing_engine_start_date != null && row.billing_engine_start_date <= today

  const engineBills = row?.billing_engine_mode === 'live' && started
  return {
    available: true,
    enabled: row?.billing_type === 'prepaid' && engineBills,
    calendarMonths: engineBills,
    reconnectionFee: Math.max(0, Number(row?.reconnection_fee ?? 0)),
  }
}
