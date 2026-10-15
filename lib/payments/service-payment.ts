// The one definition of what recording a service payment DOES.
//
// Lifted out of app/actions/payments.ts so there is exactly one path that
// settles a balance, moves network access, writes the receipt row and logs the
// extension — reached both by the staff till (recordPayment, which parses the
// form and supplies the signed-in cashier as the actor) and by an online
// payment (the Fygaro webhook, which supplies an "Online payment" actor with no
// staff user). Two callers, one body: a second copy of this would drift, and a
// payment path that drifts is the worst place for the "a parser written twice
// will differ" failure this repo was burned by (AGENTS.md).
//
// This file is deliberately NOT a 'use server' module. Everything exported from
// one becomes a callable server action endpoint; a payment core taking a raw
// customerId, amount and actor must never be reachable that way, or a client
// could POST a payment for anyone. The callers are the authorisation boundary.

import { revalidatePath } from 'next/cache'

import {
  billingPeriod, calendarMonthSettled, carriedBalanceAfter, effectiveBillDay, isPartialPayment,
  monthsCovered, parseYmd, periodAlreadyGranted, periodCompletion, prepaymentCredit,
  proportionalDate, serviceExpiry, ymd, type AccessDecision,
} from '@/lib/billing'
import { legacyPaymentType, type PaymentMethod } from '@/lib/data/checkoff'
import { formatCurrencyExact, paymentInstant } from '@/lib/format'
import {
  billedThroughOf, PREPAID_CALENDAR_OFF, prepaidCalendarFor, readMonthCharges,
} from '@/lib/data/prepaid-calendar'
import {
  calendarExpiry, forwardLines, laterYmd, monthLabel, round100, tillBreakdown,
  type BreakdownLine, type TillBreakdown,
} from '@/lib/prepaid-calendar'
import { getExpiryClock } from '@/lib/data/company'
import { applyExpiryClock } from '@/lib/radius/format'
import { firstPeriodAnchor } from '@/lib/data/first-period'
import { findOrCreatePaymentCategory } from '@/lib/data/payment-categories'
import { grantAnchor, latestGrant } from '@/lib/data/period-grants'
import { canExtend } from '@/lib/status'
import { getRadiusStatus as readNetworkRecord, radiusConfigured } from '@/lib/radius-db'
import { applyRadiusWrite, radiusLogDetails } from '@/lib/radius/operations'
import { type SchemaCapabilities } from '@/lib/schema'
import { logEvent } from '@/lib/audit'
import { notifyPaymentReceipt } from '@/lib/sms/notify'
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
       * True when the payment bought no months, so the expiry was left where
       * it was and nothing was written to the network. The money is held as
       * credit (`creditHeld`) for the next bill run to draw down.
       */
      accessUnchanged?: boolean
      /** Credit this payment created, for the panel to say where the money went. */
      creditHeld?: number
      /**
       * The row just written. The receipt modal re-reads the payment by this
       * id rather than being handed a receipt built here, so the receipt shown
       * after a payment and a reprint of it months later come from the same
       * code path. See lib/data/receipts.ts.
       */
      paymentId?: number
      /**
       * Migration 0025: what this visit paid against one-off charges, and what
       * each still owes afterwards. Absent or empty when none were paid.
       * `amount` above is the whole visit; `servicePaid` is the service part.
       */
      oneOff?: { category: string; paid: number; owing: number }[]
      servicePaid?: number
    }
  | { ok: false; error: string; fieldErrors?: Record<string, string> }

/** Money is stored as numeric; keep float drift out of what we write back. */
export const round2 = (n: number) => Math.round(n * 100) / 100

/** `date`, or `limit` when that is earlier. No limit, no cap. */
const capAt = (date: Date, limit: Date | null) =>
  limit && limit.getTime() < date.getTime() ? limit : date

export const money = (n: number) =>
  'J$' + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n)

export type Allocation = { chargeId: number; amount: number }

export type CheckedAllocation = Allocation & {
  categoryId: number
  category: string
  outstandingBefore: number
}

