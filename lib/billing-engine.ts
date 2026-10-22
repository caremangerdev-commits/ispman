/**
 * The daily billing engine's arithmetic: the two period shapes and the one
 * verdict. Migration 0024.
 *
 * CLIENT-SAFE ON PURPOSE, like lib/billing.ts: the Billing Runs page previews
 * what a tick would do with the same functions the tick runs, so the two
 * cannot disagree. Nothing here reads a database; the tick route hands rows
 * in and the Postgres function (apply_bill_charges, migration 0024) applies
 * the result. The shapes exist HERE and nowhere else — not in SQL, not in a
 * second copy for the page.
 *
 * ONE SHAPE: THE CALENDAR MONTH, 1st to last day, charged on the COMPANY'S
 * bill day, for prepaid and postpaid alike. The bill day is only the day the
 * charge is raised; it does not shape the period, and the customer's own
 * bill_date is not read.
 *
 * What differs is the amount. Prepaid is calendar-month prepaid (migration
 * 0028, owner 7-8 Oct 2026 — "simply how prepaid works now"): the month's
 * figure is ROUNDED TO THE NEAREST HUNDRED (lib/prepaid-calendar.ts#round100),
 * and the hourly service pass later reduces it to the days of service if the
 * customer is cut off (lib/data/prepaid-service.ts). Postpaid charges the
 * exact figure.
 *
 * The old prepaid shape — each customer's bill date to the same date next
 * month — was deleted on 8 Oct 2026. Ezmze, the one company it ran for, was
 * billing the calendar month already (every bill date the 1st).
 *
 * THE PERIOD IS NOT THE EXPIRY. The cut-off day is when an unpaid customer is
 * disconnected, not the end of the period. This module names periods and
 * charge dates. It never reads, derives or produces an expiry, and the engine
 * never writes radcheck. Expiries move on payment, nowhere else.
 *
 * ONE PERIOD PER CUSTOMER, EVER. NEVER A BACKLOG. The verdict looks only at
 * the period containing today. A tick late in that period still charges it
 * (late is not skipped); a tick before its charge date waits; no tick ever
 * reaches back to an earlier period. Whether a period has ALREADY been charged
 * is not decided here at all — that is the unique index on bill_charges
 * (customer_id, period_start), which apply_bill_charges() reports back as
 * "already charged".
 *
 * DATE-ONLY STRINGS THROUGHOUT, compared as strings. `today` is the company's
 * own date (lib/format.ts#instantToDateOnly with settings.timezone), never the
 * server's. No Date object crosses a zone here, which is the mistake the
 * payment preview once made.
 */

import {
  daysNotBilledInPeriod, daysToPeriodEnd, periodDays, periodFor, type BillPeriod,
} from '@/lib/bill-period'
import { effectiveBillDay } from '@/lib/billing'
import { monthFigure, round100 } from '@/lib/prepaid-calendar'
import { postpaidMonthCharge, type ServiceBreak } from '@/lib/service-days'

// The period shapes live in lib/bill-period.ts so the payment path can use the
// same arithmetic without a cycle. Re-exported here because this is where
// every caller already looks for them.
export { flexPeriod, monthPeriod, periodDays, type BillPeriod } from '@/lib/bill-period'

/** `settings.billing_type`. No per-customer override exists. */
export type CompanyBillingType = 'prepaid' | 'postpaid'

/** `settings.billing_engine_mode`. */
export type EngineMode = 'off' | 'dry_run' | 'live'

export function toCompanyBillingType(value: string | null | undefined): CompanyBillingType {
  return value === 'prepaid' ? 'prepaid' : 'postpaid'
}

export function toEngineMode(value: string | null | undefined): EngineMode {
  return value === 'live' || value === 'dry_run' ? value : 'off'
}

// The period shapes, the date helpers and the period-relative day counts all
// live in lib/bill-period.ts now (migration 0043), so the payment path can use
// the same arithmetic. They are imported and re-exported above.



// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type EngineVerdict =
  /** Charge this customer for this period. */
  | 'charge'
  /** The month's charge date (the company's bill day) has not arrived. */
  | 'not_due'
  /** The charge date is before the company's engine start date. Never charged. */
  | 'before_start'
  /**
   * The customer was connected after the charge date, or connected this month
   * with the company's connection month OFF (0032). This month is not charged
   * by the engine: with the connection month on, a prepaid customer's was
   * charged at Provision; with it off, they start on the 1st of next month.
   */
  | 'joined_after'
  /**
   * The whole month was charged before the engine took this customer over
   * (customers.billed_through, migration 0030). Prepaid only.
   */
  | 'covered'
  /** Rate plus add-ons is zero. A comped customer: the owner set their rate to 0. */
  | 'zero_rate'
  /** Access had expired in radcheck when the tick fired. No service, no charge. */
  | 'no_service'
  /** No radcheck row at all. Never provisioned, so no service to charge for. */
  | 'unprovisioned'

