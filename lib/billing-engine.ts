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
 * TWO SHAPES, NOT ONE. A company is prepaid or postpaid (settings.billing_type)
 * and the two are different things:
 *
 *   Postpaid   THE CALENDAR MONTH, 1st to last day, charged on the COMPANY'S
 *              bill day while the month is still running. The bill day is only
 *              the day the bill goes out; it does not shape the period, and the
 *              customer's own bill_date is ignored entirely.
 *
 *   Prepaid    THE CUSTOMER'S BILL DATE TO THE SAME DATE NEXT MONTH, charged on
 *              the bill date, and it is the month AHEAD. JMEDIA's 20th group
 *              charged on 20 Sep covers 20 Sep to 20 Oct. Anchored on the
 *              customer's bill date (the company's for a customer with none —
 *              lib/billing.ts#effectiveBillDay, the one bill-day function).
 *
 * Do not unify them. A shared function with a flag would have to explain why
 * the bill day shapes one period and not the other, and that explanation is
 * the two functions below.
 *
 * THE PERIOD IS NOT THE EXPIRY. JMEDIA's 20th group: bill date 20, cut-off 24.
 * The period is 20 Sep to 20 Oct; the cut-off is the 24th; the four days
 * between are the payment window. This module names periods and charge dates.
 * It never reads, derives or produces an expiry, and the engine never writes
 * radcheck. Expiries move on payment, nowhere else.
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

import { effectiveBillDay } from '@/lib/billing'

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

/**
 * A period and the date its charge is raised.
 *
 * `start` and `end` are what bill_charges stores. `end` is the day the period
 * runs to: for postpaid the last day of the month (inclusive, as Run Bills and
 * last_billed_date already mean it); for prepaid the same date next month, the
 * day the next period starts — "20 Sep to 20 Oct".
 */
export type BillPeriod = {
  start: string
  end: string
  /** The company-local date on which this period's charge is raised. */
  chargeDate: string
}

// ---------------------------------------------------------------------------
// Date helpers, private. Whole-day arithmetic on (year, month, day) triples so
// no Date ever carries a time or a zone.
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toYmd(y: number, m: number, d: number): string {
  return y + '-' + pad(m) + '-' + pad(d)
}

