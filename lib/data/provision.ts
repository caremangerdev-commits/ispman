import 'server-only'

import { addonTotals } from '@/lib/data/addon-totals'
import { getFirstPeriodRules } from '@/lib/data/company'
import { prepaidCalendarFor } from '@/lib/data/prepaid-calendar'
import { instantToDateOnly } from '@/lib/format'
import {
  firstMonthCharge, monthLabel, provisionChoices, provisionDefault,
} from '@/lib/prepaid-calendar'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * What the Provision popup offers, and what provisionCustomer accepts. ONE
 * read for both, so the two dates on the screen are the two the action checks
 * the posted one against (owner, 8 Oct 2026: "popup with every press of the
 * provision button with both cut off dates only", for every company, prepaid
 * and postpaid).
 *
 * `today` is the COMPANY's date, not the server's: on a UTC server the day
 * turns at 7 or 8 PM in Jamaica, and the next cut-off day would turn with it.
 */
export type ProvisionPlan = {
  today: string
  /** The next cut-off day after today and the one after it; null without a cut-off day. */
  choices: [string, string] | null
  /** The choice the popup starts on: the company's own first-expiry rule. */
  preselect: string | null
  /**
   * Calendar-month prepaid (migration 0028), when on for the company: the first
   * charge Provision writes — connection day to the month's end. Null otherwise.
   */
  firstCharge: (ReturnType<typeof firstMonthCharge> & { label: string }) | null
}

/**
 * The log types Provision writes about the first month's charge — only ever
 * with calendar-month prepaid on. Any one of them is the record that a
 * customer was provisioned UNDER the model (see provisionedUnderModel).
 */
export const FIRST_MONTH_EVENTS = {
  charged: 'first_month_charged',
  skipped: 'first_month_charge_skipped',
  failed: 'first_month_charge_failed',
} as const

/**
 * Was this customer provisioned with calendar-month prepaid on?
 *
 * OPTION A (owner, 8 Oct 2026): customers provisioned BEFORE the model came in,
 * who have not paid yet, finish on the first-payment rule they were
 * provisioned under; anyone provisioned under it gets the model. The till asks
 * here.
 *
 * The evidence is Provision's own log row about the first month's charge —
 * written, skipped or failed — not a date: it says what actually happened at
 * that customer's provisioning, and a failed charge (added by hand afterwards)
 * still counts as provisioned under the model, so the old rule cannot charge
 * the first period a second time.
 */
export async function provisionedUnderModel(companyId: number, customerId: number): Promise<boolean> {
  const { data, error } = await tenantClient()
    .from('log')
    .select('id')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .in('type', Object.values(FIRST_MONTH_EVENTS))
    .limit(1)
  if (error) throw new Error('Could not read how this customer was provisioned: ' + error.message)
  return (data ?? []).length > 0
}

export async function provisionPlan(
  companyId: number,
  customerId: number,
  now: Date = new Date()
): Promise<ProvisionPlan> {
  const db = tenantClient()
  const [{ data: settings }, { data: customer }, rules, calendar] = await Promise.all([
    db.from('settings').select('timezone').eq('company_id', companyId).maybeSingle(),
    db.from('customers').select('cut_off_date, monthly_rate')
      .eq('company_id', companyId).eq('id', customerId).maybeSingle(),
    getFirstPeriodRules(companyId),
    prepaidCalendarFor(companyId),
  ])

  const zone = (settings as { timezone: string | null } | null)?.timezone || 'America/Jamaica'
  const today = instantToDateOnly(now, zone)
  const row = customer as { cut_off_date: number | null; monthly_rate: number | string | null } | null

  const cutOff = row?.cut_off_date ?? null
  const choices = cutOff && cutOff >= 1 ? provisionChoices(today, cutOff) : null

  let firstCharge: ProvisionPlan['firstCharge'] = null
  if (calendar.enabled && row) {
    // Rate plus add-ons: the monthly charge every other path prices from.
    const addons = (await addonTotals([customerId])).get(customerId) ?? 0
    const charge = firstMonthCharge(today, Number(row.monthly_rate ?? 0) + addons)
    firstCharge = { ...charge, label: monthLabel(charge.periodStart) }
  }

  return {
    today,
    choices,
    preselect: choices
      ? provisionDefault(today, choices, rules.firstExpiryRuleEnabled && !calendar.enabled)
      : null,
    firstCharge,
  }
}
