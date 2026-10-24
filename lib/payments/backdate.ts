/**
 * BACKDATING A PAYMENT: one rule, one threshold, one wording.
 *
 * WHY (Vernon, 23 October 2026). Chloe keyed 172 payments that week and 171
 * carried the right date. The one that did not — #17432, J$9,000 — was typed
 * as 23 SEPTEMBER instead of 23 October: a single wrong month in a date field.
 * It passed every check, because the only date rules were "parses" and "not in
 * the future". The till then settled the 1-31 July period with it, the money
 * vanished from the day's history and from the cashier's cash sheet, and it
 * surfaced only because she counted her drawer and came up short.
 *
 * SO: a date in the recent past stays free, because cashiers legitimately key
 * yesterday's takings the next morning (Vernon did exactly that with #17343 to
 * #17354). Past the limit the cashier has to say they mean it and why.
 *
 * CLIENT-SAFE ON PURPOSE, like lib/billing-engine.ts: the form warns with the
 * same functions the action refuses with, so the two cannot drift apart and a
 * cashier is never stopped by a rule the screen did not show them first.
 *
 * THE DATES ARE `YYYY-MM-DD` STRINGS, compared as strings and differenced as
 * UTC midnights. Never a Date carrying a time of day: the whole defect this
 * guards against is a calendar date going wrong.
 */

/**
 * How many days back a payment may be dated with no explanation. Seven, not
 * one: a cashier keying Saturday's takings on Monday is ordinary, and a limit
 * that fires on ordinary work is a limit people learn to click through.
 */
export const BACKDATE_FREE_DAYS = 7

/** Whole days from `paidOn` to `today`. Negative when the date is forward. */
export function daysBackdated(paidOn: string, today: string): number {
  const a = Date.parse(paidOn + 'T00:00:00Z')
  const b = Date.parse(today + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** Dated before today at all: worth showing, not worth refusing. */
export function isBackdated(paidOn: string, today: string): boolean {
  return paidOn < today
}

/** Past the free window, so the cashier must confirm and give a reason. */
export function needsBackdateReason(paidOn: string, today: string): boolean {
  return daysBackdated(paidOn, today) > BACKDATE_FREE_DAYS
}

/**
 * What the cashier is told, on screen and from the server, in the same words.
 * Names the date and the gap, because "too far back" does not tell someone who
 * mistyped a month that they mistyped a month.
 */
export function backdateNotice(paidOn: string, today: string): string {
  const days = daysBackdated(paidOn, today)
  if (days <= 0) return ''
  const when = days === 1 ? 'yesterday' : days + ' days ago'
  return 'This payment will be dated ' + paidOn + ', ' + when + '.'
}

/** The refusal, when the confirmation or the reason is missing. */
export function backdateError(paidOn: string, today: string): string {
  return (
    'This date is ' + daysBackdated(paidOn, today) + ' days back. Tick "I mean to backdate this" ' +
    'and say why in the notes, or correct the date.'
  )
}
