import 'server-only'

import { CUSTOMER_UPDATED } from '@/lib/customer-changes'
import { tenantClient } from '@/lib/supabase/tenant'
import type { LogRow } from '@/lib/types'

/**
 * Reads of the `customer_updated` rows in the shared `log` table.
 *
 * No new table and no migration: the edit form writes into `log` through
 * lib/audit.ts#logEvent like every other audit row, and this picks them back
 * out for the Change History card. Follows lib/data/network-events.ts and
 * lib/data/balance-adjustments.ts, which do the same job for the network
 * buttons and the manager balance adjustment.
 *
 * WHY THE CARD AND NOT ONLY THE ACTIVITY FEED. "Who moved this customer to
 * FILE B, and when" is a question about ONE customer. The company-wide feed
 * answers it in principle and not in practice — it is thousands of rows, most
 * of them network events — so the answer has to sit on the record it is about.
 */
export async function listCustomerChanges(
  companyId: number,
  customerId: number,
  limit = 10
): Promise<LogRow[]> {
  const db = tenantClient()
  const { data, error } = await db
    .from('log')
    .select('id, type, details, created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .eq('type', CUSTOMER_UPDATED)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (error) {
    // The record is fine without the card, so this degrades rather than
    // failing the page — same as listNetworkHistory.
    console.error('[customer-changes] history failed:', error.message)
    return []
  }

  return (data ?? []) as unknown as LogRow[]
}
