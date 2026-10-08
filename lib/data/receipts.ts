import { PAYMENT_METHOD_LABELS, toPaymentMethod } from '@/lib/data/checkoff'
import { instantToDateOnly } from '@/lib/format'
import {
  receiptDateTime, receiptNumber, type Receipt, type ReceiptLine,
} from '@/lib/receipt'
import { prepaidCalendarFor } from '@/lib/data/prepaid-calendar'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A calendar-month line in the receipt's 32 columns: "Oct 2026, 24 days",
 * "Nov 2026, full month", "Earlier balance".
 */
function monthLineLabel(l: { month: string; label: string; days: number | null; kind: string }): string {
  if (!l.month) return l.label
  const [y, m] = l.month.split('-').map(Number)
  const head = (SHORT_MONTHS[m - 1] ?? '') + ' ' + y
  if (l.days !== null) return head + ', ' + l.days + (l.days === 1 ? ' day' : ' days')
  return head + ', full month'
}

type PaymentRow = {
  id: number
  amount: number | string
  payment_date: string
  created_at: string | null
  agent: string | null
  payment_type: string | null
  payment_method?: string | null
  notes: string | null
  months_paid: number | null
  carried_balance_before?: number | string | null
  carried_balance_after?: number | string | null
  credit_applied?: number | string | null
  amount_due?: number | string | null
  first_period_discount?: number | string | null
  payment_kind?: string | null
  paid_on?: string | null
  service_charge?: number | string | null
  service_active_until?: string | null
  payment_categories?: { name: string } | null
  visit_id?: string | null
  charge_id?: number | null
  charge_outstanding_before?: number | string | null
  /** Migration 0028: the per-month lines the till showed a returning customer. */
  service_breakdown?: { month: string; label: string; days: number | null; amount: number; kind: string }[] | null
  customers: {
    id: number
    first_name: string | null
    last_name: string | null
    /** Migration 0020; absent from the select until it is applied. */
    account_number?: string | null
  } | null
}

/**
 * Builds the receipt for a payment that has already been written.
 *
 * There is deliberately only one way to produce a receipt, and it reads the
 * stored row. The modal shown straight after a payment does not build its
 * receipt from what the form had in hand — it re-reads the row it just wrote,
 * exactly as the reprint action does. That is what makes "a reprint is
 * identical to the original" true by construction rather than by careful
 * duplication.
 *
 * ONE VISIT, ONE RECEIPT (migration 0025). A till visit that paid service and
 * one-off charges wrote a row each, all carrying the same visit_id. Asked for
 * any of them, this reads all of them and prints one piece of paper, numbered
 * by the lowest id — so the receipt after the payment, a reprint from the
 * payment list and the one attached to the customer's message are the same.
 *
 * Nothing here recalculates a charge. Every figure printed was stamped on the
 * payments rows when the payment was taken; the customer's current rate,
 * current balance, current expiry and what their charges owe today are not
 * consulted, because all of them may have moved since and none of them belong
 * on a receipt for a past payment.
 */
