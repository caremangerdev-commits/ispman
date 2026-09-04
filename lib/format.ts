/** Shared display formatting. Keep every user-facing number/date going through here. */

const LOCALE = 'en-US'

/**
 * Jamaican dollars are conventionally written "J$". Intl offers no such form
 * for JMD — narrowSymbol collapses to a bare "$" (ambiguous against USD) and
 * symbol/code both give "JMD 51,000" — so the prefix is applied by hand.
 *
 * TODO: drive this from settings.currency once more than one tenant exists.
 */
const SYMBOL = 'J$'

const CURRENCY_SYMBOLS: Record<string, string> = {
  JMD: 'J$',
  USD: 'US$',
  TTD: 'TT$',
  BBD: 'Bds$',
  GYD: 'G$',
  XCD: 'EC$',
}

/** Short prefix for a currency code, e.g. JMD -> "J$". Falls back to the code. */
export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? code
}

/** "J$2,500" — whole units, since ISP billing here has no cents in practice. */
export function formatCurrency(value: number | string | null | undefined): string {
  const n = Number(value ?? 0)
  const safe = Number.isFinite(n) ? n : 0
  const digits = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(
    Math.abs(safe)
  )
  return (safe < 0 ? '-' : '') + SYMBOL + digits
}

/** Compact form for chart axes: "J$120k". */
export function formatCompactCurrency(value: number): string {
  if (Math.abs(value) >= 1000) return SYMBOL + Math.round(value / 1000) + 'k'
  return SYMBOL + Math.round(value)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "12m ago", "3h ago", "2d ago", then an absolute date. */
export function timeAgo(input: string | Date | null | undefined): string {
  if (!input) return '—'
  const then = new Date(input).getTime()
  if (!Number.isFinite(then)) return '—'

  const diff = Date.now() - then
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return Math.floor(diff / MINUTE) + 'm ago'
  if (diff < DAY) return Math.floor(diff / HOUR) + 'h ago'
  if (diff < 7 * DAY) return Math.floor(diff / DAY) + 'd ago'
  return new Date(input).toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' })
}

/** "Today" / "Yesterday" / "12 Mar" — for payment rows. */
export function formatRelativeDate(input: string | Date | null | undefined): string {
  if (!input) return '—'
  const d = new Date(input)
  if (!Number.isFinite(d.getTime())) return '—'

  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(new Date()) - startOf(d)) / DAY)

  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return days + ' days ago'
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })
}

/**
 * The calendar date inside a date-only value, as plain numbers.
 *
 * A DATE column ("2026-09-15") is a CALENDAR DATE, not an instant. It has no
 * time and no timezone, and the two obvious ways of reading it both move it:
 *
 *   new Date('2026-09-15')            parsed as UTC midnight by spec, so every
 *                                     viewer west of UTC renders 14 Sep.
 *   new Date('2026-09-15T00:00:00')   parsed as midnight in the PROCESS zone,
 *                                     which then shifts if it is re-rendered
 *                                     in any other zone — a UTC server writing
 *                                     for a UTC-5 company lands on 14 Sep.
 *
 * So the string is never turned into an instant at all. The digits are read
 * straight out of it and the caller formats those.
 *
 * Accepts a bare "YYYY-MM-DD" or anything beginning with one, which covers a
 * DATE column and a timestamp that has already been reduced to a date.
 */
export function dateOnlyParts(
  value: string | null | undefined
): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((value ?? '').trim())
  if (!m) return null

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  return { year, month, day }
}

/**
 * "15 Sep 2026" — the app's standard date, for a DATE column.
 *
 * THE ONLY WAY A DATE-ONLY VALUE SHOULD BE RENDERED. The Date it builds is
 * local midnight from local parts and is formatted in that same local zone, so
 * there is no conversion anywhere in the path and no way for it to slip a day.
 */
