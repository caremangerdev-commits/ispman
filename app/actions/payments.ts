'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import {
  billingPeriod, carriedBalanceAfter, isPartialPayment,
  outstandingBalance, parseYmd, postpaidExpiry, proportionalDate, toBillingType,
  ymd, type AccessDecision,
} from '@/lib/billing'
import { legacyPaymentType, toPaymentMethod } from '@/lib/data/checkoff'
import { findOrCreatePaymentCategory } from '@/lib/data/payment-categories'
import { renewal } from '@/lib/domain'
import { can } from '@/lib/permissions'
import { canExtend } from '@/lib/status'
import { getRadiusStatus as readNetworkRecord, radiusConfigured } from '@/lib/radius-db'
import {
  applyRadiusWrite, paymentExpiry, radiusLogDetails,
} from '@/lib/radius/operations'
import { getSchemaCapabilities, type SchemaCapabilities } from '@/lib/schema'
import { logEvent } from '@/lib/audit'
import { displayName, getSession, type Session } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { toExpiryMode } from '@/lib/types'

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
 * A 'payment_recorded' activity-log row IS written. That is the audit trail for
 * money received, not a network event — the Network History card reads only the
 * four network_* types (lib/status.ts#NETWORK_EVENT_TYPES), none of which is
 * written here.
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
    .select('id, first_name, last_name')
    .eq('company_id', company.id)
    .eq('id', customerId)
    .maybeSingle()

  if (loadError) return { ok: false, error: 'Could not load customer: ' + loadError.message }

  const customer = customerRow as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
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

  const { data: inserted, error: insertError } = await db
    .from('payments')
    .insert(insertRow)
    .select('id')
    .single()

  if (insertError) return { ok: false, error: 'Could not record payment: ' + insertError.message }

  await logEvent({
    customerId: customer.id,
    type: 'payment_recorded',
    tag: '[payments]',
    details:
      money(paidAmount) + ' other payment collected by ' + agent +
      ' | purpose_id=' + categoryId + ' | no service extension',
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
  const monthsPaid = num(formData, 'months_paid') ?? 1
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
  if (monthsPaid < 1 || monthsPaid > 6) fieldErrors.months_paid = 'Months paid must be 1 to 6.'

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
    'id, first_name, last_name, balance, last_bill_date, mac_address, monthly_rate, cut_off_date' +
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
    balance: number | string | null
    last_bill_date: string | null
    mac_address: string | null
    monthly_rate: number | string | null
    cut_off_date: number | null
    customer_type?: string | null
    pppoe_username?: string | null
    expiry_mode?: string | null
    billing_type?: string | null
    carried_balance?: number | string | null
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

  const billingType = toBillingType(caps.billing ? customer.billing_type : 'prepaid')
  const postpaid = billingType === 'postpaid'

  const monthlyCharge = Number(customer.monthly_rate ?? 0) + addonTotal
  const carriedBefore = caps.billing ? Number(customer.carried_balance ?? 0) : 0
  const partial = isPartialPayment(monthlyCharge, carriedBefore, paidAmount)
  const carriedAfter = carriedBalanceAfter(monthlyCharge, carriedBefore, paidAmount)
  const outstanding = outstandingBalance(monthlyCharge, paidAmount)

  // A decision only means something for a payment that is actually short. One
  // sent for a payment that covers the bill is dropped rather than stored.
  const decision: AccessDecision | null = partial
    ? accessDecisionRaw === 'date_selected' ? 'date_selected' : 'full_period'
    : null

  // Falls back to 'from_expiry' when migration 0004 has not been applied.
  const mode = toExpiryMode(caps.expiryMode ? customer.expiry_mode : 'from_expiry')
  const { nextBillDate } = renewal(
    customer.last_bill_date, mode, monthsPaid, paymentDate
  )

  // The company grace period is what carries a postpaid customer past their
  // bill day before they are cut off.
  let gracePeriodDays = 0
  if (postpaid && caps.generalSettings) {
    const { data: settingsRow } = await db
      .from('settings')
      .select('grace_period_days')
      .eq('company_id', company.id)
      .maybeSingle()

    gracePeriodDays = Number(
      (settingsRow as { grace_period_days: number | null } | null)?.grace_period_days ?? 0
    )
  }

  // --- Where access should end ---------------------------------------------
  //
  // The registry is read BEFORE the new expiry is computed, because its expiry
  // is the anchor for both the prepaid calculation and the proportional date.
  // Anchoring to last_bill_date instead is what previously wrote an expiry
  // earlier than the customer already had.
  const identity =
    customer.customer_type === 'pppoe' ? customer.pppoe_username : customer.mac_address

  const registered =
    identity && radiusConfigured()
      ? await readNetworkRecord(identity).catch(() => null)
      : null

  const registryExpiry = registered?.expiry ?? null

  // The date a full payment would have reached. Prepaid keeps its existing
  // months-from-expiry calculation untouched; postpaid runs to its bill day
  // plus the grace period. This is also the "Full Period" branch of a short
  // payment, which is the whole point of offering it.
  const fullPeriodExpiry = postpaid
    ? postpaidExpiry(customer.bill_date ?? null, gracePeriodDays, paymentDate)
    : paymentExpiry(mode, registryExpiry, monthsPaid, paymentDate, customer.cut_off_date ?? null)

  const newExpiry =
    decision === 'date_selected' && chosenDate ? chosenDate : fullPeriodExpiry

  // Recomputed rather than trusted, so the log records the real proportional
  // date even if the form sent a stale one.
  const proportional = partial
    ? proportionalDate({
        billingType,
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
    // Only postpaid bills for a period already used, so only postpaid stamps
    // one. A prepaid payment buys months forward and has no such period.
    if (postpaid) {
      const period = billingPeriod(paymentDate)
      insertRow.billing_period_start = period.start
      insertRow.billing_period_end = period.end
    }
    insertRow.access_granted_until = ymd(newExpiry)
    insertRow.carried_balance_before = carriedBefore
    insertRow.carried_balance_after = carriedAfter
    // Null for a payment that cleared the bill: there was no decision to make.
    insertRow.access_decision = decision
  }

  const { data: inserted, error: insertError } = await db
    .from('payments')
    .insert(insertRow)
    .select('id')
    .single()

  if (insertError) return { ok: false, error: 'Could not record payment: ' + insertError.message }

  const paymentId = (inserted as unknown as { id: number }).id

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
              billingType + ', ' +
              (postpaid ? 'bill period' : monthsPaid + ' month(s) paid') +
              ', mode=' + mode +
              (decision ? ', partial=' + decision : ''),
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
  const patch: Record<string, unknown> = {}

  if (postpaid) {
    // Postpaid deliberately writes nothing else. last_bill_date in particular
    // is left alone: it drives the prepaid renewal cycle, and a postpaid
    // customer's cycle is described by last_billed_date and bill_date instead.
    patch.carried_balance = carriedAfter
    patch.last_billed_date = ymd(paymentDate)
  } else {
    // Prepaid keeps exactly the behaviour it had before postpaid existed: the
    // payment clears what it covers and the bill cycle advances.
    patch.balance = Math.max(0, Number(customer.balance ?? 0) - paidAmount)
    patch.last_bill_date = ymd(nextBillDate)
    if (caps.billing) patch.carried_balance = carriedAfter
  }

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

  await logEvent({
    customerId: customer.id,
    type: 'payment_recorded',
    tag: '[payments]',
    details: paymentLogDetails({
      amount: paidAmount,
      agent,
      networkExtended,
      newExpiry,
      decision,
      outstanding,
      proportional,
      beyondProportional,
    }),
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
 * The activity-log sentence for a recorded payment.
 *
 * Four shapes, because the four outcomes are genuinely different facts and this
 * log is what an owner reads back months later to work out what was agreed at
 * the counter. A date beyond the proportional one names the proportional date
 * too, so the decision can be judged without recomputing it.
 *
 * The access clause is only claimed when access actually moved. A payment that
 * saved but never reached the network says so, rather than reporting an
 * extension that did not happen.
 */
function paymentLogDetails(opts: {
  amount: number
  agent: string
  networkExtended: boolean
  newExpiry: Date
  decision: AccessDecision | null
  outstanding: number
  proportional: Date | null
  beyondProportional: boolean
}): string {
  const {
    amount, agent, networkExtended, newExpiry, decision, outstanding,
    proportional, beyondProportional,
  } = opts

  const when = logDate(newExpiry)
  const opening = 'Payment of ' + money(amount) + ' recorded by ' + agent + '.'

  if (!networkExtended) {
    const tail = decision ? ' Outstanding balance: ' + money(outstanding) + '.' : ''
    return opening + ' Access was not extended.' + tail
  }

  if (decision === null) {
    return opening + ' Access extended to ' + when + '.'
  }

  if (decision === 'full_period') {
    return (
      opening + ' Full period granted to ' + when + '. Outstanding balance: ' +
      money(outstanding) + ' carried to next bill.'
    )
  }

  if (beyondProportional && proportional) {
    return (
      opening + ' Access granted to ' + when + ' — beyond proportional date of ' +
      logDate(proportional) + '. Outstanding balance: ' + money(outstanding) + '.'
    )
  }

  return (
    opening + ' Access granted to ' + when + '. Outstanding balance: ' +
    money(outstanding) + '.'
  )
}

const logDate = (d: Date) =>
  d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })

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

  const db = tenantClient()
  const { data, error } = await db
    .from('payments')
    .select('id, amount, customer_id, months_paid, payment_type, payment_date, agent, notes')
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
  } | null

  if (!payment) return { ok: false as const, error: 'That payment no longer exists.' }

  return { ok: true as const, company, profile, db, payment }
}

/**
 * Re-reads a customer's balance and writes an adjusted value.
 *
 * Balance is the amount owed, so recording a payment subtracted from it and any
 * correction has to put the difference back. The balance is re-read here rather
 * than carried from the page, so a payment taken between page load and save is
 * not silently overwritten.
 */
async function adjustBalance(
  db: ReturnType<typeof tenantClient>,
  companyId: number,
  customerId: number | null,
  delta: number
) {
  if (!customerId || delta === 0) return

  const { data } = await db
    .from('customers')
    .select('balance')
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()

  if (!data) return

  const current = Number((data as unknown as { balance: number | string | null }).balance ?? 0)
  await db
    .from('customers')
    .update({ balance: Math.max(0, current + delta) })
    .eq('company_id', companyId)
    .eq('id', customerId)
}

/**
 * Corrects a recorded payment.
 *
 * A correction to the amount is pushed back through the customer's balance, but
 * the billing cycle is deliberately NOT recomputed: `last_bill_date` has moved
 * on and any later payment has advanced it again, so rewinding it from here
 * would corrupt the cycle rather than repair it. Adjust the customer's dates
 * directly if a months-paid correction has to change their expiry.
 */
export async function updatePayment(
  _prev: PaymentResult | null,
  formData: FormData
): Promise<PaymentResult> {
  const paymentId = num(formData, 'payment_id')
  const loaded = await loadForMutation(paymentId, 'edit_payment')
  if (!loaded.ok) return { ok: false, error: loaded.error }

  const { company, profile, db, payment } = loaded

  const fieldErrors: Record<string, string> = {}

  const amount = num(formData, 'amount')
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

  // A larger payment leaves less owing, so the delta is old minus new.
  await adjustBalance(db, company.id, payment.customer_id, previousAmount - (amount as number))

  await logEvent({
    customerId: payment.customer_id,
    type: 'payment_updated',
    tag: '[payments]',
    details:
      'Payment #' + payment.id + ' corrected from ' + money(previousAmount) +
      ' to ' + money(amount as number) + ' by ' + profile.email,
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

  const { company, profile, db, payment } = loaded
  const amount = Number(payment.amount ?? 0)

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

  // The money is no longer recorded as received, so it is owed again.
  await adjustBalance(db, company.id, payment.customer_id, amount)

  await logEvent({
    customerId: payment.customer_id,
    type: 'payment_deleted',
    tag: '[payments]',
    details: 'Payment #' + payment.id + ' of ' + money(amount) + ' deleted by ' + profile.email,
  })

  revalidatePath('/dashboard/payments')
  if (payment.customer_id) revalidatePath('/dashboard/customers/' + payment.customer_id)
  revalidatePath('/dashboard')

  redirect(
    '/dashboard/payments?toast=' + encodeURIComponent('Payment of ' + money(amount) + ' deleted')
  )
}
