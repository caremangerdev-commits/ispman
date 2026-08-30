'use server'

import { getReceipt } from '@/lib/data/receipts'
import { canAny } from '@/lib/permissions'
import type { Receipt } from '@/lib/receipt'
import { getSession } from '@/lib/session'

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
 * manager must be able to reprint one they did not.
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

  // Scoped to the caller's company inside getReceipt, so a payment id from
  // another tenant is indistinguishable from one that does not exist.
  const tR = Date.now()
  const out = await getReceipt(company.id, paymentId)
  console.log('[perf] loadReceipt: getReceipt               %dms', Date.now() - tR)
  console.log('[perf] loadReceipt: TOTAL                    %dms', Date.now() - t0)
  return out
}
