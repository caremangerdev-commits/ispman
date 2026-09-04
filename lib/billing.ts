/**
 * Prepaid and postpaid billing arithmetic (migration 0011).
 *
 * Client-safe on purpose: the record-payment form previews every figure the
 * server is about to write, so both sides have to run the same functions. The
 * server remains the source of truth — nothing here is trusted from the form.
 *
 * The two billing types differ in when the money is collected, and therefore in
 * WHERE THE DEBT ALREADY IS by the time a cashier sees the customer:
 *
 *   prepaid  — buys months up front. The month being bought is not on the
 *              account yet, so the amount due is this month's charge plus
 *              anything carried, and access runs from the expiry already held.
 *   postpaid — is billed for a period already used. THE BILL RUN
 *              (app/actions/bulk.ts#billBatch) HAS ALREADY ADDED THE MONTHLY
 *              CHARGE TO `carried_balance`, so the amount due IS the carried
 *              balance. Adding a monthly charge on top of it at the till bills
 *              the customer twice for the same month.
 *
 * That asymmetry is why every money function below takes a BillingType. It is
 * the FIRST parameter rather than the last so that a call with its arguments in
 * the wrong order fails to compile instead of quietly returning a wrong figure.
 *
 * The same split governs the dates. `bill_date` decides WHEN A BILL IS
 * GENERATED; `cut_off_date` decides WHEN ACCESS EXPIRES. They are different
 * columns describing different events, and neither substitutes for the other.
 */

import { addMonths, nextCutOff } from '@/lib/expiry'

/** `customers.billing_type`. */
export type BillingType = 'prepaid' | 'postpaid'

export const BILLING_TYPES: BillingType[] = ['prepaid', 'postpaid']

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  prepaid: 'Prepaid',
  postpaid: 'Postpaid',
}

export const BILLING_TYPE_HELP: Record<BillingType, string> = {
  prepaid: 'Pays in advance. Access runs from their current expiry.',
  postpaid: 'Billed for the month just used. Access runs to their cut off date.',
}

export function toBillingType(value: string | null | undefined): BillingType {
  return BILLING_TYPES.includes(value as BillingType) ? (value as BillingType) : 'prepaid'
}

/**
 * `payments.access_decision` — how a short payment was resolved at the till.
 *
 * `proportional` is part of the column's vocabulary but the record-payment form
 * never writes it: choosing a date always stores `date_selected`, even when the
 * cashier accepts the suggested proportional date unchanged. Keeping the two
 * apart means the log records what the cashier chose, not what we inferred.
 */
export type AccessDecision = 'full_period' | 'proportional' | 'date_selected'

export const ACCESS_DECISIONS: AccessDecision[] = [
  'full_period', 'proportional', 'date_selected',
]

