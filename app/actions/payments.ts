'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import {
  billingPeriod, carriedBalanceAfter, firstPeriodCharge, firstPeriodDays,
  firstPeriodDiscount, isPartialPayment, MAX_PREPAY_MONTHS, monthsCovered,
  outstandingBalance, parseYmd, prepaymentCredit, proportionalDate, reverseCredit,
  serviceExpiry, ymd, type AccessDecision,
} from '@/lib/billing'
import { legacyPaymentType, toPaymentMethod } from '@/lib/data/checkoff'
import { getFirstPeriodRules } from '@/lib/data/company'
import { firstPeriodAnchor } from '@/lib/data/first-period'
import { findOrCreatePaymentCategory } from '@/lib/data/payment-categories'
import { getReversalSubject } from '@/lib/data/payments'
import { can } from '@/lib/permissions'
import { canExtend } from '@/lib/status'
import { getRadiusStatus as readNetworkRecord, radiusConfigured } from '@/lib/radius-db'
import {
  applyRadiusWrite, radiusLogDetails,
} from '@/lib/radius/operations'
import { getSchemaCapabilities, type SchemaCapabilities } from '@/lib/schema'
import { logEvent } from '@/lib/audit'
import { notifyPaymentReceipt } from '@/lib/sms/notify'
import { displayName, getSession, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

export type PaymentResult =
  | {
      ok: true
      amount?: number
      customerId?: number
      customerName?: string
      /** New service expiry, for the success panel. Null if not derivable. */
      newExpiryIso?: string | null
      /** True when network access was genuinely extended. */
      networkExtended?: boolean
      /** Set when the payment saved but access did not move. */
      warning?: string | null
      /** Shortfall carried to the customer's next bill; 0 when fully paid. */
      carriedBalance?: number
      /**
       * The row just written. The receipt modal re-reads the payment by this
       * id rather than being handed a receipt built here, so the receipt shown
       * after a payment and a reprint of it months later come from the same
       * code path. See lib/data/receipts.ts.
       */
      paymentId?: number
    }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

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

/** Money is stored as numeric; keep float drift out of what we write back. */
const round2 = (n: number) => Math.round(n * 100) / 100

const money = (n: number) =>
  'J$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)

/** Sentinel the Purpose dropdown submits for its "+ Add new category" row. */
const NEW_CATEGORY = '__new__'

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
  if (amount === null || amount <= 0) fieldErrors.amount = 'Enter an amount greater than zero.'

  const chosenDate = parseYmd(accessDateRaw)
  if (accessDecisionRaw === 'date_selected' && !chosenDate) {
    fieldErrors.access_date = 'Choose a valid date for access.'
  }

  // Defaults to now, which is what the record-payment form always wants. The
  // time is kept, not floored to midday, so the collections list orders by
  // when the money actually came in.
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

  const db = tenantClient()

  const cols =
    'id, first_name, last_name, last_bill_date, mac_address, monthly_rate, cut_off_date' +
    (caps.catalog ? ', misc_category_id' : '') +
    (caps.connectionTypes ? ', customer_type, pppoe_username' : '') +
    (caps.expiryMode ? ', expiry_mode' : '') +
    (caps.billing
      ? ', billing_type, carried_balance, account_credit, bill_date, last_billed_date'
      : '')

  const { data, error: loadError } = await db
    .from('customers')
    .select(cols)
    .eq('company_id', company.id)
    .eq('id', customerId)
    .maybeSingle()

  if (loadError) return { ok: false, error: 'Could not load customer: ' + loadError.message }

  const customer = data as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
    last_bill_date: string | null
    mac_address: string | null
    monthly_rate: number | string | null
    cut_off_date: number | null
    misc_category_id?: number | null
    customer_type?: string | null
    pppoe_username?: string | null
    expiry_mode?: string | null
    billing_type?: string | null
    carried_balance?: number | string | null
    account_credit?: number | string | null
    bill_date?: number | null
  } | null

  if (!customer) return { ok: false, error: 'That customer no longer exists.' }

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer'
  const paidAmount = amount as number

  // --- What this customer owes ---------------------------------------------
  //
  // The monthly charge is the customer's rate PLUS every active add-on, which
  // is the monthly figure the payment page shows. Billing the bare monthly_rate
  // column would quietly drop add-ons from the amount due.
  let addonTotal = 0
  if (caps.billing && caps.catalog) {
    const { data: links } = await db
      .from('customer_additional_services')
      .select('additional_services(monthly_price)')
      .eq('customer_id', customer.id)

    addonTotal = ((links ?? []) as unknown as {
      additional_services: { monthly_price: number | string | null } | null
    }[]).reduce((sum, l) => sum + Number(l.additional_services?.monthly_price ?? 0), 0)
  }

  // ONE BILLING MODEL — nothing branches on billing_type. The bill run charges
  // carried_balance and this settles it. See lib/billing.ts.
  //
  // monthlyCharge is no longer part of what is OWED; it survives because the
  // proportional-access maths is priced off a month, and because the receipt
  // stamps it as the month's service charge.
  const monthlyCharge = Number(customer.monthly_rate ?? 0) + addonTotal
  const carriedBefore = caps.billing ? Number(customer.carried_balance ?? 0) : 0

  // --- Where access currently ends -----------------------------------------
  //
  // Read BEFORE anything is priced, because the expiry it holds is the anchor
  // for the prepaid calculation, for the proportional date, AND for the length
  // of a first period. Anchoring to last_bill_date instead is what previously
  // wrote an expiry earlier than the customer already had.
  const identity =
    customer.customer_type === 'pppoe' ? customer.pppoe_username : customer.mac_address

  const registered =
    identity && radiusConfigured()
      ? await readNetworkRecord(identity).catch(() => null)
      : null

  const registryExpiry = registered?.expiry ?? null

  // --- First period (migration 0017) ---------------------------------------
  //
  // Null for everybody except a customer making their first payment since
  // ISPMan provisioned them, with the company switch on. See resolveFirstPeriod.
  //
  // Sits here, after the registry read and before the pricing, because the
  // expiry provisioning wrote is what says how long the first period is.
  const firstPeriod = await resolveFirstPeriod({
    companyId: company.id,
    customerId: customer.id,
    monthlyCharge,
    registryExpiry,
    discountRequested: str(formData, 'first_period_discount') === '1',
  })

  // --- What this payment is settling ---------------------------------------
  //
  // For everybody else the amount due IS the carried balance and nothing else
  // (lib/billing.ts#amountDue): the bill run charged the month when it ended,
  // and this settles it.
  //
  // A FIRST PERIOD HAS NEVER BEEN BILLED. Provisioning granted access to the
  // end of it without charging anything, and the bill run only charges periods
  // that have already closed — so at the moment of the first payment the
  // customer owes for days they are already using while the carried balance
  // still says zero. Folding it in here is what lets the rest of this function
  // price the payment with no second billing path: the shortfall, the credit
  // and the partial-payment decision all measure against this one number.
  const due = round2(carriedBefore + (firstPeriod?.due ?? 0))

  const partial = isPartialPayment(due, paidAmount)
  const carriedAfter = carriedBalanceAfter(due, paidAmount)

  // --- Prepayment ----------------------------------------------------------
  //
  // Anything handed over beyond what is due is money for months not yet billed.
  // It is held as account_credit and drawn down by future bill runs before they
  // add anything to carried_balance (app/actions/bulk.ts#billBatch), so a
  // customer who paid three months up front never reads as owing during the
  // months they have already paid for.
  const creditBefore = caps.billing ? Number(customer.account_credit ?? 0) : 0
  const creditAdded = caps.billing ? prepaymentCredit(due, paidAmount) : 0
  const creditAfter = round2(creditBefore + creditAdded)

  // MONTHS BOUGHT FORWARD, from the MONEY and never from the form's dropdown.
  //
  // A FIRST PAYMENT BUYS NONE BY DEFAULT, and that is the whole difference.
  // The customer already holds access to the end of the first period — that is
  // what provisioning wrote and what they are now paying for — so settling it
  // moves nothing. monthsCovered has a floor of 1 because for a renewal that is
  // right: the bill run charged a month that has passed, and paying it buys the
  // next one. Here the period being paid for is the one still running, and only
  // money BEYOND it buys anything further.
  const excess = Math.max(0, round2(paidAmount - due))
  const monthsPaid = firstPeriod
    ? monthlyCharge > 0
      ? Math.min(MAX_PREPAY_MONTHS, Math.floor(excess / monthlyCharge))
      : 0
    : monthsCovered(due, monthlyCharge, paidAmount)

  // A decision only means something for a payment that is actually short. One
  // sent for a payment that covers the bill is dropped rather than stored.
  const decision: AccessDecision | null = partial
    ? accessDecisionRaw === 'date_selected' ? 'date_selected' : 'full_period'
    : null

  // The company grace period is what carries a customer past their cut-off day
  // before they are actually taken off the network.
  let gracePeriodDays = 0
  if (caps.generalSettings) {
    const { data: settingsRow } = await db
      .from('settings')
      .select('grace_period_days')
      .eq('company_id', company.id)
      .maybeSingle()

    gracePeriodDays = Number(
      (settingsRow as { grace_period_days: number | null } | null)?.grace_period_days ?? 0
    )
  }

  // The date a full payment would have reached, and the "Full Period" branch of
  // a short one. One calculation for everybody now — the months-from-expiry
  // walk went with the prepaid arm and its months-to-pay selector.
  //
  // A FIRST PAYMENT THAT BUYS NO FURTHER MONTHS DOES NOT MOVE THE EXPIRY. It
  // stays exactly where provisioning put it, because that is the end of the
  // period the money is paying for. serviceExpiry cannot say this — it floors
  // months at 1, which is right for a renewal and wrong here — so the branch is
  // taken before the call rather than by passing it a zero it would ignore.
  const fullPeriodExpiry =
    firstPeriod && monthsPaid === 0
      ? firstPeriod.expiry
      : serviceExpiry({
          // cut_off_date, not bill_date: the bill day says when the charge is
          // raised, the cut-off day says when access ends. Anchored on the
          // registry expiry so settling the bill rolls the customer PAST the
          // cut-off that bill was due at rather than up to it.
          cutOffDay: customer.cut_off_date ?? null,
          gracePeriodDays,
          currentExpiry: registryExpiry,
          from: paymentDate,
          // A prepayment moves the expiry the WHOLE distance now, not one month
          // per bill run. The customer paid for the months today, so they hold
          // them today.
          months: monthsPaid,
        })

  const newExpiry =
    decision === 'date_selected' && chosenDate ? chosenDate : fullPeriodExpiry

  // Recomputed rather than trusted, so the log records the real proportional
  // date even if the form sent a stale one.
  const proportional = partial
    ? proportionalDate({
        amountPaid: paidAmount,
        monthlyCharge,
        currentExpiry: registryExpiry,
        from: paymentDate,
      })
    : null

  const beyondProportional = Boolean(
    decision === 'date_selected' && proportional && ymd(newExpiry) > ymd(proportional)
  )

  // --- Record the payment ---------------------------------------------------
  //
  // payment_method carries the full list; payment_type is the older, narrower
  // column that existing reads still depend on. Both are written so nothing
  // regresses while 0010 is rolling out. See lib/data/checkoff.ts.
  const method = toPaymentMethod(paymentMethodRaw || paymentType)

  const insertRow: Record<string, unknown> = {
    company_id: company.id,
    customer_id: customer.id,
    amount: paidAmount,
    months_paid: monthsPaid,
    payment_type: legacyPaymentType(method),
    payment_date: paymentDate.toISOString(),
    agent,
    notes: notes || null,
  }

  if (caps.checkoff) {
    insertRow.payment_method = method
    insertRow.checked_off = false
    // The collector's identity, so "My Collections" and checkoff can attribute
    // the payment even if the free-text agent field is later edited.
    insertRow.user_id = profile.id
  }

  if (caps.otherPayments) {
    insertRow.payment_kind = 'service'
    insertRow.paid_on = ymd(paymentDate)
    // The monthly charge this payment settled, stamped so the receipt can print
    // the "Monthly service" line without recomputing it from a rate or an
    // add-on list that may have changed since. See migration 0013.
    insertRow.service_charge = monthlyCharge
  }

  if (caps.billing) {
    // Every payment now settles a period already used, so every payment stamps
    // one. Under the retired split only the postpaid arm did.
    const period = billingPeriod(paymentDate, customer.bill_date ?? null)
    insertRow.billing_period_start = period.start
    insertRow.billing_period_end = period.end
    insertRow.access_granted_until = ymd(newExpiry)
    insertRow.carried_balance_before = carriedBefore
    insertRow.carried_balance_after = carriedAfter
    // Null for a payment that cleared the bill: there was no decision to make.
    insertRow.access_decision = decision
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
  if (caps.firstPeriod) {
    // WHAT THE CUSTOMER WAS ASKED FOR, so the receipt can restate it rather
    // than reassembling it from parts. Equal to carried_balance_before for an
    // ordinary payment; larger for a first payment, whose period the carried
    // balance has never held. See migration 0017 and lib/data/receipts.ts.
    insertRow.amount_due = due
    // Stamped for EVERY payment, zero included, on the same reasoning as
    // credit_applied in 0015: a stamped 0 says no discount was given, where
    // NULL would only say nobody recorded one. The receipt prints neither, but
    // the two are different facts.
    insertRow.first_period_discount =
      firstPeriod?.discountApplied ? firstPeriod.discount : 0
  }

  if (caps.creditReversal) {
    // THE REVERSAL RECORD (migration 0015). Written for EVERY payment, zero
    // included, not just the ones that created credit: a correction has to be
    // able to tell "this payment made no credit" from "nobody recorded what it
    // made", and only a stamped 0 says the first. Rows predating 0015 are NULL
    // and their corrections skip the reversal rather than guess.
    insertRow.credit_applied = creditAdded
  }

  const { data: inserted, error: insertError } = await db
    .from('payments')
    .insert(insertRow)
    .select('id')
    .single()

  if (insertError) return { ok: false, error: 'Could not record payment: ' + insertError.message }

  const paymentId = (inserted as unknown as { id: number }).id

  // A SHORT FIRST PERIOD IS CHARGED AT FULL RATE UNLESS SOMEONE DECIDES
  // OTHERWISE, and this row is the record of who decided. The reduction is open
  // to any role and is never applied automatically, so nothing else in the
  // system says it happened or names the person who allowed it.
  if (firstPeriod?.discountApplied) {
    await logEvent({
      customerId: customer.id,
      type: 'first_period_discount',
      tag: '[payments]',
      details:
        'First period discount applied | days=' + firstPeriod.days +
        ' | full_charge=' + firstPeriod.charge.toFixed(2) +
        ' | discount=' + firstPeriod.discount.toFixed(2) +
        ' | charged=' + firstPeriod.due.toFixed(2) +
        ' | payment_id=' + paymentId +
        ' | by=' + agent,
      // Negative: this reduced what the customer owed. Dropped with a console
      // warning until migration 0016 is applied, which is by design.
      amount: -firstPeriod.discount,
    })
  }

  // --- Extend network access, where the customer actually has any -----------
  //
  // The payment is already saved and stays saved whatever happens below: the
  // money was taken and must be on record. Network access is a separate
  // question, and only customers who are both marked active AND present in the
  // network registry get extended. Everyone else is recorded and flagged, so
  // the cashier is told plainly that access was not extended rather than being
  // shown a success that is only half true.
  const NOT_ACTIVATED =
    'This customer is not activated on the network. Payment will be recorded but ' +
    'internet access will not be extended until the customer is activated.'

  let networkExtended = false
  let warning: string | null = null

  if (!identity) {
    warning = NOT_ACTIVATED
  } else if (!radiusConfigured()) {
    warning = NOT_ACTIVATED
  } else {
    if (registered === null) {
      warning =
        'Payment recorded, but the network could not be reached, so access was ' +
        'not extended. Try again once the connection is restored.'
    } else if (!canExtend(registered.status)) {
      warning = NOT_ACTIVATED
    } else if (
      firstPeriod &&
      monthsPaid === 0 &&
      newExpiry.getTime() === firstPeriod.expiry.getTime()
    ) {
      // DELIBERATELY NOT A WARNING. This is the correct and expected outcome of
      // a first payment: the customer already holds access to the end of the
      // period they have just paid for, so there is nothing to move. Writing
      // the same date back would put an extend through the backwards-write
      // guard for no reason and log an extension that extended nothing.
    } else {
      // extendInRadius still refuses to move an expiry backwards. A cashier who
      // picks a date earlier than the customer already holds lands here and is
      // told so — the guard is not relaxed for partial payments.
      const result = await applyRadiusWrite('extend', identity, newExpiry)

      if (result.ok) {
        networkExtended = true

        // The expiry the registry now actually holds, for the receipt's
        // "Service active until" line. Written after the extend rather than
        // with the insert because until the write returns there is no fact to
        // record — and it stays NULL when access did not move, which is what
        // makes the receipt omit the line for an unprovisioned customer.
        //
        // Distinct from access_granted_until (0011), which is stamped with the
        // intended expiry whether or not the write landed.
        // newExpiry is the Date handed to applyRadiusWrite, so on ok it is
        // what the registry now holds. result.newExpiry is a RADIUS-format
        // string and is not parsed back for this.
        if (caps.otherPayments && newExpiry) {
          await db
            .from('payments')
            .update({ service_active_until: ymd(newExpiry) })
            .eq('company_id', company.id)
            .eq('id', paymentId)
        }

        await logEvent({
          customerId: customer.id,
          type: 'radius_extend',
          tag: '[payments]',
          details: radiusLogDetails({
            action: 'extend',
            identity,
            oldExpiry: result.oldExpiry,
            newExpiry: result.newExpiry,
            actor: profile.email,
            skipped: result.skipped,
            note:
              'bill period' +
              (decision ? ', partial=' + decision : '') +
              // Kept when payment_recorded went: a manager granting a date
              // beyond what the money bought is a decision, and this is now
              // the only row that says it happened.
              (beyondProportional ? ', beyond_proportional' : ''),
          }),
        })
      } else {
        warning =
          'Payment recorded, but access could not be extended: ' + result.error
        await logEvent({
          customerId: customer.id,
          type: 'radius_extend_failed',
          tag: '[payments]',
          details:
            'RADIUS extend FAILED | identity=' + identity +
            ' | old_expiry=' + (result.oldExpiry ?? 'none') +
            ' | by=' + profile.email + ' | ' + result.error,
        })
      }
    }
  }

  // --- Settle the customer record -------------------------------------------
  //
  // Billing only. A payment never writes status: it is derived from the network
  // registry, and the extend above is the only thing that can move it. An
  // unactivated customer therefore keeps warning on every payment until an
  // administrator activates them, rather than being marked active by the act
  // of paying.
  //
  // cut_off_date is never touched here by either billing type — it is the
  // customer's standing agreement, not a consequence of one payment.
  // A PAYMENT WRITES carried_balance AND NOTHING ELSE.
  //
  // `balance` is NOT written. It is the retired split's column: nothing ever
  // charged it, so decrementing it here only ever moved a figure that was
  // already 0 and that no page reads any more. See lib/billing.ts.
  //
  // last_bill_date is left alone. It drove the retired prepaid renewal cycle,
  // and there is no longer a months-forward cycle for a payment to advance.
  //
  // last_billed_date is left alone because IT IS THE BILL RUN'S COLUMN AND
  // MEANS THE END OF THE PERIOD BILLED, not the date money changed hands.
  // This used to stamp the payment date over it, and app/actions/bulk.ts
  // #billedInPeriod reads that as "already billed for the month the payment
  // fell in": every customer who paid during September was then skipped by
  // the 1 October run and got a month of service with no bill raised.
  //
  // A payment SETTLES a bill; it does not raise one. Only billBatch writes
  // this column. When a customer last paid is already recorded — payments
  // .paid_on, stamped on the row inserted above — so nothing is lost here.
  const patch: Record<string, unknown> = { carried_balance: carriedAfter }

  // account_credit is written ONLY when 0011 is present, and only when this
  // payment actually created credit — an ordinary payment that clears the
  // balance exactly leaves the column untouched rather than rewriting it to
  // the same number.
  if (caps.billing && creditAdded > 0) patch.account_credit = creditAfter

  const { error: updateError } = await db
    .from('customers')
    .update(patch)
    .eq('company_id', company.id)
    .eq('id', customer.id)

  if (updateError) {
    return {
      ok: false,
      error:
        'Payment was saved but the customer record could not be updated: ' +
        updateError.message,
    }
  }

  // Same as the "other" path above: queued after the money is recorded, and
  // never able to fail the payment.
  await notifyPaymentReceipt({
    companyId: company.id,
    companyName: company.name,
    customerId: customer.id,
    paymentId,
    amount: paidAmount,
  })

  revalidatePath('/dashboard/customers/' + customer.id)
  revalidatePath('/dashboard/customers')
  revalidatePath('/dashboard/payments')
  revalidatePath('/dashboard/payments/new')
  revalidatePath('/dashboard')

  // Returns rather than redirecting: the form renders its own success state
  // with the new expiry, and the collections panel beside it refreshes in
  // place. Redirecting away would lose both.
  return {
    ok: true as const,
    amount: paidAmount,
    customerId: customer.id,
    customerName: fullName,
    // Only surfaced when access actually moved, so the panel never promises an
    // extension that did not happen.
    newExpiryIso: networkExtended && newExpiry ? newExpiry.toISOString() : null,
    networkExtended,
    warning,
    carriedBalance: caps.billing ? carriedAfter : 0,
    paymentId,
  }
}

