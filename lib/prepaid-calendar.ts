/**
 * Calendar-month prepaid: the arithmetic. Migration 0028; owner, 7-8 Oct 2026.
 *
 * CLIENT-SAFE AND PURE, like lib/billing.ts: the till's preview, the payment
 * action, the hourly tick and the provisioning path all call these, so the
 * figure a customer is shown is the figure written. Nothing here reads a
 * database or a clock — `today` is always handed in, as the company's own date.
 *
 * THE MODEL
 *   - The period is the calendar month. The cut-off day is when an unpaid
 *     customer is disconnected, not the end of the period.
 *   - A month's figure = monthly charge x days of service / days in that month,
 *     the daily rate exact, the result ROUNDED TO THE NEAREST HUNDRED once:
 *     down below 50, up at 50 and above. Each month on its own, never a total,
 *     so a month carries the same figure whether the engine or the till worked
 *     it out.
 *   - Days spent disconnected are free. The cut-off day counts as a service
 *     day, and so does the day service comes back.
 *   - Months paid forward are whole calendar months at the full rate.
 *   - The expiry is the cut-off day of the month after the last month paid.
 *
 * DATES are `YYYY-MM-DD` strings in the company's zone throughout; no Date
 * object carries a zone through here.
 */

/** Nearest hundred: down below 50, up at 50 and above. Cents first, so float noise cannot tip a .50. */
export function round100(x: number): number {
  if (!Number.isFinite(x)) return 0
  const cents = Math.round(x * 100)
  return (Math.floor((Math.abs(cents) + 5000) / 10000) * 100) * Math.sign(cents)
}

/** [year, month 1-12, day] from `YYYY-MM-DD`. */
export function ymdParts(ymd: string): [number, number, number] {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number)
  return [y, m, d]
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Days in a month. Month is 1-12. */
export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** The month a date falls in: first day, last day, length, and its `YYYY-MM` key. */
export function monthOf(ymd: string): { key: string; start: string; end: string; days: number } {
  const [y, m] = ymdParts(ymd)
  const days = daysInMonth(y, m)
  return { key: y + '-' + pad(m), start: y + '-' + pad(m) + '-01', end: y + '-' + pad(m) + '-' + pad(days), days }
}

/** The month `n` months after the one `ymd` falls in, as its first day. */
export function addMonths(ymd: string, n: number): string {
  const [y, m] = ymdParts(ymd)
  const idx = y * 12 + (m - 1) + n
  return Math.floor(idx / 12) + '-' + pad((idx % 12) + 1) + '-01'
}