export type EngineCustomer = {
  id: number
  /**
   * `customers.bill_date`: the day of the month THIS customer is billed on,
   * resolved through effectiveBillDay against the company's day. Most
   * customers have none and fall back to the company's. Read on both shapes —
   * on a calendar month it moves the charge date, on a flex month it also
   * opens the period.
   */
  billDate?: number | null
  /** `customers.date_added`. Null reads as "always been here". */
  dateAdded: string | null
  /**
   * monthly_rate PLUS every active add-on: the monthly figure the payment page
   * shows and the cashier collects. Run Bills charges the bare rate; it is the
   * outlier, not this.
   */
  monthlyCharge: number
  /**
   * `customers.billed_through` (migration 0030): the last day charged by hand
   * before the engine took the customer over. Null for everybody the engine
   * has always billed. Prepaid reads it; postpaid ignores it.
   */
  billedThrough?: string | null
  /**
   * `customers.connected_on` (migration 0032): the day they were first
   * provisioned. The engine counts them as joined on it, falling back to
   * dateAdded for a customer never provisioned in ISPMan.
   */
  connectedOn?: string | null
  /**
   * POSTPAID, DAY-BASED (owner, 11 Oct 2026): the customer's breaks in service
   * (lib/data/service-breaks.ts). Given for every postpaid customer; the month
   * is then priced by lib/service-days.ts#postpaidMonthCharge.
   */
  breaks?: ServiceBreak[]
}

export type EngineDecision = {
  verdict: EngineVerdict
  period: BillPeriod
  /** The company's bill day: the day every customer's month is charged on. */
  billDay: number
  /**
   * What a 'charge' verdict charges: rate plus add-ons — to the nearest
   * hundred for prepaid, to the cent for postpaid. For the month a hand-over
   * ends in, the days after it (lib/prepaid-calendar.ts#monthFigure).
   */
  amount: number
  /** The days `amount` rests on when it is a part month; null for a whole month. */
  serviceDays: number | null
  /** The whole month's figure, kept beside a part month's amount. */
  fullAmount: number
}

/**
 * What the engine does with ONE customer, today. Pure.
 *
 * THE ORDER IS THE ORDER OF REASONS an operator should be given, and the
 * order the bill_runs counters are filled in:
 *   not_due          the charge date is ahead of today
 *   before_start     the charge date is before the company's start date
 *   joined_after     the customer was not here on the charge date
 *   covered          the whole month was charged by hand before the hand-over
 *   zero_rate        nothing to charge
 *   no_service / unprovisioned   radcheck, read by the caller
 *   charge
 *
 * "Already charged" is deliberately absent: the unique index decides it, and
 * apply_bill_charges() reports it. A preview that wants the number asks
 * bill_charges directly.
 *
 * `startDate` null reads as "never" — the mode/start check constraint on
 * settings makes that unreachable for a company that is not off, and this is
 * the safe reading if it ever is.
 */