/**
 * What a customer owes for their FIRST period, or null when this is not one.
 *
 * Null is the answer for almost every payment, and the checks are ordered so
 * that the common case costs nothing: the company switch is a settings read
 * that getFirstPeriodRules keeps narrow, and the two history queries in
 * lib/data/first-period.ts only run once it says the feature is on.
 *
 * WHY A MISSING REGISTRY EXPIRY RETURNS NULL RATHER THAN A ZERO-DAY PERIOD.
 * The expiry is what the period is measured to. When RADIUS is unconfigured or
 * the NAS is unreachable there is no honest length to price, and treating that
 * as "0 days" would charge the customer the bare monthly rate while telling
 * them it was pro-rata. Falling back to the ordinary path charges them the same
 * thing without the claim.
 *
 * THE DISCOUNT IS REQUESTED, NEVER ASSUMED. discountRequested is the cashier
 * ticking a box; a period of 30 days or more offers nothing to tick, which is
 * why the flag is combined with a positive discount rather than trusted alone.
 */
type FirstPeriod = {
  /** When ISPMan provisioned them. The start of the period. */
  anchor: Date
  /** The expiry provisioning wrote. The end of the period. */
  expiry: Date
  /** Whole days from anchor to expiry. */
  days: number
  /** The full charge for those days. Never below the monthly rate. */
  charge: number
  /** What may be taken off when the period is SHORT of 30 days. Often 0. */
  discount: number
  /** Whether the cashier actually applied it. */
  discountApplied: boolean
  /** charge less the discount if applied. What this payment is settling. */
  due: number
}

