/**
 * Postpaid service days: which days of a month a customer had service.
 * Owner, 11 Oct 2026 — day-based charging for postpaid.
 *
 * CLIENT-SAFE AND PURE, like lib/prepaid-calendar.ts: the engine, the next bill
 * day's correction and the preview all count days with these, so a customer is
 * never charged one number and shown another.
 *
 * THE RULES
 *   - The day service ENDS is free: a customer cut off on 1 Nov (the cut-off
 *     day, expiry 1 Nov at 8 AM) has no service from the 1st. Staff
 *     disconnecting on request ends service that day, the same.
 *   - The day service COMES BACK is charged: paying and reconnecting on
 *     15 Nov makes the 15th a service day.
 *   - A month with no break is a full month. A customer cut off on the
 *     cut-off day, which falls after the month has ended, owes that month in
 *     full — the break is in the next month.
 *
 * WHERE THE BREAKS COME FROM: every change to a customer's expiry, as the log
 * records it (lib/data/service-breaks.ts), and their expiry now. A break is
 * `{ off, back }`: `off` the first day without service, `back` the first day
 * with it again, null while they are still off.
 *
 * DATES are `YYYY-MM-DD` strings in the company's zone throughout.
 */

import { monthFigure, round100 } from '@/lib/prepaid-calendar'

/** One change to a customer's expiry: when it was made, and from what to what. */
export type ExpiryEvent = {
  /** The day the change was written, `YYYY-MM-DD`. */
  day: string
  /** The expiry date before it; null when there was none (a first provision). */
  from: string | null
  /** The expiry date after it. */
  to: string
}

export type ServiceBreak = { off: string; back: string | null }

/**
 * The breaks in a customer's service, from their expiry changes in the order
 * they were made, and whether they are on service now.
 *
 * Service ends when the expiry passes (that day is free) or when a change
 * writes an expiry on or before the day it was made (a disconnection: that
 * day is free) — whichever is later. A change that writes an expiry after the
 * day it was made brings service back on that day (charged).
 *
 * `onNow` / `expiryNow` are the registry as it stands, which wins over the log
 * at the end: a change made outside ISPMan is not in the log, but its effect
 * on whether the customer is on now is.
 */
export function serviceBreaks(
  events: ExpiryEvent[],
  today: string,
  onNow: boolean,
  expiryNow: string | null
): ServiceBreak[] {
  const breaks: ServiceBreak[] = []
  // While off: the first day without service. While on: null.
  let offSince: string | null = null
  // While on: the day service is due to end with nothing further written.
  let endsOn: string | null = null

  // Stable sort: changes on the same day keep the order they were made in.
  for (const e of [...events].sort((a, b) => a.day.localeCompare(b.day))) {
    // Off already when this change was made? The change's own "before" value
    // is the truth (it was read from the registry as the write was made); what
    // was tracked is the fallback. This is what finds a customer cut off
    // before anything was logged and reconnected after.
    if (offSince === null) {
      const ending = e.from ?? endsOn
      if (ending !== null && ending <= e.day) offSince = ending
    }
    if (e.to > e.day) {
      // The change leaves them on: an open break closes the day it was made.
      if (offSince !== null) breaks.push({ off: offSince, back: e.day })
      offSince = null
      endsOn = e.to
    } else {
      // An expiry on or before the day it was written: a disconnection (or a
      // correction into the past) — service ends that day, unless it already had.
      if (offSince === null) offSince = e.day
      endsOn = null
    }
  }

  if (!onNow) {
    const off = offSince
      ?? (endsOn !== null && endsOn <= today ? endsOn
        : expiryNow !== null && expiryNow <= today ? expiryNow : today)
    breaks.push({ off, back: null })
  } else if (offSince !== null) {
    // The log says off, the registry says on: something outside ISPMan put
    // them back, on a day nobody logged. Counted back from today, as the
    // hourly read would have seen it.
    breaks.push({ off: offSince, back: today })
  }
  return breaks
}

/** Days in a month (1-12). */
function daysIn(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/**
 * What a postpaid month comes to for one customer — THE one pricing of it,
 * used by the bill day (the month running, projected to its end) and by the
 * next bill day's correction (the month just ended, exact), so the two cannot
 * disagree.
 *
 *   - Connected during the month (after the 1st) with the company's connection
 *     month OFF: nothing (migration 0032).
 *   - Otherwise the days of service — from the connection day when connected
 *     during it — at the monthly charge / days in the month, rounded to the
 *     nearest hundred (lib/prepaid-calendar.ts#monthFigure). Every day of it:
 *     the monthly charge, rounded.
 */
export function postpaidMonthCharge(opts: {
  monthStart: string
  monthlyCharge: number
  breaks: ServiceBreak[]
  /** Connection day (or the day the record was made), `YYYY-MM-DD`; null when unknown. */
  joinedOn: string | null
  chargeConnectionMonth: boolean
}): { amount: number; serviceDays: number | null; fullAmount: number; connectionMonth: boolean; days: number; monthDays: number } {
  const [y, m] = opts.monthStart.split('-').map(Number)
  const dim = daysIn(y, m)
  const monthEnd = opts.monthStart.slice(0, 8) + String(dim).padStart(2, '0')
  const joined = opts.joinedOn && opts.joinedOn > opts.monthStart && opts.joinedOn <= monthEnd ? opts.joinedOn : null
  const fullAmount = round100(opts.monthlyCharge)
  if (opts.joinedOn && opts.joinedOn > monthEnd) {
    return { amount: 0, serviceDays: 0, fullAmount, connectionMonth: false, days: 0, monthDays: dim }
  }
  if (joined && !opts.chargeConnectionMonth) {
    return { amount: 0, serviceDays: 0, fullAmount, connectionMonth: true, days: 0, monthDays: dim }
  }
  const days = serviceDaysInMonth(opts.monthStart, opts.breaks, joined)
  return {
    amount: monthFigure(opts.monthlyCharge, days, dim),
    serviceDays: days >= dim ? null : days,
    fullAmount,
    connectionMonth: joined !== null,
    days,
    monthDays: dim,
  }
}

/**
 * Days of service in the month starting `monthStart` (`YYYY-MM-01`): every day
 * from the 1st — or from `joinedOn` when they were connected during the month —
 * to the month's end that no break covers. A break still open (`back` null)
 * covers every day from its `off` on, which is how a customer off on the bill
 * day is charged only the days they had; one with no open break is counted to
 * the month's end, as if service continues.
 */
export function serviceDaysInMonth(
  monthStart: string,
  breaks: ServiceBreak[],
  joinedOn: string | null
): number {
  const [y, m] = monthStart.split('-').map(Number)
  const dim = daysIn(y, m)
  const prefix = monthStart.slice(0, 8)
  let days = 0
  for (let d = 1; d <= dim; d++) {
    const day = prefix + String(d).padStart(2, '0')
    if (joinedOn !== null && day < joinedOn) continue
    if (breaks.some((b) => day >= b.off && (b.back === null || day < b.back))) continue
    days += 1
  }
  return days
}
