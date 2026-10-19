import type { Brand, BrandLetterhead } from '@/lib/brand'
import { showsTax, splitTax, type BillSettings, type BillTemplate } from '@/lib/bill/settings'

/**
 * A bill, as data: what all three templates print, built from the records.
 *
 * PURE. No database, no clock: the loader (lib/data/bill.ts) reads the rows
 * and the company's date, and the settings page's sample builds one from made-up
 * rows through the same function. The renderers (lib/bill/pdf.ts) never
 * compute a figure — every number on a bill is decided here, once.
 *
 * WHAT A BILL CAN KNOW. Every service payment row records the carried balance
 * either side of it (migration 0011), and every charge the billing engine
 * raises records the same (bill_charges, 0024). Charges raised by hand with
 * Run Bills leave no row per customer; they show up as the balance rising
 * between one payment's "after" and the next payment's "before", and are
 * listed as "Charges billed" for exactly that difference. Nothing is invented
 * beyond that, with one exception the Statement makes and says so: see
 * `currentServiceLine`.
 */

export type Ymd = string

export type BillLine = {
  description: string
  /** A second, muted line under the description: the speed, the months. */
  detail: string | null
  /** The service period the line covers, inclusive of both dates as printed. */
  period: { start: Ymd; end: Ymd } | null
  /** What the customer pays for it, tax included. */
  gross: number
}

export type LedgerEntry = {
  date: Ymd
  detail: string
  /** Charged, or null. */
  charge: number | null
  /** Paid or credited, or null. */
  payment: number | null
  /** The carried balance after this entry: positive is owed. */
  balance: number
}

export type BillPaymentRow = {
  id: number
  /** The company-local date it was paid. */
  date: Ymd
  amount: number
  /** "Cash", "Card, online", ... or null. */
  method: string | null
  monthsPaid: number
  carriedBefore: number | null
  carriedAfter: number | null
  /** The service end this payment wrote, or null when it moved nothing. */
  runsTo: Ymd | null
}

export type BillChargeRow = {
  date: Ymd
  periodStart: Ymd
  periodEnd: Ymd
  amount: number
  carriedBefore: number
  carriedAfter: number
  creditApplied: number
}

export type BillInput = {
  template: BillTemplate
  /** The company's own today. */
  today: Ymd
  company: { name: string; phone: string | null; email: string | null }
  settings: BillSettings
  brand: Brand
  letterhead: BrandLetterhead | null
  customer: {
    id: number
    name: string
    address: string | null
    phone: string | null
    accountNumber: string | null
    plan: { name: string; downMbps: number; upMbps: number } | null
    /** Rate plus add-ons: what a month costs. */
    monthlyCharge: number
    /** customers.carried_balance now. */
    carried: number
    /** customers.account_credit now. */
    credit: number
    /** Where service currently runs to, or null when unknown. */
    expiry: Ymd | null
    /** The day of the month bills are raised (lib/billing.ts#effectiveBillDay). */
    billDay: number
  }
  /** Service payments only, any order. */
  payments: BillPaymentRow[]
  /** Engine charges, any order. Empty for a company billed by hand. */
  charges: BillChargeRow[]
  howToPay: { inPerson: string | null; bank: string | null; online: string | null }
  /** A calendar month to bill, 'YYYY-MM', or null for the current period. */
  month?: string | null
  /** The payment a Receipt is for, or null for the latest. */
  paymentId?: number | null
}

export type BillDocument = {
  /** What is actually drawn. A Receipt with no payment to show is drawn as a Statement. */
  template: BillTemplate
  title: string
  number: string
  numberLabel: string
  issued: Ymd
  due: Ymd | null
  company: {
    name: string
    addressLines: string[]
    phone: string | null
    email: string | null
    /** "TRN 123-456-789", or null. */
    taxIdLine: string | null
    /** "GCT reg. 0001234", or null. */
    taxRegLine: string | null
  }
  customer: {
    name: string
    addressLines: string[]
    phone: string | null
    accountNumber: string
    plan: string | null
    speed: string | null
  }
  lines: BillLine[]
  /** Whether a statement line was drawn from the plan rather than a record. */
  lineFromPlan: boolean
  tax: { shown: boolean; label: string; rate: number }
  totals: { net: number; tax: number; gross: number }
  summary: {
    previousBalance: number
    payments: number
    charges: number
    /** Positive owed, negative in credit. */
    totalDue: number
  }
  period: { start: Ymd; end: Ymd }
  ledger: {
    from: Ymd
    to: Ymd
    broughtForward: number
    entries: LedgerEntry[]
    closing: number
    creditHeld: number
    charged: number
  }
  receipt: {
    paidOn: Ymd
    paidBy: string
    amount: number
    runsTo: Ymd | null
    outstanding: number
  } | null
  serviceRunsTo: Ymd | null
  howToPay: { inPerson: string | null; bank: string | null; online: string | null }
  legal: string
  symbol: string
  brand: Brand
  letterhead: BrandLetterhead | null
}

