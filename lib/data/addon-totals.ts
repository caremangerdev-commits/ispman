import 'server-only'

import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/** How many customer ids go in one `in()` filter. Keeps the URL short. */
const ID_CHUNK = 200

/**
 * Active add-ons per customer, summed the way app/actions/payments.ts sums
 * them: the monthly charge is monthly_rate PLUS these. Shared by the billing
 * engine and the calendar-month prepaid service pass, so both price a month
 * from the same figure.
 */
export async function addonTotals(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const caps = await getSchemaCapabilities()
  if (!caps.catalog || ids.length === 0) return out

  const db = tenantClient()
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const { data, error } = await db
      .from('customer_additional_services')
      .select('customer_id, additional_services(monthly_price)')
      .in('customer_id', chunk)
    if (error) throw new Error('Could not read add-ons: ' + error.message)
    for (const row of (data ?? []) as unknown as {
      customer_id: number
      additional_services: { monthly_price: number | string | null } | null
    }[]) {
      out.set(row.customer_id, (out.get(row.customer_id) ?? 0) + Number(row.additional_services?.monthly_price ?? 0))
    }
  }
  return out
}