export function toAccessDecision(
  value: string | null | undefined
): AccessDecision | null {
  return ACCESS_DECISIONS.includes(value as AccessDecision)
    ? (value as AccessDecision)
    : null
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` from a date's LOCAL parts.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that converts to UTC first, so
 * a local midnight anywhere east of Greenwich reports the previous day. These
 * values become billing period and expiry dates, so an off-by-one is a real
 * billing error.
 */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

/** Parses `YYYY-MM-DD` as LOCAL midnight, for the same reason as ymd(). */
export function parseYmd(value: string | null | undefined): Date | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0)
  return Number.isFinite(d.getTime()) ? d : null
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

const DAY = 86_400_000

/** Whole days between two dates, ignoring the time of day. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY)
}

/**
 * The first of the month a postpaid payment is settling.
 *
 * Postpaid bills IN ARREARS: the run on `bill_date` charges for the month that
 * has just ended. A payment is therefore NEVER settling the month it is taken
 * in — on a bill date of the 1st, money taken on 4 September pays the August
 * bill. Reading the period off the payment date, as this used to, labelled every
 * postpaid payment with a month the customer had not been billed for yet.
 *
 * A payment taken BEFORE this month's bill has been generated goes back one
 * month further, because the charge it is clearing came from the previous run:
 * with a bill date of the 15th, a payment on 10 September still settles July. A
 * bill date of the 1st can never reach that branch, which is why a company
 * billing on the 1st always sees simply "the previous month".
 *
 * Derived from `bill_date` rather than from `last_billed_date`, even though the
 * bill run stamps the period end there: a postpaid payment overwrites that same
 * column with the payment date (app/actions/payments.ts, the settle step), so it
 * cannot be relied on to still describe a billing period.
 */
function settledMonthStart(from: Date, billDate: number | null): Date {
  const day = billDate && billDate >= 1 ? Math.floor(billDate) : 1
  const back = from.getDate() >= day ? 1 : 2
  return new Date(from.getFullYear(), from.getMonth() - back, 1)
}

/** The month a postpaid payment covers — first and last day inclusive. */
export function billingPeriod(
  from: Date,
  billDate: number | null
): { start: string; end: string } {
  const start = settledMonthStart(from, billDate)
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0)
  return { start: ymd(start), end: ymd(end) }
}

/** "August 2026" — the bill period label on the expiry preview. */
export function billingPeriodLabel(from: Date, billDate: number | null): string {
  return settledMonthStart(from, billDate)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * What the customer owes today.
 *
 * PREPAID   — this month's charge plus anything carried. The month is being
 *             bought now, so it is not on the account until this figure is paid.
 * POSTPAID  — the carried balance, and nothing else. The bill run put the
 *             monthly charge there when the period ended; charging a month again
 *             here is the same month billed twice.
 *
 * `monthlyCharge` is the customer's full monthly figure — their rate plus every
 * active add-on — not the bare `monthly_rate` column. Billing the bare rate
 * would silently drop add-ons from a prepaid amount due. It is still required
 * for postpaid because the proportional-access maths is priced off a month.
 */
export function amountDue(
  billingType: BillingType,
  monthlyCharge: number,
  carriedBalance: number
): number {
  if (billingType === 'postpaid') return round2(safe(carriedBalance))
  return round2(safe(monthlyCharge) + safe(carriedBalance))
}

/**
 * What a payment leaves owing — measured against whichever figure the customer
 * is actually short of.
 *
 * PREPAID   — the monthly charge alone, NOT the amount due. A short payment
 *             carries one month's shortfall forward, and the balance already
 *             being carried is not re-carried on top of itself.
 * POSTPAID  — the carried balance, which is the whole of what is owed. Measuring
 *             a postpaid shortfall against one month's charge wrote off every
 *             month beyond the first: a customer carrying two months at 4,500
 *             who handed over 4,000 was left owing 500 instead of 5,000.
 *
 * This is the rule the activity log and the customer's new `carried_balance`
 * both use, so the figure the cashier is shown is the figure that gets written.
 */
export function outstandingBalance(
  billingType: BillingType,
  monthlyCharge: number,
  carriedBalance: number,
  amountPaid: number
): number {
  const owed = billingType === 'postpaid' ? safe(carriedBalance) : safe(monthlyCharge)
  return round2(Math.max(0, owed - safe(amountPaid)))
}

/** The `carried_balance` to write. Clearing the full amount due clears it. */
export function carriedBalanceAfter(
  billingType: BillingType,
  monthlyCharge: number,
  carriedBalance: number,
  amountPaid: number
): number {
  if (safe(amountPaid) >= amountDue(billingType, monthlyCharge, carriedBalance)) return 0
  return outstandingBalance(billingType, monthlyCharge, carriedBalance, amountPaid)
}

/** True when the money taken does not cover what is owed. */
export function isPartialPayment(
  billingType: BillingType,
  monthlyCharge: number,
  carriedBalance: number,
  amountPaid: number
): boolean {
  const paid = safe(amountPaid)
  return paid > 0 && paid < amountDue(billingType, monthlyCharge, carriedBalance)
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Days of access a short payment has actually bought, as thirtieths of a month.
 *
 * Always rounded DOWN. A part-day is not a day of service, and rounding up
 * would give away access that was not paid for on every partial payment the
 * company takes.
 */
export function proportionalDays(amountPaid: number, monthlyCharge: number): number {
  const charge = safe(monthlyCharge)
  const paid = safe(amountPaid)
  if (charge <= 0 || paid <= 0) return 0
  return Math.floor((paid / charge) * 30)
}

/**
 * The date a short payment proportionally reaches — the picker's suggestion.
 *
 * Prepaid runs from today, because a prepaid customer is buying forward from
 * now. Postpaid runs from the expiry already held in the network registry,
 * because that is where their paid-for access currently ends; an unprovisioned
 * postpaid customer has no such anchor and runs from today instead.
 *
 * A registry expiry already in the past is used as-is rather than being pulled
 * forward to today: the customer is being credited only the days they paid for,
 * and the cashier can move the picker if the result is unusable.
 */
export function proportionalDate(opts: {
  billingType: BillingType
  amountPaid: number
  monthlyCharge: number
  /** Expiry held in the network registry. Null when unprovisioned. */
  currentExpiry: Date | null
  from: Date
}): Date {
  const { billingType, amountPaid, monthlyCharge, currentExpiry, from } = opts

  const base =
    billingType === 'postpaid' && currentExpiry
      ? startOfDay(currentExpiry)
      : startOfDay(from)

  base.setDate(base.getDate() + proportionalDays(amountPaid, monthlyCharge))
  return base
}

/**
 * Expiry a full postpaid payment reaches: the CUT-OFF DAY AFTER THE ONE THE
 * CUSTOMER IS CURRENTLY PAID THROUGH, plus the company grace period.
 *
 * Two things here were previously wrong, and they compounded.
 *
 * FIRST, THE DAY IS `cut_off_date`, NOT `bill_date`. This used to take the bill
 * day and lean on grace_period_days to stand in for the cut-off. With the
 * default grace of 0 (migration 0007) that collapsed the two columns together,
 * so a customer billed on the 1st and cut off on the 8th was given the 1st.
 * bill_date decides when a bill is GENERATED and has no bearing on access.
 *
 * SECOND, THE ANCHOR IS THE HELD EXPIRY, NOT TODAY. Billing in arrears, the
 * cut-off ahead of a customer is the deadline for the bill they are standing at
 * the counter to settle — so paying it must carry them PAST that cut-off, not up
 * to it. Anchoring on today returned the deadline itself: a customer cut off on
 * the 8th who paid August's bill on 3 September bought five days.
 *
 * Anchoring on the registry expiry gets both the early and the late payer right,
 * because a cut-off already behind them cannot be the anchor:
 *
 *   cut-off 8, holds 8 Sep, pays  3 Sep  → 8 Oct   (rolled past the deadline)
 *   cut-off 8, holds 8 Sep, pays 20 Sep  → 8 Oct   (paying late buys no more)
 *
 * An expiry at or behind today is not used — walking forward from it could still
 * land in the past and leave a paying customer offline — so those anchor on the
 * payment date, which is also what an unprovisioned customer gets.
 *
 * The grace period is added on top of the cut-off day, which is where a company
 * that runs one wants it: cut off on the 8th with 5 days' grace disconnects on
 * the 13th. It is added AFTER the walk, so the held expiry it produced last
 * month still anchors to the right cut-off this month.
 *
 * nextCutOff clamps a day longer than the target month, so a cut-off of 31 lands
 * on 30 September rather than rolling into October. Falls back to whole months
 * when no cut-off day is recorded — the same fallback prepaid uses.
 */
export function postpaidExpiry(opts: {
  cutOffDay: number | null
  gracePeriodDays: number
  /** Expiry held in the network registry. Null when unprovisioned. */
  currentExpiry: Date | null
  from: Date
}): Date {
  const { cutOffDay, gracePeriodDays, currentExpiry, from } = opts

  const grace = Math.max(0, Math.floor(safe(gracePeriodDays)))
  const today = startOfDay(from)

  const anchor =
    currentExpiry && startOfDay(currentExpiry).getTime() > today.getTime()
      ? startOfDay(currentExpiry)
      : today

  // nextCutOff is strictly after the anchor and the anchor is never behind
  // today, so this can never return a date that has already passed.
  const next = nextCutOff(anchor, cutOffDay) ?? addMonths(anchor, 1)
  next.setDate(next.getDate() + grace)
  return next
}

// ---------------------------------------------------------------------------

function safe(n: number | string | null | undefined): number {
  const v = Number(n ?? 0)
  return Number.isFinite(v) ? v : 0
}

/** Money is stored as numeric; keep float drift out of what we write back. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
