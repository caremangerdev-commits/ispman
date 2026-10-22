/**
 * THE TWO PERIOD SHAPES. Migration 0043.
 *
 * Pure, client-safe, and importing nothing — which is the point. The engine
 * (lib/billing-engine.ts) and the payment path (lib/billing.ts) both need to
 * know what period a date falls in, and lib/billing-engine.ts already imports
 * effectiveBillDay from lib/billing.ts. Putting the arithmetic in either of
 * them would make a cycle, and copying it into both is the "a parser written
 * twice will differ" failure this repo was burned by (AGENTS.md). So it lives
 * here, once, and both import it.
 *
 * THE CALENDAR MONTH (monthPeriod): 1st to last day, charged on the bill day
 * of that month. The bill day does not shape the period — a company billing on
 * the 26th charges 1 Sep to 30 Sep on 26 Sep, while September is still running.
 *
 * BILL DAY TO BILL DAY (flexPeriod, settings.flex_month): the period opens on
 * the customer's own bill day and ends the day before the next one. Bill day 20
 * gives 20 Oct to 19 Nov, charged on 20 Oct — in advance, not in arrears.
 *
 * Bill day 1 gives the same answer from both, which is why a company whose
 * customers all bill on the 1st sees no change when flex is turned on.
 *
 * DATE-ONLY STRINGS THROUGHOUT, compared as strings. No Date object carries a
 * time or a zone across this boundary.
 */

export type BillPeriod = {
  start: string
  end: string
  /** The company-local date on which this period's charge is raised. */
  chargeDate: string
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function toYmd(y: number, m: number, d: number): string {
  return y + '-' + pad(m) + '-' + pad(d)
}

/** [year, month 1-12, day] from `YYYY-MM-DD`. Throws on anything else. */
export function parts(ymd: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) throw new Error('"' + ymd + '" is not a YYYY-MM-DD date.')
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Days in a month. Month is 1-12. */
export function daysIn(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** A day of month clamped to the month's length: 31 in September is the 30th. */
export function clampDay(y: number, m: number, day: number): number {
  return Math.min(Math.max(1, day), daysIn(y, m))
}

/** (year, month) `n` months on. Month is 1-12. */
export function addMonth(y: number, m: number, n: number): [number, number] {
  const idx = y * 12 + (m - 1) + n
  return [Math.floor(idx / 12), (idx % 12) + 1]
}

/** `ymd` shifted by whole days. UTC arithmetic only; no zone crosses here. */
export function shiftDays(ymd: string, n: number): string {
  const [y, m, d] = parts(ymd)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return toYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/** Whole days from `from` to `to`, both counted. 1 Oct to 1 Oct is 1. */
export function daysInclusive(from: string, to: string): number {
  const [ay, am, ad] = parts(from)
  const [by, bm, bd] = parts(to)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000) + 1
}

/**
 * The calendar month containing `today`, charged on `billDay` of that month.
 * A bill day longer than the month is clamped to its last day, so a bill day
 * of 31 charges September on the 30th rather than never.
 */
export function monthPeriod(today: string, billDay: number): BillPeriod {
  const [y, m] = parts(today)
  return {
    start: toYmd(y, m, 1),
    end: toYmd(y, m, daysIn(y, m)),
    chargeDate: toYmd(y, m, clampDay(y, m, billDay)),
  }
}

/**
 * The bill-day-to-bill-day period containing `today`. The charge is raised on
 * the day the period opens.
 */
export function flexPeriod(today: string, billDay: number): BillPeriod {
  const [y, m, d] = parts(today)
  // Before this month's bill day, the period running opened last month.
  const [sy, sm] = d < clampDay(y, m, billDay) ? addMonth(y, m, -1) : [y, m]
  const start = toYmd(sy, sm, clampDay(sy, sm, billDay))
  const [ny, nm] = addMonth(sy, sm, 1)
  const nextStart = toYmd(ny, nm, clampDay(ny, nm, billDay))
  return { start, end: shiftDays(nextStart, -1), chargeDate: start }
}

/** The period containing `today` under whichever shape the company uses. */
export function periodFor(today: string, billDay: number, flexMonth: boolean): BillPeriod {
  return flexMonth ? flexPeriod(today, billDay) : monthPeriod(today, billDay)
}

/**
 * The period's length in days. A calendar month gives its own length.
 *
 * Takes the two ends rather than a whole BillPeriod so a charge row's stored
 * period_start/period_end can be passed straight in — those carry no charge
 * date, and the length does not need one.
 */
export function periodDays(period: { start: string; end: string }): number {
  return daysInclusive(period.start, period.end)
}

/** Days from `from` to the END OF THE PERIOD, both counted. */
export function daysToPeriodEnd(from: string, period: { start: string; end: string }): number {
  if (from > period.end) return 0
  return Math.max(0, daysInclusive(from, period.end))
}

/**
 * The days of THIS PERIOD not already charged by hand before the hand-over
 * (customers.billed_through, migration 0030). Null: none of it was. 0: all of
 * it was. Billed through 3 Nov leaves 27 of November's 30.
 */
export function daysNotBilledInPeriod(
  period: BillPeriod,
  billedThrough: string | null
): number | null {
  if (!billedThrough || billedThrough < period.start) return null
  if (billedThrough >= period.end) return 0
  return daysToPeriodEnd(shiftDays(billedThrough, 1), period)
}
