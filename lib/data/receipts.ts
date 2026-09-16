import { PAYMENT_METHOD_LABELS, toPaymentMethod } from '@/lib/data/checkoff'
import { instantToDateOnly } from '@/lib/format'
import {
  receiptDate, receiptDateTime, receiptNumber, type Receipt,
} from '@/lib/receipt'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

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
 * Nothing here recalculates a charge. Every figure printed was stamped on the
 * payments row when the payment was taken; the customer's current rate, current
 * balance and current expiry are not consulted, because all three may have
 * moved since and none of them belong on a receipt for a past payment.
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

  const r = data as unknown as {
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
    customers: {
      id: number
      first_name: string | null
      last_name: string | null
      /** Migration 0020; absent from the select until it is applied. */
      account_number?: string | null
    } | null
  }

  // Company identity and timezone for the header. Read live and not stamped on
  // the payment: a company that corrects its own phone number wants the
  // corrected number on reprints, which is why the brief sources these from
  // settings rather than from the payment.
  const tMeta = Date.now()
  const [companyRes, settingsRes] = await Promise.all([
    db.from('companies').select('name, phone').eq('id', companyId).maybeSingle(),
    db.from('settings').select('timezone').eq('company_id', companyId).maybeSingle(),
  ])
  console.log('[perf]   getReceipt: companies+settings     %dms', Date.now() - tMeta)

  const company = companyRes.data as { name: string; phone: string | null } | null
  const timeZone =
    (settingsRes.data as { timezone: string | null } | null)?.timezone ?? 'America/Jamaica'

  const kind = r.payment_kind === 'other' ? 'other' : 'service'
  const paid = Number(r.amount ?? 0)

  // paid_on is the business date, and it is a DATE column — a calendar date,
  // carried as the string it is stored as. It is NOT turned into a Date: doing
  // that invented a midnight in the server's zone which the receipt formatter
  // then re-projected into the company's, printing the day before.
  //
  // A pre-0013 row has no paid_on, so payment_date stands in. That one IS a
  // real instant (TIMESTAMPTZ), so reducing it to a date genuinely does need
  // the company timezone — the one conversion in this file that is correct.
  const paidOn = r.paid_on ?? instantToDateOnly(new Date(r.payment_date), timeZone)
  // The time of day comes from created_at, NOT from payment_date. The service
  // flow builds payment_date as the stated date at 12:00 local
  // (app/actions/payments.ts, `paymentDateRaw + 'T12:00:00'`), so its time half
  // is a placeholder and every service receipt reading it printed "12:00 PM".
  // created_at is the row's actual insert time, which is what the receipt means
  // by the time a payment was recorded. See receiptDateTime.
  const recordedAt = r.created_at ? new Date(r.created_at) : null

  const method = toPaymentMethod(r.payment_method ?? r.payment_type)

  const lines: { label: string; amount: number }[] = []
  let totalDue: number | null = null
  let balance: number | null = null
  let activeUntil: string | null = null
  let creditCarried: number | null = null
  let accessUnchanged = false

  if (kind === 'other') {
    // The line item is the category name. No balance, no expiry, no brought
    // forward figure — an "other" payment settles itself and nothing else.
    lines.push({ label: r.payment_categories?.name ?? 'Other', amount: paid })
    totalDue = paid
  } else {
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
      r.amount_due === null || r.amount_due === undefined
        ? r.carried_balance_before === null || r.carried_balance_before === undefined
          ? null
          : Number(r.carried_balance_before)
        : Number(r.amount_due)

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
    const discount = Number(r.first_period_discount ?? 0)

    if (stampedDue !== null) {
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

    balance = Number(r.carried_balance_after ?? 0)

    // What this payment carried forward, from the value IT stamped (0015) and
    // never from the credit the customer holds now — that has moved on with
    // every bill run since, and a reprint has to say what this payment did.
    // Stamped 0 for a payment that made none, and NULL on rows predating 0015;
    // both print nothing.
    creditCarried =
      r.credit_applied === null || r.credit_applied === undefined
        ? null
        : Number(r.credit_applied)

    // Also a DATE column, and the one the off-by-one was reported against.
    if (r.service_active_until) activeUntil = receiptDate(r.service_active_until)

    // A service payment that bought no months (lib/billing.ts#monthsCovered)
    // is stamped months_paid 0, and the expiry it left the customer with is
    // the one they already held. The receipt has to say that in so many words:
    // "Service active until" alone reads as a grant.
    accessUnchanged = Number(r.months_paid ?? 1) === 0
  }

  return {
    kind,
    companyName: company?.name ?? '',
    companyPhone: company?.phone ?? null,
    number: receiptNumber(r.id),
    dateLabel: receiptDateTime(paidOn, recordedAt, timeZone),
    cashier: r.agent ?? '',
    customerName:
      [r.customers?.first_name, r.customers?.last_name].filter(Boolean).join(' ') || 'Customer',
    // Migration 0020 gave customers a real account number, and this line has
    // been waiting for it — it used to read null with a note saying to populate
    // it the day such a column existed. Null stays the answer before 0020 and
    // for any row without one, and the receipt omits the line entirely rather
    // than printing an empty field.
    accountNumber: r.customers?.account_number ?? null,
    lines,
    totalDue,
    paidLabel: 'Paid (' + PAYMENT_METHOD_LABELS[method] + ')',
    paid,
    balance,
    creditCarried,
    activeUntil,
    accessUnchanged,
  }
}
