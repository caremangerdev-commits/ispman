import 'server-only'

import { toAccessDecision, type PriorGrant } from '@/lib/billing'
import { logField, readLogDetail } from '@/lib/log-detail'
import { parseRadiusExpiration } from '@/lib/radius/format'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The customer's most recent service payment that MOVED THE EXPIRY, read from
 * the payment row itself — the one-month-per-period guard's evidence. See
 * lib/billing.ts#periodAlreadyGranted for how it is matched.
 *
 * "Moved" is two stamps together: months_paid >= 1 (the pricing bought a
 * month) and service_active_until NOT NULL (the registry write landed —
 * app/actions/payments.ts stamps it after the extend returns ok). A payment
 * whose extend failed granted nothing, and the payment after it must still be
 * allowed to grant; a payment that bought no months stamps
 * service_active_until too, with the expiry it left alone, which is why the
 * months_paid half is required as well.
 *
 * Migration 0011 columns throughout, so NULL BEFORE IT IS APPLIED: the guard
 * then never fires and the payment path behaves exactly as it did.
 *
 * FAILS TO "NO GRANT". A read error prices the payment the way it was priced
 * before the guard existed. Being wrong in that direction repeats the old
 * bug for one payment; being wrong in the other direction leaves a paying
 * customer without the access their money bought.
 */
export async function latestGrant(
  companyId: number,
  customerId: number
): Promise<PriorGrant | null> {
  const caps = await getSchemaCapabilities()
  if (!caps.billing || !caps.otherPayments) return null

  const db = tenantClient()

  const { data, error } = await db
    .from('payments')
    .select(
      'id, billing_period_start, carried_balance_after, access_granted_until, ' +
        'access_decision, paid_on, service_active_until'
    )
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('payment_kind', 'service')
    .gte('months_paid', 1)
    .not('service_active_until', 'is', null)
    .not('access_granted_until', 'is', null)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[period-grants] grant lookup failed:', error.message)
    return null
  }

  const row = data as unknown as {
    id: number
    billing_period_start: string | null
    carried_balance_after: number | string | null
    access_granted_until: string
    access_decision: string | null
    paid_on: string | null
  } | null

  if (!row || !row.paid_on) return null

  return {
    paymentId: row.id,
    periodStart: row.billing_period_start,
    carriedAfter: Number(row.carried_balance_after ?? 0),
    grantedUntil: row.access_granted_until,
    decision: toAccessDecision(row.access_decision),
    paidOn: row.paid_on,
  }
}

/**
 * The registry expiry a grant's payment ANCHORED ON — what radcheck held the
 * moment before that payment moved it. Needed only to say where a picked
 * date's month would have run to (lib/billing.ts#periodCompletion), so it is
 * read only for a grant that picked a date.
 *
 * NOT A NEW COLUMN. The extend that wrote the grant logged a `radius_extend`
 * row carrying `old_expiry` (lib/radius/operations.ts#radiusLogDetails), and
 * that row is the record — the same reading of the audit trail that
 * lib/data/first-period.ts does for the provisioning moment. The row is found
 * by customer and by time: it is written in the same request as the payment,
 * after the insert, so it lands within moments of the payment's created_at.
 *
 * Null when no row is found in the window, when the value does not parse, or
 * when the grant did not pick a date. Every null reads as "unknown" and the
 * caller makes no completion from it.
 */
export async function grantAnchor(
  companyId: number,
  customerId: number,
  grant: PriorGrant
): Promise<Date | null> {
  if (grant.decision !== 'date_selected') return null

  const db = tenantClient()

  const { data: payment, error: paymentError } = await db
    .from('payments')
    .select('created_at')
    .eq('company_id', companyId)
    .eq('id', grant.paymentId)
    .maybeSingle()

  if (paymentError || !payment) return null

  const createdAt = new Date((payment as { created_at: string }).created_at)
  if (!Number.isFinite(createdAt.getTime())) return null

  // Five minutes covers a slow RADIUS write; the row is ordered nearest-first
  // so a second extend for the same customer later in the window cannot be
  // taken for this one.
  const windowEnd = new Date(createdAt.getTime() + 5 * 60_000)

  const { data: rows, error: logError } = await db
    .from('log')
    .select('details, created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('type', 'radius_extend')
    .gte('created_at', createdAt.toISOString())
    .lte('created_at', windowEnd.toISOString())
    .order('created_at', { ascending: true })
    .limit(1)

  if (logError) {
    console.error('[period-grants] anchor lookup failed:', logError.message)
    return null
  }

  const first = (rows as { details: string | null }[] | null)?.[0]
  if (!first) return null

  const raw = logField(readLogDetail(first.details).body, 'old_expiry')
  if (!raw || raw === 'none') return null

  return parseRadiusExpiration(raw)
}