/** [year, month 1-12, day] from `YYYY-MM-DD`. Throws on anything else. */
function parts(ymd: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) throw new Error('"' + ymd + '" is not a YYYY-MM-DD date.')
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Days in a month. Month is 1-12. */
function daysIn(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** A day of month clamped to the month's length: 31 in September is the 30th. */
function clampDay(y: number, m: number, day: number): number {
  return Math.min(Math.max(1, day), daysIn(y, m))
}

/** The month after (y, m). */
function nextMonth(y: number, m: number): [number, number] {
  return m === 12 ? [y + 1, 1] : [y, m + 1]
}

/** The month before (y, m). */
function prevMonth(y: number, m: number): [number, number] {
  return m === 1 ? [y - 1, 12] : [y, m - 1]
}

// ---------------------------------------------------------------------------
// The two shapes
// ---------------------------------------------------------------------------

/**
 * POSTPAID: the calendar month containing `today`, charged on the company's
 * bill day of that month.
 *
 * The bill day does not shape the period. A company billing on the 26th
 * charges 1 Sep to 30 Sep on 26 Sep, while September is still running. A bill
 * day longer than the month is clamped to its last day, so a bill day of 31
 * charges September on the 30th rather than never.
 */
export function postpaidPeriod(today: string, companyBillDay: number): BillPeriod {
  const [y, m] = parts(today)
  return {
    start: toYmd(y, m, 1),
    end: toYmd(y, m, daysIn(y, m)),
    chargeDate: toYmd(y, m, clampDay(y, m, companyBillDay)),
  }
}

/**
 * PREPAID: the customer's bill date to the same date next month, charged on the
 * bill date. The month ahead.
 *
 * The period containing `today` starts on the most recent occurrence of the
 * bill day on or before today. On 22 Sep a bill day of 20 gives 20 Sep to
 * 20 Oct; on 19 Sep it gives 20 Aug to 20 Sep. The charge date IS the start.
 *
 * A bill day longer than the month is clamped in each month separately, so a
 * bill day of 31 gives 30 Sep to 31 Oct and then 31 Oct to 30 Nov: "the same
 * date next month" as nearly as that month allows, and never a day in the
 * month after.
 */
export function prepaidPeriod(today: string, billDay: number): BillPeriod {
  const [y, m, d] = parts(today)

  let sy = y
  let sm = m
  let sd = clampDay(y, m, billDay)
  if (sd > d) {
    ;[sy, sm] = prevMonth(y, m)
    sd = clampDay(sy, sm, billDay)
  }

  const [ey, em] = nextMonth(sy, sm)
  const start = toYmd(sy, sm, sd)
  return {
    start,
    end: toYmd(ey, em, clampDay(ey, em, billDay)),
    chargeDate: start,
  }
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type EngineVerdict =
  /** Charge this customer for this period. */
  | 'charge'
  /** The period's charge date has not arrived. Postpaid only, by construction. */
  | 'not_due'
  /** The charge date is before the company's engine start date. Never charged. */
  | 'before_start'
  /**
   * The customer joined after the charge date. Their first charge is the next
   * period's. THIS IS THE GAP PRO-RATA JOINING CLOSES: the stretch between
   * joining and the next charge date is priced at the till by the first-period
   * rule (migration 0017) for now, and by nothing in this engine.
   */
  | 'joined_after'
  /** Rate plus add-ons is zero. A comped customer: the owner set their rate to 0. */
  | 'zero_rate'
  /** Access had expired in radcheck when the tick fired. No service, no charge. */
  | 'no_service'
  /** No radcheck row at all. Never provisioned, so no service to charge for. */
  | 'unprovisioned'

export type EngineCustomer = {
  id: number
  /** `customers.bill_date` as stored. Prepaid reads it; postpaid ignores it. */
  billDate: number | null
  /** `customers.date_added`. Null reads as "always been here". */
  dateAdded: string | null
  /**
   * monthly_rate PLUS every active add-on: the monthly figure the payment page
   * shows and the cashier collects. Run Bills charges the bare rate; it is the
   * outlier, not this.
   */
  monthlyCharge: number
}

export type EngineDecision = {
  verdict: EngineVerdict
  period: BillPeriod
  /** The day this customer is charged on. Informational for postpaid. */
  billDay: number
  /** Rate plus add-ons, rounded to cents. What a 'charge' verdict charges. */
  amount: number
}

/**
 * What the engine does with ONE customer, today. Pure.
 *
 * THE ORDER IS THE ORDER OF REASONS an operator should be given, and the
 * order the bill_runs counters are filled in:
 *   not_due          the charge date is ahead of today (postpaid)
 *   before_start     the charge date is before the company's start date
 *   joined_after     the customer was not here on the charge date
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
}): EngineDecision {
  const { customer } = opts

  // Postpaid ignores the customer's bill date ENTIRELY: only the company's day
  // is consulted, and a missing one reads as the 1st through the same function
  // the rest of the app uses.
  const billDay =
    opts.billingType === 'prepaid'
      ? effectiveBillDay(customer.billDate, opts.companyBillDay)
      : effectiveBillDay(null, opts.companyBillDay)

  const period =
    opts.billingType === 'prepaid'
      ? prepaidPeriod(opts.today, billDay)
      : postpaidPeriod(opts.today, billDay)

  const amount = Math.round((Number.isFinite(customer.monthlyCharge) ? customer.monthlyCharge : 0) * 100) / 100
  const out = (verdict: EngineVerdict): EngineDecision => ({ verdict, period, billDay, amount })

  if (period.chargeDate > opts.today) return out('not_due')
  if (opts.startDate === null || period.chargeDate < opts.startDate) return out('before_start')
  if (customer.dateAdded && customer.dateAdded.slice(0, 10) > period.chargeDate) return out('joined_after')
  if (amount <= 0) return out('zero_rate')
  if (opts.service === 'disconnected') return out('no_service')
  if (opts.service === 'unprovisioned') return out('unprovisioned')
  return out('charge')
}

/** One element of the list apply_bill_charges() takes. */
export type ChargeElement = {
  customer_id: number
  period_start: string
  period_end: string
  amount: number
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
    }))
}
