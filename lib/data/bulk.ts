import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { getProvisionedIdentities } from '@/lib/radius-db'
import { usernameKey } from '@/lib/radius/format'
import { radiusIdentity } from '@/lib/radius/format'

/**
 * Company-wide reads for the bulk actions on the customer list.
 *
 * Every one of them acts on a whole company at once, so the reads here must
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
  /** Day of the month, 1-28, or null when this customer has none of their own. */
  cut_off_date: number | null
}

async function readAllCustomers(companyId: number): Promise<BulkCustomer[]> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  // customer_type / pppoe_username only exist once 0003 has been applied.
  // Without them radiusIdentity falls back to the MAC for everyone, which is
  // exactly how the app behaved before that migration.
  const columns =
    'id, first_name, last_name, mac_address, cut_off_date' +
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
        cut_off_date: (row.cut_off_date as number | null) ?? null,
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
// Bill All
// ---------------------------------------------------------------------------

export type BillableCustomer = {
  id: number
  name: string
  /** Never null: a missing rate reads as 0 and is skipped by the caller. */
  monthlyRate: number
  carriedBalance: number
  /** Prepayment held. The run draws this down before charging carried_balance. */
  accountCredit: number
  /**
   * `YYYY-MM-DD` of the last period this customer was billed FOR — not the day
   * a run happened. That distinction is the whole idempotency guard: see
   * app/actions/bulk.ts#billBatch.
   */
  lastBilledDate: string | null
  /**
   * The name this customer authenticates under in radcheck: the PPPoE username
   * for a PPPoE subscriber, the MAC for everyone else. Null when neither is
   * recorded, which means there is no row in the registry to ask about.
   *
   * Carried here so the bill run can test whether service was actually being
   * delivered — see app/actions/bulk.ts#billBatch.
   */
  identity: string | null
}

const BILLABLE_BASE =
  'id, first_name, last_name, monthly_rate, carried_balance, account_credit, ' +
  'last_billed_date, mac_address'

/**
 * The select list, plus the 0003 identity columns where they exist.
 *
 * Assembled rather than constant for the same reason as everywhere else:
 * PostgREST rejects the whole query for one unknown column, so a database
 * without migration 0003 has to ask for less. Without those columns every
 * customer is identified by MAC, which is what the app did before PPPoE.
 */
async function billableColumns(): Promise<string> {
  const caps = await getSchemaCapabilities()
  return caps.connectionTypes
    ? BILLABLE_BASE + ', customer_type, pppoe_username'
    : BILLABLE_BASE
}

function toBillable(row: Record<string, unknown>): BillableCustomer {
  // Same rule as every other radcheck caller: PPPoE authenticates by username,
  // everyone else by MAC.
  const pppoe = (row.pppoe_username as string | null | undefined) ?? null
  const mac = (row.mac_address as string | null | undefined) ?? null
  const identity = row.customer_type === 'pppoe' ? pppoe : mac

  return {
    id: row.id as number,
    name:
      [row.first_name as string | null, row.last_name as string | null]
        .filter(Boolean)
        .join(' ') || 'Customer #' + (row.id as number),
    monthlyRate: Number(row.monthly_rate ?? 0) || 0,
    carriedBalance: Number(row.carried_balance ?? 0) || 0,
    accountCredit: Number(row.account_credit ?? 0) || 0,
    lastBilledDate: (row.last_billed_date as string | null) ?? null,
    identity: identity && identity.trim() ? identity.trim() : null,
  }
}

/**
 * Every customer in the company, paged past the 1000-row cap.
 *
 * NO LONGER FILTERED ON billing_type. Under the retired prepaid/postpaid split
 * this excluded prepaid customers, which meant the bill run never charged them
 * and their debt was expected to live in `customers.balance` — a column nothing
 * ever charged. Every company now bills the same way. See lib/billing.ts.
 *
 * Returns [] when migration 0011 has not been applied — the columns do not
 * exist and PostgREST would reject the select outright.
 */
export async function readBillableCustomers(companyId: number): Promise<BillableCustomer[]> {
  const caps = await getSchemaCapabilities()
  if (!caps.billing) return []

  const db = tenantClient()
  const cols = await billableColumns()
  const out: BillableCustomer[] = []

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('customers')
      .select(cols)
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)

    if (error) throw new Error('Failed to load billable customers: ' + error.message)

    const rows = (data ?? []) as unknown as Record<string, unknown>[]
    for (const row of rows) out.push(toBillable(row))
    if (rows.length < PAGE) break
  }

  return out
}

/**
 * The customers named by a batch, read back from the database.
 *
 * The client posts ids and nothing else. Every amount that gets added is
 * computed here from the row the write is about to touch, so a stale or
 * tampered preview cannot change what anybody is billed.
 */
export async function readBillableByIds(
  companyId: number,
  ids: number[]
): Promise<BillableCustomer[]> {
  if (ids.length === 0) return []

  const caps = await getSchemaCapabilities()
  if (!caps.billing) return []

  const db = tenantClient()
  const cols = await billableColumns()
  const { data, error } = await db
    .from('customers')
    .select(cols)
    .eq('company_id', companyId)
    .in('id', ids)

  if (error) throw new Error('Failed to load billable customers: ' + error.message)

  return ((data ?? []) as unknown as Record<string, unknown>[]).map(toBillable)
}

// ---------------------------------------------------------------------------
// Provision All
// ---------------------------------------------------------------------------

export type ProvisionCandidate = {
  id: number
  name: string
  /** MAC for dhcp/hotspot, PPPoE username for pppoe — radiusIdentity()'s rule. */
  identity: string
  /**
   * This customer's own cut-off day, which is what their expiry is derived
   * from. Null when they have none set; the caller falls back to the company
   * day rather than guessing one here.
   */
  cutOffDate: number | null
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

    if (identity) {
      withIdentity.push({
        id: customer.id,
        name: bulkCustomerName(customer),
        identity,
        cutOffDate: customer.cut_off_date,
      })
    } else {
      noIdentity.push({ id: customer.id, name: bulkCustomerName(customer) })
    }
  }

  const provisioned = await findProvisioned(withIdentity.map((c) => c.identity))

  const ready: ProvisionCandidate[] = []
  const alreadyProvisioned: { id: number; name: string }[] = []
  for (const candidate of withIdentity) {
    // One normalised comparison. This was two .has() calls trying to guess at
    // the casing radcheck happened to use, which still missed every mixed-case
    // row — getProvisionedIdentities now returns normalised keys.
    if (provisioned.has(usernameKey(candidate.identity))) {
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
    'id, first_name, last_name, mac_address, cut_off_date' +
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
    cut_off_date: (row.cut_off_date as number | null) ?? null,
  }))
}
