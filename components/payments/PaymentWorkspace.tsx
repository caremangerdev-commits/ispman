'use client'

import { useState, type ReactNode } from 'react'

import { RecordPaymentForm } from '@/components/payments/RecordPaymentForm'
import type { PaymentCategory } from '@/lib/data/payment-categories'
import type { SearchHit } from '@/app/api/search/route'

/**
 * Layout shell for the record-payment screen.
 *
 * Two modes:
 *
 *   browsing — no customer picked yet: the search sits on the left with the
 *              agent's collections beside it, so they can see what they have
 *              taken so far while they look someone up.
 *
 *   focused  — a customer is picked: everything else gets out of the way. The
 *              payment collapses to a single centred column and the
 *              collections panel is hidden, so the only thing on screen is the
 *              transaction being taken. Clearing the customer restores the
 *              browsing view, by which point the panel has refreshed.
 *
 * The mode is derived from the form's selection, so this owns the state and
 * the form reports changes up. Initialising from `initialCustomer` here rather
 * than syncing in an effect keeps both components free of cascading renders.
 */
export function PaymentWorkspace({
  stats,
  collections,
  initialCustomer,
  currency,
  gracePeriodDays,
  billingAvailable,
  paymentCategories,
  otherPaymentsAvailable,
}: {
  /** The four running totals, rendered on the server. */
  stats: ReactNode
  /** The collections list (search + payments), rendered on the server. */
  collections: ReactNode
  initialCustomer: SearchHit | null
  currency: string
  /** Company grace period, for the postpaid expiry preview. */
  gracePeriodDays: number
  /** False until migration 0011 is applied — postpaid controls stay hidden. */
  billingAvailable: boolean
  /** The Purpose list for "other" payments. */
  paymentCategories: PaymentCategory[]
  /** False until migration 0013 is applied — the type toggle stays hidden. */
  otherPaymentsAvailable: boolean
}) {
  const [focused, setFocused] = useState(Boolean(initialCustomer))

  // One tree for both modes, switched by class name. Returning a different
  // tree per mode would move RecordPaymentForm to a new position, remounting
  // it and discarding the very selection that put us in focused mode.
  // Full-width bands rather than two columns: a short lookup card beside a tall
  // collections panel left the page lopsided. Stacking them gives each row the
  // full width and a consistent rhythm — lookup, totals, history.
  return (
    <div className={focused ? 'mx-auto w-full max-w-2xl' : 'space-y-4'}>
      <RecordPaymentForm
        initialCustomer={initialCustomer}
        currency={currency}
        gracePeriodDays={gracePeriodDays}
        billingAvailable={billingAvailable}
        paymentCategories={paymentCategories}
        otherPaymentsAvailable={otherPaymentsAvailable}
        onCustomerChange={(hit) => setFocused(Boolean(hit))}
      />

      {focused ? null : stats}
      {focused ? null : collections}
    </div>
  )
}
