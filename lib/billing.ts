/**
 * Billing arithmetic (migration 0011).
 *
 * Client-safe on purpose: the record-payment form previews every figure the
 * server is about to write, so both sides have to run the same functions. The
 * server remains the source of truth — nothing here is trusted from the form.
 *
 * ONE BILLING MODEL. Every company bills the same way:
 *
 *   the bill run (app/actions/bulk.ts#billBatch) adds monthly_rate to
 *   `carried_balance`; payments reduce it. THE AMOUNT DUE IS THE CARRIED
 *   BALANCE, full stop. Adding a monthly charge on top of it at the till bills
 *   the customer twice for the same month.
 *
 * THE PREPAID/POSTPAID SPLIT IS RETIRED. It modelled a distinction that did not
 * exist in the data: the prepaid arm read its debt from `customers.balance`, a
 * column no writer ever CHARGED — the bill run never touched it and the payment
 * path only decremented it — so it decayed to 0 and every prepaid customer read
 * as owing nothing while carrying real arrears. `carried_balance` was already
 * the authoritative debt for both arms, so the arms were collapsed into the
 * postpaid one, which is the arm that was correct.
 *
 * `customers.billing_type` still exists as a column and is still read back as
 * data, but NOTHING BRANCHES ON IT. Do not reintroduce a branch here without
 * first giving the other model a column that is actually charged.
 *
 * `bill_date` decides WHEN A BILL IS GENERATED; `cut_off_date` decides WHEN
 * ACCESS EXPIRES. They are different columns describing different events, and
 * neither substitutes for the other.
 */

import { addMonths, advanceCutOff } from '@/lib/expiry'

/** `customers.billing_type`. */
export type BillingType = 'prepaid' | 'postpaid'

const BILLING_TYPES: BillingType[] = ['prepaid', 'postpaid']

// No LABELS and no HELP: nothing presents billing type as a choice any more,
// and a label is what a choice needs. toBillingType survives only to keep the
// column's values legal on the way in and out.
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
 * The first of the month a payment is settling.
 *
 * Billing is IN ARREARS: the run on `bill_date` charges for the month that
 * has just ended. A payment is therefore NEVER settling the month it is taken
 * in — on a bill date of the 1st, money taken on 4 September pays the August
 * bill. Reading the period off the payment date, as this used to, labelled every
 * payment with a month the customer had not been billed for yet.
 *
 * A payment taken BEFORE this month's bill has been generated goes back one
 * month further, because the charge it is clearing came from the previous run:
 * with a bill date of the 15th, a payment on 10 September still settles July. A
 * bill date of the 1st can never reach that branch, which is why a company
 * billing on the 1st always sees simply "the previous month".
 *
 * Derived from `bill_date` rather than from `last_billed_date`. The bill run
 * stamps the period end there and is the only writer of it, but it is stamped
 * per RUN rather than per customer-month, so bill_date is the stabler anchor.
 */
function settledMonthStart(from: Date, billDate: number | null): Date {
  const day = billDate && billDate >= 1 ? Math.floor(billDate) : 1
  const back = from.getDate() >= day ? 1 : 2
  return new Date(from.getFullYear(), from.getMonth() - back, 1)
}

/** The month a payment covers — first and last day inclusive. */
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
 * What the customer owes today: the carried balance, and nothing else.
 *
 * The bill run put the monthly charge there when the period ended, so charging
 * a month again here is the same month billed twice.
 *
 * Takes no monthly charge and no billing type. Both were parameters of the
 * retired split — see the note at the top of this file.
 */
export function amountDue(carriedBalance: number): number {
  return round2(safe(carriedBalance))
}

/**
 * What a payment leaves owing.
 *
 * Measured against the carried balance, which is the whole of what is owed.
 * Measuring a shortfall against one month's charge instead wrote off every
 * month beyond the first: a customer carrying two months at 4,500 who handed
 * over 4,000 was left owing 500 instead of 5,000.
 *
 * This is the rule the activity log and the customer's new `carried_balance`
 * both use, so the figure the cashier is shown is the figure that gets written.
 */
