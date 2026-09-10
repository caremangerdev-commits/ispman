'use server'

import { getReceipt } from '@/lib/data/receipts'
import { can, canAny } from '@/lib/permissions'
import type { Receipt } from '@/lib/receipt'
import { getSchemaCapabilities } from '@/lib/schema'
import { displayName, getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * The receipt for one payment.
 *
 * The only way the client obtains a receipt — used both by the modal that
 * appears after a payment is recorded and by the Print action on the payment
 * list and detail pages. One path means a reprint cannot drift from the
 * original: both call this, which reads the same stored row.
 *
 * Gated on being able to record a payment OR to view all payments: a cashier
 * must be able to reprint a receipt for the payment they just took, and a
 * manager must be able to reprint one they did not — and that difference is
 * now enforced rather than assumed, see the ownership check below.
 *
 * THIS IS WHY A CASHIER KEEPS RECEIPTS after view_all_payments narrowed to
 * manager and above: record_payment is held by every role, so the first half
 * of the check still passes for them. Reprinting the receipt for a payment you
 * took is part of taking it.
 */
export async function loadReceipt(paymentId: number): Promise<Receipt | null> {
  // [perf] TEMPORARY instrumentation
  const t0 = Date.now()
  const { company, profile } = await getSession()
  console.log('[perf] loadReceipt: getSession               %dms', Date.now() - t0)

  if (!canAny(profile.role, ['record_payment', 'view_all_payments'])) {
    throw new Error('Forbidden: role "' + profile.role + '" cannot view receipts.')
  }

  if (!Number.isInteger(paymentId)) return null

  // SCOPED TO THEIR OWN PAYMENTS unless they may read the whole book. Company
  // scoping alone was enough while every role that could reach this could also
  // open the payments list; now that a cashier holds receipts and nothing else,
  // it is the only thing standing between them and any payment in the company
  // by guessing an id. A refusal returns null rather than an error, so a
  // payment belonging to a colleague is indistinguishable from one that does
  // not exist — the same rule the company scope already follows.
  if (!can(profile.role, 'view_all_payments')) {
    const mine = await paymentBelongsTo(company.id, paymentId, profile)
    if (!mine) return null
  }

  // Scoped to the caller's company inside getReceipt, so a payment id from
  // another tenant is indistinguishable from one that does not exist.
  const tR = Date.now()
  const out = await getReceipt(company.id, paymentId)
  console.log('[perf] loadReceipt: getReceipt               %dms', Date.now() - tR)
  console.log('[perf] loadReceipt: TOTAL                    %dms', Date.now() - t0)
  return out
}

/**
 * Whether this payment was taken by this operator.
 *
 * THE SAME RULE THE COLLECTIONS LIST USES — see getAgentCollections in
 * lib/data/checkoff.ts: the user id when there is one, falling back to the
 * agent name for rows written before migration 0010 added the column. If the
 * two ever disagree, a cashier sees a payment in their collections that they
 * cannot reprint, which is the exact hole this whole change is closing.
 *
 * COMPARED IN JAVASCRIPT, NOT IN A POSTGREST FILTER. The fallback needs the
 * agent's display name, which is free text — one containing a comma would end
 * the filter expression early and change which rows it matches. A security
 * check is the last place to build a query string out of user data.
 */
async function paymentBelongsTo(
  companyId: number,
  paymentId: number,
  profile: { id: number; first_name: string | null; last_name: string | null; email: string }
): Promise<boolean> {
  const caps = await getSchemaCapabilities()

  const { data } = await tenantClient()
    .from('payments')
    .select('agent' + (caps.checkoff ? ', user_id' : ''))
    .eq('company_id', companyId)
    .eq('id', paymentId)
    .maybeSingle()

  const row = data as unknown as { agent: string | null; user_id?: number | null } | null
  if (!row) return false

  // A row that names a user is decided by that alone: it was attributed when it
  // was taken, and an operator later renamed must not lose their own receipts.
  if (caps.checkoff && row.user_id !== null && row.user_id !== undefined) {
    return row.user_id === profile.id
  }

  // Pre-0010 rows carry only the free-text agent name, which is all that was
  // ever recorded about who took them.
  return (row.agent ?? '') === displayName(profile)
}