// ---------------------------------------------------------------------------
// Dates, as plain YYYY-MM-DD: no time zone can move them.
// ---------------------------------------------------------------------------

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function parts(d: Ymd): [number, number, number] {
  return [Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** `d` plus `months` calendar months, the day clamped to the month's last. */
export function addMonthsYmd(d: Ymd, months: number): Ymd {
  const [y, m, day] = parts(d)
  const index = y * 12 + (m - 1) + months
  const ty = Math.floor(index / 12)
  const tm = (index % 12) + 1
  return ty + '-' + pad(tm) + '-' + pad(Math.min(day, lastDay(ty, tm)))
}

function monthStart(d: Ymd): Ymd {
  return d.slice(0, 7) + '-01'
}

function monthEnd(d: Ymd): Ymd {
  const [y, m] = parts(d)
  return d.slice(0, 7) + '-' + pad(lastDay(y, m))
}

/** "5 Oct 2026". */
export function dayShort(d: Ymd): string {
  const [y, m, day] = parts(d)
  return day + ' ' + MONTHS_SHORT[m - 1] + ' ' + y
}

/** "5 November 2026". */
export function dayLong(d: Ymd): string {
  const [y, m, day] = parts(d)
  return day + ' ' + MONTHS_LONG[m - 1] + ' ' + y
}

/** "5 Oct", for a ledger's date column. */
export function dayMonth(d: Ymd): string {
  const [, m, day] = parts(d)
  return day + ' ' + MONTHS_SHORT[m - 1]
}

/** "5 Oct – 5 Nov 2026", or "28 Dec 2026 – 28 Jan 2027" across a year. */
export function rangeText(start: Ymd, end: Ymd): string {
  if (start.slice(0, 4) === end.slice(0, 4)) return dayMonth(start) + ' – ' + dayShort(end)
  return dayShort(start) + ' – ' + dayShort(end)
}

/**
 * The latest bill day in (after, upTo], or `upTo` when there is none — where a
 * charge raised by hand between two dates is dated. The bill day is clamped to
 * short months, as the engine and Run Bills clamp it.
 */
function billDayBetween(after: Ymd | null, upTo: Ymd, billDay: number): Ymd {
  const [y, m] = parts(upTo)
  for (let back = 0; back < 3; back++) {
    const index = y * 12 + (m - 1) - back
    const ty = Math.floor(index / 12)
    const tm = (index % 12) + 1
    const d = ty + '-' + pad(tm) + '-' + pad(Math.min(Math.max(1, billDay), lastDay(ty, tm)))
    if (d <= upTo && (after === null || d > after)) return d
    if (after !== null && d <= after) break
  }
  return upTo
}

const round2 = (n: number) => Math.round(n * 100) / 100
const EPS = 0.005

// ---------------------------------------------------------------------------
// The account's history, reconciled from the rows
// ---------------------------------------------------------------------------

type Event =
  | { kind: 'payment'; date: Ymd; order: number; row: BillPaymentRow; before: number; after: number }
  | { kind: 'charge'; date: Ymd; order: number; row: BillChargeRow; before: number; after: number }
  | { kind: 'billed'; date: Ymd; order: number; amount: number; before: number; after: number }
  | { kind: 'adjusted'; date: Ymd; order: number; amount: number; before: number; after: number }

/**
 * Every recorded movement of the carried balance, oldest first, with the
 * balance either side of each, and a "billed" or "adjusted" entry wherever the
 * balance moved between two records with no record of why.
 *
 * Each entry's `before` is the previous entry's `after`, so the history chains
 * exactly from its first record to the customer's balance today.
 */
function history(input: BillInput): Event[] {
  const raw: Event[] = []
  for (const p of input.payments) {
    if (p.carriedBefore === null || p.carriedAfter === null) continue
    raw.push({ kind: 'payment', date: p.date, order: 1, row: p, before: p.carriedBefore, after: p.carriedAfter })
  }
  for (const c of input.charges) {
    raw.push({ kind: 'charge', date: c.date, order: 0, row: c, before: c.carriedBefore, after: c.carriedAfter })
  }
  // Same day: charges before payments, as a bill is raised before it is paid;
  // then by the payment's id, the order the till took them.
  raw.sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1
      : a.order !== b.order ? a.order - b.order
        : (a.kind === 'payment' && b.kind === 'payment' ? a.row.id - b.row.id : 0)
  )

  const out: Event[] = []
  let prevAfter: number | null = null
  let prevDate: Ymd | null = null
  const gap = (from: number, to: number, upTo: Ymd) => {
    const diff = round2(to - from)
    if (diff > EPS) {
      const date = billDayBetween(prevDate, upTo, input.customer.billDay)
      out.push({ kind: 'billed', date, order: 0, amount: diff, before: from, after: to })
    } else if (diff < -EPS) {
      out.push({ kind: 'adjusted', date: upTo, order: 0, amount: -diff, before: from, after: to })
    }
  }

  for (const e of raw) {
    if (prevAfter !== null) gap(prevAfter, e.before, e.date)
    out.push(e)
    prevAfter = e.after
    prevDate = e.date
  }
  // Since the last record: a bill raised by hand that is not paid yet.
  if (prevAfter !== null) gap(prevAfter, round2(input.customer.carried), input.today)

  return out
}

function planDetail(plan: BillInput['customer']['plan']): string | null {
  if (!plan) return null
  return plan.downMbps + ' / ' + plan.upMbps + ' Mbps'
}

function serviceName(plan: BillInput['customer']['plan']): string {
  return plan ? plan.name + ' internet service' : 'Internet service'
}

/** A charge as a bill line. */
function chargeLine(input: BillInput, e: Event): BillLine | null {
  const plan = input.customer.plan
  if (e.kind === 'charge') {
    return {
      description: serviceName(plan),
      detail: planDetail(plan),
      period: { start: e.row.periodStart, end: e.row.periodEnd },
      gross: e.row.amount,
    }
  }
  if (e.kind === 'billed') {
    return {
      description: serviceName(plan),
      detail: planDetail(plan),
      period: { start: e.date, end: addMonthsYmd(e.date, 1) },
      gross: e.amount,
    }
  }
  return null
}

function addressLines(text: string | null): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
}

