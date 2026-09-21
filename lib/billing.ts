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
function settledMonthStart(from: Date, billDay: number): Date {
  const back = from.getDate() >= billDay ? 1 : 2
  return new Date(from.getFullYear(), from.getMonth() - back, 1)
}

/**
 * THE DAY OF THE MONTH A CUSTOMER IS BILLED ON. One definition, every caller.
 *
 * The customer's own `bill_date`; failing that the company's
 * (`settings.bill_date`); failing that the 1st.
 *
 * WHY THIS IS A FUNCTION AND NOT A `?? 1`. Most customers on this platform have
 * no bill date of their own — 1,276 of Vernon's 1,279, every customer of four
 * other companies — and are billed on the company's day. The payment path used
 * to read a missing date as the 1st while the bill run was about to read it as
 * the company's day: for a company billing on the 26th, the till would have
 * said a payment on the 19th settled August while the run that raised the
 * charge called it July. Same drift as the three customer searches, and the
 * same cure: everything below takes a resolved `billDay: number`, so a caller
 * cannot reach the period arithmetic without coming through here first.
 */
export function effectiveBillDay(
  customerBillDate: number | null | undefined,
  companyBillDate: number | null | undefined
): number {
  for (const candidate of [customerBillDate, companyBillDate]) {
    const day = Math.floor(Number(candidate))
    if (Number.isFinite(day) && day >= 1 && day <= 31) return day
  }
  return 1
}

/**
 * The billed month a payment settles — first and last day inclusive — or NULL
 * WHEN IT SETTLES NONE.
 *
 * A PAYMENT ONLY HAS A BILL PERIOD IF A BILL IS BEING PAID. With nothing on the
 * carried balance no bill run's charge is being cleared: the money is a
 * prepayment for time ahead, and the arithmetic above would still hand it a
 * month — an unrelated one. A customer provisioned in September who had never
 * been billed, holding an expiry of 24 September, was shown "Bill period: July
 * 2026", and the same July was stamped on the payment row. An empty label is
 * better than a wrong month, and the stored columns matter more than the
 * label: bills will read them.
 *
 * THE TEST IS settledMonths(), the same function that decides whether the
 * money buys a renewal month, so "this payment settles a month" means one
 * thing to the pricing, the label and the stored period. A first-period
 * payment (migration 0017) has nothing carried either — its charge was never
 * raised by a bill run — so it has no bill period, for the same reason.
 *
 * `carriedBalance` is the balance BEFORE this payment.
 */
export function billingPeriod(
  from: Date,
  /** From effectiveBillDay — never a raw, possibly-null column. */
  billDay: number,
  carriedBalance: number
): { start: string; end: string } | null {
  if (settledMonths(carriedBalance) === 0) return null
  const start = settledMonthStart(from, billDay)
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 0)
  return { start: ymd(start), end: ymd(end) }
}

/**
 * "August 2026" — the bill period label on the expiry preview. Null exactly
 * when billingPeriod is: nothing owed, no month to name.
 */
