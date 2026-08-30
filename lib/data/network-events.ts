import 'server-only'

import { tenantClient } from '@/lib/supabase/tenant'
import { NETWORK_EVENT_TYPES } from '@/lib/status'
import type { LogRow } from '@/lib/types'

/**
 * Reads of the `network_*` rows in the shared `log` table.
 *
 * No new table and no migration: the four network buttons write into `log`
 * alongside every other audit row, and these queries pick them back out. Two
 * things need them — the Network History card on the customer record, and the
 * 'disconnected' status, which cannot be derived from radcheck because a
 * deliberate cut-off and an ordinary lapse are both just an expiry in the past.
 *
 * The type list is closed (lib/status.ts#NETWORK_EVENT_TYPES) and matched with
 * `in` rather than a `network_%` prefix: in SQL LIKE the underscore is itself a
 * wildcard, and PostgREST gives no way to escape it, so a prefix match would
 * also catch types nobody intended.
 */

/**
 * The type of the most recent network event for each of `customerIds`.
 *
 * One query for the whole page — the customer list and the dashboard both need
 * this per row, and asking per customer would be a round trip each. Customers
 * with no network events are absent from the Map, which reads as "never touched
 * by an operator" rather than as an unknown.
 *
 * Rows come back newest first, so the first one seen for a customer is theirs.
 * The cap is far above what a company accumulates in these four event types,
 * and only ever truncates the oldest rows; a customer whose most recent network
 * event falls outside it reads as 'expired'/'inactive' rather than
 * 'disconnected', which is a degradation and not a wrong number.
 */
export async function lastNetworkEvents(
  companyId: number,
  customerIds: number[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>()

  const ids = [...new Set(customerIds.filter((id) => Number.isInteger(id)))]
  if (ids.length === 0) return out

  const db = tenantClient()
  const { data, error } = await db
    .from('log')
    .select('customer_id, type, created_at')
    .eq('company_id', companyId)
    .in('customer_id', ids)
    .in('type', NETWORK_EVENT_TYPES as unknown as string[])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(10_000)

  if (error) {
    // A status that falls back to the radcheck-only answer is far better than a
    // customer list that will not load, so this degrades rather than throwing.
    console.error('[network-events] lookup failed:', error.message)
    return out
  }

  for (const row of (data ?? []) as { customer_id: number | null; type: string | null }[]) {
    if (row.customer_id === null || row.type === null) continue
    if (!out.has(row.customer_id)) out.set(row.customer_id, row.type)
  }

  return out
}

/** The single-customer form of lastNetworkEvents, for the detail page. */
export async function lastNetworkEvent(
  companyId: number,
  customerId: number
): Promise<string | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('log')
    .select('type')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .in('type', NETWORK_EVENT_TYPES as unknown as string[])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error('[network-events] lookup failed:', error.message)
    return null
  }

  return (data as { type: string | null } | null)?.type ?? null
}

/**
 * The customer's recent network events, newest first, for the history card.
 *
 * Only the four operator actions. Failed writes are logged under
 * `radius_*_failed` and stay out of this list on purpose: the card answers
 * "what happened to this customer's access", and an attempt that never reached
 * the NAS did not change it.
 */
export async function listNetworkHistory(
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
    .in('type', NETWORK_EVENT_TYPES as unknown as string[])
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[network-events] history failed:', error.message)
    return []
  }

  return (data ?? []) as unknown as LogRow[]
}
