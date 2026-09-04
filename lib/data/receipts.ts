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
    'id, amount, payment_date, created_at, agent, payment_type, notes' +
    (caps.checkoff ? ', payment_method' : '') +
    (caps.billing ? ', carried_balance_before, carried_balance_after' : '') +
    (caps.otherPayments
      ? ', payment_kind, paid_on, service_charge, service_active_until, ' +
        'payment_categories(name)'
      : '') +
    ', customers(id, first_name, last_name)'

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
    carried_balance_before?: number | string | null
    carried_balance_after?: number | string | null
    payment_kind?: string | null
    paid_on?: string | null
    service_charge?: number | string | null
    service_active_until?: string | null
    payment_categories?: { name: string } | null
    customers: { id: number; first_name: string | null; last_name: string | null } | null
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

  if (kind === 'other') {
    // The line item is the category name. No balance, no expiry, no brought
    // forward figure — an "other" payment settles itself and nothing else.
    lines.push({ label: r.payment_categories?.name ?? 'Other', amount: paid })
    totalDue = paid
  } else {
    const charge = r.service_charge === null || r.service_charge === undefined
      ? null
      : Number(r.service_charge)
    const before = Number(r.carried_balance_before ?? 0)

    if (charge !== null) {
      // Balance b/f is printed ABOVE the month's own charge: the column reads
      // what was owed coming in, then what this month added, then the total.
      // Only when something was actually carried in.
      if (before > 0) lines.push({ label: 'Balance b/f', amount: before })
      lines.push({ label: 'Monthly service', amount: charge })
      totalDue = charge + before
    }
    // With no stored charge (a payment taken before 0013) there is no honest
    // breakdown to print, so the receipt shows the amount paid alone rather
    // than a total reconstructed from today's rate. See migration 0013.

    balance = Number(r.carried_balance_after ?? 0)

    // Also a DATE column, and the one the off-by-one was reported against.
    if (r.service_active_until) activeUntil = receiptDate(r.service_active_until)
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
    // `customers` has no account number column — there is nowhere for one to
    // come from, so the line is omitted, which is the behaviour the brief
    // specifies for a customer without one. Populate this the day such a column
    // exists and the line appears with no other change.
    accountNumber: null,
    lines,
    totalDue,
    paidLabel: 'Paid (' + PAYMENT_METHOD_LABELS[method] + ')',
    paid,
    balance,
    activeUntil,
  }
}
