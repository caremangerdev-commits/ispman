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
