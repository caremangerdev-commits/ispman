import { tenantClient } from '@/lib/supabase/tenant'

/** A customer already holding a MAC, as the add form names them. */
export type MacHolder = { id: number; name: string }

/** How many holders are named. More than this is a cleanup job, not a form message. */
const NAMED = 3

/**
 * The customers of this company already holding a MAC.
 *
 * `mac` must already be in the stored form (lib/mac.ts#canonicalMac): every
 * stored MAC is, so an exact match is the whole test.
 *
 * A LIST, NOT .maybeSingle(). The add form's check used maybeSingle, which
 * answers a MAC held by two customers with an error and no row, and the check
 * read that as "nobody has it". 36 MACs were already shared inside a company on
 * 15 Oct 2026, and at Vernon a third customer had been added on one of them
 * (00:00:00:00:01:06: #3026, #5945, #6096).
 *
 * Null when the lookup itself failed, so a caller can refuse rather than read
 * "could not check" as "free".
 */
export async function findMacHolders(companyId: number, mac: string): Promise<MacHolder[] | null> {
  const { data, error } = await tenantClient()
    .from('customers')
    .select('id, first_name, last_name')
    .eq('company_id', companyId)
    .eq('mac_address', mac)
    .order('id', { ascending: true })
    .limit(NAMED)

  if (error) return null
  return ((data ?? []) as unknown as { id: number; first_name: string | null; last_name: string | null }[])
    .map((r) => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Customer #' + r.id,
    }))
}

/** "#2358 Dena Chambers", or "#3026 A, #5945 B and #6096 C". */
export function describeMacHolders(holders: MacHolder[]): string {
  const each = holders.map((h) => '#' + h.id + ' ' + h.name)
  return each.length > 1 ? each.slice(0, -1).join(', ') + ' and ' + each[each.length - 1] : each[0] ?? ''
}
