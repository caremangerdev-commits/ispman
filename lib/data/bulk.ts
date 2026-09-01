import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { getProvisionedIdentities } from '@/lib/radius-db'
import { radiusIdentity } from '@/lib/radius/format'

/**
 * Company-wide reads for the two bulk actions on the customer list.
 *
 * Both of them act on EVERY customer in the company, so the reads here must
 * genuinely see every customer — see readAllCustomers for why that is not the
 * default.
 */

/**
 * PostgREST caps an unbounded select at 1000 rows.
 *
 * For a "set ALL cut off dates" or "provision ALL" button that cap is not a
 * performance detail, it is a silent wrong answer: customer 1001 onwards would
 * be missing from the count the operator confirms and from the work that
 * follows. So every read here pages explicitly until it sees a short page.
 */
const PAGE = 1000

/** How many identities go into one `username IN (…)` list. */
const RADCHECK_CHUNK = 500

export type BulkCustomer = {
  id: number
  first_name: string | null
  last_name: string | null
  mac_address: string | null
  customer_type: string | null
  pppoe_username: string | null
}

async function readAllCustomers(companyId: number): Promise<BulkCustomer[]> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  // customer_type / pppoe_username only exist once 0003 has been applied.
  // Without them radiusIdentity falls back to the MAC for everyone, which is
  // exactly how the app behaved before that migration.
  const columns =
    'id, first_name, last_name, mac_address' +
    (caps.connectionTypes ? ', customer_type, pppoe_username' : '')

  const out: BulkCustomer[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('customers')
      .select(columns)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) throw new Error('Failed to load customers: ' + error.message)

    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    for (const row of rows) {
      out.push({
        id: row.id as number,
        first_name: (row.first_name as string | null) ?? null,
        last_name: (row.last_name as string | null) ?? null,
        mac_address: (row.mac_address as string | null) ?? null,
        customer_type: (row.customer_type as string | null) ?? null,
        pppoe_username: (row.pppoe_username as string | null) ?? null,
      })
    }

    if (rows.length < PAGE) break
  }

  return out
}

export function bulkCustomerName(customer: BulkCustomer): string {
  return (
    [customer.first_name, customer.last_name].filter(Boolean).join(' ') ||
    'Customer #' + customer.id
  )
}

/** Every customer in the company, however many there are. */
export async function countAllCustomers(companyId: number): Promise<number> {
  const db = tenantClient()
  const { count, error } = await db
    .from('customers')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)

  if (error) throw new Error('Failed to count customers: ' + error.message)
  return count ?? 0
}

// ---------------------------------------------------------------------------
// Provision All
// ---------------------------------------------------------------------------

export type ProvisionCandidate = {
  id: number
  name: string
  /** MAC for dhcp/hotspot, PPPoE username for pppoe — radiusIdentity()'s rule. */
  identity: string
}

export type ProvisionPlan = {
  /** Unprovisioned, and reachable by an identity. */
  ready: ProvisionCandidate[]
  /** No MAC and no PPPoE username — nothing to key radcheck on. */
  noIdentity: { id: number; name: string }[]
  /** Already has radcheck rows; left alone. */
  alreadyProvisioned: { id: number; name: string }[]
}

/**
 * Which of the company's customers a bulk provision would actually write.
 *
 * The radcheck side is ONE query per 500 identities, not one per customer —
 * see getProvisionedIdentities. A company of a few thousand is two or three
 * round trips to the NAS in total.
 *
 * Note that this uses radiusIdentity(), so a PPPoE customer is looked up under
 * their username. The customer list's status column looks every row up by MAC
 * instead (lib/data/customers.ts), so for a PPPoE customer the two can
 * disagree — this one is the correct answer, because it matches the identity
 * the write will use.
 */
export async function getProvisionPlan(companyId: number): Promise<ProvisionPlan> {
  const customers = await readAllCustomers(companyId)

  const withIdentity: ProvisionCandidate[] = []
  const noIdentity: { id: number; name: string }[] = []

  for (const customer of customers) {
    const identity = radiusIdentity({
      customerType: customer.customer_type,
      macAddress: customer.mac_address,
      pppoeUsername: customer.pppoe_username,
    })?.trim()

    if (identity) withIdentity.push({ id: customer.id, name: bulkCustomerName(customer), identity })
    else noIdentity.push({ id: customer.id, name: bulkCustomerName(customer) })
  }

  const provisioned = await findProvisioned(withIdentity.map((c) => c.identity))

  const ready: ProvisionCandidate[] = []
  const alreadyProvisioned: { id: number; name: string }[] = []
  for (const candidate of withIdentity) {
    if (provisioned.has(candidate.identity.toUpperCase()) || provisioned.has(candidate.identity)) {
      alreadyProvisioned.push({ id: candidate.id, name: candidate.name })
    } else {
      ready.push(candidate)
    }
  }

  return { ready, noIdentity, alreadyProvisioned }
}

/**
 * The identities that already have radcheck rows, chunked.
 *
 * getProvisionedIdentities normalises each identity the same way the write
 * does, so a MAC comes back uppercase with colons and a PPPoE username comes
 * back untouched. Callers compare against both forms.
 *
 * Deliberately NOT wrapped in a try/catch. A failed lookup must not read as
 * "nobody is provisioned": provisioning writes DELETE-then-INSERT, so acting on
 * a false negative would replace a paid-up customer's expiry with the bulk
 * date. Failing the run is the safe outcome.
 */
export async function findProvisioned(identities: string[]): Promise<Set<string>> {
  const unique = [...new Set(identities.filter(Boolean))]
  const found = new Set<string>()

  for (let i = 0; i < unique.length; i += RADCHECK_CHUNK) {
    const chunk = unique.slice(i, i + RADCHECK_CHUNK)
    for (const username of await getProvisionedIdentities(chunk)) found.add(username)
  }

  return found
}

/**
 * The customers named by a batch, read back from the database rather than
 * trusted from the caller.
 *
 * The client posts ids; the identity that gets written is derived here, from
 * the row, scoped to the caller's own company.
 */
export async function readCustomersByIds(
  companyId: number,
  ids: number[]
): Promise<BulkCustomer[]> {
  if (ids.length === 0) return []

  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const columns =
    'id, first_name, last_name, mac_address' +
    (caps.connectionTypes ? ', customer_type, pppoe_username' : '')

  const { data, error } = await db
    .from('customers')
    .select(columns)
    .eq('company_id', companyId)
    .in('id', ids)

  if (error) throw new Error('Failed to load customers: ' + error.message)

  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    id: row.id as number,
    first_name: (row.first_name as string | null) ?? null,
    last_name: (row.last_name as string | null) ?? null,
    mac_address: (row.mac_address as string | null) ?? null,
    customer_type: (row.customer_type as string | null) ?? null,
    pppoe_username: (row.pppoe_username as string | null) ?? null,
  }))
}
