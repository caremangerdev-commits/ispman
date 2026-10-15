import { tenantClient } from '@/lib/supabase/tenant'

/** A customer already holding a MAC, as the add form names them. */
export type MacHolder = { id: number; name: string }

/** How many holders are named. More than this is a cleanup job, not a form message. */
const NAMED = 3

/** Chunk size for the `in` filter; keeps the querystring inside sane limits. */
const LOOKUP_CHUNK = 400

type Row = { id: number; first_name: string | null; last_name: string | null; mac_address: string | null }

const holderOf = (r: Row): MacHolder => ({
  id: r.id,
  name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Customer #' + r.id,
})

/**
 * The customers of this company already holding a MAC.
 *
 * `mac` must already be in the stored form (lib/mac.ts#canonicalMac): every
 * stored MAC is, so an exact match is the whole test. `exceptId` leaves out
 * the customer being edited, who may hold it already.
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
export async function findMacHolders(
  companyId: number,
  mac: string,
  exceptId?: number
): Promise<MacHolder[] | null> {
  let query = tenantClient()
    .from('customers')
    .select('id, first_name, last_name, mac_address')
    .eq('company_id', companyId)
    .eq('mac_address', mac)
  if (exceptId !== undefined) query = query.neq('id', exceptId)

  const { data, error } = await query.order('id', { ascending: true }).limit(NAMED)
  if (error) return null
  return ((data ?? []) as unknown as Row[]).map(holderOf)
}

/**
 * For many MACs at once: each one already held in this company, mapped to who
 * holds it in words (describeMacHolders). MACs nobody holds are absent.
 *
 * Throws when the lookup fails, because both callers (the import preview and
 * the import write) must stop rather than treat every MAC as free.
 */
export async function macHoldersByMac(companyId: number, macs: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(macs.filter(Boolean))]
  const found = new Map<string, MacHolder[]>()
  const db = tenantClient()

  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const { data, error } = await db
      .from('customers')
      .select('id, first_name, last_name, mac_address')
      .eq('company_id', companyId)
      .in('mac_address', unique.slice(i, i + LOOKUP_CHUNK))
      .order('id', { ascending: true })
    if (error) throw new Error('Could not check existing MAC addresses: ' + error.message)

    for (const r of (data ?? []) as unknown as Row[]) {
      if (!r.mac_address) continue
      const list = found.get(r.mac_address) ?? []
      if (list.length < NAMED) list.push(holderOf(r))
      found.set(r.mac_address, list)
    }
  }

  return new Map([...found].map(([mac, holders]) => [mac, describeMacHolders(holders)]))
}

/** "#2358 Dena Chambers", or "#3026 A, #5945 B and #6096 C". */
export function describeMacHolders(holders: MacHolder[]): string {
  const each = holders.map((h) => '#' + h.id + ' ' + h.name)
  return each.length > 1 ? each.slice(0, -1).join(', ') + ' and ' + each[each.length - 1] : each[0] ?? ''
}