export function outstandingBalance(carriedBalance: number, amountPaid: number): number {
  return round2(Math.max(0, safe(carriedBalance) - safe(amountPaid)))
}

/**
 * The `carried_balance` to write. Clearing the full amount due clears it.
 *
 * Identical to outstandingBalance now that the amount due IS the carried
 * balance — the two diverged only under the retired prepaid arm, where the
 * amount due carried a monthly charge the shortfall was not measured against.
 * Kept as its own function because the two say different things at the call
 * site, and a later billing rule may separate them again.
 */
export function carriedBalanceAfter(carriedBalance: number, amountPaid: number): number {
  return outstandingBalance(carriedBalance, amountPaid)
}

/** True when the money taken does not cover what is owed. */
export function isPartialPayment(carriedBalance: number, amountPaid: number): boolean {
  const paid = safe(amountPaid)
  return paid > 0 && paid < amountDue(carriedBalance)
}

// ---------------------------------------------------------------------------
// Prepayment
// ---------------------------------------------------------------------------

/**
 * The most months one payment can buy forward.
 *
 * Caps what a mistyped amount can do: at a rate of 3,500 an extra zero would
 * otherwise push an expiry out by twenty years. Money beyond the cap is still
 * kept — it becomes credit — it just buys no further expiry.
 */
export const MAX_PREPAY_MONTHS = 6

export const PREPAY_MONTH_OPTIONS = [1, 2, 3, 4, 5, 6]

/**
 * What the till should ask for when the cashier picks `months`.
 *
 * The FIRST month is what the customer already owes — their carried balance —
 * and every month after it is a full monthly charge paid forward. So one month
 * asks for the balance alone, which is what the form did before prepayment
 * existed.
 *
 * With nothing owed, one month asks for nothing: a customer who is square and
 * wants to pay ahead picks two or more.
 */
export function amountDueForMonths(
  carriedBalance: number,
  monthlyCharge: number,
  months: number
): number {
  const extra = Math.max(0, Math.floor(months) - 1)
  return round2(safe(carriedBalance) + safe(monthlyCharge) * extra)
}

/**
 * Money received beyond what was owed. This is what becomes `account_credit`.
 *
 * Never negative: a payment short of the balance creates no credit, it leaves
 * a carried balance — see outstandingBalance.
 */
export function prepaymentCredit(carriedBalance: number, amountPaid: number): number {
  return round2(Math.max(0, safe(amountPaid) - safe(carriedBalance)))
}

/**
 * How many months of ACCESS the money actually bought.
 *
 * DERIVED FROM THE MONEY, NOT FROM THE DROPDOWN. The dropdown seeds the amount
 * field; the cashier can then type over it, and what the customer handed across
 * the counter is what they get. Picking "3 months" and taking one month's money
 * must not buy three months of access, and the two agree exactly whenever the
 * seeded amount is the amount paid — which is the ordinary case.
 *
 * The first month is always included and is the one the cut-off walk already
 * bought, whether or not there was a balance to settle. Each further whole
 * monthly charge on top buys one more.
 *
 *   rate 3,500, owes 3,500, pays 10,500 -> credit 7,000 -> 1 + 2 = 3 months
 *   rate 3,500, owes 3,500, pays  3,500 -> credit     0 -> 1 month
 *   rate 3,500, owes     0, pays 10,500 -> credit 10,500 -> 1 + 3 = 4 months
 *
 * A short payment yields 1: the partial-payment machinery decides that expiry,
 * exactly as it did before prepayment existed.
 */
export function monthsCovered(
  carriedBalance: number,
  monthlyCharge: number,
  amountPaid: number
): number {
  const charge = safe(monthlyCharge)
  if (charge <= 0) return 1

  const extra = Math.floor(prepaymentCredit(carriedBalance, amountPaid) / charge)
  return Math.min(MAX_PREPAY_MONTHS, 1 + Math.max(0, extra))
}

