import { withExpiry } from '@/lib/domain'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'
import { batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { lastNetworkEvents } from '@/lib/data/network-events'
import {
  CUSTOMER_STATUSES, resolveStatus, STATUS_LABELS, type CustomerStatus,
} from '@/lib/status'
import type {
  ConnectionType, Customer, CustomerCategory, CustomerType,
  CustomerWithExpiry, ExpiryMode,
} from '@/lib/types'
import { toBillingType, type BillingType } from '@/lib/billing'
import {
  toConnectionType, toCustomerCategory, toCustomerType, toExpiryMode,
} from '@/lib/types'

export type CustomerFilter = 'all' | CustomerStatus

/** Tabs, in the order the status spec lists them. */
export const FILTERS: { key: CustomerFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  ...CUSTOMER_STATUSES.map((k) => ({ key: k as CustomerFilter, label: STATUS_LABELS[k] })),
]

const SELECT =
  'id, first_name, last_name, email, phone, address, gps, mac_address, monthly_rate, balance, cut_off_date, last_bill_date, date_added'

/**
 * Columns added by migration 0003.
 *
 * Requesting a column that does not exist makes PostgREST reject the whole
 * query, so the select list is assembled from what the schema actually has —
 * see lib/schema.ts.
 */
async function selectWithExtras(join = false) {
  const caps = await getSchemaCapabilities()
  let sel = SELECT
  if (caps.connectionTypes) sel += ', customer_type, pppoe_username, access_point'
  if (caps.expiryMode) sel += ', expiry_mode'
  if (caps.billing) {
    sel += ', billing_type, carried_balance, account_credit, bill_date, last_billed_date'
  }
  if (caps.catalog) {
    sel += ', connection_type, customer_category, notes, misc_category_id, service_plan_id'
    // Both relationships are named explicitly: `customers` currently has two
    // foreign keys to each of these tables (the original `_fk` pair plus the
    // `_id_fkey` pair added by migration 0006), and PostgREST refuses an
    // ambiguous embed. 0009 removes the duplicates; the hint stays valid
    // afterwards because it names the constraint that survives.
    if (join) {
      sel +=
        ', service_plans!customers_service_plan_id_fkey(id, name, speed_down_mbps, speed_up_mbps, monthly_price)' +
        ', misc_categories!customers_misc_category_id_fkey(id, name)'
    }
  }
  return { sel, caps }
}



/**
 * Fills in the migration 0011 billing columns for a row read without them.
 *
 * `Customer` declares them as always present, so every read has to land on a
 * concrete value. Before 0011 that value is "prepaid, carrying nothing", which
 * is exactly how the app treated every customer beforehand.
 */
function withBillingDefaults<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    billing_type: toBillingType(row.billing_type as string | null | undefined),
    carried_balance: Number(row.carried_balance ?? 0),
    account_credit: Number(row.account_credit ?? 0),
    bill_date: (row.bill_date as number | null | undefined) ?? null,
    last_billed_date: (row.last_billed_date as string | null | undefined) ?? null,
  }
}

export type CustomerListRow = CustomerWithExpiry & {
  /**
   * For imported customers this holds the location name — ENDEAVOUR, MT ZION,
   * BROWN'S TOWN — which is what the list column and the address filter show.
   *
   * Declared here rather than on `Customer` because two dashboard reads
   * (lib/data/dashboard.ts and lib/data/roleDashboards.ts) cast to `Customer`
   * from selects that omit the column. Promoting it would type those rows as
   * carrying an address they never fetched. This module's SELECT always
   * includes it.
   */
  address: string | null
}

export type CustomerListResult = {
  rows: CustomerListRow[]
  total: number
  page: number
  pageCount: number
  counts: Record<CustomerFilter, number>
  /**
   * Every distinct address in the company, sorted, for the filter dropdown.
   *
   * Company-wide on purpose: it is built before the search and the status
   * filter are applied, so the list of places does not shrink as the operator
   * narrows the rows. A dropdown that hides the option you need because the
   * current filter excluded it is a dropdown you cannot navigate out of.
   */
  addresses: string[]
}

