/**
 * Thermal receipt layout.
 *
 * The whole receipt is rendered to an array of fixed-width monospace lines by
 * `renderReceipt`, and every output path — the on-screen modal, the print
 * stylesheet, and the PDF download — prints those same lines. That is the point
 * of the module: three renderers that each laid out their own columns would
 * drift, and a receipt whose printed copy differs from the screen is worse than
 * no receipt at all.
 *
 * Everything here is pure and free of server imports, so the client bundle can
 * run it to draw the modal and the PDF without a round trip.
 */

/**
 * Characters per line at 80mm.
 *
 * 80mm of paper at the usual 12 CPI leaves 32 usable columns, which is what the
 * specified layout is built around:
 *
 *     Monthly service         3,500.00
 *     |-------------|         |------|
 *     label, left             right-aligned, column 32
 */
export const RECEIPT_WIDTH = 32

/** Width of the left label column in the header block (Receipt #, Date, ...). */
const LABEL_WIDTH = 11

/** Width of the rule drawn above the total. */
const RULE_WIDTH = 9

export type ReceiptKind = 'service' | 'other'

/** One money line on the body of the receipt. */
export type ReceiptLine = { label: string; amount: number }

export type Receipt = {
  kind: ReceiptKind
  companyName: string
  companyPhone: string | null
  /** The payments row id, zero padded to 8. */
  number: string
  /** paid_on, with the time the payment was recorded. */
  dateLabel: string
  cashier: string
  customerName: string
  /** Omitted from the receipt entirely when null. */
  accountNumber: string | null
  /**
   * The charges being settled. One line for an "other" payment (the category
   * name); for a service payment the monthly charge and, when there was one,
   * the balance brought forward.
   */
  lines: ReceiptLine[]
  /**
   * Sum of `lines`. Null for a pre-0013 service payment, whose monthly charge
   * was never stored — the receipt then prints the amount paid alone rather
   * than inventing a breakdown. See migration 0013.
   */
  totalDue: number | null
  /** e.g. "Paid (Cash)". */
  paidLabel: string
  paid: number
  /** Service only. Always printed when present, including at 0.00. */
  balance: number | null
  /** Service only. Omitted when the payment set no expiry. */
  activeUntil: string | null
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Two decimals, thousands separated. Fixed so columns line up. */
export function receiptMoney(n: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

/** Centres within the paper width. Left-biased when it cannot centre exactly. */
function centre(text: string): string {
  const room = RECEIPT_WIDTH - text.length
  if (room <= 0) return text.slice(0, RECEIPT_WIDTH)
  return ' '.repeat(Math.floor(room / 2)) + text
}

/**
 * A label on the left and a value pushed to the right margin.
 *
 * When the two cannot fit on one line the value wins the right margin and the
 * label is truncated — a receipt that has lost a letter of "Installation" is
 * readable, one whose amount has wrapped to the next line is not.
 */
function columns(label: string, value: string): string {
  const room = RECEIPT_WIDTH - value.length
  if (room < 1) return value.slice(-RECEIPT_WIDTH)
  const left = label.length > room - 1 ? label.slice(0, room - 1) : label
  return left + ' '.repeat(RECEIPT_WIDTH - left.length - value.length) + value
}

/** A header field: fixed-width label column, value left-aligned after it. */
function field(label: string, value: string): string {
  return label.padEnd(LABEL_WIDTH) + value
}

/** The rule above the total, right-aligned over the amount column. */
function rule(): string {
  return ' '.repeat(RECEIPT_WIDTH - RULE_WIDTH) + '-'.repeat(RULE_WIDTH)
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The receipt as fixed-width lines, top to bottom.
 *
 * Blank lines are meaningful — they are the vertical rhythm of the printed
 * receipt — so they are returned as empty strings rather than skipped.
 */
export function renderReceipt(r: Receipt): string[] {
  const out: string[] = []

  // --- Header ---
  out.push(centre(r.companyName))
  if (r.companyPhone) out.push(centre(r.companyPhone))
  out.push('')

  out.push(field('Receipt #', r.number))
  out.push(field('Date', r.dateLabel))
  out.push(field('Cashier', r.cashier))
  out.push('')

  out.push(field('Customer', r.customerName))
  // Omitted entirely — not printed blank — when the customer has no account
  // number. See the note in lib/data/receipts.ts.
  if (r.accountNumber) out.push(field('Account', r.accountNumber))
  out.push('')

  // --- Charges ---
  for (const line of r.lines) {
    out.push(columns(line.label, receiptMoney(line.amount)))
  }

  // A pre-0013 service payment has no stored breakdown, so there is nothing to
  // total and no rule to draw: the amount paid stands alone.
  if (r.totalDue !== null) {
    out.push(rule())
    out.push(columns('Total due', receiptMoney(r.totalDue)))
  }

  out.push(columns(r.paidLabel, receiptMoney(r.paid)))

  // Service only. Printed even at zero — "Balance 0.00" is the line the
  // customer is looking for, and omitting it reads as an oversight.
  if (r.balance !== null) {
    out.push(columns('Balance', receiptMoney(r.balance)))
  }

  if (r.activeUntil) {
    out.push('')
    out.push(columns('Service active until', r.activeUntil))
  }

  out.push('')
  out.push(centre('Thank you'))

  return out
}

/** The receipt as one printable string. */
export function receiptText(r: Receipt): string {
  return renderReceipt(r).join('\n')
}

/** `00001847` — the payments row id, zero padded to 8. */
export function receiptNumber(id: number): string {
  return String(id).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Month names, spelled out rather than taken from Intl.
 *
 * Intl's "short" month is locale- and ICU-version-dependent: en-GB renders
 * September as "Sept", four characters, which pushes
 * "Service active until  16 Sept 2026" past the 32-column width and truncates
 * the label. The receipt grid is fixed, so the month has to be too.
 */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** `16 Sep 2026` */
export function receiptDate(value: Date, timeZone: string): string {
  // en-CA gives YYYY-MM-DD parts, so the numbers come back in a fixed order
  // and already converted into the company timezone.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value)

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''

  return get('day') + ' ' + MONTHS[Number(get('month')) - 1] + ' ' + get('year')
}

/**
 * `28 Aug 2026  2:14 PM` — the business date with the time it was recorded.
 *
 * The two halves come from different columns on purpose. `paid_on` is the date
 * the cashier states, and it may be back-dated; the time of day is only
 * meaningful as the moment the row was actually written. Taking both from one
 * timestamp would either lose a back-dated payment's stated date or print a
 * time that never happened.
 */
export function receiptDateTime(
  paidOn: Date,
  recordedAt: Date | null,
  timeZone: string
): string {
  const date = receiptDate(paidOn, timeZone)
  if (!recordedAt) return date

  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(recordedAt)

  return date + '  ' + time
}