/**
 * The first-period figures for ONE customer, for the till to preview.
 *
 * Returns null for the overwhelming majority of customers, which is what the
 * form treats as "price this the ordinary way".
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
export async function loadFirstPeriod(customerId: number): Promise<{
  days: number
  charge: number
  discount: number
} | null> {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'record_payment')) return null

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

  if (!customer) return null

  // The same monthly charge the till prices against: rate plus active add-ons.
  let addonTotal = 0
  if (caps.billing && caps.catalog) {
    const { data: links } = await db
      .from('customer_additional_services')
      .select('additional_services(monthly_price)')
      .eq('customer_id', customer.id)

    addonTotal = ((links ?? []) as unknown as {
      additional_services: { monthly_price: number | string | null } | null
    }[]).reduce((sum, l) => sum + Number(l.additional_services?.monthly_price ?? 0), 0)
  }

  const identity =
    customer.customer_type === 'pppoe' ? customer.pppoe_username : customer.mac_address

  const registered =
    identity && radiusConfigured()
      ? await readNetworkRecord(identity).catch(() => null)
      : null

  const period = await resolveFirstPeriod({
    companyId: company.id,
    customerId: customer.id,
    monthlyCharge: Number(customer.monthly_rate ?? 0) + addonTotal,
    registryExpiry: registered?.expiry ?? null,
    // The preview always shows what the discount WOULD be. Whether it is
    // applied is the cashier’s tick at submit time, not a property of the
    // customer, so it is deliberately not asked here.
    discountRequested: false,
  })

  if (!period) return null

  return { days: period.days, charge: period.charge, discount: period.discount }
}
async function resolveFirstPeriod(opts: {
  companyId: number
  customerId: number
  monthlyCharge: number
  registryExpiry: Date | null
  discountRequested: boolean
}): Promise<FirstPeriod | null> {
  const { companyId, customerId, monthlyCharge, registryExpiry, discountRequested } = opts

  const { prorataFirstPaymentEnabled } = await getFirstPeriodRules(companyId)
  if (!prorataFirstPaymentEnabled) return null
  if (!registryExpiry) return null

  const anchor = await firstPeriodAnchor(companyId, customerId)
  if (!anchor) return null

  const days = firstPeriodDays(anchor, registryExpiry)
  const charge = firstPeriodCharge(monthlyCharge, days)
  const discount = firstPeriodDiscount(monthlyCharge, days)
  const discountApplied = discountRequested && discount > 0

  return {
    anchor,
    expiry: registryExpiry,
    days,
    charge,
    discount,
    discountApplied,
    due: round2(charge - (discountApplied ? discount : 0)),
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
    (caps.creditReversal ? ', credit_applied' : '')

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
 * READ AT THE MOMENT OF THE CHANGE and stamped on the row, because it is the
 * whole point of the entry: reversing money does not touch radcheck (the
 * backwards-write guard in lib/radius-db.ts#extendInRadius forbids it), so a
 * reversal leaves the customer holding access the payment had bought. Recording
 * what that access was is what makes "money taken back, service left running"
 * visible afterwards rather than something to be inferred.
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
  await db
    .from('customers')
    .update({ carried_balance: Math.max(0, current + delta) })
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

  // Clamped at zero to match customers_carried_balance_check (migration 0011).
  const carriedBase = Math.max(0, round2(currentCarried + carriedDelta))

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
  expiry: string
  actor: string
}): string {
  const {
    action, paymentId, customer, oldAmount, newAmount, method, paymentDate,
    effect, restated, expiry, actor,
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
  const credit =
    effect.creditApplied === null
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
    // itself: money moved here, access did not.
    field('expiry_action', 'none (correct_expiry is a separate action)') +
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

  const fieldErrors: Record<string, string> = {}

  const amount = num(formData, 'amount')
  // Read from the form HERE, unlike recordPayment: this is a correction to the
  // months_paid RECORDED on an existing row, not a decision about how much
  // access to grant. See the note on updatePayment.
  const monthsPaid = num(formData, 'months_paid') ?? 1
  const paymentType = str(formData, 'payment_type') || 'cash'
  const paymentDateRaw = str(formData, 'payment_date')
  const agent = str(formData, 'agent')
  const notes = str(formData, 'notes')

  if (amount === null || amount <= 0) fieldErrors.amount = 'Enter an amount greater than zero.'
  if (monthsPaid < 1 || monthsPaid > 6) fieldErrors.months_paid = 'Months paid must be 1 to 6.'
  if (!agent) fieldErrors.agent = 'Agent is required.'

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

  const caps = await getSchemaCapabilities()

  const patch: Record<string, unknown> = {
    amount: amount as number,
    months_paid: monthsPaid,
    payment_type: paymentType,
    payment_date: paymentDate.toISOString(),
    agent,
    notes: notes || null,
  }

  // paid_on is the column reporting reads, so a correction to the date has to
  // move it too. Leaving it behind would put the edited payment in one day's
  // collections and print another date on its receipt.
  if (caps.otherPayments) patch.paid_on = ymd(paymentDate)

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

  if (effect.carriedBefore !== null && effect.carriedAfter !== null) {
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
      expiry: await standingExpiry(customer?.identity ?? null),
      actor: profile.email,
    }),
  })

  revalidatePath('/dashboard/payments')
  revalidatePath('/dashboard/payments/' + payment.id)
  if (payment.customer_id) revalidatePath('/dashboard/customers/' + payment.customer_id)
  revalidatePath('/dashboard')

  redirect('/dashboard/payments/' + payment.id + '?toast=' + encodeURIComponent('Payment updated'))
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
  // the moment the money was taken back — the pairing this entry exists to make
  // visible. radcheck is untouched by any of this; that is the point.
  const expiryAtChange = await standingExpiry(customer?.identity ?? null)

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

  if (effect.carriedBefore !== null && effect.carriedAfter !== null) {
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
      expiry: expiryAtChange,
      actor: profile.email,
    }),
  })

  revalidatePath('/dashboard/payments')
  if (payment.customer_id) revalidatePath('/dashboard/customers/' + payment.customer_id)
  revalidatePath('/dashboard')

  redirect(
    '/dashboard/payments?toast=' + encodeURIComponent('Payment of ' + money(amount) + ' deleted')
  )
}
