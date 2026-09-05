import 'server-only'

import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Reads of the `balance_adjusted` rows in the shared `log` table.
 *
 * No new table and no column on `customers`: the manager adjustment writes into
 * `log` through lib/audit.ts#logEvent like every other audit row, and these
 * queries pick it back out to mark the balance in the UI. Follows
 * lib/data/network-events.ts, which does the same job for the network buttons.
 *
 * WHY A STORED "IS IT STILL ADJUSTED" FLAG WOULD BE WRONG. The obvious design
 * is a column set by the adjustment and cleared by whatever recomputes the
 * balance next. Nothing ever does. A bill run ADDS its charge to the carried
 * balance (app/actions/bulk.ts#billBatch) and a payment SUBTRACTS from it
 * (app/actions/payments.ts#recordPayment) — neither replaces the number, so an
 * adjustment stays baked into every value that follows it, for good. There is
 * no moment at which the mark would legitimately clear, which makes "has this
 * balance ever been adjusted, when, and by whom" the only honest question, and
 * the log already answers it.
 */

export const BALANCE_ADJUSTED = 'balance_adjusted'

export type BalanceAdjustment = {
  /** When the adjustment was made. */
  at: string
  /** The full logged detail: old value, new value, who, and why. */
  details: string
}

/**
 * The most recent balance adjustment for one customer, or null if never.
 *
 * Used by the customer record to mark a carried balance as hand-set. A failure
 * degrades to null — an unmarked balance is worse than a customer page that
 * will not load, and the log row itself is unaffected either way.
 */
export async function lastBalanceAdjustment(
  companyId: number,
  customerId: number
): Promise<BalanceAdjustment | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('log')
    .select('details, created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('type', BALANCE_ADJUSTED)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[balance-adjustments] lookup failed:', error.message)
    return null
  }

  const row = data as { details: string | null; created_at: string | null } | null
  if (!row?.created_at) return null

  return { at: row.created_at, details: row.details ?? '' }
}

/**
 * The most recent balance adjustment for each of `customerIds`, as one query.
 *
 * The customer list needs this per row; asking per customer would be a round
 * trip each. Customers with no adjustment are absent from the Map, which reads
 * as "never adjusted" rather than as an unknown.
 *
 * Rows come back newest first, so the first one seen for a customer is theirs.
 * The cap only ever truncates the oldest rows: a customer whose adjustment
 * falls outside it renders unmarked, which is a degradation and not a wrong
 * number.
 */
export async function lastBalanceAdjustments(
  companyId: number,
  customerIds: number[]
): Promise<Map<number, BalanceAdjustment>> {
  const out = new Map<number, BalanceAdjustment>()

  const ids = [...new Set(customerIds.filter((id) => Number.isInteger(id)))]
  if (ids.length === 0) return out

  const db = tenantClient()
  const { data, error } = await db
    .from('log')
    .select('customer_id, details, created_at')
    .eq('company_id', companyId)
    .in('customer_id', ids)
    .eq('type', BALANCE_ADJUSTED)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(10_000)

  if (error) {
    console.error('[balance-adjustments] lookup failed:', error.message)
    return out
  }

  const rows = (data ?? []) as {
    customer_id: number | null
    details: string | null
    created_at: string | null
  }[]

  for (const row of rows) {
    if (row.customer_id === null || !row.created_at) continue
    if (out.has(row.customer_id)) continue
    out.set(row.customer_id, { at: row.created_at, details: row.details ?? '' })
  }

  return out
}