/** "October 2026" — for the till and the receipt. */
export function monthLabel(ymd: string): string {
  const [y, m] = ymdParts(ymd)
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

/**
 * A month's figure: the monthly charge for the days of service in it, rounded
 * to the nearest hundred. A whole month is the monthly charge itself, rounded.
 */
export function monthFigure(monthlyCharge: number, serviceDays: number, daysInThatMonth: number): number {
  const days = Math.max(0, Math.min(serviceDays, daysInThatMonth))
  if (days === daysInThatMonth) return round100(monthlyCharge)
  return round100((monthlyCharge * days) / daysInThatMonth)
}

/** Days from `ymd` to the end of its month, both counted: 16 Oct -> 16. */
export function daysToMonthEnd(ymd: string): number {
  const [y, m, d] = ymdParts(ymd)
  return daysInMonth(y, m) - d + 1
}

/**
 * The month's service days once service ENDS on `endedOn` (the cut-off day
 * or the day staff disconnected — counted as a service day).
 *
 * `current` is the days the month's charge rests on now; null is the whole
 * month. The days after the end are taken off. A month charged in full and cut
 * off on the 8th keeps 8; a month already reduced and since resumed keeps its
 * earlier days plus the days from its return to the new end.
 */
export function daysAfterServiceEnds(current: number | null, endedOn: string): number {
  const [y, m, d] = ymdParts(endedOn)
  const dim = daysInMonth(y, m)
  return Math.max(0, (current ?? dim) - (dim - d))
}

/**
 * The month's service days once service RESUMES on `resumedOn` (counted as a
 * service day): the days it already had, plus the days from the return to the
 * month's end. Never more than the month.
 *
 * `current` is the days of an EXISTING charge (null = the whole month), or
 * 'none' when the month has no charge yet — a customer disconnected on the
 * bill date was not charged for it.
 */
export function daysAfterServiceResumes(current: number | null | 'none', resumedOn: string): number {
  const [y, m] = ymdParts(resumedOn)
  const dim = daysInMonth(y, m)
  const already = current === 'none' ? 0 : current ?? dim
  return Math.min(dim, already + daysToMonthEnd(resumedOn))
}

/**
 * Where the expiry lands: the cut-off day of the month `monthsPaid` months
 * after the current one. Paying the current month on 16 Oct gives the cut-off
 * day in November; paying it and November gives December's. A cut-off day
 * longer than the month is clamped to its last day.
 */
export function calendarExpiry(today: string, monthsPaid: number, cutOffDay: number): string {
  const first = addMonths(today, Math.max(1, Math.floor(monthsPaid)))
  const [y, m] = ymdParts(first)
  return y + '-' + pad(m) + '-' + pad(Math.min(Math.max(1, cutOffDay), daysInMonth(y, m)))
}

/** The two first-expiry choices offered at Provision: the next cut-off day, and the one after it. */
export function provisionChoices(today: string, cutOffDay: number): [string, string] {
  const [y, m, d] = ymdParts(today)
  const clamp = (yy: number, mm: number) => Math.min(Math.max(1, cutOffDay), daysInMonth(yy, mm))
  const thisMonth = y + '-' + pad(m) + '-' + pad(clamp(y, m))
  // "Next" is strictly after today: provisioned on the cut-off day itself, the
  // next cut-off is next month's.
  const first = clamp(y, m) > d ? thisMonth : calendarExpiry(today, 1, cutOffDay)
  const second = calendarExpiry(first, 1, cutOffDay)
  return [first, second]
}

/** The later of two `YYYY-MM-DD` dates; a null second is ignored. */
export function laterYmd(a: string, b: string | null): string {
  return b && b > a ? b : a
}

/** Whole days from `a` to `b`: 5 Oct to 8 Oct is 3. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = ymdParts(a)
  const [by, bm, bd] = ymdParts(b)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/**
 * Which of the two Provision choices the popup starts on: what Provision did
 * before there was a popup, so confirming without looking changes nothing.
 * The 21-day rule on: the first when it is at least 21 days away, else the
 * second (lib/expiry.ts#firstExpiry). Off — and always under calendar-month
 * prepaid, which replaces that rule — the first.
 */
export function provisionDefault(today: string, choices: [string, string], twentyOneDayRule: boolean): string {
  if (!twentyOneDayRule) return choices[0]
  return daysBetween(today, choices[0]) >= 21 ? choices[0] : choices[1]
}

/**
 * A new customer's first charge under calendar-month prepaid: connection day to
 * the month's end, both counted, at the month's daily rate, rounded. Whichever
 * of the two dates Provision was given — a later one delays the disconnection,
 * and the days to it are charged by the months they fall in.
 */
export function firstMonthCharge(today: string, monthlyCharge: number): {
  periodStart: string
  periodEnd: string
  days: number
  monthDays: number
  amount: number
  fullAmount: number
} {
  const month = monthOf(today)
  const days = daysToMonthEnd(today)
  return {
    periodStart: month.start,
    periodEnd: month.end,
    days,
    monthDays: month.days,
    amount: monthFigure(monthlyCharge, days, month.days),
    fullAmount: round100(monthlyCharge),
  }
}

// ---------------------------------------------------------------------------
// The till
// ---------------------------------------------------------------------------

/** One month's charge as bill_charges holds it. */
export type MonthCharge = {
  /** `YYYY-MM-01`. */
  periodStart: string
  amount: number
  /** Days the amount rests on; null = the whole month. */
  serviceDays: number | null
}

export type BreakdownLine = {
  /** `YYYY-MM`. */
  month: string
  label: string
  /** Days of service the line is for; null for a whole month. */
  days: number | null
  /** What this line asks for now. */
  amount: number
  kind: 'earlier' | 'current' | 'forward'
}

export type TillBreakdown = {
  lines: BreakdownLine[]
  /** What the service money due comes to: every line except forward months. */
  due: number
  /**
   * The change to this month's charge that taking the payment writes, or null
   * when it does not change (the customer is not disconnected).
   */
  current: {
    periodStart: string
    periodEnd: string
    /** The amount the row holds now, or null when there is no row. The guard. */
    expected: number | null
    amount: number
    serviceDays: number
    delta: number
    fullAmount: number
  } | null
}

/**
 * What a customer is asked for at the till, month by month.
 *
 * DISCONNECTED: this month is recomputed for the return — its days so far plus
 * today to the month's end — and that change is the one thing taking the
 * payment writes. Cut off 8 Oct, paying 16 Oct: 8 + 16 = 24 days of 31.
 * Disconnected since September and paying 3 Nov: November is 3 to 30, and
 * October stands at what the disconnection reduced it to.
 *
 * Every line is a month. The balance is spread over the months newest first —
 * a payment clears the oldest debt — and anything older than the charges on
 * record (a balance from before the engine) is one "Earlier balance" line.
 *
 * Forward months are whole months at the full rate, listed after.
 */
export function tillBreakdown(opts: {
  today: string
  monthlyCharge: number
  carriedBefore: number
  /** This customer's charges, any order; at least the recent months. */
  charges: MonthCharge[]
  disconnected: boolean
  forwardMonths: number
}): TillBreakdown {
  const { today, monthlyCharge } = opts
  const month = monthOf(today)
  const row = opts.charges.find((c) => c.periodStart === month.start) ?? null

  let current: TillBreakdown['current'] = null
  let carried = opts.carriedBefore
  const charges = [...opts.charges]

  if (opts.disconnected) {
    const serviceDays = daysAfterServiceResumes(row ? row.serviceDays : 'none', today)
    const amount = monthFigure(monthlyCharge, serviceDays, month.days)
    const delta = amount - (row ? row.amount : 0)
    current = {
      periodStart: month.start,
      periodEnd: month.end,
      expected: row ? row.amount : null,
      amount,
      serviceDays,
      delta,
      fullAmount: round100(monthlyCharge),
    }
    carried = Math.round((carried + delta) * 100) / 100
    const at = charges.findIndex((c) => c.periodStart === month.start)
    const replaced = { periodStart: month.start, amount, serviceDays }
    if (at >= 0) charges[at] = replaced
    else charges.push(replaced)
  }

  // Spread what is owed over the months, newest first.
  const lines: BreakdownLine[] = []
  let remaining = Math.max(0, carried)
  const newestFirst = charges.sort((a, b) => b.periodStart.localeCompare(a.periodStart))
  for (const c of newestFirst) {
    if (remaining <= 0) break
    const take = Math.min(c.amount, remaining)
    if (take <= 0) continue
    const [y, m] = ymdParts(c.periodStart)
    const dim = daysInMonth(y, m)
    lines.push({
      month: c.periodStart.slice(0, 7),
      label: monthLabel(c.periodStart),
      days: c.serviceDays === null || c.serviceDays >= dim ? null : c.serviceDays,
      amount: Math.round(take * 100) / 100,
      kind: c.periodStart === month.start ? 'current' : 'earlier',
    })
    remaining = Math.round((remaining - take) * 100) / 100
  }
  if (remaining > 0) {
    lines.push({ month: '', label: 'Earlier balance', days: null, amount: remaining, kind: 'earlier' })
  }
  lines.reverse() // oldest first on the page

  const due = Math.max(0, carried)
  lines.push(...forwardLines(today, opts.forwardMonths, monthlyCharge))

  return { lines, due, current }
}

/** Whole months paid ahead, after the one `today` is in: full rate, rounded. */
export function forwardLines(today: string, months: number, monthlyCharge: number): BreakdownLine[] {
  const out: BreakdownLine[] = []
  for (let i = 1; i <= Math.max(0, Math.floor(months)); i++) {
    const start = addMonths(today, i)
    out.push({
      month: start.slice(0, 7),
      label: monthLabel(start),
      days: null,
      amount: round100(monthlyCharge),
      kind: 'forward',
    })
  }
  return out
}
