/**
 * Cut-off day arithmetic.
 *
 * Client-safe on purpose: the record-payment form previews the expiry the
 * server is about to write to radcheck, so both sides run these functions. The
 * server remains the source of truth — nothing computed in the form is trusted
 * on submit.
 *
 * A customer on `from_expiry` ("From Cut Off Date") does not buy 30-day blocks.
 * They buy their way to the NEXT occurrence of the company's cut-off day, and
 * one further occurrence for each additional month paid. Adding whole months to
 * the current expiry — which is what this used to do — drifts the customer off
 * the cut-off day forever after the first late payment.
 */

/** Days in the calendar month containing `year`/`month` (month is 0-based). */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function midnight(year: number, month: number, day: number): Date {
  return new Date(year, month, day, 0, 0, 0, 0)
}

/**
 * The first cut-off day strictly after `anchor`.
 *
 *   anchor 12 Sep, cut-off 5  → 5 Oct  (the 5th has already gone this month)
 *   anchor  3 Sep, cut-off 5  → 5 Sep  (the 5th is still ahead)
 *
 * A cut-off day longer than the target month is clamped to that month's last
 * day, so a cut-off of 31 lands on 28 Feb rather than rolling into March. The
 * clamp can collide with the anchor itself (anchor 28 Feb, cut-off 31), so the
 * result is checked and pushed a month on when it would not actually advance —
 * a month paid for must always move the expiry.
 *
 * Returns null when there is no cut-off day on record; the caller decides what
 * to fall back to rather than having a guess baked in here.
 */
export function nextCutOff(anchor: Date, cutOffDay: number | null): Date | null {
  if (!cutOffDay || !Number.isFinite(cutOffDay) || cutOffDay < 1) return null

  const wanted = Math.floor(cutOffDay)
  const anchorDay = anchor.getDate()

  // Same month while the cut-off is still ahead of the anchor, next month once
  // it has passed (or landed on the anchor exactly).
  let month = anchor.getMonth() + (anchorDay < wanted ? 0 : 1)
  const year = anchor.getFullYear()

  let candidate = midnight(year, month, Math.min(wanted, daysInMonth(year, month)))

  // Only reachable when the clamp pulled the candidate back onto the anchor.
  if (candidate.getTime() <= midnight(year, anchor.getMonth(), anchorDay).getTime()) {
    month += 1
    candidate = midnight(year, month, Math.min(wanted, daysInMonth(year, month)))
  }

  return candidate
}

/**
 * `months` consecutive cut-off days after `anchor`.
 *
 * Applied one month at a time — each month's result is the next month's anchor
 * — because the months are not interchangeable: with a cut-off of 5 and an
 * expiry of 12 Sep, one month buys 5 Oct, two buys 5 Nov, three buys 5 Dec.
 * Adding three months to 12 Sep and then snapping to a cut-off day gives the
 * same answer here but not across a short month, so the loop is the rule.
 *
 * Returns null when there is no cut-off day on record.
 */
export function advanceCutOff(
  anchor: Date,
  cutOffDay: number | null,
  months: number
): Date | null {
  const count = Math.max(1, Math.floor(months))

  let current = anchor
  for (let i = 0; i < count; i++) {
    const next = nextCutOff(current, cutOffDay)
    if (!next) return null
    current = next
  }
  return current
}

/**
 * Whole calendar months added to `from`, clamped to the target month's length.
 *
 * The fallback for a customer with no cut-off day recorded, and what
 * `from_payment` has always done.
 */
export function addMonths(from: Date, months: number): Date {
  const count = Math.max(1, Math.floor(months))
  const year = from.getFullYear()
  const month = from.getMonth() + count
  const day = Math.min(from.getDate(), daysInMonth(year, month))

  const next = midnight(year, month, day)
  // Keep the time-of-day the caller handed us for from_payment, where the
  // anchor is a payment timestamp rather than a stored midnight date.
  next.setHours(from.getHours(), from.getMinutes(), from.getSeconds(), 0)
  return next
}

/**
 * The expiry a FIRST-TIME provision should be given — the 21-day rule.
 *
 * A customer switched on a few days before their cut-off day would otherwise
 * buy a full month and get a week of it. So the next occurrence of the cut-off
 * day only counts if it is at least 21 days out; closer than that and the first
 * period runs to the occurrence after it, giving them a short month plus a full
 * one rather than a stub.
 *
 *   today 26 Aug, cut-off 5  → next is 5 Sep, 10 days out → 5 Oct
 *   today 26 Aug, cut-off 20 → next is 20 Sep, 25 days out → 20 Sep
 *
 * Both hops go through nextCutOff, so the cut-off day is re-derived from the
 * ORIGINAL day each time rather than from a clamped result: a cut-off of 31
 * that lands on 30 Sep still produces 31 Oct next, not 30 Oct.
 *
 * PROVISIONING ONLY. Renewals and reconnections walk to the plain next cut-off
 * (nextCutOff) — the 21-day allowance is a one-off for the first period, not a
 * standing discount.
 *
 * Falls back to a month from today when no cut-off day is on record.
 */
export function firstExpiry(cutOffDay: number | null, from: Date = new Date()): Date {
  const today = midnight(from.getFullYear(), from.getMonth(), from.getDate())

  const next = nextCutOff(today, cutOffDay)
  if (!next) return addMonths(today, 1)

  const days = Math.round((next.getTime() - today.getTime()) / 86_400_000)
  if (days >= 21) return next

  return nextCutOff(next, cutOffDay) ?? addMonths(next, 1)
}
