import { formatMoney } from '@/lib/format'

/**
 * What the portal says about a customer's service, decided ONCE.
 *
 * The account page, the reconnect page and the payment-return page all show
 * the same state (paid up / expiring / off), the same colours for it, and the
 * same words on the pay button. Those are decided here and nowhere else, so a
 * customer who is cut off reads "Pay J$3,500 and reconnect" on whichever page
 * the walled garden or an SMS link dropped them on.
 *
 * PURE. Every date is a YYYY-MM-DD string and "today" is passed in, read once
 * on the server (lib/data/portal.ts#getPortalAccount) — so this is safe in a
 * render and the fill, the day count and the note can never be computed from
 * two different clocks.
 */

/**
 * The three states. SEMANTIC, NEVER THE BRAND: the colours that go with them
 * (green, amber, red in components/portal/portal.module.css) are the same for
 * every tenant, because "your internet is off" must not be orange for one
 * company and teal for the next.
 */
export type ServiceState = 'ok' | 'warn' | 'bad'

/** At or under this many days left, the service reads as expiring. */
export const EXPIRING_DAYS = 3

export function serviceState(days: number): ServiceState {
  if (days < 0) return 'bad'
  if (days <= EXPIRING_DAYS) return 'warn'
  return 'ok'
}

// ---------------------------------------------------------------------------
// Dates. Parsed and formatted in UTC so a calendar date never shifts a day
// because of the server's zone: "2026-11-05" is 5 November everywhere.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

function utc(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

function toYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The same day a calendar month earlier, clamped: 31 Mar -> 28 Feb. */
export function monthBefore(ymd: string): string {
  const ms = utc(ymd)
  if (ms === null) return ymd
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() - 1
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return toYmd(Date.UTC(y, m, Math.min(d.getUTCDate(), last)))
}

const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' })

/** "5 November", with the year only when it is not this year's. */
export function longDay(ymd: string, today: string): string {
  const ms = utc(ymd)
  if (ms === null) return ymd
  const sameYear = ymd.slice(0, 4) === today.slice(0, 4)
  return fmt(sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' })
    .format(ms)
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "5 Oct", or "5 Oct 2026" when asked for the year. Month names spelled out
 * rather than taken from Intl: en-GB's short September is "Sept".
 */
export function shortDay(ymd: string, withYear = false): string {
  const ms = utc(ymd)
  if (ms === null) return ymd
  const d = new Date(ms)
  return d.getUTCDate() + ' ' + MONTHS_SHORT[d.getUTCMonth()] + (withYear ? ' ' + d.getUTCFullYear() : '')
}

// ---------------------------------------------------------------------------
// The span
// ---------------------------------------------------------------------------

export type ServiceSpan = {
  /** YYYY-MM-DD the bar starts: the day they paid, else a month before the end. */
  start: string
  /** YYYY-MM-DD the bar ends: the day the service runs to. */
  end: string
  /** 0-100: how much of the span has been USED. 100 once it has run out. */
  filled: number
  /** The two labels under the bar; the year is shown when they straddle one. */
  startLabel: string
  endLabel: string
}

/**
 * The bar from the day the customer paid to the day they run out, filled by
 * the time already used — 19 days left of 31 is 38% filled, exactly as the
 * reference draws it.
 */
export function serviceSpan(opts: {
  expiry: string
  paidOn: string | null
  today: string
}): ServiceSpan {
  const { expiry, today } = opts
  const start = opts.paidOn && opts.paidOn < expiry ? opts.paidOn : monthBefore(expiry)

  const s = utc(start)
  const e = utc(expiry)
  const t = utc(today)
  let filled = 100
  if (s !== null && e !== null && t !== null && e > s && t < e) {
    filled = Math.min(100, Math.max(0, ((t - s) / (e - s)) * 100))
  }

  const straddles = start.slice(0, 4) !== expiry.slice(0, 4)
  return {
    start,
    end: expiry,
    filled: Math.round(filled * 10) / 10,
    startLabel: shortDay(start, straddles),
    endLabel: shortDay(expiry, straddles),
  }
}

/** Whole days between two YYYY-MM-DD dates. For tests and callers without a count. */
export function daysBetween(from: string, to: string): number | null {
  const a = utc(from)
  const b = utc(to)
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS)
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** Money as a customer reads it: whole units, cents only when there are some. */
export function portalMoney(amount: number, symbol: string): string {
  const cents = Math.round(Math.abs(amount) * 100) % 100 !== 0
  return formatMoney(amount, symbol, { cents })
}

/** The big figure and the words beside it. `big` null: say it in `unit` alone. */
export function dayCount(days: number): { big: string | null; unit: string } {
  if (days === 0) return { big: null, unit: 'Last day' }
  if (days > 0) return { big: String(days), unit: days === 1 ? 'day left' : 'days left' }
  const ago = Math.abs(days)
  return { big: String(ago), unit: ago === 1 ? 'day ago' : 'days ago' }
}

export const FLAG_TEXT: Record<ServiceState, string> = {
  ok: 'Paid up',
  warn: 'Expiring soon',
  bad: 'Service off',
}

/**
 * The pill. "Paid up" is only true when nothing is owed: a postpaid customer
 * with a bill out whose service is still running is "Active", not paid up.
 */
export function flagText(state: ServiceState, owes: boolean): string {
  return state === 'ok' && owes ? 'Active' : FLAG_TEXT[state]
}

/**
 * The sentence under the count: what happens, and when. The "few minutes"
 * promise is made only when the customer can pay online, because only an
 * online payment reconnects them on its own. Without online payment the note
 * points at the Where to pay card — only when the page shows one.
 */
export function serviceNote(opts: {
  state: ServiceState
  days: number
  expiry: string
  today: string
  canPay: boolean
  /** The page shows a Where to pay card the note may point at. */
  whereToPay: boolean
  companyName: string
}): string {
  const { state, days, expiry, today, canPay, whereToPay, companyName } = opts
  const on = longDay(expiry, today)

  if (state === 'bad') {
    if (canPay) {
      return 'Your internet went off on ' + on + '. Pay now and you will be back online in a few minutes.'
    }
    return 'Your internet went off on ' + on + '. Pay ' + (companyName || 'us') +
      ' to come back online' + (whereToPay ? ' — see Where to pay.' : '.')
  }

  const tail = !canPay && whereToPay ? ' See Where to pay.' : ''
  if (state === 'warn') {
    if (days === 0) return 'Your internet goes off today unless you pay now.' + tail
    if (days === 1) return 'Your internet goes off tomorrow, ' + on + ', unless you pay before then.' + tail
    return 'Your internet goes off on ' + on + ' unless you pay before then.' + tail
  }
  return 'Your internet stays on until ' + on + '. Pay before then to keep it running.' + tail
}

/**
 * What the pay button offers: the balance when something is owed, else one
 * month's charge, else nothing (the customer types an amount).
 */
export function payAmount(balance: number, monthlyCharge: number): number | null {
  if (balance > 0.005) return Math.round(balance * 100) / 100
  if (monthlyCharge > 0.005) return Math.round(monthlyCharge * 100) / 100
  return null
}

/**
 * The button's words change with the state: a cut-off customer is not paying
 * "a bill", they are paying to come back.
 */
export function payLabel(state: ServiceState | null, amount: number | null, symbol: string): string {
  const m = amount !== null ? portalMoney(amount, symbol) : null
  if (state === 'bad') return m ? 'Pay ' + m + ' and reconnect' : 'Pay and reconnect'
  if (state === 'warn') return m ? 'Pay ' + m + ' now' : 'Pay now'
  return 'Pay bill'
}