function lineGross(e: Event): number {
  return e.kind === 'charge' ? e.row.amount : e.kind === 'billed' ? e.amount : 0
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export function buildBillDocument(input: BillInput): BillDocument {
  const s = input.settings
  const today = input.today
  const events = history(input)
  const acct = input.customer.accountNumber ?? String(input.customer.id)
  const netNow = round2(input.customer.carried - input.customer.credit)

  // --- The period ------------------------------------------------------------
  //
  // A chosen month is that calendar month. Otherwise the current bill: from the
  // most recent charge to today, so the latest bill and everything paid since
  // are on one page. With no charge on record, the month to date.
  const monthChosen = input.month && /^\d{4}-\d{2}$/.test(input.month) ? input.month : null
  let period: { start: Ymd; end: Ymd }
  if (monthChosen) {
    const start = monthChosen + '-01'
    period = { start, end: monthEnd(start) < today ? monthEnd(start) : today }
  } else {
    const lastCharge = [...events].reverse().find((e) => (e.kind === 'charge' || e.kind === 'billed') && e.date <= today)
    period = { start: lastCharge ? lastCharge.date : monthStart(today), end: today }
  }
  const inPeriod = (d: Ymd) => d >= period.start && d <= period.end

  // --- Statement lines and summary ------------------------------------------
  const periodCharges = events.filter((e) => (e.kind === 'charge' || e.kind === 'billed') && inPeriod(e.date))
  let lines = periodCharges.map((e) => chargeLine(input, e)).filter((l): l is BillLine => l !== null)

  // THE ONE LINE DRAWN FROM THE PLAN. A prepaid company billed by hand draws
  // each month's charge out of credit the customer paid ahead, which moves no
  // carried balance and so leaves nothing above to list. With no charge in the
  // period, a customer whose service runs into it, and a price for a month,
  // the Statement itemises the plan for the service period it is in: that IS
  // the month they are being billed for. The summary below is derived from it
  // so the strip still adds up, and `lineFromPlan` lets the page say so.
  let lineFromPlan = false
  const expiry = input.customer.expiry
  if (lines.length === 0 && input.customer.monthlyCharge > EPS && expiry && expiry >= period.start) {
    const start = addMonthsYmd(expiry, -1)
    lines = [{
      description: serviceName(input.customer.plan),
      detail: planDetail(input.customer.plan),
      period: { start, end: expiry },
      gross: round2(input.customer.monthlyCharge),
    }]
    lineFromPlan = true
  }

  const charges = round2(lines.reduce((t, l) => t + l.gross, 0))
  const periodPayments = input.payments.filter((p) => inPeriod(p.date))
  const paid = round2(periodPayments.reduce((t, p) => t + p.amount, 0))

  // What is due at the end of the period: today's balance net of credit for
  // the current bill; the carried balance as the records stood at the month's
  // end for a past month. The previous balance is then what makes the strip
  // add up — previous - payments + charges = total due — so any movement the
  // records cannot explain lands in "previous balance", never in a wrong total.
  let totalDue = netNow
  if (monthChosen && period.end < today) {
    const after = events.filter((e) => e.date > period.end)
    totalDue = after.length ? after[0].before : round2(input.customer.carried)
  }
  const previousBalance = round2(totalDue + paid - charges)

  // --- Tax -------------------------------------------------------------------
  const taxShown = showsTax(s)
  const rate = taxShown ? s.taxRate : 0
  let net = 0
  let tax = 0
  for (const l of lines) {
    const split = splitTax(l.gross, rate)
    net += split.net
    tax += split.tax
  }

  // --- Ledger ----------------------------------------------------------------
  //
  // Every recorded movement in the window, each with the balance its own row
  // recorded after it. The window is a chosen month, or the last three months
  // to today, as the reference shows ("1 August to 19 October").
  const ledgerFrom = monthChosen ? period.start : monthStart(addMonthsYmd(today, -2))
  const ledgerTo = monthChosen ? period.end : today
  const windowEvents = events.filter((e) => e.date >= ledgerFrom && e.date <= ledgerTo)
  const before = events.filter((e) => e.date < ledgerFrom)
  const broughtForward = windowEvents.length
    ? windowEvents[0].before
    : before.length ? before[before.length - 1].after : round2(input.customer.carried)

  const entries: LedgerEntry[] = windowEvents.map((e) => {
    if (e.kind === 'payment') {
      const credit = round2(e.row.amount - (e.before - e.after))
      return {
        date: e.date,
        detail: 'Payment received' + (e.row.method ? ' · ' + e.row.method : '') +
          (credit > EPS ? ' · ' + money(credit, input.settings.currencySymbol) + ' held as credit' : ''),
        charge: null,
        payment: e.row.amount,
        balance: e.after,
      }
    }
    if (e.kind === 'adjusted') {
      return { date: e.date, detail: 'Balance adjustment', charge: null, payment: e.amount, balance: e.after }
    }
    const line = chargeLine(input, e)
    const fromCredit = e.kind === 'charge' && e.row.creditApplied > EPS
      ? ' · ' + money(e.row.creditApplied, input.settings.currencySymbol) + ' from credit'
      : ''
    return {
      date: e.date,
      detail: (input.customer.plan?.name ?? 'Internet') + ' service' +
        (line?.period ? ' · ' + dayMonth(line.period.start) + ' – ' + dayMonth(line.period.end) : '') +
        fromCredit,
      charge: lineGross(e),
      payment: null,
      balance: e.after,
    }
  })
  const ledgerCharged = round2(entries.reduce((t, e) => t + (e.charge ?? 0), 0))

  // --- Receipt ---------------------------------------------------------------
  const sorted = [...input.payments].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))
  const payment = input.paymentId ? sorted.find((p) => p.id === input.paymentId) ?? null : sorted[0] ?? null
  // A Receipt needs a payment. With none to show, the customer gets a Statement
  // rather than an empty receipt.
  const template: BillTemplate = input.template === 'receipt' && !payment ? 'statement' : input.template

  let receipt: BillDocument['receipt'] = null
  let receiptLines: BillLine[] = []
  if (template === 'receipt' && payment) {
    const runsTo = payment.runsTo ?? null
    const months = Math.max(1, payment.monthsPaid || 1)
    receiptLines = [{
      description: payment.monthsPaid >= 1
        ? (input.customer.plan ? input.customer.plan.name + ' internet' : 'Internet service')
        : 'Payment on account',
      detail: [planDetail(input.customer.plan), payment.monthsPaid > 1 ? payment.monthsPaid + ' months' : null]
        .filter(Boolean).join(' · ') || null,
      period: runsTo && payment.monthsPaid >= 1 ? { start: addMonthsYmd(runsTo, -months), end: runsTo } : null,
      gross: payment.amount,
    }]
    receipt = {
      paidOn: payment.date,
      paidBy: payment.method ?? 'Payment',
      amount: payment.amount,
      runsTo,
      outstanding: payment.carriedAfter ?? Math.max(0, netNow),
    }
  }

  const docLines = template === 'receipt' ? receiptLines : lines
  if (template === 'receipt') {
    net = 0
    tax = 0
    for (const l of docLines) {
      const split = splitTax(l.gross, rate)
      net += split.net
      tax += split.tax
    }
  }
  const gross = round2(docLines.reduce((t, l) => t + l.gross, 0))

  // --- Numbers and dates -----------------------------------------------------
  const yyyymm = (d: Ymd) => d.slice(0, 4) + d.slice(5, 7)
  const number =
    template === 'receipt' && payment ? String(payment.id).padStart(8, '0')
      : template === 'ledger' ? acct + '-' + today.replace(/-/g, '')
        : acct + '-' + yyyymm(period.start)

  const runsTo = template === 'receipt' && receipt ? receipt.runsTo : expiry
  const owing = (template === 'ledger' ? round2(input.customer.carried) : totalDue) > EPS
  const due: Ymd | null =
    template === 'receipt'
      ? runsTo
      : owing
        ? (expiry && expiry > today ? expiry : today)
        : expiry && expiry > today ? expiry : null

  const taxIdLine = s.taxId ? s.taxIdLabel + ' ' + s.taxId : null
  // A registration number is only printed by a company that says it is
  // registered: a bill with no tax line and a tax registration on it says two
  // different things.
  const taxRegLine = s.taxRegistered && s.taxRegistrationNumber ? s.taxLabel + ' reg. ' + s.taxRegistrationNumber : null
  const legalBits = [input.company.name, taxIdLine, taxRegLine].filter(Boolean) as string[]
  const legal =
    template === 'ledger'
      ? 'Queries about this statement should be raised within 30 days. ' + legalBits.join(' · ')
      : legalBits.join(' · ') + ' · ' + (taxShown ? 'Tax invoice' : template === 'receipt' ? 'Receipt' : 'Invoice') +
        ' — retain for your records.'

  return {
    template,
    title: template === 'receipt' ? 'Receipt' : template === 'ledger' ? 'Statement of account' : 'Invoice',
    number,
    numberLabel: template === 'receipt' ? 'No.' : template === 'ledger' ? 'Statement' : 'Invoice',
    issued: today,
    due,
    company: {
      name: input.company.name,
      addressLines: addressLines(s.address),
      phone: input.company.phone,
      email: input.company.email,
      taxIdLine,
      taxRegLine,
    },
    customer: {
      name: input.customer.name,
      addressLines: addressLines(input.customer.address),
      phone: input.customer.phone,
      accountNumber: acct,
      plan: input.customer.plan?.name ?? null,
      speed: planDetail(input.customer.plan),
    },
    lines: docLines,
    lineFromPlan: template === 'statement' && lineFromPlan,
    tax: { shown: taxShown, label: s.taxLabel, rate },
    totals: { net: round2(net), tax: round2(tax), gross },
    summary: { previousBalance, payments: paid, charges, totalDue },
    period,
    ledger: {
      from: ledgerFrom,
      to: ledgerTo,
      broughtForward,
      entries,
      closing: round2(input.customer.carried),
      creditHeld: round2(input.customer.credit),
      charged: ledgerCharged,
    },
    receipt,
    serviceRunsTo: runsTo,
    howToPay: input.howToPay,
    legal,
    symbol: s.currencySymbol,
    brand: input.brand,
    letterhead: input.letterhead,
  }
}

/** "J$3,500.00", "-J$200.00". Bills always show cents. */
export function money(n: number, symbol: string): string {
  const v = Number.isFinite(n) ? n : 0
  const digits = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v))
  return (v < -EPS ? '-' : '') + symbol + digits
}