/** The payments rows for a visit's charge amounts. No billing column is set. */
export function chargePaymentRows(opts: {
  companyId: number
  customerId: number
  checked: CheckedAllocation[]
  visitId: string
  paidOn: string
  stampedAt: Date
  method: PaymentMethod
  agent: string
  notes: string
  userId: number | null
  segmentId: number | null
  caps: SchemaCapabilities
}): Record<string, unknown>[] {
  return opts.checked.map((a) => {
    const row: Record<string, unknown> = {
      company_id: opts.companyId,
      customer_id: opts.customerId,
      amount: a.amount,
      // Bought no months of service, same as any "other" payment.
      months_paid: 0,
      payment_kind: 'other',
      payment_category_id: a.categoryId,
      charge_id: a.chargeId,
      visit_id: opts.visitId,
      charge_outstanding_before: a.outstandingBefore,
      paid_on: opts.paidOn,
      payment_date: opts.stampedAt.toISOString(),
      payment_type: legacyPaymentType(opts.method),
      agent: opts.agent,
      notes: opts.notes || null,
    }
    if (opts.caps.checkoff) {
      row.payment_method = opts.method
      row.checked_off = false
      row.user_id = opts.userId
    }
    if (opts.caps.paymentSegment) row.customer_misc_category_id = opts.segmentId
    return row
  })
}

/**
 * The trigger's refusal, in the cashier's words. Anything else passes through.
 */
export function visitInsertError(message: string): string {
  return message.includes('charge_guard:')
    ? 'A one-off charge changed while this payment was being entered — it was ' +
      'paid or voided at another till. Nothing was recorded. Reselect the ' +
      'customer and try again.'
    : 'Could not record payment: ' + message
}

/** What the success panel says about the charges a visit paid. */
export function oneOffSummary(checked: CheckedAllocation[]) {
  return checked.map((a) => ({
    category: a.category,
    paid: a.amount,
    owing: round2(a.outstandingBefore - a.amount),
  }))
}

/** Who a payment is attributed to, in place of the staff session. */
export type ServicePaymentActor = {
  /** Free-text agent stamped on the payment row (a cashier's name, or "Online payment (Fygaro)"). */
  agent: string
  /** users.id for checkoff attribution, or null for a payment no staff member collected. */
  userId: number | null
  /** The actor in the audit log's `by=` lines (a cashier's email, or a channel name). */
  email: string
}

/**
 * Everything the service path needs, already validated by the caller. The till
 * recomputes none of this from a form here — recordPayment does that parsing and
 * hands clean values down; an online payment hands them straight from the
 * verified webhook. What the money buys is still derived below from `paidAmount`
 * and the customer's own record, never trusted from the caller.
 */
export type ServicePaymentInput = {
  company: { id: number; name: string }
  caps: SchemaCapabilities
  actor: ServicePaymentActor
  customerId: number
  paidAmount: number
  /** The business date: midday on the stated day in the server's zone. */
  paymentDate: Date
  method: PaymentMethod
  notes: string
  /** The cashier's access choice for a short payment; '' (none) for an online payment. */
  accessDecisionRaw: string
  /** A cashier-picked access date; null for an online payment. */
  chosenDate: Date | null
  /** One-off charge allocations paid in the same visit; empty for an online payment. */
  checked: CheckedAllocation[]
  /** The reconnection-fee box, ticked; false for an online payment. */
  chargeFee: boolean
}

/**
 * Records a payment, settles what it leaves owing, and moves network access.
 *
 * The two billing types share this one path and differ in three places only:
 * which date access runs to, whether a billing period is stamped on the row,
 * and which customer columns are written. How a short payment is settled is
 * identical for both.
 *
 * Nothing the caller computed about what the money buys is trusted. The amount
 * due, the shortfall and the proportional date are all recalculated here from
 * the customer's own record — the caller supplies only how much was handed over,
 * and which date was chosen if one was.
 */
