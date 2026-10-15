'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import {
  outstandingBalance, parseYmd, prepaymentCredit, reverseCredit, ymd, type PriorGrant,
} from '@/lib/billing'
import { legacyPaymentType, toPaymentMethod } from '@/lib/data/checkoff'
import { instantToDateOnly, paymentInstant } from '@/lib/format'
import {
  billedThroughOf, PREPAID_CALENDAR_OFF, prepaidCalendarFor, readMonthCharges,
} from '@/lib/data/prepaid-calendar'
import { type MonthCharge } from '@/lib/prepaid-calendar'
import { firstPeriodAnchor } from '@/lib/data/first-period'
import {
  applyExpiryUndo, expiryActionText, planExpiryUndo, planMonthsTakeBack, type ExpiryUndo,
} from '@/lib/data/payment-expiry'
import { getChargesById, listOpenCharges, type OpenCharge } from '@/lib/data/charges'
import { findOrCreatePaymentCategory } from '@/lib/data/payment-categories'
import { getReversalSubject } from '@/lib/data/payments'
import { grantAnchor, latestGrant } from '@/lib/data/period-grants'
import { can } from '@/lib/permissions'
import { getRadiusStatus as readNetworkRecord, radiusConfigured } from '@/lib/radius-db'
import { getSchemaCapabilities, type SchemaCapabilities } from '@/lib/schema'
import { logEvent } from '@/lib/audit'
import { notifyPaymentReceipt } from '@/lib/sms/notify'
import { displayName, getSession, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import {
  chargePaymentRows, money, oneOffSummary, recordServicePayment, round2, visitInsertError,
  type Allocation, type CheckedAllocation, type PaymentResult,
} from '@/lib/payments/service-payment'

// PaymentResult now lives with the payment core it describes, so the one path
// that records a service payment and the form components that render its result
// read the same shape. Re-exported here because the form components import it
// from this module.
export type { PaymentResult }

const str = (fd: FormData, key: string) => {
  const v = fd.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

const num = (fd: FormData, key: string) => {
  const v = str(fd, key)
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Sentinel the Purpose dropdown submits for its "+ Add new category" row. */
const NEW_CATEGORY = '__new__'

// ---------------------------------------------------------------------------
// One-off charges at the till (migration 0025)
//
// A visit can pay service, one-off charges, or both. Every row it writes
// carries one visit_id, so the receipt reads them as one piece of paper
// (lib/data/receipts.ts). The charge rows are ordinary "other" payments with
// charge_id set: they go through NONE of the service code — no balance, no
// credit, no expiry, no RADIUS — exactly like recordOtherPayment.
//
// ALL ROWS OF A VISIT ARE ONE INSERT STATEMENT, so Postgres writes all of them
// or none. The guard trigger checks each charge row as it goes in; if one would
// overpay its charge the whole visit is refused and nothing is recorded — no
// service payment on its own, no half a visit.
// ---------------------------------------------------------------------------

/** Form fields the till posts per charge: charge_amount_<id>. */
const CHARGE_FIELD = 'charge_amount_'

/** The non-zero charge amounts a submission carries. */
function readAllocations(formData: FormData): Allocation[] {
  const out: Allocation[] = []
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith(CHARGE_FIELD) || typeof value !== 'string') continue
    const chargeId = Number(key.slice(CHARGE_FIELD.length))
    const raw = value.trim()
    if (!Number.isInteger(chargeId) || !raw) continue
    out.push({ chargeId, amount: Number(raw) })
  }
  return out
}

/**
 * Checks a submission's charge amounts against the charges as they stand.
 *
 * A courtesy, not the guard: it turns the common mistakes into field errors
 * the cashier can fix. The trigger is what actually refuses an overpayment,
 * including one made possible by another cashier between this read and the
 * insert.
 */
async function checkAllocations(
  companyId: number,
  customerId: number,
  allocations: Allocation[]
): Promise<{ rows: CheckedAllocation[]; fieldErrors: Record<string, string> }> {
  const fieldErrors: Record<string, string> = {}
  const rows: CheckedAllocation[] = []

  const nonZero = allocations.filter((a) => a.amount !== 0)
  for (const a of allocations) {
    if (!Number.isFinite(a.amount) || a.amount < 0) {
      fieldErrors[CHARGE_FIELD + a.chargeId] = 'Enter an amount of zero or more.'
    }
  }
  if (nonZero.length === 0) return { rows, fieldErrors }

  const charges = await getChargesById(companyId, nonZero.map((a) => a.chargeId))
  for (const a of nonZero) {
    if (!Number.isFinite(a.amount) || a.amount < 0) continue
    // Company-scoped by getChargesById. The ids are posted by the browser, so
    // the customer is matched here too (and again by the trigger).
    const c = charges.find((x) => x.id === a.chargeId && x.customerId === customerId)
    const key = CHARGE_FIELD + a.chargeId
    if (!c || c.status === 'voided') {
      fieldErrors[key] = 'This charge is no longer open.'
    } else if (round2(a.amount) > c.outstanding) {
      fieldErrors[key] = 'Only ' + money(c.outstanding) + ' is owed on this charge.'
    } else {
      rows.push({
        chargeId: c.id,
        amount: round2(a.amount),
        categoryId: c.categoryId,
        category: c.category,
        outstandingBefore: c.outstanding,
      })
    }
  }

  return { rows, fieldErrors }
}

/**
 * A visit that pays one-off charges and no service.
 *
 * Nothing on the customer record is read for billing or written at all, and
 * nothing reaches the network: the same promise recordOtherPayment makes.
 */
async function recordChargeVisit(opts: {
  formData: FormData
  session: Session
  caps: SchemaCapabilities
  customerId: number
  checked: CheckedAllocation[]
  paymentDate: Date
}): Promise<PaymentResult> {
  const { formData, session, caps, customerId, checked, paymentDate } = opts
  const { company, profile } = session
  const db = tenantClient()

  const { data: customerRow } = await db
    .from('customers')
    .select('id, first_name, last_name' + (caps.catalog ? ', misc_category_id' : ''))
    .eq('company_id', company.id)
    .eq('id', customerId)
    .maybeSingle()
  const customer = customerRow as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
    misc_category_id?: number | null
  } | null
  if (!customer) return { ok: false, error: 'That customer no longer exists.' }

  const { data: tzRow } = await db
    .from('settings').select('timezone').eq('company_id', company.id).maybeSingle()
  const timeZone = (tzRow as { timezone: string | null } | null)?.timezone ?? 'America/Jamaica'
  const stampedAt = paymentInstant(ymd(paymentDate), new Date(), timeZone) ?? paymentDate

  const method = toPaymentMethod(str(formData, 'payment_method') || 'cash')
  const rows = chargePaymentRows({
    companyId: company.id,
    customerId: customer.id,
    checked,
    visitId: crypto.randomUUID(),
    paidOn: ymd(paymentDate),
    stampedAt,
    method,
    agent: str(formData, 'agent') || displayName(profile),
    notes: str(formData, 'notes'),
    userId: profile.id,
    segmentId: customer.misc_category_id ?? null,
    caps,
  })

  const { data: inserted, error } = await db.from('payments').insert(rows).select('id')
  if (error) return { ok: false, error: visitInsertError(error.message) }

  const ids = ((inserted ?? []) as unknown as { id: number }[]).map((r) => r.id)
  const firstId = Math.min(...ids)
  const total = round2(checked.reduce((s, a) => s + a.amount, 0))

  await notifyPaymentReceipt({
    companyId: company.id,
    companyName: company.name,
    customerId: customer.id,
    paymentId: firstId,
    amount: total,
  })

  revalidatePath('/dashboard/customers/' + customer.id)
  revalidatePath('/dashboard/payments')
  revalidatePath('/dashboard/payments/new')
  revalidatePath('/dashboard')

  return {
    ok: true as const,
    amount: total,
    servicePaid: 0,
    customerId: customer.id,
    customerName:
      [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer',
    newExpiryIso: null,
    networkExtended: false,
    warning: null,
    carriedBalance: 0,
    paymentId: firstId,
    oneOff: oneOffSummary(checked),
  }
}

/**
 * Records an "other" payment: a one-off charge that is not for service.
 *
 * Installation, a router sale, a reconnection fee. The money is collected and
 * attributed exactly as a service payment is, and it is checked off with the
 * rest of the cashier's float — but it settles nothing on the customer's
 * account, so this path deliberately does NONE of the following:
 *
 *   - no extendInRadius / applyRadiusWrite, and no radcheck write of any kind
 *   - no expiry change, and no access_granted_until
 *   - no carried_balance, account_credit or any other billing column
 *   - no update to the customers row at all
 *   - no network_* event row
 *
 * It is a separate function rather than a branch threaded through the service
 * flow for exactly that reason: there is no path from here into the billing
 * code, so no later edit here can reach it by accident.
 *
 * NO activity-log row is written either. The payments row IS the record of
 * money received — amount, purpose, agent, method, date, all of it — so a
 * 'payment_recorded' line beside it only restated what the payment already
 * said, and buried the rows that carry facts nothing else holds. What stays in
 * the log is the network half (radius_extend, radius_extend_failed) and the
 * reversals, neither of which can be read back off a row that is gone.
 */
async function recordOtherPayment(
  formData: FormData,
  session: Session,
  caps: SchemaCapabilities
): Promise<PaymentResult> {
  const { company, profile } = session
  const db = tenantClient()
  const fieldErrors: Record<string, string> = {}

  const customerId = num(formData, 'customer_id')
  const amount = num(formData, 'amount')
  const paymentMethodRaw = str(formData, 'payment_method')
  const notes = str(formData, 'notes')
  const agent = str(formData, 'agent') || displayName(profile)

  const categoryRaw = str(formData, 'payment_category_id')
  const newCategoryName = str(formData, 'new_payment_category')

  if (customerId === null) return { ok: false, error: 'Select a customer first.' }
  if (amount === null || amount <= 0) fieldErrors.amount = 'Enter an amount greater than zero.'
  // Same rule as the service flow: "Other" as a method says nothing on its own.
  if (paymentMethodRaw === 'other' && !notes) {
    fieldErrors.notes = 'Describe the payment method.'
  }

  // --- Date ----------------------------------------------------------------
  // Defaults to today and may not be in the future. No lower limit: a payment
  // may legitimately be entered days after it was taken.
  const paidOnRaw = str(formData, 'paid_on')
  const paidOn = paidOnRaw ? parseYmd(paidOnRaw) : new Date()
  if (!paidOn) {
    fieldErrors.paid_on = 'Enter a valid date.'
  } else if (ymd(paidOn) > ymd(new Date())) {
    fieldErrors.paid_on = 'The date cannot be in the future.'
  }

  // --- Purpose -------------------------------------------------------------
  // Every role that may record a payment may also add a category, so this is
  // gated by recordPayment's record_payment check and nothing further.
  let categoryId: number | null = null

  if (categoryRaw === NEW_CATEGORY) {
    if (!newCategoryName) {
      fieldErrors.new_payment_category = 'Enter a name for the new category.'
    } else {
      const created = await findOrCreatePaymentCategory(company.id, newCategoryName)
      if (created.ok) categoryId = created.category.id
      else fieldErrors.new_payment_category = created.error
    }
  } else if (categoryRaw) {
    const parsed = Number(categoryRaw)
    if (Number.isInteger(parsed)) categoryId = parsed
  }

  if (categoryId === null && !fieldErrors.new_payment_category) {
    fieldErrors.payment_category_id = 'Choose what this payment is for.'
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  // Validated above, so it is a number from here down.
  const paidAmount = amount as number

  // The customer is loaded for their name only. Nothing on the row is read for
  // billing, and nothing on it is written back.
  const { data: customerRow, error: loadError } = await db
    .from('customers')
    // misc_category_id only once the catalogue exists (0005). An "other"
    // payment is somebody's income too, so it carries the same segment stamp
    // as a service payment — see the note on the insert below.
    .select('id, first_name, last_name' + (caps.catalog ? ', misc_category_id' : ''))
    .eq('company_id', company.id)
    .eq('id', customerId)
    .maybeSingle()

  if (loadError) return { ok: false, error: 'Could not load customer: ' + loadError.message }

  const customer = customerRow as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
    misc_category_id?: number | null
  } | null

  if (!customer) return { ok: false, error: 'That customer no longer exists.' }

  const fullName =
    [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer'
  const method = toPaymentMethod(paymentMethodRaw || 'cash')
  const paidDate = paidOn as Date

  // payment_date carries the stated date with the current time of day, so the
  // collections list still orders by when the money came in while the receipt
  // prints the date the cashier stated. paid_on is the date itself.
  const now = new Date()
  const stamped = new Date(paidDate)
  stamped.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0)

  const insertRow: Record<string, unknown> = {
    company_id: company.id,
    customer_id: customer.id,
    amount: paidAmount,
    // Zero, not the column default of 1: this payment buys no months of
    // service, and a 1 would read as a month paid everywhere months_paid shows.
    months_paid: 0,
    payment_kind: 'other',
    payment_category_id: categoryId,
    paid_on: ymd(paidDate),
    payment_date: stamped.toISOString(),
    // The legacy METHOD column, written exactly as the service path writes it.
    // Unrelated to payment_kind — see migration 0013.
    payment_type: legacyPaymentType(method),
    agent,
    notes: notes || null,
  }

  // An "other" payment is still cash in the drawer, so it is checked off with
  // everything else the cashier collected. Checkoff is collection accounting,
  // not billing.
  if (caps.checkoff) {
    insertRow.payment_method = method
    insertRow.checked_off = false
    insertRow.user_id = profile.id
  }

  // WHOSE INCOME THIS IS, AS IT WAS TODAY (migration 0018).
  //
  // Stamped rather than joined, because the join answers with the segment the
  // customer is in NOW. Two owners splitting one customer base by misc category
  // read that breakdown as "what I collected in August"; moving one customer
  // between segments would rewrite August for both of them, with nothing
  // recording that it happened — app/actions/customers.ts#updateCustomer writes
  // no log row at all.
  //
  // Null when the customer has no segment. That money is not dropped: it lands
  // in the breakdown’s permanent "Uncategorised" row.
  if (caps.paymentSegment) {
    insertRow.customer_misc_category_id = customer.misc_category_id ?? null
  }
  const { data: inserted, error: insertError } = await db
    .from('payments')
    .insert(insertRow)
    .select('id')
    .single()

  if (insertError) return { ok: false, error: 'Could not record payment: ' + insertError.message }

  // The receipt text. Queued, not sent — the dispatcher owns delivery — and it
  // cannot fail this action: the money is taken and the row is written, so a
  // text that could not be queued must not turn a completed payment into an
  // error in front of a cashier.
  await notifyPaymentReceipt({
    companyId: company.id,
    companyName: company.name,
    customerId: customer.id,
    paymentId: (inserted as unknown as { id: number }).id,
    amount: paidAmount,
  })

  revalidatePath('/dashboard/customers/' + customer.id)
  revalidatePath('/dashboard/payments')
  revalidatePath('/dashboard/payments/new')
  revalidatePath('/dashboard')

  return {
    ok: true as const,
    amount: paidAmount,
    customerId: customer.id,
    customerName: fullName,
    // Never set: this payment moved no expiry and extended no access.
    newExpiryIso: null,
    networkExtended: false,
    warning: null,
    carriedBalance: 0,
    paymentId: (inserted as unknown as { id: number }).id,
  }
}

/**
 * Records a payment, settles what it leaves owing, and moves network access.
 *
 * Every role can record a payment (see lib/permissions.ts), so this is gated on
 * `record_payment` rather than any customer-management right.
 *
 * The two billing types share this one path and differ in three places only:
 * which date access runs to, whether a billing period is stamped on the row,
 * and which customer columns are written. How a short payment is settled is
 * identical for both.
 *
 * Nothing the form computed is trusted. The amount due, the shortfall and the
 * proportional date are all recalculated here from the customer's own record —
 * the form supplies only the cashier's two decisions: how much was handed over,
 * and which date they chose if they chose one.
 */
export async function recordPayment(
  _prev: PaymentResult | null,
  formData: FormData
): Promise<PaymentResult> {
  const session = await getSession()
  const { company, profile } = session

  if (!can(profile.role, 'record_payment')) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot record payments.')
  }

  const caps = await getSchemaCapabilities()

  // An "other" payment is handled by its own function and returns from here, so
  // none of the billing, expiry or RADIUS code below is reachable for one.
  // Guarded on the capability as well as the field: before 0013 is applied the
  // columns do not exist, the form never offers the toggle, and anything that
  // posted 'other' anyway is recorded as an ordinary service payment rather
  // than failing on an unknown column.
  if (caps.otherPayments && str(formData, 'payment_kind') === 'other') {
    return recordOtherPayment(formData, session, caps)
  }

  const fieldErrors: Record<string, string> = {}

  const customerId = num(formData, 'customer_id')
  const amount = num(formData, 'amount')
  // NOTE: months_paid is deliberately NOT read from the form. How many months a
  // payment bought is derived from the money received further down
  // (lib/billing.ts#monthsCovered), so a dropdown left on '3 months' while one
  // month of cash is handed over cannot buy three months of access.
  const paymentType = str(formData, 'payment_type') || 'cash'
  const paymentMethodRaw = str(formData, 'payment_method')
  // The Date field posts as paid_on. payment_date is still accepted so the
  // older callers that supply it keep working unchanged.
  const paymentDateRaw = str(formData, 'paid_on') || str(formData, 'payment_date')
  // The agent is not submitted: a payment is attributed to whoever is signed
  // in and cannot be restated at the till. It is still read from the form
  // because recordPayment is also reachable with it supplied.
  const agent = str(formData, 'agent') || displayName(profile)
  const notes = str(formData, 'notes')

  // Present only when the form decided the payment was short. Both are
  // re-validated against the recomputed amount due below — a decision that
  // arrives for a payment which turns out to cover the bill is discarded.
  const accessDecisionRaw = str(formData, 'access_decision')
  const accessDateRaw = str(formData, 'access_date')

  if (customerId === null) return { ok: false, error: 'Select a customer first.' }
  // "Other" carries no information on its own, so the note becomes the record
  // of what actually happened.
  if (paymentMethodRaw === 'other' && !notes) {
    fieldErrors.notes = 'Describe the payment method.'
  }

  // ONE-OFF CHARGES PAID IN THE SAME VISIT (migration 0025). Checked up front
  // so every mistake on the form comes back at once, before anything is
  // written. The service amount may then be zero: a visit can pay for an
  // installation and nothing else.
  const charges = caps.charges
    ? await checkAllocations(company.id, customerId, readAllocations(formData))
    : { rows: [], fieldErrors: {} }
  Object.assign(fieldErrors, charges.fieldErrors)
  const chargeTotal = round2(charges.rows.reduce((s, a) => s + a.amount, 0))
  const serviceTaken = amount !== null && amount > 0

  if (amount !== null && amount < 0) {
    fieldErrors.amount = 'Enter an amount of zero or more.'
  } else if (!serviceTaken && chargeTotal === 0 && Object.keys(charges.fieldErrors).length === 0) {
    fieldErrors.amount = 'Enter an amount greater than zero.'
  }

  const chosenDate = parseYmd(accessDateRaw)
  if (accessDecisionRaw === 'date_selected' && !chosenDate) {
    fieldErrors.access_date = 'Choose a valid date for access.'
  }

  // THE BUSINESS DATE, NOT THE STORED INSTANT. This Date is midday on the
  // stated date in the server's zone, and it is used for exactly two things:
  // the calendar date (paid_on, the bill period, the expiry walk's `from`) and
  // the future check below. It is NOT what payment_date is written from — see
  // `stampedAt` further down, once the company's timezone is known. Until
  // 25 September 2026 it was, and the comment here claimed the time was kept;
  // it was not. The form always posts the date, so this was noon UTC on every
  // service payment, which is 7:00 AM in Jamaica.
  const paymentDate = paymentDateRaw ? new Date(paymentDateRaw + 'T12:00:00') : new Date()
  if (!Number.isFinite(paymentDate.getTime())) {
    fieldErrors.paid_on = 'Enter a valid date.'
  } else if (ymd(paymentDate) > ymd(new Date())) {
    // No lower limit — a payment may be entered days after it was taken — but
    // it cannot be dated forward.
    fieldErrors.paid_on = 'The date cannot be in the future.'
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  // No service money: the visit pays charges only, and none of the service
  // path below — balance, credit, expiry, network — is reachable.
  if (!serviceTaken) {
    return recordChargeVisit({
      formData, session, caps, customerId, checked: charges.rows, paymentDate,
    })
  }

  // The service path — settling the balance, moving access, writing the receipt
  // row and logging the extension — is the one core the Fygaro webhook also
  // calls (lib/payments/service-payment.ts). The till supplies the signed-in
  // cashier as the actor; what the money buys is recomputed in there from the
  // customer's own record, not from anything the form sent.
  const method = toPaymentMethod(paymentMethodRaw || paymentType)

  return recordServicePayment({
    company,
    caps,
    actor: { agent, userId: profile.id, email: profile.email },
    customerId,
    paidAmount: amount as number,
    paymentDate,
    method,
    notes,
    accessDecisionRaw,
    chosenDate,
    checked: charges.rows,
    chargeFee: str(formData, 'reconnection_fee') === '1',
    // The till files its audit rows under the signed-in cashier, as it always
    // has; checkedOff defaults to false so the payment joins the float.
    log: logEvent,
  })
}

/**
 * What the till needs to know about ONE customer before pricing a payment,
 * beyond what the search hit carries: the most recent payment that moved their
 * expiry, for the one-month-per-period guard; their open one-off charges; the
 * reconnection fee; and, under calendar-month prepaid, their month charges.
 *
 * There is no first period any more (owner, 11 Oct 2026).
 *
 * WHY A SERVER ACTION AND NOT A FIELD ON THE SEARCH HIT. Answering this needs
 * two history queries and a radcheck read per customer. On a search that is a
 * per-row cost paid for every name the cashier types past; here it is paid
 * once, when they actually pick somebody.
 *
 * NOTHING HERE IS TRUSTED ON SUBMIT. recordPayment recomputes all of it from
 * the same functions against the same rows — this only decides what the cashier
 * is SHOWN, in the same way the form already previews the expiry and the
 * proportional date.
 */
export type PaymentContext = {
  /**
   * The prior grant, with the registry expiry it anchored on ("YYYY-MM-DD",
   * null when unknown or when it did not pick a date), so the form can say
   * where a completion would run to with lib/billing.ts#periodCompletion.
   */
  grant: (PriorGrant & { anchorThen: string | null }) | null
  /**
   * One-off charges the customer can still pay against (migration 0025),
   * oldest first. Empty for almost everybody, and before 0025 is applied.
   */
  charges: OpenCharge[]
  /**
   * The reconnection fee the till offers this customer, or 0: the company's
   * fee when their service has ended — prepaid or postpaid (owner, 8 Oct 2026)
   * — and 0 otherwise. The same test recordPayment makes.
   */
  reconnectionFee: number
  /**
   * The engine bills this company by calendar month (prepaid or postpaid):
   * the till names the month a payment settles that way, as recordPayment does.
   */
  calendarMonths: boolean
  /**
   * Calendar-month prepaid (migration 0028), when the model applies to the
   * company; null otherwise. `returning` says the customer's service has
   * ended, so the till recomputes this month.
   */
  calendar: {
    returning: boolean
    /**
     * A new customer's first payment since provisioning: priced and landed like
     * a return, never short of the expiry provisioning gave (recordPayment).
     */
    firstPayment: boolean
    /** The customer's recent month charges, for the breakdown. */
    monthCharges: MonthCharge[]
    /** customers.billed_through (migration 0030), for the breakdown; null for nearly everybody. */
    billedThrough: string | null
  } | null
}

export async function loadPaymentContext(customerId: number): Promise<PaymentContext> {
  const none: PaymentContext = { grant: null, charges: [], reconnectionFee: 0, calendarMonths: false, calendar: null }

  const { company, profile } = await getSession()
  if (!can(profile.role, 'record_payment')) return none

  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const cols =
    'id, monthly_rate, mac_address' +
    (caps.connectionTypes ? ', customer_type, pppoe_username' : '')

  const { data } = await db
    .from('customers')
    .select(cols)
    .eq('company_id', company.id)
    .eq('id', customerId)
    .maybeSingle()

  const customer = data as unknown as {
    id: number
    monthly_rate: number | string | null
    mac_address: string | null
    customer_type?: string | null
    pppoe_username?: string | null
  } | null

  if (!customer) return none

  const identity =
    customer.customer_type === 'pppoe' ? customer.pppoe_username : customer.mac_address

  const registered =
    identity && radiusConfigured()
      ? await readNetworkRecord(identity).catch(() => null)
      : null

  // The same tests recordPayment makes before it prices: a returning customer's
  // month is recomputed under the model, and a first payment since
  // provisioning lands its expiry by the model.
  const prepaid = caps.billing ? await prepaidCalendarFor(company.id) : PREPAID_CALENDAR_OFF
  const firstAnchor = prepaid.enabled ? await firstPeriodAnchor(company.id, customer.id) : null
  const model = prepaid.enabled
  const disconnectedNow = registered !== null && registered.exists && registered.status !== 'active'
  const returning = model && disconnectedNow
  const firstPayment = model && !returning && (registered?.expiry ?? null) !== null && firstAnchor !== null

  // A first payment has no prior grant by definition (no service payment since
  // provisioning), so the read is skipped rather than made and ignored.
  const prior = firstPayment || returning ? null : await latestGrant(company.id, customer.id)
  const anchor = prior ? await grantAnchor(company.id, customer.id, prior) : null
  const charges = await listOpenCharges(company.id, customer.id)

  return {
    grant: prior ? { ...prior, anchorThen: anchor ? ymd(anchor) : null } : null,
    charges,
    reconnectionFee:
      disconnectedNow && prepaid.reconnectionFee > 0 && caps.otherPayments && caps.charges
        ? prepaid.reconnectionFee
        : 0,
    calendarMonths: prepaid.calendarMonths,
    calendar: model
      ? {
          returning,
          firstPayment,
          monthCharges: returning ? await readMonthCharges(company.id, customer.id) : [],
          billedThrough: returning ? await billedThroughOf(company.id, customer.id) : null,
        }
      : null,
  }
}
/**
 * Loads a payment for mutation and confirms the caller may act on it.
 *
 * Scoping the read by company_id is what stops one tenant editing another's
 * records: the permission check alone would not, since a company_admin holds
 * these rights over their own company only.
 */
async function loadForMutation(
  paymentId: number | null,
  permission: 'edit_payment' | 'delete_payment'
) {
  const { company, profile } = await getSession()

  if (!can(profile.role, permission)) {
    throw new Error(
      'Forbidden: role "' + profile.role + '" cannot perform ' + permission + '.'
    )
  }
  if (paymentId === null) return { ok: false as const, error: 'Missing payment reference.' }

  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  // What the payment did to the customer's balance, so a correction can restate
  // it exactly rather than inferring the effect from the amount alone. See
  // restateBalances.
  const cols =
    'id, amount, customer_id, months_paid, payment_type, payment_date, agent, notes' +
    (caps.checkoff ? ', payment_method' : '') +
    (caps.billing ? ', carried_balance_before, carried_balance_after' : '') +
    (caps.creditReversal ? ', credit_applied' : '') +
    (caps.otherPayments ? ', payment_kind' : '')

  const { data, error } = await db
    .from('payments')
    .select(cols)
    .eq('company_id', company.id)
    .eq('id', paymentId)
    .maybeSingle()

  if (error) return { ok: false as const, error: 'Could not load payment: ' + error.message }

  const payment = data as unknown as {
    id: number
    amount: number | string
    customer_id: number | null
    months_paid: number | null
    payment_type: string | null
    payment_date: string
    agent: string | null
    notes: string | null
    payment_method?: string | null
    carried_balance_before?: number | string | null
    carried_balance_after?: number | string | null
    credit_applied?: number | string | null
    payment_kind?: string | null
  } | null

  if (!payment) return { ok: false as const, error: 'That payment no longer exists.' }

  // Who the payment belongs to, and how to find them in radcheck. Both are
  // needed for the reversal log line — the name so the row is readable once the
  // customer row is gone, the identity so the standing expiry can be read.
  const customer = payment.customer_id
    ? await getReversalSubject(company.id, payment.customer_id)
    : null

  return { ok: true as const, company, profile, db, payment, customer }
}

/**
 * The customer's standing radcheck expiry, for a reversal log line.
 *
 * READ AT THE MOMENT OF THE CHANGE and stamped on the row. An edit does not
 * touch radcheck, so it can leave the customer holding access the old amount
 * bought; a deletion puts the month back where it safely can
 * (lib/data/payment-expiry.ts) and says when it could not. Recording the
 * access as it stood makes either visible afterwards.
 *
 * Never throws and never blocks the reversal: an unreachable NAS returns a
 * marker, so the log says the expiry was unknown rather than silently omitting
 * the field and reading like there was none.
 */
async function standingExpiry(identity: string | null): Promise<string> {
  if (!identity) return 'none (not provisioned)'
  if (!radiusConfigured()) return 'unknown (network not configured)'

  const record = await readNetworkRecord(identity).catch(() => null)
  if (!record) return 'unknown (network unreachable)'

  return record.rawExpiry ?? 'none (no expiry on record)'
}

/**
 * Re-reads a customer's carried balance and writes an adjusted value.
 *
 * carried_balance is the amount owed, so recording a payment subtracted from it
 * and any correction has to put the difference back. It is re-read here rather
 * than carried from the page, so a payment taken between page load and save is
 * not silently overwritten.
 *
 * MOVED OFF `balance` WITH THE REST OF THE SPLIT. This used to adjust `balance`,
 * which no page reads and no bill run charges — so deleting a payment appeared
 * to return the money while leaving the real debt cleared.
 *
 * Not a perfect inverse, and was not before either: a payment that cleared the
 * bill saturated carried_balance at 0, so reversing it restores the payment
 * amount rather than the pre-payment figure. Correcting an amount downward on a
 * settled account is the case to watch.
 */
async function adjustCarriedBalance(
  db: ReturnType<typeof tenantClient>,
  companyId: number,
  customerId: number | null,
  delta: number
) {
  if (!customerId || delta === 0) return

  const { data } = await db
    .from('customers')
    .select('carried_balance')
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()

  if (!data) return

  const current = Number(
    (data as unknown as { carried_balance: number | string | null }).carried_balance ?? 0
  )
  // NOT clamped at zero since migration 0027: a balance may be negative (the
  // customer is owed money), and clamping would silently erase that amount.
  await db
    .from('customers')
    .update({ carried_balance: Math.round((current + delta) * 100) / 100 })
    .eq('company_id', companyId)
    .eq('id', customerId)
}

/**
 * What a payment did to a customer's two billing columns, read off its own row.
 *
 * All three are null for rows written before the migration that added them —
 * 0011 for the balance pair, 0015 for the credit — and null is NOT zero. A
 * correction that cannot see what the payment did must fall back to the amount
 * delta and say so, rather than assume it did nothing.
 */
type PaymentEffect = {
  carriedBefore: number | null
  carriedAfter: number | null
  creditApplied: number | null
}

function paymentEffect(payment: {
  carried_balance_before?: number | string | null
  carried_balance_after?: number | string | null
  credit_applied?: number | string | null
}): PaymentEffect {
  const n = (v: number | string | null | undefined) =>
    v === null || v === undefined ? null : Number(v)

  return {
    carriedBefore: n(payment.carried_balance_before),
    carriedAfter: n(payment.carried_balance_after),
    creditApplied: n(payment.credit_applied),
  }
}

/**
 * Applies a correction to BOTH billing columns in one read-modify-write.
 *
 * WHY THE AMOUNT DELTA WAS NOT ENOUGH. adjustCarriedBalance moves the balance by
 * the difference in amount, which is right only when the whole payment went
 * against the balance. A prepayment does not: part of it settled the bill and
 * the rest became credit. Correcting 10,500 down to 3,500 through the amount
 * delta put 7,000 back on a balance that had never carried it, AND left the
 * 7,000 of credit standing — wrong twice, in opposite directions.
 *
 * So a correction restates what the payment actually did. `carriedDelta` is the
 * change to what the payment left owing, `creditDelta` the change to the credit
 * it created; both are computed by the caller from the payment's own stamped
 * columns, so neither is inferred.
 *
 * ORDER MATTERS. The credit reversal runs against the balance the carried delta
 * has already produced, because credit the bill run has spent comes back as a
 * charge on that same balance (lib/billing.ts#reverseCredit). Doing it the
 * other way round would drop the shortfall.
 *
 * Re-reads the customer rather than trusting the page, so a payment or a bill
 * run landing between page load and save is not silently overwritten.
 */
async function restateBalances(opts: {
  db: ReturnType<typeof tenantClient>
  companyId: number
  customerId: number | null
  carriedDelta: number
  creditDelta: number
  /** False when 0011 is absent, in which case account_credit does not exist. */
  billing: boolean
}): Promise<{ carried: number; credit: number; shortfall: number } | null> {
  const { db, companyId, customerId, carriedDelta, creditDelta, billing } = opts
  if (!customerId) return null
  if (carriedDelta === 0 && creditDelta === 0) return null

  const { data } = await db
    .from('customers')
    .select(billing ? 'carried_balance, account_credit' : 'carried_balance')
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()

  if (!data) return null

  const row = data as unknown as {
    carried_balance: number | string | null
    account_credit?: number | string | null
  }

  const currentCarried = Number(row.carried_balance ?? 0)
  const currentCredit = billing ? Number(row.account_credit ?? 0) : 0

  // Not clamped at zero: since migration 0027 a balance may be negative (the
  // customer is owed money), and clamping would silently erase that amount.
  const carriedBase = round2(currentCarried + carriedDelta)

  const settled =
    creditDelta < 0
      ? reverseCredit(currentCredit, carriedBase, -creditDelta)
      : {
        credit: round2(currentCredit + creditDelta),
        carriedBalance: carriedBase,
        reversed: 0,
        shortfall: 0,
      }

  const patch: Record<string, unknown> = { carried_balance: settled.carriedBalance }
  if (billing) patch.account_credit = settled.credit

  await db
    .from('customers')
    .update(patch)
    .eq('company_id', companyId)
    .eq('id', customerId)

  return {
    carried: settled.carriedBalance,
    credit: settled.credit,
    shortfall: settled.shortfall,
  }
}

/**
 * The `details` line for a payment edit or deletion — the two events that take
 * money back out of the system.
 *
 * WRITTEN TO BE RECONSTRUCTED FROM, NOT JUST READ. "Payment deleted" tells you
 * nothing a month later: not who it belonged to, not how much left the books,
 * not whether the customer kept the service it had bought. Every field needed
 * to answer those is stamped here, at the moment of the change, because most of
 * them are gone afterwards — the payment row is deleted, and the customer's
 * radcheck expiry moves on.
 *
 * `amount_removed` IS A DELTA AND IS SIGNED, so a period's entries sum to the
 * money taken back out. Positive means money left the books (a deletion, or an
 * edit revising an amount down); negative means an edit revised one up. Old and
 * new are kept alongside it for reading, but the delta is the summable field.
 *
 * Every field follows the `| name=value` convention lib/format.ts
 * #humaniseLogDetail already extracts, so a later report can pull them out
 * without a new parser. Values are stripped of `|` so one cannot fake a field.
 */
function reversalDetails(opts: {
  action: 'edited' | 'deleted'
  paymentId: number
  customer: { id: number; name: string } | null
  oldAmount: number
  newAmount: number
  method: string | null
  paymentDate: string
  effect: PaymentEffect
  restated: { shortfall: number } | null
  /** An "other" payment: no service balance or credit was touched. */
  other: boolean
  expiry: string
  /**
   * What happened to the expiry. A deletion says (lib/data/payment-expiry.ts);
   * an edit does not move it, and the default says that.
   */
  expiryAction?: string
  actor: string
}): string {
  const {
    action, paymentId, customer, oldAmount, newAmount, method, paymentDate,
    effect, restated, other, expiry, expiryAction, actor,
  } = opts

  // A pipe inside a value would split into a field that was never written.
  const clean = (v: string) => v.replace(/\|/g, '/').trim()
  const field = (name: string, value: string | number) =>
    ' | ' + name + '=' + clean(String(value))

  const parts =
    'Payment #' + paymentId + ' ' + action +
    field('customer', customer ? customer.name + ' #' + customer.id : 'none (not a customer payment)') +
    field('amount_removed', (oldAmount - newAmount).toFixed(2)) +
    field('amount_old', oldAmount.toFixed(2)) +
    field('amount_new', newAmount.toFixed(2)) +
    field('method', method || 'unknown') +
    field('payment_date', paymentDate.slice(0, 10)) +
    // THE FIELD THIS ENTRY EXISTS FOR. See standingExpiry.
    field('service_expiry_at_change', expiry)

  // Credit: reversed, partly reversed, or knowingly not reversed at all. The
  // last case must be stated — silence there reads exactly like a payment that
  // never created credit, and the two need different follow-up.
  //
  // An "other" payment has no credit record because it never made any, and
  // the credit line would wrongly send someone to check account_credit by hand.
  const credit =
    other
      ? field('balance_action', 'none (other payment; service balance and credit untouched)')
      : effect.creditApplied === null
      ? field('credit_reversed', 'NOT REVERSED (payment predates the credit record; check account_credit by hand)')
      : effect.creditApplied === 0
        ? ''
        : field('credit_reversed', effect.creditApplied.toFixed(2)) +
          (restated && restated.shortfall > 0
            ? field('credit_shortfall_to_balance', restated.shortfall.toFixed(2))
            : '')

  return (
    parts + credit +
    // Stated on every row rather than left to be inferred from the absence of a
    // network_expiry_corrected entry, so the pairing is legible in the log
    // itself.
    field('expiry_action', expiryAction ?? 'none (correct_expiry is a separate action)') +
    field('by', actor)
  )
}

/**
 * Corrects a recorded payment.
 *
 * A correction to the amount is pushed back through the customer's carried
 * balance, but the billing cycle is deliberately NOT recomputed: `last_bill_date`
 * has moved on and any later payment has advanced it again, so rewinding it from
 * here would corrupt the cycle rather than repair it. Adjust the customer's dates
 * directly if a months-paid correction has to change their expiry.
 *
 * CREDIT IS REVERSED, from the `credit_applied` column migration 0015 stamps on
 * every payment. The correction recomputes what the new amount would have
 * created against the balance the payment itself recorded, and applies the
 * difference — including the case where a bill run has already spent the credit,
 * which comes back as a charge on the carried balance
 * (lib/billing.ts#reverseCredit).
 *
 * Payments written before 0015 carry no credit record. Their corrections move
 * the balance only, and say so in the log rather than assuming no credit
 * existed. Editing months_paid alone is unaffected: it changes no money and no
 * credit.
 */
export async function updatePayment(
  _prev: PaymentResult | null,
  formData: FormData
): Promise<PaymentResult> {
  const paymentId = num(formData, 'payment_id')
  const loaded = await loadForMutation(paymentId, 'edit_payment')
  if (!loaded.ok) return { ok: false, error: loaded.error }

  const { company, profile, db, payment, customer } = loaded
  const isOther = payment.payment_kind === 'other'

  const fieldErrors: Record<string, string> = {}

  const amount = num(formData, 'amount')
  // Read from the form HERE, unlike recordPayment: this is a correction to the
  // months_paid RECORDED on an existing row, not a decision about how much
  // access to grant. See the note on updatePayment.
  //
  // An "other" payment bought no months and keeps 0 whatever the form posts:
  // the edit form's months control starts at 1, and a 1 would read as a month
  // of service paid everywhere months_paid shows.
  const monthsPaid = isOther ? 0 : num(formData, 'months_paid') ?? 1
  const paymentType = str(formData, 'payment_type') || 'cash'
  const paymentDateRaw = str(formData, 'payment_date')
  const agent = str(formData, 'agent')
  const notes = str(formData, 'notes')

  if (amount === null || amount <= 0) fieldErrors.amount = 'Enter an amount greater than zero.'
  if (!isOther && (monthsPaid < 1 || monthsPaid > 6)) {
    fieldErrors.months_paid = 'Months paid must be 1 to 6.'
  }
  if (!agent) fieldErrors.agent = 'Agent is required.'

  // The business date, as in recordPayment: midday in the server's zone, used
  // for the calendar date only. What payment_date is written from is decided
  // below, once the company's timezone is known.
  const paymentDate = paymentDateRaw
    ? new Date(paymentDateRaw + 'T12:00:00')
    : new Date(payment.payment_date)

  if (!Number.isFinite(paymentDate.getTime())) {
    fieldErrors.payment_date = 'Enter a valid date.'
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, error: 'Please correct the highlighted fields.', fieldErrors }
  }

  const previousAmount = Number(payment.amount ?? 0)

  const [caps, { data: tzRow }] = await Promise.all([
    getSchemaCapabilities(),
    db.from('settings').select('timezone').eq('company_id', company.id).maybeSingle(),
  ])
  const timeZone = (tzRow as { timezone: string | null } | null)?.timezone ?? 'America/Jamaica'

  // AN EDIT THAT LEAVES THE DATE ALONE LEAVES THE TIME ALONE. Correcting an
  // amount must not move a payment's real time to the moment of the edit —
  // and every stamp this used to write was noon in the server's zone, so the
  // stored instant is only restated when the date itself changes. Then the
  // same rule as recordPayment: now for today, noon in the company's zone for
  // a back-dated one. lib/format.ts#paymentInstant.
  const heldOn = instantToDateOnly(new Date(payment.payment_date), timeZone)
  const stampedAt =
    ymd(paymentDate) === heldOn
      ? new Date(payment.payment_date)
      : paymentInstant(ymd(paymentDate), new Date(), timeZone) ?? paymentDate

  const patch: Record<string, unknown> = {
    amount: amount as number,
    months_paid: monthsPaid,
    payment_type: paymentType,
    payment_date: stampedAt.toISOString(),
    agent,
    notes: notes || null,
  }

  // paid_on is the column reporting reads, so a correction to the date has to
  // move it too. Leaving it behind would put the edited payment in one day's
  // collections and print another date on its receipt.
  if (caps.otherPayments) patch.paid_on = ymd(paymentDate)

  // FEWER MONTHS TAKES THE EXPIRY BACK BY THE DIFFERENCE (owner, 9 Oct 2026),
  // with the same safeguards as a deletion: lib/data/payment-expiry.ts. A
  // payment typed as six months and corrected to one kept its six (Patricia
  // Salmon). Planned before the row changes, carried out once it has.
  const previousMonths = payment.months_paid ?? 1
  const monthsBack = isOther ? 0 : previousMonths - monthsPaid
  const expiryPlan: ExpiryUndo | null = monthsBack >= 1
    ? await planMonthsTakeBack(company.id, payment.id, customer?.identity ?? null, monthsBack)
      .catch((err: Error): ExpiryUndo => ({ kind: 'left', current: null, message: 'Could not work out the expiry: ' + err.message + ' Check it by hand.' }))
    : null

  const { error: updateError } = await db
    .from('payments')
    .update(patch)
    .eq('company_id', company.id)
    .eq('id', payment.id)

  if (updateError) return { ok: false, error: 'Could not update payment: ' + updateError.message }

  // --- Restate what the payment did ----------------------------------------
  //
  // Recomputed against `carried_balance_before` — what the customer owed at the
  // moment the payment was taken — so the corrected amount is split between
  // balance and credit exactly as it would have been at the till. Falls back to
  // the amount delta when that column is absent (pre-0011 rows), which is the
  // behaviour this had before credit existed.
  const effect = paymentEffect(payment)
  let restated: { shortfall: number } | null = null

  if (isOther) {
    // AN "OTHER" PAYMENT NEVER TOUCHED THE SERVICE BALANCE, so correcting it
    // restates nothing there. It carries no before/after stamps, and without
    // this branch it fell to the amount-delta fallback below — meant for
    // pre-0011 SERVICE rows — and moved carried_balance by money that was never
    // service money.
  } else if (effect.carriedBefore !== null && effect.carriedAfter !== null) {
    const newCarriedAfter = outstandingBalance(effect.carriedBefore, amount as number)
    const newCredit = prepaymentCredit(effect.carriedBefore, amount as number)

    restated = await restateBalances({
      db,
      companyId: company.id,
      customerId: payment.customer_id,
      carriedDelta: round2(newCarriedAfter - effect.carriedAfter),
      // Null credit_applied means the payment predates 0015 and there is no
      // record to reverse from. Left alone deliberately, and reported below.
      creditDelta:
        effect.creditApplied === null ? 0 : round2(newCredit - effect.creditApplied),
      billing: caps.billing,
    })

    if (caps.creditReversal) {
      await db
        .from('payments')
        .update({ credit_applied: newCredit })
        .eq('company_id', company.id)
        .eq('id', payment.id)
    }
  } else {
    // A larger payment leaves less owing, so the delta is old minus new.
    await adjustCarriedBalance(
      db, company.id, payment.customer_id, previousAmount - (amount as number)
    )
  }

  const expiryAtChange = await standingExpiry(customer?.identity ?? null)
  const expiryDone = expiryPlan
    ? await applyExpiryUndo({
        plan: expiryPlan,
        companyId: company.id,
        customerId: payment.customer_id,
        identity: customer?.identity ?? null,
        paymentId: payment.id,
        cause: 'edited from ' + previousMonths + ' to ' + monthsPaid + (monthsPaid === 1 ? ' month' : ' months'),
        actorEmail: profile.email,
      })
    : null

  await logEvent({
    customerId: payment.customer_id,
    type: 'payment_updated',
    tag: '[payments]',
    details: reversalDetails({
      action: 'edited',
      paymentId: payment.id,
      customer,
      oldAmount: previousAmount,
      newAmount: amount as number,
      method: payment.payment_method ?? payment.payment_type ?? null,
      paymentDate: payment.payment_date,
      effect,
      restated,
      other: isOther,
      expiry: expiryAtChange,
      expiryAction: expiryDone
        ? expiryActionText(expiryDone, 'none (this payment did not move the expiry)')
        : 'none (months paid not lowered: ' + previousMonths + ' -> ' + monthsPaid + ')',
      actor: profile.email,
    }),
  })

  revalidatePath('/dashboard/payments')
  revalidatePath('/dashboard/payments/' + payment.id)
  if (payment.customer_id) revalidatePath('/dashboard/customers/' + payment.customer_id)
  revalidatePath('/dashboard')

  const expiryNote =
    expiryDone?.kind === 'restore' || expiryDone?.kind === 'shift' ? ' Expiry moved back to ' + expiryDone.to + '.'
      : expiryDone?.kind === 'left' ? ' Expiry NOT moved: ' + expiryDone.message
        : ''
  redirect(
    '/dashboard/payments/' + payment.id + '?' + (expiryDone?.kind === 'left' ? 'toastKind=error&' : '') +
    'toast=' + encodeURIComponent('Payment updated.' + expiryNote)
  )
}