/**
 * What a bill run's charge does against a standing credit.
 *
 * Credit is drawn down BEFORE anything is added to the carried balance, so a
 * customer who paid three months up front is not shown as owing money in the
 * two runs their prepayment already covers.
 *
 * Both columns carry a `>= 0` CHECK (migration 0011) and neither result here
 * can go negative: the draw is capped at the credit held and at the charge.
 */
export function applyCredit(
  accountCredit: number,
  carriedBalance: number,
  charge: number
): { credit: number; carriedBalance: number; drawn: number } {
  const held = Math.max(0, safe(accountCredit))
  const due = Math.max(0, safe(charge))
  const drawn = Math.min(held, due)

  return {
    credit: round2(held - drawn),
    carriedBalance: round2(safe(carriedBalance) + (due - drawn)),
    drawn: round2(drawn),
  }
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
 * Runs from the expiry already held in the network registry, because that is
 * where the customer's paid-for access currently ends. An unprovisioned
 * customer has no such anchor and runs from the payment date instead.
 *
 * A registry expiry already in the past is used as-is rather than being pulled
 * forward to today: the customer is being credited only the days they paid for,
 * and the cashier can move the picker if the result is unusable.
 */
export function proportionalDate(opts: {
  amountPaid: number
  monthlyCharge: number
  /** Expiry held in the network registry. Null when unprovisioned. */
  currentExpiry: Date | null
  from: Date
}): Date {
  const { amountPaid, monthlyCharge, currentExpiry, from } = opts

  const base = currentExpiry ? startOfDay(currentExpiry) : startOfDay(from)

  base.setDate(base.getDate() + proportionalDays(amountPaid, monthlyCharge))
  return base
}

/**
 * Expiry a full payment reaches: the CUT-OFF DAY AFTER THE ONE THE CUSTOMER IS
 * CURRENTLY PAID THROUGH, plus the company grace period.
 *
 * Was `postpaidExpiry`. It is now the only expiry calculation there is — the
 * retired prepaid arm used a months-from-expiry walk instead, driven by the
 * months-to-pay selector that went with it.
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
 * when no cut-off day is recorded.
 */
export function serviceExpiry(opts: {
  cutOffDay: number | null
  gracePeriodDays: number
  /** Expiry held in the network registry. Null when unprovisioned. */
  currentExpiry: Date | null
  from: Date
  /**
   * Months of access this payment bought. 1 is a plain renewal and is what
   * every caller meant before prepayment existed, so it is the default.
   *
   * MOVED IN ONE JUMP, AT THE MOMENT OF PAYMENT — a customer paying three
   * months forward has a three-month expiry the instant the money is taken,
   * not one that creeps forward as each bill run passes.
   */
  months?: number
}): Date {
  const { cutOffDay, gracePeriodDays, currentExpiry, from, months = 1 } = opts

  const grace = Math.max(0, Math.floor(safe(gracePeriodDays)))
  const count = Math.max(1, Math.floor(safe(months)))
  const today = startOfDay(from)

  const anchor =
    currentExpiry && startOfDay(currentExpiry).getTime() > today.getTime()
      ? startOfDay(currentExpiry)
      : today

  // advanceCutOff walks the cut-off day ONE MONTH AT A TIME, re-deriving it from
  // the original day at every hop. That is not the same as taking the next
  // cut-off and adding months to it, and the difference is a real drift: from
  // 15 Jan with a cut-off of 31, walking gives 31 Jan -> 28 Feb -> 31 Mar, while
  // adding two months to 31 Jan gives 31 Mar via 28 Feb only by luck and lands
  // on 30 Apr the following hop. Do not "simplify" this to addMonths.
  //
  // Both branches are strictly after the anchor and the anchor is never behind
  // today, so this can never return a date that has already passed.
  const next = advanceCutOff(anchor, cutOffDay, count) ?? addMonths(anchor, count)
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