export function engineVerdict(opts: {
  billingType: CompanyBillingType
  /** Today in the company's zone, `YYYY-MM-DD`. */
  today: string
  /** `settings.billing_engine_start_date`. */
  startDate: string | null
  /** `settings.bill_date`. */
  companyBillDay: number | null
  customer: EngineCustomer
  /** From the registry. Undefined when the caller could not resolve an identity. */
  service: 'active' | 'disconnected' | 'unprovisioned' | undefined
  /**
   * settings.charge_connection_month (migration 0032). On: the month a
   * customer was connected in is charged from the connection day to its end.
   * Off: that month is not charged at all. Prepaid and postpaid alike.
   */
  chargeConnectionMonth?: boolean
  /**
   * `settings.flex_month`. Off (the default): the period is the calendar
   * month, exactly as before. On: the period runs from the customer's bill day
   * to the day before the next one.
   */
  flexMonth?: boolean
}): EngineDecision {
  const { customer } = opts

  // The customer's own day, falling back to the company's, through the same
  // function the till and the payment path already use — so a charge and the
  // payment that clears it can never be worked out from different days.
  const billDay = effectiveBillDay(customer.billDate ?? null, opts.companyBillDay)
  const period = periodFor(opts.today, billDay, opts.flexMonth === true)
  const span = periodDays(period)

  const exact = Math.round((Number.isFinite(customer.monthlyCharge) ? customer.monthlyCharge : 0) * 100) / 100
  const prepaid = opts.billingType === 'prepaid'
  const fullAmount = prepaid ? round100(exact) : exact

  // JOINED ON THE CONNECTION DAY (0032), not the day the record was made.
  const joined = (customer.connectedOn ?? customer.dateAdded ?? null)?.slice(0, 10) ?? null

  // POSTPAID, DAY-BASED (owner, 11 Oct 2026). The month running is priced
  // from the days of service — those had so far, and the rest of the month for
  // a customer on service now — so a customer off on the bill day still pays
  // for the days they had, and one off all month pays nothing. Changes after
  // the bill day are settled on the next one (lib/data/postpaid-settle.ts).
  if (!prepaid && customer.breaks !== undefined) {
    const p = postpaidMonthCharge({
      monthStart: period.start,
      monthlyCharge: exact,
      breaks: customer.breaks,
      joinedOn: joined,
      chargeConnectionMonth: opts.chargeConnectionMonth === true,
    })
    const outDays = (verdict: EngineVerdict): EngineDecision =>
      ({ verdict, period, billDay, amount: p.amount, serviceDays: p.serviceDays, fullAmount: p.fullAmount })
    if (period.chargeDate > opts.today) return outDays('not_due')
    if (opts.startDate === null || period.chargeDate < opts.startDate) return outDays('before_start')
    if (joined !== null && joined > period.chargeDate) return outDays('joined_after')
    if (p.connectionMonth && opts.chargeConnectionMonth !== true) return outDays('joined_after')
    if (exact <= 0) return outDays('zero_rate')
    if (opts.service === 'unprovisioned') return outDays('unprovisioned')
    if (p.days === 0) return outDays('no_service')
    return outDays('charge')
  }
  // Connected partway through this period: the connection month.
  const connectionMonth = joined !== null && joined > period.start && joined <= period.end

  // Days of the period to charge; null for all of them.
  //   THE HAND-OVER (0030, owner 8 Oct 2026): only the days after the last day
  //   charged by hand.
  //   THE CONNECTION MONTH (0032, owner 11 Oct 2026): from the connection day.
  // Both are measured against the PERIOD, which is the calendar month unless
  // flex is on — so these give the same answers as before for every company
  // that has not turned it on.
  const handover = prepaid ? daysNotBilledInPeriod(period, customer.billedThrough ?? null) : null
  const fromConnection = connectionMonth ? daysToPeriodEnd(joined, period) : null
  const open = handover === null ? fromConnection
    : fromConnection === null ? handover
      : Math.min(handover, fromConnection)
  const amount = open === null ? fullAmount : monthFigure(exact, open, span)
  const out = (verdict: EngineVerdict): EngineDecision =>
    ({ verdict, period, billDay, amount, serviceDays: open, fullAmount })

  if (period.chargeDate > opts.today) return out('not_due')
  if (opts.startDate === null || period.chargeDate < opts.startDate) return out('before_start')
  if (joined !== null && joined > period.chargeDate) return out('joined_after')
  // Connected this month, on or before its charge date, with the connection
  // month OFF: not charged — they start on the 1st of the next month.
  if (connectionMonth && !opts.chargeConnectionMonth) return out('joined_after')
  if (open === 0) return out('covered')
  if (amount <= 0) return out('zero_rate')
  if (opts.service === 'disconnected') return out('no_service')
  if (opts.service === 'unprovisioned') return out('unprovisioned')
  return out('charge')
}

/**
 * One element of the list apply_bill_charges() takes. A part month carries its
 * days and the full-month figure, which 0030's version of the function writes
 * to the row so the service pass and the till work from them.
 */
export type ChargeElement = {
  customer_id: number
  period_start: string
  period_end: string
  amount: number
  service_days?: number
  full_amount?: number
}

/** The 'charge' decisions, in the shape the Postgres function consumes. */
export function toChargeElements(
  decided: { customer: EngineCustomer; decision: EngineDecision }[]
): ChargeElement[] {
  return decided
    .filter((d) => d.decision.verdict === 'charge')
    .map((d) => ({
      customer_id: d.customer.id,
      period_start: d.decision.period.start,
      period_end: d.decision.period.end,
      amount: d.decision.amount,
      ...(d.decision.serviceDays === null
        ? {}
        : { service_days: d.decision.serviceDays, full_amount: d.decision.fullAmount }),
    }))
}