/**
 * Lists customers for one company, with search, status filter and pagination.
 *
 * Status is not a column: it is read from the network registry in one batched
 * query and merged onto each row, so filtering and the tab counts happen in
 * memory. A branch's customer list is small enough for that to be fine.
 */
export async function listCustomers(opts: {
  companyId: number
  query?: string
  filter?: CustomerFilter
  /** Exact address to narrow to, already trimmed. Empty means every address. */
  address?: string
  page?: number
  perPage?: number
}): Promise<CustomerListResult> {
  const {
    companyId, query = '', filter = 'all', address = '', page = 1, perPage = 10,
  } = opts

  const db = tenantClient()
  const { sel } = await selectWithExtras()
  const { data, error } = await db
    .from('customers')
    .select(sel)
    .eq('company_id', companyId)
    .order('id', { ascending: true })

  if (error) throw new Error('Failed to load customers: ' + error.message)

  // withExpiry() spreads the row but its return type is fixed to Customer's
  // fields, so address is carried back on explicitly rather than cast in.
  const all = ((data ?? []) as unknown as (Customer & { address: string | null })[])
    .map((row) => withBillingDefaults(row) as Customer & { address: string | null })
    .map((row) => ({ ...withExpiry(row), address: row.address ?? null }))

  // One registry lookup for the whole company. A failure leaves every row
  // 'unknown' rather than falsely reporting them all unregistered.
  let registry = new Map<string, { status: CustomerStatus; expiry: Date | null }>()
  if (radiusConfigured()) {
    try {
      registry = await batchGetRadiusStatus(all.map((c) => c.mac_address))
    } catch (err) {
      console.error('[customers] network status lookup failed:', (err as Error).message)
    }
  }
  const reachable = registry.size > 0 || all.length === 0

  // radcheck cannot tell a deliberate cut-off from an ordinary lapse — both are
  // an expiry in the past — so the event log supplies the difference. One query
  // for the page, same as the registry lookup above.
  const events = await lastNetworkEvents(companyId, all.map((c) => c.id))

  for (const c of all) {
    const key = c.mac_address ? c.mac_address.trim().toUpperCase() : null
    const hit = key ? registry.get(key) : undefined
    const base = hit ? hit.status : reachable ? 'unprovisioned' : 'unknown'
    c.radiusStatus = resolveStatus(base, events.get(c.id))
    c.radiusExpiry = hit?.expiry ?? null
  }

  const counts: Record<CustomerFilter, number> = {
    all: all.length,
    active: 0, expired: 0, inactive: 0, disconnected: 0, unprovisioned: 0, unknown: 0,
  }
  for (const c of all) counts[c.radiusStatus ?? 'unknown']++

  // Trimmed on both sides so a stored "ENDEAVOUR " and the option built from it
  // are the same place. Imported rows come from a spreadsheet; some of them have
  // trailing spaces.
  const addresses = [
    ...new Set(all.map((c) => (c.address ?? '').trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b))

  const wanted = address.trim()
  const needle = query.trim().toLowerCase()
  const matched = all.filter((c) => {
    if (filter !== 'all' && c.radiusStatus !== filter) return false
    if (wanted && (c.address ?? '').trim() !== wanted) return false
    if (!needle) return true
    const haystack = [
      c.first_name,
      c.last_name,
      [c.first_name, c.last_name].filter(Boolean).join(' '),
      c.phone,
      c.mac_address,
    ]
    return haystack.some((v) => (v ?? '').toLowerCase().includes(needle))
  })

  const pageCount = Math.max(1, Math.ceil(matched.length / perPage))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const start = (safePage - 1) * perPage

  return {
    rows: matched.slice(start, start + perPage),
    total: matched.length,
    page: safePage,
    pageCount,
    counts,
    addresses,
  }
}

export type CustomerDetail = CustomerWithExpiry & {
  address: string | null
  gps: string | null
  cut_off_date: number | null
  /** Migration 0011. `billingAvailable` is false until it is applied, and the
   *  detail page hides the postpaid rows rather than showing empty ones. */
  billingAvailable: boolean
  billingType: BillingType
  /** null when migration 0003 has not been applied. */
  customerType: CustomerType | null
  pppoeUsername: string | null
  accessPoint: string | null
  /** Effective renewal anchor; 'from_expiry' until migration 0004 is applied. */
  expiryMode: ExpiryMode
  expiryModeEditable: boolean
  /** Migration 0005 fields; null/false when the catalogue is absent. */
  catalogAvailable: boolean
  connectionType: ConnectionType | null
  customerCategory: CustomerCategory | null
  notes: string | null
  miscCategoryId: number | null
  miscCategoryName: string | null
  servicePlanId: number | null
  servicePlan: {
    id: number
    name: string
    speed_down_mbps: number
    speed_up_mbps: number
    monthly_price: number | string
  } | null
}

export async function getCustomer(
  companyId: number,
  id: number
): Promise<CustomerDetail | null> {
  const db = tenantClient()
  const { sel, caps } = await selectWithExtras(true)
  const { data, error } = await db
    .from('customers')
    .select(sel)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  if (error) throw new Error('Failed to load customer: ' + error.message)
  if (!data) return null

  const row = data as unknown as Customer & {
    address: string | null
    gps: string | null
    cut_off_date: number | null
    customer_type?: string | null
    pppoe_username?: string | null
    access_point?: string | null
    expiry_mode?: string | null
    billing_type?: string | null
    carried_balance?: number | string | null
    account_credit?: number | string | null
    bill_date?: number | null
    last_billed_date?: string | null
    connection_type?: string | null
    customer_category?: string | null
    notes?: string | null
    misc_category_id?: number | null
    service_plan_id?: number | null
    service_plans?: {
      id: number
      name: string
      speed_down_mbps: number
      speed_up_mbps: number
      monthly_price: number | string
    } | null
    misc_categories?: { id: number; name: string } | null
  }

  return {
    ...withExpiry(withBillingDefaults(row) as Customer & typeof row),
    address: row.address,
    gps: row.gps,
    cut_off_date: row.cut_off_date,
    billingAvailable: caps.billing,
    billingType: toBillingType(caps.billing ? row.billing_type : 'prepaid'),
    customerType: caps.connectionTypes ? toCustomerType(row.customer_type) : null,
    pppoeUsername: row.pppoe_username ?? null,
    accessPoint: row.access_point ?? null,
    expiryMode: toExpiryMode(caps.expiryMode ? row.expiry_mode : 'from_expiry'),
    expiryModeEditable: caps.expiryMode,
    catalogAvailable: caps.catalog,
    connectionType: caps.catalog ? toConnectionType(row.connection_type) : null,
    customerCategory: caps.catalog ? toCustomerCategory(row.customer_category) : null,
    notes: row.notes ?? null,
    miscCategoryId: row.misc_category_id ?? null,
    miscCategoryName: row.misc_categories?.name ?? null,
    servicePlanId: row.service_plan_id ?? null,
    servicePlan: row.service_plans ?? null,
  }
}

export type CustomerPayment = {
  id: number
  amount: number | string
  months_paid: number | null
  payment_type: string | null
  payment_date: string
  agent: string | null
  notes: string | null
}

export async function getCustomerPayments(
  companyId: number,
  customerId: number
): Promise<CustomerPayment[]> {
  const db = tenantClient()
  const { data, error } = await db
    .from('payments')
    .select('id, amount, months_paid, payment_type, payment_date, agent, notes')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('payment_date', { ascending: false })

  if (error) throw new Error('Failed to load payments: ' + error.message)
  return (data ?? []) as unknown as CustomerPayment[]
}

export type CustomerTicket = {
  id: number
  title: string
  status: string | null
  priority: string | null
  created_at: string
}

export async function getCustomerTickets(
  companyId: number,
  customerId: number
): Promise<CustomerTicket[]> {
  const db = tenantClient()
  const { data, error } = await db
    .from('support_tickets')
    .select('id, title, status, priority, created_at')
    .eq('company_id', companyId)
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) throw new Error('Failed to load tickets: ' + error.message)
  return (data ?? []) as unknown as CustomerTicket[]
}