export function formatDateOnly(value: string | null | undefined): string {
  const p = dateOnlyParts(value)
  if (!p) return '—'
  return new Date(p.year, p.month - 1, p.day).toLocaleDateString(LOCALE, {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/**
 * A date-only value as a Date at LOCAL midnight, for comparing against other
 * local dates. Null when there is no usable date.
 *
 * The only safe way to get a Date out of a DATE column. Comparing
 * `new Date('2026-09-01')` — UTC midnight — against a locally-built month
 * boundary is out by the whole UTC offset, which is enough to drop a customer
 * added on the 1st into the previous month.
 */
export function dateOnlyToLocalDate(value: string | null | undefined): Date | null {
  const p = dateOnlyParts(value)
  return p ? new Date(p.year, p.month - 1, p.day) : null
}

/**
 * Whole days from today to a date-only value. Negative once it has passed.
 *
 * Both sides are local midnight, so the answer is a count of calendar days and
 * never a fraction rounded across a timezone offset.
 */
export function daysUntilDateOnly(value: string | null | undefined): number | null {
  const target = dateOnlyToLocalDate(value)
  if (!target) return null
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((target.getTime() - today.getTime()) / DAY)
}

/**
 * The calendar date a WALL-CLOCK Date spells out, as "YYYY-MM-DD".
 *
 * For a Date that was built from wall-clock parts and never meant an instant —
 * radcheck's `Expiration` ("15 Sep 2026 00:00") is parsed into one of these.
 * Sending such a Date to a browser as an instant and re-reading its parts there
 * shifts it by the difference between the two zones; taking the date here, in
 * the process that parsed it, is what keeps it the date FreeRADIUS was given.
 *
 * NOT for a genuine timestamp — use instantToDateOnly, which names its zone.
 */
export function localDateOnly(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate())
}

/**
 * The calendar date an INSTANT falls on, in a named zone, as "YYYY-MM-DD".
 *
 * The opposite direction to the above and the only conversion that is ever
 * correct: a real timestamp genuinely does fall on different dates in different
 * places, so the zone has to be named. en-CA is asked for because it returns
 * the parts already in YYYY-MM-DD order.
 */
export function instantToDateOnly(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return get('year') + '-' + get('month') + '-' + get('day')
}

/** MAC addresses are too wide for narrow panels — show the tail only. */
export function truncateMac(mac: string | null | undefined): string {
  if (!mac) return '—'
  const parts = mac.split(':')
  if (parts.length <= 3) return mac
  return '…' + parts.slice(-3).join(':')
}

export function initials(first?: string | null, last?: string | null): string {
  return ((first?.[0] ?? '') + (last?.[0] ?? '')).toUpperCase() || '?'
}

export function fullName(
  p: { first_name?: string | null; last_name?: string | null } | null | undefined
): string {
  if (!p) return 'Unknown'
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unknown'
}

/**
 * Turns a structured audit-log detail into something a person can read.
 *
 * The `log.details` column deliberately stores a machine-parseable record of
 * every network write — identity, old expiry, new expiry, operator — because
 * it is the audit trail. That format is not for customers or counter staff, so
 * it is rewritten here at display time. The stored row is never altered.
 *
 * Anything that does not match the structured shape is passed through, since
 * most log entries are already written as plain sentences.
 *
 * THE PLATFORM OPERATOR MARKER is handled here for every row, structured or
 * plain, and deliberately BEFORE the network-event rewrite below. That rewrite
 * rebuilds its sentence from named fields and drops anything it did not
 * capture, so a marker left in place would be written to the database and then
 * be invisible on the tenant's own activity log — worse than not marking at
 * all, and invisible on exactly the writes an ISP most needs the truth about.
 */
export function humaniseLogDetail(details: string | null | undefined): string {
  if (!details) return ''

  // See lib/audit.ts#actingMarker. Stripped from the text that gets rewritten,
  // then re-attached to whatever that rewrite produces.
  const marked = /\s*\|\s*via=super_admin:#\d+\s*$/.test(details)
  const body = marked ? details.replace(/\s*\|\s*via=super_admin:#\d+\s*$/, '') : details
  const attribute = (text: string) => (marked ? text + ' (platform operator)' : text)

  const m = /^RADIUS (\w+)(?: (FAILED))? \| identity=([^|]+?) \|/.exec(body.trim())
  if (!m) return attribute(body)

  const [, action, failed, identity] = m
  const field = (name: string) => {
    // The pipe must stay escaped for the regex, not read as alternation.
    const f = new RegExp('\\| ' + name + '=([^|]+)').exec(body)
    return f ? f[1].trim() : null
  }

  const who = field('by')
  const newExpiry = field('new_expiry')
  const subject = 'Network access for ' + identity.trim()

  const verb =
    action === 'provision' ? 'provisioned'
      : action === 'reconnect' ? 'reconnected'
      : action === 'extend' ? 'extended'
      : action === 'disconnect' ? 'disconnected'
      : action

  if (failed) {
    return attribute(subject + ' could not be ' + verb + (who ? ' by ' + who : ''))
  }

  const until =
    newExpiry && action !== 'disconnect' ? ' until ' + newExpiry : ''

  return attribute(subject + ' ' + verb + until + (who ? ', by ' + who : ''))
}