export function billingPeriodLabel(
  from: Date,
  /** From effectiveBillDay — never a raw, possibly-null column. */
  billDay: number,
  carriedBalance: number
): string | null {
  if (settledMonths(carriedBalance) === 0) return null
  return settledMonthStart(from, billDay)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

// ---------------------------------------------------------------------------
// When a bill falls due (the bill run)
// ---------------------------------------------------------------------------

/**
 * The date the bill FOR a period falls due for a customer billed on `billDay`:
 * that day of the month AFTER the period. Billing is in arrears — August's bill
 * is raised in September — which is the same convention settledMonthStart reads
 * backwards from a payment date.
 *
 * DATE-ONLY STRINGS IN AND OUT, compared as strings. No Date crosses a zone
 * here, which is the mistake the payment preview made.
 *
 * A day longer than the month is clamped to its last day, so a bill day of 31
 * falls due on 30 September rather than never.
 */
export function billDueDate(periodEnd: string, billDay: number): string {
  const [y, m] = periodEnd.split('-').map(Number)
  // `m` is 1-based, so as a 0-based index it already names the month after.
  const next = new Date(y, m, 1)
  const last = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
  return ymd(new Date(next.getFullYear(), next.getMonth(), Math.min(Math.max(1, billDay), last)))
}

export type BillDueVerdict =
  /** The bill date has come round and the customer was here for it. */
  | 'due'
  /** The bill date for this period has not arrived yet. */
  | 'not_yet'
  /** It came round BEFORE the customer was on the platform. Never theirs. */
  | 'before_joined'

/**
 * Whether the bill for a period is due for one customer, today.
 *
 * LATE IS STILL DUE. A customer billed on the 20th is due on the 20th and on
 * the 25th alike: a run nobody pressed on the day is late, not skipped. (Whether
 * they are then BILLED is a second question — the run also skips anyone whose
 * access has lapsed, with no grace; see app/actions/bulk.ts#serviceStateFor.)
 *
 * A BILL DATE ONLY COUNTS IF THE CUSTOMER WAS HERE WHEN IT CAME ROUND. Without
 * this, "late is still due" bills a new customer for every date that passed
 * before they existed: JMEDIA's 29 customers billed on the 4th were imported on
 * 16 September, and a run on 20 September would have read their 4 September
 * date as merely late and charged a month they had already been carried past.
 * Their first bill is the first date on or after they joined. For a migrated
 * company `date_added` is the legacy signup date, long past, and never binds.
 */
export function billDue(opts: {
  /** Last day of the period being billed, `YYYY-MM-DD`. */
  periodEnd: string
  billDay: number
  /** Today IN THE COMPANY'S ZONE, `YYYY-MM-DD` — not the server's. */
  today: string
  /** `customers.date_added`. Null reads as "always been here". */
  dateAdded: string | null
}): { verdict: BillDueVerdict; dueDate: string } {
  const dueDate = billDueDate(opts.periodEnd, opts.billDay)
  if (dueDate > opts.today) return { verdict: 'not_yet', dueDate }
  if (opts.dateAdded && dueDate < opts.dateAdded.slice(0, 10)) return { verdict: 'before_joined', dueDate }
  return { verdict: 'due', dueDate }
}

/**
 * `due` bills customers whose bill date has been reached — the default.
 * `all` bills the whole company whatever their bill dates, which is what the
 * run did before bill dates counted. It stays possible because a company's
 * first run, or a catch-up, may genuinely want it; it is never the default.
 */
export type BillScope = 'due' | 'all'

export type BillRunVerdict =
  | 'bill'
  | 'already_billed'
  | 'not_due'
  | 'before_joined'
  | 'zero_rate'
  | 'disconnected'
  | 'unprovisioned'

/** Was this customer already billed FOR the period? The guard, in JavaScript. */
export function billedInPeriod(
  lastBilledDate: string | null,
  period: { start: string; end: string }
): boolean {
  return lastBilledDate !== null && lastBilledDate >= period.start && lastBilledDate <= period.end
}

/**
 * WHAT A BILL RUN DOES WITH ONE CUSTOMER. One decision, for the preview and the
 * write alike — app/actions/bulk.ts calls this from loadBillAllPlan and again
 * from billBatch, so the list an operator confirms and the rows that get
 * charged are decided by the same lines.
 *
 * THE ORDER IS THE ORDER OF REASONS an operator should be given:
 *   already billed   the guard, first and unconditional, in both scopes
 *   not due / before joined   the bill date — skipped entirely in scope 'all'
 *   zero rate, disconnected, unprovisioned   as before bill dates counted
 *
 * Pure. The service state is handed in because reading radcheck is the
 * caller's job; everything else is arithmetic on the row.
 */
export function billRunVerdict(opts: {
  period: { start: string; end: string }
  scope: BillScope
  /** Today in the company's zone, `YYYY-MM-DD`. */
  today: string
  companyBillDate: number | null
  customer: {
    lastBilledDate: string | null
    billDate: number | null
    dateAdded: string | null
    monthlyRate: number
  }
  service: 'active' | 'disconnected' | 'unprovisioned' | undefined
}): { verdict: BillRunVerdict; billDay: number; dueDate: string } {
  const { period, customer } = opts
  const billDay = effectiveBillDay(customer.billDate, opts.companyBillDate)
  const due = billDue({
    periodEnd: period.end, billDay, today: opts.today, dateAdded: customer.dateAdded,
  })
  const out = (verdict: BillRunVerdict) => ({ verdict, billDay, dueDate: due.dueDate })

  if (billedInPeriod(customer.lastBilledDate, period)) return out('already_billed')

  if (opts.scope === 'due') {
    if (due.verdict === 'not_yet') return out('not_due')
    if (due.verdict === 'before_joined') return out('before_joined')
  }

  if (customer.monthlyRate <= 0) return out('zero_rate')
  if (opts.service === 'disconnected') return out('disconnected')
  if (opts.service === 'unprovisioned') return out('unprovisioned')
  return out('bill')
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
 * Whether a payment against `carriedBalance` is SETTLING a month.
 *
 * The one place the "renewal month" is decided, shared by the seed
 * (amountDueForMonths) and the pricing (monthsCovered) so the two cannot
 * disagree about it. A bill run charged a month that has passed; paying any of
 * it buys the next one, which is the month the cut-off walk has always bought.
 * With nothing owed there is no such month: every whole charge in the money is
 * a month paid forward, and none of it is a renewal.
 *
 * This used to be an unconditional 1, and the difference reached production:
 * a customer holding 1 Oct with nothing owed handed over one month's charge and
 * was written 1 Dec — the floor counted a renewal month that did not exist,
 * and then the credit arithmetic counted the same money again as prepayment.
 */
function settledMonths(carriedBalance: number): number {
  return safe(carriedBalance) > 0 ? 1 : 0
}

/**
 * What the till should ask for when the cashier picks `months`.
 *
 * The FIRST month is what the customer already owes — their carried balance —
 * and every month after it is a full monthly charge paid forward. So one month
 * asks for the balance alone, which is what the form did before prepayment
 * existed.
 *
 * WITH NOTHING OWED, EVERY MONTH IS A CHARGE. A customer who is square and
 * picks one month is asked for one month's charge, not J$0 — an empty Amount
 * field is what sent cashiers typing a figure over a seed that had told them
 * nothing, and the first version of this asked exactly that. What is asked for
 * here is what monthsCovered reads back as bought when it is the amount paid.
 */
export function amountDueForMonths(
  carriedBalance: number,
  monthlyCharge: number,
  months: number
): number {
  const extra = Math.max(0, Math.floor(months) - settledMonths(carriedBalance))
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
 * THE RULE: a payment buys the month it settles, plus one month for every
 * whole monthly charge beyond what was owed. If nothing was owed there is no
 * month being settled, so the count is just the whole charges in the money.
 *
 *   rate 3,500, owes 3,500, pays 10,500 -> settles 1, credit 7,000  -> 3 months
 *   rate 3,500, owes 3,500, pays  3,500 -> settles 1, credit     0  -> 1 month
 *   rate 3,500, owes 4,500, pays  2,000 -> settles 1, credit     0  -> 1 month
 *   rate 3,500, owes     0, pays  3,500 -> settles 0, credit 3,500  -> 1 month
 *   rate 3,500, owes     0, pays 10,500 -> settles 0, credit 10,500 -> 3 months
 *   rate 3,500, owes     0, pays  1,500 -> settles 0, credit 1,500  -> 0 months
 *
 * The third line is what the settled month protects: a short payment on a real
 * balance still yields 1, and the partial-payment machinery decides that
 * expiry exactly as it did before prepayment existed.
 *
 * THE LAST LINE IS ZERO, AND CALLERS MUST HANDLE IT. serviceExpiry floors its
 * months at 1, so a caller that passes 0 through gets a month the customer did
 * not pay for. Zero means access is unchanged: the expiry stays where it is and
 * the money is held as credit for the next bill run to draw down. Take that
 * branch before calling serviceExpiry — app/actions/payments.ts and the
 * record-payment form both do.
 *
 * A first payment (migration 0017) does not come through here. Its period is
 * already held and never billed, so it is priced on its own branch in
 * app/actions/payments.ts from the excess alone.
 */
export function monthsCovered(
  carriedBalance: number,
  monthlyCharge: number,
  amountPaid: number
): number {
  const charge = safe(monthlyCharge)
  const settled = safe(amountPaid) > 0 ? settledMonths(carriedBalance) : 0
  if (charge <= 0) return settled

  const extra = Math.floor(prepaymentCredit(carriedBalance, amountPaid) / charge)
  return Math.min(MAX_PREPAY_MONTHS, settled + Math.max(0, extra))
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

/**
 * Takes back credit a payment created, when that payment is corrected or
 * deleted. The inverse of prepaymentCredit, settled against what is left.
 *
 * THE CREDIT MAY ALREADY BE SPENT. A bill run draws prepayment down a month at
 * a time (applyCredit), so by the time anyone corrects the payment there may be
 * less credit standing than the payment created — or none. The difference
 * cannot come out of `account_credit`, which carries a `>= 0` CHECK (migration
 * 0011), so IT GOES ON THE CARRIED BALANCE.
 *
 * That is not a fudge to satisfy the constraint, it is the correct entry. Credit
 * that a bill run consumed was consumed against a real charge. If the payment
 * that created it turns out not to have happened, that charge was never actually
 * settled, and an unsettled charge is exactly what a carried balance is:
 *
 *   paid 10,500 on 3,500 owed -> credit 7,000, month 1 settled
 *   one bill run             -> credit 3,500, month 2 paid from credit
 *   corrected down to 3,500  -> reverse 7,000, but only 3,500 is left
 *                            -> credit 0, and month 2's 3,500 returns to the
 *                               balance, which is the truth: it was never paid
 *
 * Callers must apply BOTH returned columns. Writing `credit` without
 * `carriedBalance` silently forgives whatever the bill run had already spent.
 */
export function reverseCredit(
  accountCredit: number,
  carriedBalance: number,
  creditToReverse: number
): { credit: number; carriedBalance: number; reversed: number; shortfall: number } {
  const held = Math.max(0, safe(accountCredit))
  const wanted = Math.max(0, safe(creditToReverse))
  const reversed = Math.min(held, wanted)
  const shortfall = wanted - reversed

  return {
    credit: round2(held - reversed),
    carriedBalance: round2(safe(carriedBalance) + shortfall),
    reversed: round2(reversed),
    shortfall: round2(shortfall),
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

// ---------------------------------------------------------------------------
// First period (migration 0017)
//
// A customer connected on the 20th with a cut-off of the 5th buys 46 days of
// service. Before this, they paid the same as one connected on the 2nd who
// bought 34, and the same as one connected on the 6th who bought 30. These
// functions price the first period by its actual length.
//
// PURE, AND CLIENT-SAFE LIKE THE REST OF THIS FILE. Whether a customer IS in
// their first period is a question about stored history and lives on the server
// in lib/data/first-period.ts; everything here is arithmetic over numbers the
// caller has already established.
// ---------------------------------------------------------------------------

/**
 * The divisor for the daily rate. NOT the length of any particular month.
 *
 * A 31-day month and a 28-day month both price at rate/30 here. That is on
 * purpose: the number a cashier is quoting has to be checkable on a phone
 * calculator at the counter, and "rate divided by thirty" is checkable in a way
 * that "rate divided by however long February is" is not. It also keeps the
 * daily rate stable across the year, so the same 46-day first period costs the
 * same in February as in August.
 */
export const DAYS_IN_BILLING_MONTH = 30

/** The monthly charge spread over a 30-day month. */
export function dailyRate(monthlyCharge: number): number {
  return safe(monthlyCharge) / DAYS_IN_BILLING_MONTH
}

/**
 * What the FIRST payment should ask for, given how long the first period is.
 *
 *   rate 3,500, cut-off 5, daily 116.67
 *     connected 2 Aug  -> 5 Sep, 34 days -> 3,500 + 4 x 116.67 = 3,967
 *     connected 6 Aug  -> 5 Sep, 30 days -> 3,500
 *     connected 20 Aug -> 5 Oct, 46 days -> 3,500 + 16 x 116.67 = 5,367
 *
 * NEVER LESS THAN THE MONTHLY CHARGE. A period shorter than 30 days returns the
 * full rate, not a reduced one. The difference is not silently dropped — it is
 * offered to the cashier by firstPeriodDiscount below, for them to apply or
 * not. Automatically discounting a short first period would make every customer
 * connected just before their cut-off cheaper than the rate card without anyone
 * deciding that, which is a pricing change disguised as arithmetic.
 */
export function firstPeriodCharge(monthlyCharge: number, days: number): number {
  const rate = safe(monthlyCharge)
  const extra = Math.max(0, Math.floor(safe(days)) - DAYS_IN_BILLING_MONTH)
  return round2(rate + extra * dailyRate(rate))
}

/**
 * The discount a cashier MAY apply when the first period is short of 30 days.
 *
 * Zero for a period of 30 days or more, so a caller can offer it unconditionally
 * and get nothing when there is nothing to offer.
 *
 *   rate 3,500, connected 10 Aug -> 5 Sep, 26 days -> 4 x 116.67 = 467
 *
 * NOTHING IN THIS FILE APPLIES IT. It is returned so the till can show it as a
 * choice; app/actions/payments.ts subtracts it only when the form says the
 * cashier ticked it, and logs who did (`first_period_discount`). See the note
 * on firstPeriodCharge for why it is not automatic.
 */
export function firstPeriodDiscount(monthlyCharge: number, days: number): number {
  const rate = safe(monthlyCharge)
  const short = Math.max(0, DAYS_IN_BILLING_MONTH - Math.floor(safe(days)))
  return round2(short * dailyRate(rate))
}

/**
 * Whole days in a first period: provisioning date to the expiry it wrote.
 *
 * daysBetween already floors both ends to local midnight, so the answer is a
 * count of calendar days and never a fraction rounded across a timezone offset
 * or a daylight-saving step.
 *
 * Negative spans return 0 rather than a negative charge — an expiry behind the
 * provisioning date is corrupt data, and the safe reading of corrupt data here
 * is "no extra days", which prices the first period at exactly the monthly
 * rate rather than below it.
 */
export function firstPeriodDays(provisionedAt: Date, expiry: Date): number {
  return Math.max(0, daysBetween(provisionedAt, expiry))
}

/** Money is stored as numeric; keep float drift out of what we write back. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
