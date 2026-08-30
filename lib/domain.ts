import type { Customer, CustomerWithExpiry, ExpiryMode } from './types'

/**
 * The schema has no `expiry_date` column, so a customer's service expiry is
 * derived: one billing month from `last_bill_date`.
 *
 * If that assumption changes (e.g. an invoices table lands, or prepaid
 * customers buy multiple months at once), this is the single place to change.
 */
export function expiryOf(customer: Pick<Customer, 'last_bill_date'>): Date | null {
  if (!customer.last_bill_date) return null
  const d = new Date(customer.last_bill_date + 'T00:00:00')
  if (!Number.isFinite(d.getTime())) return null
  d.setMonth(d.getMonth() + 1)
  return d
}

const DAY = 86_400_000

function startOfToday(): number {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
}

/** Whole days from today until expiry. Negative means already expired. */
export function daysUntil(expiry: Date | null): number | null {
  if (!expiry) return null
  const e = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate()).getTime()
  return Math.round((e - startOfToday()) / DAY)
}

/**
 * Adds the derived BILLING expiry to a customer.
 *
 * No status is computed here any more: status comes from the network registry
 * alone (lib/radius-db.ts#batchGetRadiusStatus) and is merged in by the caller.
 */
export function withExpiry(customer: Customer): CustomerWithExpiry {
  const expiresAt = expiryOf(customer)
  return {
    ...customer,
    expiresAt,
    daysUntilExpiry: daysUntil(expiresAt),
  }
}

/**
 * The `last_bill_date` a renewal should write, and the expiry it produces.
 *
 * Expiry is derived as `last_bill_date + 1 month` (see expiryOf), so a renewal
 * is expressed by moving the bill date rather than storing an expiry:
 *
 *   from_expiry  — advance the existing bill date by the months paid, so a late
 *                  payer keeps the days they already paid for.
 *   from_payment — anchor to the payment date, restarting the cycle now.
 *
 * Uses calendar months rather than fixed 30-day blocks, to stay consistent with
 * expiryOf() and with monthly billing.
 */
export function renewal(
  lastBillDate: string | null,
  mode: ExpiryMode,
  monthsPaid: number,
  paymentDate: Date = new Date()
): { nextBillDate: Date; nextExpiry: Date } {
  const months = Math.max(1, Math.floor(monthsPaid))
  const payDay = new Date(
    paymentDate.getFullYear(), paymentDate.getMonth(), paymentDate.getDate()
  )

  const current = lastBillDate ? new Date(lastBillDate + 'T00:00:00') : null

  let nextBillDate: Date
  if (mode === 'from_expiry' && current && Number.isFinite(current.getTime())) {
    nextBillDate = new Date(current)
    nextBillDate.setMonth(nextBillDate.getMonth() + months)
  } else {
    // from_payment, or no usable bill date to extend from.
    nextBillDate = new Date(payDay)
    nextBillDate.setMonth(nextBillDate.getMonth() + (months - 1))
  }

  const nextExpiry = new Date(nextBillDate)
  nextExpiry.setMonth(nextExpiry.getMonth() + 1)

  return { nextBillDate, nextExpiry }
}

/** Percent change, guarding the divide-by-zero case a fresh dataset produces. */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null
  if (previous === 0) return current === 0 ? 0 : null
  return ((current - previous) / previous) * 100
}