/**
 * Deletes a payment and returns what it covered to the customer's balance.
 *
 * As with an edit, the billing cycle is not rewound — see updatePayment.
 */
export async function deletePayment(formData: FormData): Promise<void> {
  const paymentId = num(formData, 'payment_id')
  const loaded = await loadForMutation(paymentId, 'delete_payment')

  if (!loaded.ok) {
    redirect('/dashboard/payments?toastKind=error&toast=' + encodeURIComponent(loaded.error))
  }

  const { company, profile, db, payment, customer } = loaded
  const amount = Number(payment.amount ?? 0)

  // Read before the row goes, or there is nothing left to reverse from.
  const effect = paymentEffect(payment)
  const caps = await getSchemaCapabilities()

  // Read BEFORE the delete so the log records the access the customer held at
  // the moment the money was taken back.
  const expiryAtChange = await standingExpiry(customer?.identity ?? null)

  // WHAT THE DELETE DOES TO THE EXPIRY (owner, 9 Oct 2026): it puts back the
  // month this payment gave. Planned while the payment row still exists — the
  // plan reads it — and carried out once it is gone. See
  // lib/data/payment-expiry.ts.
  const expiryPlan = await planExpiryUndo(company.id, payment.id, customer?.identity ?? null)
    .catch((err: Error): ExpiryUndo => ({ kind: 'left', current: null, message: 'Could not work out the expiry: ' + err.message + ' Check it by hand.' }))

  const { error: deleteError } = await db
    .from('payments')
    .delete()
    .eq('company_id', company.id)
    .eq('id', payment.id)

  if (deleteError) {
    redirect(
      '/dashboard/payments/' + payment.id + '?toastKind=error&toast=' +
      encodeURIComponent('Could not delete payment: ' + deleteError.message)
    )
  }

  // The money is no longer recorded as received, so everything the payment did
  // is undone: what it settled goes back on the balance, and the credit it
  // created is taken back. A deletion reverses the WHOLE effect, which is what
  // separates it from a correction — there is no new amount to restate against.
  let restated: { shortfall: number } | null = null
  const isOther = payment.payment_kind === 'other'

  if (isOther) {
    // Nothing to undo on the service balance: an "other" payment never touched
    // it. See the same branch in updatePayment for what the fallback did here.
  } else if (effect.carriedBefore !== null && effect.carriedAfter !== null) {
    restated = await restateBalances({
      db,
      companyId: company.id,
      customerId: payment.customer_id,
      carriedDelta: round2(effect.carriedBefore - effect.carriedAfter),
      creditDelta: effect.creditApplied === null ? 0 : -effect.creditApplied,
      billing: caps.billing,
    })
  } else {
    await adjustCarriedBalance(db, company.id, payment.customer_id, amount)
  }

  const expiryDone = await applyExpiryUndo({
    plan: expiryPlan,
    companyId: company.id,
    customerId: payment.customer_id,
    identity: customer?.identity ?? null,
    paymentId: payment.id,
    cause: 'deleted',
    actorEmail: profile.email,
  })

  await logEvent({
    customerId: payment.customer_id,
    type: 'payment_deleted',
    tag: '[payments]',
    details: reversalDetails({
      action: 'deleted',
      paymentId: payment.id,
      customer,
      oldAmount: amount,
      // A deletion removes the whole amount, so the delta is the amount itself.
      newAmount: 0,
      method: payment.payment_method ?? payment.payment_type ?? null,
      paymentDate: payment.payment_date,
      effect,
      restated,
      other: isOther,
      expiry: expiryAtChange,
      expiryAction: expiryActionText(expiryDone, 'none (this payment did not move the expiry)'),
      actor: profile.email,
    }),
  })

  revalidatePath('/dashboard/payments')
  if (payment.customer_id) revalidatePath('/dashboard/customers/' + payment.customer_id)
  revalidatePath('/dashboard')

  const expiryNote =
    expiryDone.kind === 'restore' || expiryDone.kind === 'shift' ? ' Expiry moved back to ' + expiryDone.to + '.'
      : expiryDone.kind === 'left' ? ' Expiry NOT moved: ' + expiryDone.message
        : ''
  redirect(
    '/dashboard/payments?' + (expiryDone.kind === 'left' ? 'toastKind=error&' : '') +
    'toast=' + encodeURIComponent('Payment of ' + money(amount) + ' deleted.' + expiryNote)
  )
}
