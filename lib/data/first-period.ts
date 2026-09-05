import 'server-only'

import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * "Is this the customer's first payment since ISPMan provisioned them?"
 *
 * NO `activated_at` COLUMN, AND DELIBERATELY SO. The provisioning moment is
 * already recorded: app/actions/customers.ts#provisionCustomer writes a
 * `network_provision` row into `log` carrying the customer id and a timestamp.
 * A column would be a second copy of that fact, and the two would drift the
 * first time one was written without the other. What is read back here is the
 * audit trail the app already keeps, not a flag maintained alongside it.
 *
 * THE THREE CONDITIONS, all of which must hold:
 *
 *   1. A `network_provision` row exists for this customer. Its `created_at` is
 *      the anchor, T. No row, no first period — this is what excludes every
 *      migrated subscriber, see below.
 *   2. No SERVICE payment has been RECORDED since T.
 *   3. No SERVICE payment is DATED before T.
 *
 * WHY (2) COMPARES created_at AND NOT payment_date. The till accepts a past
 * date on purpose — money is often entered days after it was taken. A cashier
 * backdating the first payment to before provisioning would leave the flag
 * standing and pro-rata the SECOND payment as well. The question being asked is
 * "has anything been entered since we switched them on", which is about when
 * the row was written, not about when the cash changed hands.
 *
 * WHY (3) EXISTS AT ALL, given (1) and (2). It is the guard against a migrated
 * subscriber who is later provisioned individually through the UI — they would
 * acquire an anchor, and if their imported history fell outside the import
 * window (scripts/migrate-legacy-company.mjs only carries payments since
 * PAYMENTS_SINCE) they could otherwise pass. Payment history predating the
 * provisioning event means the customer had service before ISPMan did, which is
 * the definition of not being new.
 *
 * WHY SERVICE PAYMENTS ONLY. An installation fee or a router sale is a real
 * `payments` row written by app/actions/payments.ts#recordOtherPayment, and
 * those are COMMON at activation. Counting them would silently deny pro-rata to
 * exactly the customers most likely to get one. Before migration 0013 there is
 * no payment_kind and every row is a service payment, which is the same answer.
 *
 * THE ~1,285 MIGRATED SUBSCRIBERS CANNOT REACH THIS, for two independent
 * reasons, either of which would be enough:
 *
 *   - scripts/migrate-legacy-company.mjs writes NO log rows whatsoever. It
 *     inserts customers and payments as plain rows and calls no app action.
 *   - bulk provisioning writes ONE `bulk_provision` row with a NULL customer id
 *     (app/actions/bulk.ts#logBulkProvision), not one `network_provision` row
 *     per customer. Sweeping them into the registry still produces no anchor.
 *
 * The accepted consequence is that a genuinely new customer who is BULK
 * provisioned gets no pro-rata either. That matches what bulk provision already
 * means here — app/actions/bulk.ts#expiryForCustomer deliberately skips the
 * 21-day rule for the same reason.
 *
 * FAILS TO "NOT FIRST". Every error path returns null, which prices the payment
 * at the ordinary rate. Being wrong in that direction charges the customer what
 * the rate card says; being wrong in the other direction overcharges them for
 * days they did not buy.
 */
export async function firstPeriodAnchor(
  companyId: number,
  customerId: number
): Promise<Date | null> {
  const db = tenantClient()

  // --- 1. The anchor -------------------------------------------------------
  //
  // EARLIEST, not latest. A customer can only be re-provisioned if their
  // radcheck rows were deleted outside this app (lib/status.ts#canProvision
  // requires 'unprovisioned'), and if that ever happens the first activation is
  // still the one that decides whether they are new. Taking the earliest also
  // makes condition 2 strictly harder to satisfy, which is the safe direction.
  const { data: provision, error: provisionError } = await db
    .from('log')
    .select('created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('type', 'network_provision')
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (provisionError) {
    console.error('[first-period] provision lookup failed:', provisionError.message)
    return null
  }

  const anchorRaw = (provision as { created_at: string | null } | null)?.created_at
  if (!anchorRaw) return null

  const anchor = new Date(anchorRaw)
  if (!Number.isFinite(anchor.getTime())) return null

  // --- 2 and 3. Any disqualifying service payment --------------------------
  //
  // Two counts rather than one `.or()`: an ISO timestamp carries colons and a
  // zone offset, and quoting those inside PostgREST's or() grammar is a trap
  // for the next person to edit this. Two head-only counts cost one round trip
  // between them and cannot be misread.
  const caps = await getSchemaCapabilities()

  const servicePayments = () => {
    const q = db
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('customer_id', customerId)
    // Before 0013 there is no payment_kind and every row is a service payment.
    return caps.otherPayments ? q.eq('payment_kind', 'service') : q
  }

  const [since, before] = await Promise.all([
    servicePayments().gte('created_at', anchor.toISOString()),
    servicePayments().lt('payment_date', anchor.toISOString()),
  ])

  if (since.error || before.error) {
    console.error(
      '[first-period] payment lookup failed:',
      since.error?.message ?? before.error?.message
    )
    return null
  }

  if ((since.count ?? 0) > 0) return null
  if ((before.count ?? 0) > 0) return null

  return anchor
}
