/**
 * Prepaid and postpaid billing arithmetic (migration 0011).
 *
 * Client-safe on purpose: the record-payment form previews every figure the
 * server is about to write, so both sides have to run the same functions. The
 * server remains the source of truth — nothing here is trusted from the form.
 *
 * The two billing types differ in when the money is collected, not in what is
 * owed:
 *
 *   prepaid  — the customer buys months up front, and access runs from the
 *              expiry they already hold.
 *   postpaid — the customer is billed for a period they have already used, and
 *              access runs to their bill date plus the company grace period.
 *
 * `carried_balance` is what a short payment leaves behind, and it is added to
 * the next bill for both types.
 */

/** `customers.billing_type`. */
export type BillingType = 'prepaid' | 'postpaid'

export const BILLING_TYPES: BillingType[] = ['prepaid', 'postpaid']

export const BILLING_TYPE_LABELS: Record<BillingType, string> = {
  prepaid: 'Prepaid',
  postpaid: 'Postpaid',
}

export const BILLING_TYPE_HELP: Record<BillingType, string> = {
  prepaid: 'Pays in advance. Access runs from their current expiry.',
  postpaid: 'Billed for the month just used. Access runs to their bill date.',
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
 * The calendar month a postpaid payment covers — first and last day inclusive.
 *
 * Postpaid bills for a period already used, so the period is the month the
 * payment is taken in.
 */
export function billingPeriod(from: Date): { start: string; end: string } {
  const start = new Date(from.getFullYear(), from.getMonth(), 1)
  const end = new Date(from.getFullYear(), from.getMonth() + 1, 0)
  return { start: ymd(start), end: ymd(end) }
}

/** "August 2026" — the bill period label on the expiry preview. */
export function billingPeriodLabel(from: Date): string {
  return from.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * What the customer owes today: this month's charge plus anything carried.
 *
 * `monthlyCharge` is the customer's full monthly figure — their rate plus every
 * active add-on — not the bare `monthly_rate` column. Billing the bare rate
 * would silently drop add-ons from the amount due.
 */
export function amountDue(monthlyCharge: number, carriedBalance: number): number {
  return round2(safe(monthlyCharge) + safe(carriedBalance))
}

/**
 * What a payment leaves owing.
 *
 * Deliberately measured against the monthly charge alone rather than the amount
 * due: a short payment carries one month's shortfall forward, and the balance
 * it was already carrying is not re-carried on top of it. This is the rule the
 * activity log and the customer's new `carried_balance` both use, so the figure
 * the cashier is shown is the figure that gets written.
 */
export function outstandingBalance(monthlyCharge: number, amountPaid: number): number {
  return round2(Math.max(0, safe(monthlyCharge) - safe(amountPaid)))
}

/** The `carried_balance` to write. Clearing the full amount due clears it. */
export function carriedBalanceAfter(
  monthlyCharge: number,
  carriedBalance: number,
  amountPaid: number
): number {
  if (safe(amountPaid) >= amountDue(monthlyCharge, carriedBalance)) return 0
  return outstandingBalance(monthlyCharge, amountPaid)
}

/** True when the money taken does not cover what is owed. */
export function isPartialPayment(
  monthlyCharge: number,
  carriedBalance: number,
  amountPaid: number
): boolean {
  const paid = safe(amountPaid)
  return paid > 0 && paid < amountDue(monthlyCharge, carriedBalance)
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
 * Expiry a full postpaid payment reaches: the customer's bill day plus the
 * company grace period, at its next occurrence after today.
 *
 * So a bill date of the 1st with a 5-day grace, paid on 20 Aug, expires on
 * 1 Sep + 5 days. Paid on 3 Aug it expires on 6 Aug — the current period's
 * cut-off has not passed yet, so there is nothing to roll forward.
 *
 * The day is clamped to the length of the month before the grace is added, so a
 * bill date of 31 lands on 30 Sep rather than rolling into October twice.
 * Falls back to today's day of month when no bill date is recorded.
 */
export function postpaidExpiry(
  billDate: number | null,
  gracePeriodDays: number,
  from: Date = new Date()
): Date {
  const grace = Math.max(0, Math.floor(safe(gracePeriodDays)))
  const day = billDate && billDate >= 1 ? Math.floor(billDate) : from.getDate()
  const today = startOfDay(from).getTime()

  // Three candidates is always enough: the current month, the next, and one
  // spare for a grace period long enough to skip a short month.
  for (let offset = 0; offset <= 3; offset++) {
    const year = from.getFullYear()
    const month = from.getMonth() + offset
    const daysInMonth = new Date(year, month + 1, 0).getDate()

    const candidate = new Date(year, month, Math.min(day, daysInMonth), 0, 0, 0, 0)
    candidate.setDate(candidate.getDate() + grace)

    if (candidate.getTime() > today) return candidate
  }

  // Unreachable while grace is capped at 30 days, but never return a date in
  // the past: that would disconnect a customer who has just paid.
  const fallback = startOfDay(from)
  fallback.setMonth(fallback.getMonth() + 1)
  return fallback
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