export async function getReceipt(companyId: number, id: number): Promise<Receipt | null> {
  // [perf] TEMPORARY instrumentation
  const tCaps = Date.now()
  const caps = await getSchemaCapabilities()
  console.log('[perf]   getReceipt: getSchemaCapabilities   %dms', Date.now() - tCaps)
  const db = tenantClient()

  // Columns from migrations that may not be applied are only requested once the
  // probe confirms them, matching how the rest of the data layer reads.
  const cols =
    'id, amount, payment_date, created_at, agent, payment_type, notes, months_paid' +
    (caps.checkoff ? ', payment_method' : '') +
    (caps.billing ? ', carried_balance_before, carried_balance_after' : '') +
    (caps.creditReversal ? ', credit_applied' : '') +
    (caps.firstPeriod ? ', amount_due, first_period_discount' : '') +
    (caps.otherPayments
      ? ', payment_kind, paid_on, service_charge, service_active_until, ' +
        'payment_categories(name)'
      : '') +
    (caps.charges ? ', visit_id, charge_id, charge_outstanding_before' : '') +
    ((await prepaidCalendarFor(companyId)).available ? ', service_breakdown' : '') +
    ', customers(id, first_name, last_name' +
    (caps.accountNumbers ? ', account_number' : '') + ')'

  const tPay = Date.now()
  const { data, error } = await db
    .from('payments')
    .select(cols)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  console.log('[perf]   getReceipt: payments row select    %dms', Date.now() - tPay)

  if (error) throw new Error('Failed to load receipt: ' + error.message)
  if (!data) return null

  const asked = data as unknown as PaymentRow

  // The rest of the visit, when there is one. Ordered by id so the paper lists
  // things in the order they were written, and so the first row is the one
  // that numbers and dates the receipt.
  let rows: PaymentRow[] = [asked]
  if (asked.visit_id) {
    const { data: visit, error: visitError } = await db
      .from('payments')
      .select(cols)
      .eq('company_id', companyId)
      .eq('visit_id', asked.visit_id)
      .order('id', { ascending: true })
    if (visitError) throw new Error('Failed to load receipt: ' + visitError.message)
    if (visit && visit.length > 0) rows = visit as unknown as PaymentRow[]
  }

  const first = rows[0]

  // Company identity and timezone for the header. Read live and not stamped on
  // the payment: a company that corrects its own phone number or address wants
  // the corrected one on reprints, which is why the brief sources these from
  // settings rather than from the payment.
  const tMeta = Date.now()
  const [companyRes, settingsRes] = await Promise.all([
    db.from('companies').select('name, phone, address').eq('id', companyId).maybeSingle(),
    db.from('settings').select('timezone').eq('company_id', companyId).maybeSingle(),
  ])
  console.log('[perf]   getReceipt: companies+settings     %dms', Date.now() - tMeta)

  const company = companyRes.data as {
    name: string
    phone: string | null
    address: string | null
  } | null
  const timeZone =
    (settingsRes.data as { timezone: string | null } | null)?.timezone ?? 'America/Jamaica'

  // paid_on is the business date, and it is a DATE column — a calendar date,
  // carried as the string it is stored as. It is NOT turned into a Date: doing
  // that invented a midnight in the server's zone which the receipt formatter
  // then re-projected into the company's, printing the day before.
  //
  // A pre-0013 row has no paid_on, so payment_date stands in. That one IS a
  // real instant (TIMESTAMPTZ), so reducing it to a date genuinely does need
  // the company timezone — the one conversion in this file that is correct.
  const paidOn = first.paid_on ?? instantToDateOnly(new Date(first.payment_date), timeZone)
  // The time of day comes from created_at, NOT from payment_date. The service
  // flow builds payment_date as the stated date at 12:00 local
  // (app/actions/payments.ts, `paymentDateRaw + 'T12:00:00'`), so its time half
  // is a placeholder and every service receipt reading it printed "12:00 PM".
  // created_at is the row's actual insert time, which is what the receipt means
  // by the time a payment was recorded. See receiptDateTime.
  const recordedAt = first.created_at ? new Date(first.created_at) : null

  // One method per visit: every row of it was written from the same field.
  const method = toPaymentMethod(first.payment_method ?? first.payment_type)

  const service = rows.find((r) => r.payment_kind !== 'other') ?? null
  const others = rows.filter((r) => r.payment_kind === 'other')

  const lines: ReceiptLine[] = []
  let totalDue: number | null = null
  let balance: number | null = null
  let creditCarried: number | null = null
  let accessUnchanged = false
  const owing: ReceiptLine[] = []

  if (service) {
    // ONE LINE, RESTATED, NEVER REASSEMBLED.
    //
    // This printed two lines and totalled them: "Balance b/f" from
    // carried_balance_before, plus "Monthly service" from the stamped
    // service_charge. Both are the same money. The bill run adds the monthly
    // charge INTO carried_balance (app/actions/bulk.ts#billBatch), so by the
    // time a payment is taken the charge is already inside the balance brought
    // forward, and "Total due" was that number added to itself — 5,000 owed
    // printed as 10,000 due, then settled to 0.00 by a payment of 5,000.
    //
    // The double count is a leftover from the retired prepaid model, where a
    // customer did pay the coming month ON TOP of what they owed. After the
    // collapse carried_balance is authoritative for everybody (lib/billing.ts
    // #amountDue), and there is nothing to add to it.
    //
    // service_charge is deliberately no longer read. It is still stamped, and
    // it is still the honest record of the rate that was in force, but it is
    // not a charge this payment settled on top of the balance and printing it
    // as one is what caused this.
    //
    // PREFERRING amount_due (migration 0017) IS NOT REDUNDANCY. For every
    // payment written before 0017 the two are identical and the fallback is
    // exact. They diverge for a FIRST payment, whose period carried_balance has
    // never held: provisioning grants access to the end of it without billing
    // it, so carried_balance_before reads 0 while the customer owes for days
    // they are already using. amount_due is the figure the till actually asked
    // for, discount included.
    const stampedDue =
      service.amount_due === null || service.amount_due === undefined
        ? service.carried_balance_before === null || service.carried_balance_before === undefined
          ? null
          : Number(service.carried_balance_before)
        : Number(service.amount_due)

    // Null only for a payment taken before the balance columns existed, where
    // there is no stamped figure and nothing honest to print. The receipt then
    // shows the amount paid alone rather than a total rebuilt from today.
    // A DISCOUNT HAS TO BE VISIBLE ON THE PAPER. It is discretionary and it is
    // given by a person, so a receipt reading only the net figure lets neither
    // the customer nor anyone going through the paper afterwards see that
    // anything was given. The log row names the agent, but nobody holding a
    // receipt is reading the log.
    //
    // amount_due is stamped NET, so the gross is the two stamped numbers added.
    // That is a sum over two recorded facts, not a figure rebuilt from a rate
    // or a live column, so a reprint years from now still prints what was
    // agreed at the counter.
    const discount = Number(service.first_period_discount ?? 0)

    // CALENDAR-MONTH PREPAID (0028): a returning customer was shown one line
    // per month with its days, and whole months paid ahead. Those lines, as
    // stamped, replace the single "Balance due" — and with more than one line
    // the receipt says what they came to.
    const breakdown =
      Array.isArray(service.service_breakdown) && service.service_breakdown.length > 0
        ? service.service_breakdown
        : null

    if (breakdown) {
      for (const l of breakdown) lines.push({ label: monthLineLabel(l), amount: Number(l.amount) })
      if (breakdown.length > 1) {
        totalDue = Math.round(breakdown.reduce((s, l) => s + Number(l.amount), 0) * 100) / 100
      }
    } else if (stampedDue !== null) {
      if (discount > 0) {
        lines.push({ label: 'Balance due', amount: stampedDue + discount })
        lines.push({ label: 'Short period disc.', amount: -discount })
        // "Total due" comes back HERE ONLY. It was dropped from the service
        // receipt because a total over a single line restates it — which stops
        // being true the moment there are two, and the customer needs to see
        // what the two came to.
        totalDue = stampedDue
      } else {
        lines.push({ label: 'Balance due', amount: stampedDue })
      }
    }

    balance = Number(service.carried_balance_after ?? 0)

    // What this payment carried forward, from the value IT stamped (0015) and
    // never from the credit the customer holds now — that has moved on with
    // every bill run since, and a reprint has to say what this payment did.
    // Stamped 0 for a payment that made none, and NULL on rows predating 0015;
    // both print nothing.
    creditCarried =
      service.credit_applied === null || service.credit_applied === undefined
        ? null
        : Number(service.credit_applied)

    // service_active_until is still selected and still stamped, but no longer
    // printed: the customer's copy carries no expiry as of 25 September 2026.
    // See lib/receipt.ts#Receipt.accessUnchanged.

    // A service payment that bought no months (lib/billing.ts#monthsCovered)
    // is stamped months_paid 0. The receipt relabels the credit line "Held as
    // credit" for it, so the paper says where the money went.
    accessUnchanged = Number(service.months_paid ?? 1) === 0
  }

  for (const r of others) {
    const label = r.payment_categories?.name ?? 'Other'
    const paidHere = Number(r.amount ?? 0)

    if (r.charge_id && r.charge_outstanding_before !== null && r.charge_outstanding_before !== undefined) {
      // A ONE-OFF CHARGE: what it owed when the visit began, and what it owes
      // now. Both from the stamp on this row, never from the charge as it
      // stands today — a later payment against it must not change this paper.
      const before = Number(r.charge_outstanding_before)
      lines.push({ label, amount: before })
      owing.push({ label: label + ' owing', amount: Math.max(0, before - paidHere) })
    } else {
      // An "other" payment taken without a charge on file. The line item is
      // the category name. No balance, no expiry, no brought forward figure —
      // it settles itself and nothing else.
      lines.push({ label, amount: paidHere })
    }
  }

  // THE TOTAL, when there is more than one thing to total. A lone "other"
  // payment with no charge keeps its established shape — category, then Total
  // due — and a lone service line keeps its own (see above).
  if (lines.length > 1) {
    totalDue = lines.reduce((s, l) => s + l.amount, 0)
  } else if (!service && others.length === 1 && !others[0].charge_id) {
    totalDue = Number(others[0].amount ?? 0)
  }

  const paid = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0)

  const allocations: ReceiptLine[] | null =
    rows.length > 1
      ? rows.map((r) => ({
          label: 'to ' + (r.payment_kind === 'other' ? r.payment_categories?.name ?? 'other' : 'service'),
          amount: Number(r.amount ?? 0),
        }))
      : null

  return {
    kind: service ? 'service' : 'other',
    companyName: company?.name ?? '',
    companyPhone: company?.phone ?? null,
    companyAddress: company?.address?.trim() || null,
    number: receiptNumber(first.id),
    dateLabel: receiptDateTime(paidOn, recordedAt, timeZone),
    cashier: first.agent ?? '',
    customerName:
      [first.customers?.first_name, first.customers?.last_name].filter(Boolean).join(' ') ||
      'Customer',
    // Migration 0020 gave customers a real account number, and this line has
    // been waiting for it — it used to read null with a note saying to populate
    // it the day such a column existed. Null stays the answer before 0020 and
    // for any row without one, and the receipt omits the line entirely rather
    // than printing an empty field.
    accountNumber: first.customers?.account_number ?? null,
    lines,
    totalDue,
    paidLabel: 'Paid (' + PAYMENT_METHOD_LABELS[method] + ')',
    paid,
    allocations,
    balance,
    owing,
    creditCarried,
    accessUnchanged,
  }
}