export async function recordServicePayment(input: ServicePaymentInput): Promise<PaymentResult> {
  const {
    company, caps, actor, customerId, paidAmount, paymentDate, method, notes,
    accessDecisionRaw, chosenDate, checked, chargeFee,
  } = input
  const agent = actor.agent

  const db = tenantClient()

  const chargeTotal = round2(checked.reduce((s, a) => s + a.amount, 0))

  const cols =
    'id, first_name, last_name, last_bill_date, mac_address, monthly_rate, cut_off_date' +
    (caps.catalog ? ', misc_category_id' : '') +
    (caps.connectionTypes ? ', customer_type, pppoe_username' : '') +
    (caps.expiryMode ? ', expiry_mode' : '') +
    (caps.billing
      ? ', carried_balance, account_credit, bill_date, last_billed_date'
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
    carried_balance?: number | string | null
    account_credit?: number | string | null
    bill_date?: number | null
  } | null

  if (!customer) return { ok: false, error: 'That customer no longer exists.' }

  const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || 'Customer'

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
  // `let`: calendar-month prepaid rewrites this month's charge for a returning
  // customer before pricing, and the balance is re-read from that write.
  let carriedBefore = caps.billing ? Number(customer.carried_balance ?? 0) : 0
  let creditOnRecord = caps.billing ? Number(customer.account_credit ?? 0) : 0

  // The company's bill day, and its timezone. Read before the pricing because
  // the bill day names the period this payment settles, and the
  // one-month-per-period guard below is keyed on that.
  //
  // NOT grace_period_days. It used to ride on this read and be added to the
  // expiry; grace is no longer part of the billing model and nothing on the
  // expiry path reads it — see lib/billing.ts#serviceExpiry.
  const { data: settingsRow } = await db
    .from('settings')
    .select('bill_date, timezone')
    .eq('company_id', company.id)
    .maybeSingle()

  const companySettings = settingsRow as unknown as {
    bill_date: number | null
    timezone: string | null
  } | null

  // The instant payment_date is written from: now for a payment dated today
  // in the company's zone, noon in that zone for a back-dated one. One
  // definition for every writer — lib/format.ts#paymentInstant.
  const stampedAt =
    paymentInstant(ymd(paymentDate), new Date(), companySettings?.timezone ?? 'America/Jamaica') ??
    paymentDate

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

  // --- Calendar-month prepaid: a disconnected customer coming back (0028) ---
  //
  // With the model on, a customer whose service has ended pays for this month's
  // days of service: the days they had before it ended, plus the day they pay
  // to the month's end (lib/prepaid-calendar.ts#tillBreakdown). Earlier months
  // were already reduced by the hourly pass. That change to this month's charge
  // is written HERE, through set_month_charge() — locked, guarded by the amount
  // the till read — BEFORE anything is priced, so the balance below already
  // includes it and every line after this is the ordinary payment path. If the
  // payment then fails to record, the change is put back.
  const calendar = caps.billing ? await prepaidCalendarFor(company.id) : PREPAID_CALENDAR_OFF

  // NO FIRST PERIOD FOR ANYONE (owner, 11 Oct 2026; Option A removed). A
  // customer's connection month is a month charge like any other — or no charge
  // at all — by the company's setting (0032, lib/data/prepaid-calendar.ts
  // #chargesConnectionMonth). The till asks for what is on the balance.
  //
  // firstAnchor survives only to say "this is their first payment since
  // provisioning", which decides where the model lands the expiry below.
  const firstAnchor = calendar.enabled ? await firstPeriodAnchor(company.id, customer.id) : null
  const model = calendar.enabled

  // Service has ended: the registry knows the customer and their access is
  // not on. Decides the reconnection fee for every company, and the month's
  // recompute under the model.
  const disconnectedNow = registered !== null && registered.exists && registered.status !== 'active'
  const returning = model && disconnectedNow
  const returnDay = ymd(paymentDate)
  let monthChange: {
    current: NonNullable<TillBreakdown['current']>
    endedOnBefore: string | null
  } | null = null
  let breakdownLines: BreakdownLine[] | null = null

  if (returning) {
    const breakdown = tillBreakdown({
      today: returnDay,
      monthlyCharge,
      carriedBefore,
      charges: await readMonthCharges(company.id, customer.id),
      disconnected: true,
      forwardMonths: 0,
      billedThrough: await billedThroughOf(company.id, customer.id),
    })
    breakdownLines = breakdown.lines

    if (breakdown.current) {
      const { data: mark } = await db
        .from('customers').select('service_ended_on')
        .eq('company_id', company.id).eq('id', customer.id).maybeSingle()
      const endedOnBefore = (mark as { service_ended_on: string | null } | null)?.service_ended_on ?? null

      const { data: applied, error: applyError } = await db.rpc('set_month_charge', {
        p_company_id: company.id,
        p_customer_id: customer.id,
        p_period_start: breakdown.current.periodStart,
        p_period_end: breakdown.current.periodEnd,
        p_charged_on: returnDay,
        p_amount: breakdown.current.amount,
        p_service_days: breakdown.current.serviceDays,
        p_full_amount: breakdown.current.fullAmount,
        p_source: 'till',
        p_expected_amount: breakdown.current.expected,
        p_touch_service: true,
        p_service_ended_on: null,
      })
      const result = applied as { ok: boolean; carried_after?: number; credit_after?: number } | null
      if (applyError || !result?.ok) {
        return {
          ok: false,
          error:
            'This customer’s charges changed while the payment was being entered — the hourly ' +
            'billing pass or another till moved them. Nothing was recorded. Reselect the ' +
            'customer and try again.',
        }
      }
      carriedBefore = Number(result.carried_after ?? carriedBefore)
      creditOnRecord = Number(result.credit_after ?? creditOnRecord)
      monthChange = { current: breakdown.current, endedOnBefore }
    }
  }

  // A NEW CUSTOMER'S FIRST PAYMENT under the model. Provisioning charged the
  // connection day to the month's end and wrote an expiry; this settles that
  // charge. Counted like a return — the current month if any money is paid, a
  // whole rounded month for each month beyond — and landed on the cut-off day
  // after the last month paid, never short of the date provisioning gave. The
  // ordinary walk from the registry expiry would count the first month again
  // on top of the date that already covers it: a free month.
  const calendarFirst = model && !returning && registryExpiry !== null && firstAnchor !== null

  /** Puts this month's charge back as it was, when the payment did not record. */
  const undoMonthChange = async () => {
    if (!monthChange) return
    await db.rpc('set_month_charge', {
      p_company_id: company.id,
      p_customer_id: customer.id,
      p_period_start: monthChange.current.periodStart,
      p_period_end: monthChange.current.periodEnd,
      p_charged_on: returnDay,
      p_amount: monthChange.current.expected ?? 0,
      p_service_days: monthChange.current.expected === null ? 0 : monthChange.current.serviceDays,
      p_full_amount: monthChange.current.fullAmount,
      p_source: 'till',
      p_expected_amount: monthChange.current.amount,
      p_touch_service: true,
      p_service_ended_on: monthChange.endedOnBefore,
    })
  }

  // --- What this payment is settling ---------------------------------------
  //
  // The amount due IS the carried balance and nothing else, for everybody
  // (lib/billing.ts#amountDue). There is no first period any more (owner,
  // 11 Oct 2026): a connection month is either charged as a month, by the
  // company's setting, or not charged at all.
  const due = round2(carriedBefore)

  const partial = isPartialPayment(due, paidAmount)
  const carriedAfter = carriedBalanceAfter(due, paidAmount)

  // --- Prepayment ----------------------------------------------------------
  //
  // Anything handed over beyond what is due is money for months not yet billed.
  // It is held as account_credit and drawn down by future bill runs before they
  // add anything to carried_balance (app/actions/bulk.ts#billBatch), so a
  // customer who paid three months up front never reads as owing during the
  // months they have already paid for.
  const creditBefore = caps.billing ? creditOnRecord : 0
  const creditAdded = caps.billing ? prepaymentCredit(due, paidAmount) : 0
  const creditAfter = round2(creditBefore + creditAdded)

  // MONTHS BOUGHT FORWARD, from the MONEY and never from the form's dropdown.
  //
  // monthsCovered: the month being settled, if there is one, plus a month per
  // whole charge beyond what was owed. That can
  // be ZERO — nothing owed and less than a month's money — and zero is handled
  // below as "access unchanged, money held as credit", never passed to
  // serviceExpiry, which would floor it to a month nobody paid for.
  // --- One month per period ------------------------------------------------
  //
  // THE GUARD. If an earlier payment already moved the expiry for the period
  // this one settles, this payment settles the debt and buys no month for it:
  // owing 4,500, a 4,000 grants the month and writes 8 Oct; the 500 the next
  // day clears the balance and the expiry stays 8 Oct. Before this the 500 saw
  // a positive balance, counted a month to settle, and walked the customer to
  // 8 Nov — two months for one month's money, on every debt paid in two goes.
  //
  // The evidence is the prior payment's own row (lib/data/period-grants.ts);
  // the match is lib/billing.ts#periodAlreadyGranted, which the till runs too.
  // The period is named from the payment date and the bill day exactly as it
  // is stamped on the row below, so the key the guard compares is the key the
  // row will carry.
  //
  // UNDER THE MODEL it is the CALENDAR MONTH the charge covers, on the
  // company's bill day (the engine's day), and a prior grant is compared by the
  // month ITS payment date settled under the same rule — not by the label it
  // was stamped with under the arrears rule, one month behind.
  // Prepaid or postpaid alike once the engine bills the company by calendar
  // month (calendar.calendarMonths).
  const byMonth = calendar.calendarMonths
  const periodBillDay = byMonth
    ? effectiveBillDay(null, companySettings?.bill_date)
    : effectiveBillDay(customer.bill_date, companySettings?.bill_date)
  const period = billingPeriod(paymentDate, periodBillDay, carriedBefore, byMonth)

  // Not for a returning calendar-month customer either: their month was just
  // recomputed from the days they had, and paying it is what brings them back.
  const grant = caps.billing && !returning && !calendarFirst
    ? await latestGrant(company.id, customer.id)
    : null
  const periodGranted =
    grant !== null &&
    periodAlreadyGranted({
      periodStart: period?.start ?? null,
      carriedBefore,
      grant: byMonth ? { ...grant, periodStart: calendarMonthSettled(grant.paidOn, periodBillDay) } : grant,
    })

  // Where a guarded payment may complete an open month to, or null: the
  // expiry then stays where it is. Only a grant that picked a date left a
  // month open, and only that case reads the anchor back from the audit row.
  const completion: Date | null =
    periodGranted && grant
      ? periodCompletion({
          grant,
          anchorThen: await grantAnchor(company.id, customer.id, grant),
          registryExpiry,
          cutOffDay: customer.cut_off_date ?? null,
        })
      : null

  // Calendar-month prepaid prices months ahead at the full rate ROUNDED, so a
  // returning customer's months are counted against that figure: the current
  // month if any money is paid (a part payment reconnects, as today), plus one
  // per whole rounded month beyond what is owed.
  const monthsPaid = returning || calendarFirst
    ? monthsCovered(due, round100(monthlyCharge), paidAmount, false)
    : monthsCovered(due, monthlyCharge, paidAmount, periodGranted)

  // A decision only means something for a payment that is actually short. One
  // sent for a payment that covers the bill is dropped rather than stored.
  //
  // NOR FOR A SHORT PAYMENT WITH NOTHING TO DECIDE: when the period already has
  // its month and there is no open month to complete, the till offers no
  // choice (both would give the same answer) and none is stored.
  const decision: AccessDecision | null =
    partial && !(periodGranted && !completion)
      ? accessDecisionRaw === 'date_selected' ? 'date_selected' : 'full_period'
      : null

  // A COMPLETION IS BOUNDED. The first picker is deliberately unbounded — a
  // manager over-granting is a decision. The second is not: it is finishing a
  // month somebody already started, and a date past that month's cut-off is
  // the next month, which this money did not buy.
  if (decision === 'date_selected' && chosenDate && completion &&
      chosenDate.getTime() > completion.getTime()) {
    return {
      ok: false,
      error: 'Please correct the highlighted fields.',
      fieldErrors: {
        access_date:
          'This payment completes the month already granted, which ends ' +
          ymd(completion) + '. A later date would start a new month.',
      },
    }
  }

  // WHERE THE WALK STARTS. The registry expiry, as always — except for a
  // guarded payment completing a picked-date month, which starts from the end
  // of that month: the hop from the picked date to its cut-off is the month
  // already paid for, not one this money bought.
  const walkFrom: Date | null = completion ?? registryExpiry

  // The date a full payment would have reached, and the "Full Period" branch of
  // a short one. One calculation for everybody now — the months-from-expiry
  // walk went with the prepaid arm and its months-to-pay selector.
  //
  // A PAYMENT THAT BUYS NO MONTHS DOES NOT MOVE THE EXPIRY. For a first payment
  // it stays exactly where provisioning put it, because that is the end of the
  // period the money is paying for. For anyone else it is a short prepayment
  // on a clear balance, or a payment on a period that already has its month:
  // the expiry stays where the registry holds it (null when the customer is
  // not on the network) and the money is credit or settles the debt.
  // serviceExpiry cannot say either — it floors months at 1, which is right
  // for a renewal and wrong here — so the branch is taken before the call
  // rather than by passing it a zero it would ignore. The one exception is a
  // completion, which moves to the end of the open month without buying one.
  //
  // A RETURNING CALENDAR-MONTH CUSTOMER lands on the cut-off day of the month
  // after the last month paid: paying this month on 16 Oct gives 8 Nov, and
  // November as well gives 8 Dec. Walking from the lapsed expiry would stop at
  // the next cut-off — on 3 Nov that is 8 Nov, for money that paid to 30 Nov.
  // A first payment lands the same way, but never short of the date
  // provisioning gave: provisioned 25 Oct to 8 Dec, paying October keeps 8 Dec.
  const calendarDate =
    (returning || calendarFirst) && monthsPaid > 0 && customer.cut_off_date
      ? parseYmd(laterYmd(
          calendarExpiry(returnDay, monthsPaid, customer.cut_off_date),
          calendarFirst && registryExpiry ? ymd(registryExpiry) : null
        ))
      : null
  const fullPeriodExpiry: Date | null =
    monthsPaid === 0
      ? walkFrom
      : calendarDate ?? serviceExpiry({
          // cut_off_date, not bill_date: the bill day says when the charge is
          // raised, the cut-off day says when access ends. Anchored on the
          // registry expiry so settling the bill rolls the customer PAST the
          // cut-off that bill was due at rather than up to it.
          cutOffDay: customer.cut_off_date ?? null,
          currentExpiry: walkFrom,
          from: paymentDate,
          // A prepayment moves the expiry the WHOLE distance now, not one month
          // per bill run. The customer paid for the months today, so they hold
          // them today.
          months: monthsPaid,
        })

  const newExpiry: Date | null =
    decision === 'date_selected' && chosenDate ? chosenDate : fullPeriodExpiry

  // Nothing was bought, so nothing moves and nothing is written to the
  // network. Decided here, once, so the row, the log and the panel all say the
  // same thing. A completion is the one zero-month payment that does move:
  // to the end of the month already paid for, never beyond it.
  const accessUnchanged = monthsPaid === 0 && !completion

  // Recomputed rather than trusted, so the log records the real proportional
  // date even if the form sent a stale one. Capped at the completion date when
  // there is one: a proportional suggestion past the end of the open month
  // would be a date this money cannot reach.
  const proportional = partial
    ? capAt(
        proportionalDate({
          amountPaid: paidAmount,
          monthlyCharge,
          currentExpiry: registryExpiry,
          from: paymentDate,
        }),
        completion
      )
    : null

  const beyondProportional = Boolean(
    decision === 'date_selected' && proportional && newExpiry &&
    ymd(newExpiry) > ymd(proportional)
  )

  // --- Record the payment ---------------------------------------------------
  //
  // payment_method carries the full list; payment_type is the older, narrower
  // column that existing reads still depend on. Both are written so nothing
  // regresses while 0010 is rolling out. See lib/data/checkoff.ts. The caller
  // resolves which method this is and hands it down.

  const insertRow: Record<string, unknown> = {
    company_id: company.id,
    customer_id: customer.id,
    amount: paidAmount,
    // A completion bought no month by the money, but it did move the expiry —
    // to the end of the month the picked-date payment before it had started.
    // Stamped at least 1 so the receipt does not print it as unchanged
    // (lib/data/receipts.ts reads months_paid 0 as exactly that) and so the
    // next guard read sees it as a grant: the month is now complete.
    months_paid: completion ? Math.max(1, monthsPaid) : monthsPaid,
    payment_type: legacyPaymentType(method),
    payment_date: stampedAt.toISOString(),
    agent,
    notes: notes || null,
  }

  if (caps.checkoff) {
    insertRow.payment_method = method
    insertRow.checked_off = false
    // The collector's identity, so "My Collections" and checkoff can attribute
    // the payment even if the free-text agent field is later edited. Null for a
    // payment no staff member collected (an online payment).
    insertRow.user_id = actor.userId
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
    // The billed month this payment settles — NULL WHEN IT SETTLES NONE. With
    // nothing carried the money is a prepayment and there is no month to name;
    // this used to stamp one anyway, derived from the date alone, and wrote
    // July onto payments by customers first provisioned in September. Bills
    // will read these columns, so a null that is true beats a month that is
    // not. See lib/billing.ts#billingPeriod.
    //
    // The bill day comes through effectiveBillDay — the customer's own, else
    // the company's — the same resolution the bill run uses, so the month a
    // payment says it settled is the month the run said it raised. Computed
    // once, above, where the guard compares it.
    insertRow.billing_period_start = period?.start ?? null
    insertRow.billing_period_end = period?.end ?? null
    // The expiry this payment leaves the customer with. For a payment that
    // bought nothing that is the one they already held, stamped so the receipt
    // can print it as unchanged; null when there is no registry expiry to keep.
    insertRow.access_granted_until = newExpiry ? ymd(newExpiry) : null
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
    // than reassembling it from parts. See migration 0017 and
    // lib/data/receipts.ts.
    insertRow.amount_due = due
    // No first-period discount exists any more (11 Oct 2026); a stamped 0 says
    // none was given, where NULL would only say nobody recorded one.
    insertRow.first_period_discount = 0
  }

  // A payment that bought nothing still stamps the expiry the customer holds,
  // because the receipt prints "Service active until" from this column and has
  // to say access is unchanged rather than say nothing. The extend path below
  // stamps it after the write for every other payment.
  if (caps.otherPayments && accessUnchanged && newExpiry) {
    insertRow.service_active_until = ymd(newExpiry)
  }

  if (caps.creditReversal) {
    // THE REVERSAL RECORD (migration 0015). Written for EVERY payment, zero
    // included, not just the ones that created credit: a correction has to be
    // able to tell "this payment made no credit" from "nobody recorded what it
    // made", and only a stamped 0 says the first. Rows predating 0015 are NULL
    // and their corrections skip the reversal rather than guess.
    insertRow.credit_applied = creditAdded
  }

  // Calendar-month prepaid: the per-month lines the till showed — this month's
  // days and amount, any earlier months, and whole months paid ahead — so the
  // receipt prints exactly what the customer was shown (migration 0028).
  if (returning && breakdownLines) {
    insertRow.service_breakdown = [
      ...breakdownLines,
      ...forwardLines(returnDay, Math.max(0, monthsPaid - 1), monthlyCharge),
    ]
  }

  // THE RECONNECTION FEE (0028). Offered only at the till and only to a
  // customer whose service has ended — prepaid or postpaid alike (owner,
  // 8 Oct 2026); ticked on by default, and the cashier may leave it off.
  // It is NOT service money: its own payments row ("Reconnection fee"), in the
  // same visit, settling like a one-off charge. It moves no expiry, changes no
  // days charged, and is never added to a balance — someone who never comes
  // back does not owe it.
  const feeOffered =
    disconnectedNow && calendar.reconnectionFee > 0 && caps.otherPayments && caps.charges
  const feeCharged = feeOffered && chargeFee
  let feeRow: Record<string, unknown> | null = null
  if (feeCharged) {
    const category = await findOrCreatePaymentCategory(company.id, 'Reconnection fee')
    if (!category.ok) {
      await undoMonthChange()
      return { ok: false, error: 'Could not record the reconnection fee: ' + category.error }
    }
    feeRow = {
      company_id: company.id,
      customer_id: customer.id,
      amount: calendar.reconnectionFee,
      months_paid: 0,
      payment_kind: 'other',
      payment_category_id: category.category.id,
      paid_on: returnDay,
      payment_date: stampedAt.toISOString(),
      payment_type: legacyPaymentType(method),
      agent,
      notes: null,
    }
    if (caps.checkoff) {
      feeRow.payment_method = method
      feeRow.checked_off = false
      feeRow.user_id = actor.userId
    }
    if (caps.paymentSegment) feeRow.customer_misc_category_id = customer.misc_category_id ?? null
  }
  const feeAmount = feeRow ? calendar.reconnectionFee : 0

  // THE VISIT'S CHARGE ROWS GO IN WITH THE SERVICE ROW, IN ONE STATEMENT. If
  // the guard refuses one, the service payment is refused with it, so a
  // cashier never has a visit that is half on record. See the note at the top
  // of this file. A reconnection fee rides in the same visit.
  const visitId = checked.length > 0 || feeRow ? crypto.randomUUID() : null
  if (visitId) insertRow.visit_id = visitId
  if (feeRow && visitId) feeRow.visit_id = visitId

  const chargeRows = visitId
    ? chargePaymentRows({
        companyId: company.id,
        customerId: customer.id,
        checked,
        visitId,
        paidOn: ymd(paymentDate),
        stampedAt,
        method,
        agent,
        notes,
        userId: actor.userId,
        segmentId: customer.misc_category_id ?? null,
        caps,
      })
    : []

  const extraRows = feeRow ? [...chargeRows, feeRow] : chargeRows
  const { data: inserted, error: insertError } = extraRows.length > 0
    ? await db
        .from('payments')
        // defaultToNull false: the service row and the charge rows carry
        // different columns, and a column one of them leaves out must take
        // its database default, not an explicit NULL.
        .insert([insertRow, ...extraRows], { defaultToNull: false })
        .select('id, charge_id' + (caps.otherPayments ? ', payment_kind' : ''))
    : await db.from('payments').insert(insertRow).select('id')

  if (insertError) {
    await undoMonthChange()
    return { ok: false, error: visitInsertError(insertError.message) }
  }

  // The service row: by kind where the column exists — a reconnection fee row
  // carries no charge_id either, so "no charge_id" alone no longer identifies it.
  const insertedRows = (inserted ?? []) as unknown as { id: number; charge_id?: number | null; payment_kind?: string }[]
  const paymentId = (
    insertedRows.find((r) => r.payment_kind === 'service') ??
    insertedRows.find((r) => !r.charge_id)
  )?.id as number

  if (feeOffered) {
    await logEvent({
      customerId: customer.id,
      type: feeRow ? 'reconnection_fee_charged' : 'reconnection_fee_waived',
      tag: '[payments]',
      details:
        (feeRow ? 'Reconnection fee charged' : 'Reconnection fee waived') +
        ' | fee=' + calendar.reconnectionFee.toFixed(2) +
        ' | payment_id=' + paymentId +
        ' | by=' + actor.email,
      amount: feeRow ? calendar.reconnectionFee : null,
    })
  }

  if (monthChange) {
    await logEvent({
      customerId: customer.id,
      type: 'service_resumed',
      tag: '[payments]',
      details:
        'Service resumed ' + returnDay + ' at the till. ' + monthLabel(monthChange.current.periodStart) +
        ' ' + (monthChange.current.expected === null ? 'charged ' : formatCurrencyExact(monthChange.current.expected) + ' -> ') +
        formatCurrencyExact(monthChange.current.amount) + ' (' + monthChange.current.serviceDays + ' days)' +
        ' | payment_id=' + paymentId +
        ' | by=' + actor.email,
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
    } else if (accessUnchanged || !newExpiry) {
      // DELIBERATELY NOT A WARNING. This is the correct and expected outcome of
      // a payment that bought no months: a first payment, where the customer
      // already holds access to the end of the period they have just paid for,
      // a short prepayment on a clear balance, where the money is held as
      // credit and the expiry stays put, or a payment on a period that already
      // has its month. Writing the same date back would put an extend through
      // the backwards-write guard for no reason and log an extension that
      // extended nothing.
      //
      // THE GUARDED CASE IS LOGGED, THOUGH. A payment on a positive balance
      // that moved nothing is the one a manager will be asked about ("they
      // paid, why are they still on the old date?"), and the row that answers
      // it — which earlier payment granted the month — should not have to be
      // reconstructed from balances.
      if (periodGranted && grant && newExpiry) {
        await logEvent({
          customerId: customer.id,
          type: 'access_already_granted',
          tag: '[payments]',
          details:
            'Access unchanged | identity=' + identity +
            ' | expiry=' + ymd(newExpiry) +
            ' | granted_by_payment=' + grant.paymentId +
            ' | payment_id=' + paymentId +
            ' | amount=' + paidAmount.toFixed(2) +
            ' | balance_after=' + carriedAfter.toFixed(2) +
            ' | by=' + actor.email,
        })
      }
    } else {
      // extendInRadius still refuses to move an expiry backwards. A cashier who
      // picks a date earlier than the customer already holds lands here and is
      // told so — the guard is not relaxed for partial payments.
      //
      // The company's expiry time goes on at this last step; the walk above works
      // in whole days at midnight and stays that way.
      const result = await applyRadiusWrite(
        'extend',
        identity,
        applyExpiryClock(newExpiry, await getExpiryClock(company.id))
      )

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
        //
        // And, from migration 0031, the Expiration values this write replaced
        // and wrote, exactly as stored: what deleting this payment puts back
        // (lib/data/payment-expiry.ts).
        const stamp: Record<string, unknown> = {}
        if (caps.otherPayments && newExpiry) stamp.service_active_until = ymd(newExpiry)
        if (caps.paymentExpiry && !result.skipped) {
          stamp.expiry_before = result.oldExpiry
          stamp.expiry_after = result.newExpiry
        }
        if (Object.keys(stamp).length) {
          await db
            .from('payments')
            .update(stamp)
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
            actor: actor.email,
            skipped: result.skipped,
            paymentId,
            note:
              'bill period' +
              // A completion moved the customer to the end of a month an
              // earlier payment started, not into a new one.
              (completion && grant ? ', completes_payment=' + grant.paymentId : '') +
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
            ' | by=' + actor.email + ' | ' + result.error,
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

  // Same as the "other" path: queued after the money is recorded, and never
  // able to fail the payment. ONE per visit: the receipt it attaches is read by
  // the service row's id and covers every row the visit wrote.
  await notifyPaymentReceipt({
    companyId: company.id,
    companyName: company.name,
    customerId: customer.id,
    paymentId,
    amount: round2(paidAmount + chargeTotal + feeAmount),
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
    amount: round2(paidAmount + chargeTotal + feeAmount),
    servicePaid: paidAmount,
    oneOff: oneOffSummary(checked),
    customerId: customer.id,
    customerName: fullName,
    // Only surfaced when access actually moved, so the panel never promises an
    // extension that did not happen.
    // Surfaced when access moved, and when it deliberately did not — the panel
    // then says which date it stayed at. Null when there is no date to give.
    newExpiryIso:
      (networkExtended || accessUnchanged) && newExpiry ? newExpiry.toISOString() : null,
    networkExtended,
    accessUnchanged,
    creditHeld: creditAdded,
    warning,
    carriedBalance: caps.billing ? carriedAfter : 0,
    paymentId,
  }
}
