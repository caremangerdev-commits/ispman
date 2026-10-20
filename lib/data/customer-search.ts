import 'server-only'

import { toAnniversaryDay, toExpiryRule, type ExpiryRule } from '@/lib/billing'
import { expiryOf } from '@/lib/domain'
import { localDateOnly } from '@/lib/format'
import { batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { lastNetworkEvents } from '@/lib/data/network-events'
import { resolveStatus, type CustomerStatus } from '@/lib/status'
import { getSchemaCapabilities, type SchemaCapabilities } from '@/lib/schema'
import {
  isSearchQuery, nameClauses, rankCustomers, searchClauses, SEARCH_LIMIT,
} from '@/lib/search'
import { tenantClient } from '@/lib/supabase/tenant'
import { toCustomerType, toExpiryMode } from '@/lib/types'

/**
 * THE customer search, and the one shape a hit comes back in.
 *
 * Every box that looks a customer up calls this: the header search and the
 * record-payment picker (through /api/search), the role dashboards, and the
 * New Ticket picker (through /api/search). They used to be three
 * implementations — /api/search, a "lite" search behind the role dashboards
 * that skipped the ranking and the status, and a full-company dropdown on the
 * New Ticket page that was no search at all — and a technician could see
 * different people, and do different things with them, depending on which box
 * they typed into. Now the limit (lib/search.ts#isSearchQuery, SEARCH_LIMIT)
 * and the result are the same everywhere.
 *
 * Also the single builder of a SearchHit for ONE customer by id (getSearchHit),
 * which the payment page and the New Ticket page use to pre-select whoever a
 * customer record sent them with. That was a second copy of the mapping below.
 *
 * Callers authorise first. This trusts the company id it is given.
 */

export type SearchHit = {
  id: number
  first_name: string | null
  last_name: string | null
  phone: string | null
  /** Location name for imported rows. Shown on a hit so a cashier can see
   *  WHY it matched when they searched by district. */
  address: string | null
  /** Migration 0020. Null until it is applied. */
  account_number: string | null
  mac_address: string | null
  /** Derived from the network registry — drives the status dot and badge. */
  status: CustomerStatus
  customer_type: string | null
  /** Billing fields, so the payment page can act on a pick without a second
   *  round trip. Already covered by the view_customer_billing_history gate. */
  monthly_rate: number
  /** Billing expiry, derived from last_bill_date. Drives the renewal preview. */
  expires_at: string | null
  /**
   * Network expiry from the registry, AS THE CALENDAR DATE RADCHECK HOLDS:
   * "YYYY-MM-DD", never an instant. Read it with parseYmd, never `new Date()`.
   *
   * It used to be `expiry.toISOString()`. radcheck stores wall-clock text with
   * no zone ("24 Sep 2026 00:00"); the server parses that in its own zone, and
   * a browser in Jamaica re-reading the instant got 23 Sep 19:00. The payment
   * form then showed the 23rd AND ANCHORED THE CUT-OFF WALK ON IT, so a
   * customer holding the 24th on a cut-off of the 24th was previewed to 28 Sep
   * while the server, reading the same row in its own zone, wrote 28 Oct. See
   * lib/format.ts#localDateOnly, which exists for exactly this.
   */
  network_expiry: string | null
  expiry_mode: string
  /** Day of month the customer is cut off. Drives the from_expiry preview,
   *  which walks to the next cut-off day rather than adding whole months. */
  cut_off_date: number | null
  /**
   * Migration 0039: the expiry rule and the stored anniversary day, so the
   * preview lands the expiry where the server will. 'company' and null before
   * 0039, which is exactly how every customer renews until then.
   */
  expiry_rule: ExpiryRule
  anniversary_day: number | null
  /** Service plan and add-ons, so the confirmation card can show the real
   *  monthly total rather than the bare rate. Empty when migration 0005 is
   *  absent. */
  service_plan: { name: string; speed: string | null; price: number } | null
  addons: { id: number; name: string; price: number }[]
  /** monthly_rate plus every active add-on. */
  total_monthly: number
  /**
   * Billing columns from migration 0011.
   *
   * Defaulted rather than made optional: before 0011 every customer behaves as
   * a prepaid one carrying nothing, which is exactly what these values say, so
   * the payment form needs no separate "migration absent" branch.
   */
  carried_balance: number
  account_credit: number
  bill_date: number | null
  last_billed_date: string | null
}

/**
 * How many candidates each query fetches before ranking. The ranking needs to
 * see the best matches, and PostgREST returns rows in no particular order, so
 * this is well above SEARCH_LIMIT.
 */
const CANDIDATES = 200

type Row = {
  id: number
  first_name: string | null
  last_name: string | null
  phone: string | null
  address: string | null
  account_number?: string | null
  mac_address: string | null
  last_bill_date: string | null
  monthly_rate: number | string | null
  cut_off_date: number | null
  customer_type?: string | null
  expiry_mode?: string | null
  expiry_rule?: string | null
  anniversary_day?: number | null
  carried_balance?: number | string | null
  account_credit?: number | string | null
  bill_date?: number | null
  last_billed_date?: string | null
  service_plans?: {
    name: string | null
    speed_down_mbps: number | null
    speed_up_mbps: number | null
    monthly_price: number | string | null
  } | null
}

function columnsFor(caps: SchemaCapabilities): string {
  return (
    'id, first_name, last_name, phone, address, mac_address, last_bill_date, monthly_rate, cut_off_date' +
    (caps.accountNumbers ? ', account_number' : '') +
    (caps.connectionTypes ? ', customer_type' : '') +
    (caps.expiryMode ? ', expiry_mode' : '') +
    (caps.anniversaryExpiry ? ', expiry_rule, anniversary_day' : '') +
    (caps.billing
      ? ', carried_balance, account_credit, bill_date, last_billed_date'
      : '') +
    (caps.catalog
      ? ', service_plans!customers_service_plan_id_fkey(name, speed_down_mbps, speed_up_mbps, monthly_price)'
      : '')
  )
}

/**
 * Up to SEARCH_LIMIT customers matching what was typed, best match first.
 * Empty for anything that is not a search (lib/search.ts#isSearchQuery) —
 * never "everyone".
 */
export async function searchCustomers(companyId: number, query: string): Promise<SearchHit[]> {
  const q = query.trim()
  if (!isSearchQuery(q)) return []

  const caps = await getSchemaCapabilities()
  const db = tenantClient()
  const columns = columnsFor(caps)

  // One .or() per word typed. PostgREST ANDs separate query parameters, so
  // chaining them is "every word matches at least one field" — the rule the
  // customer list applies in memory from the same module, lib/search.ts.
  let lookup = db.from('customers').select(columns).eq('company_id', companyId)
  for (const clause of searchClauses(q, { accountNumbers: caps.accountNumbers })) {
    lookup = lookup.or(clause)
  }

  // A second, name-only query, so customers whose NAME matches are always among
  // the candidates however many match only on address. Both feed one ranking:
  // a name match above an address match (lib/search.ts#rankCustomers).
  let byName = db.from('customers').select(columns).eq('company_id', companyId)
  for (const clause of nameClauses(q)) {
    byName = byName.or(clause)
  }

  const [all, named] = await Promise.all([lookup.limit(CANDIDATES), byName.limit(CANDIDATES)])
  const error = all.error ?? named.error
  if (error) throw new Error('Search failed: ' + error.message)

  const seen = new Set<number>()
  const candidates = [...(named.data ?? []), ...(all.data ?? [])].filter((r) => {
    const id = (r as unknown as { id: number }).id
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }) as unknown as Row[]

  return toHits(companyId, caps, rankCustomers(candidates, q).slice(0, SEARCH_LIMIT))
}

/** One customer as a SearchHit, or null when they are not in this company. */
export async function getSearchHit(companyId: number, id: number): Promise<SearchHit | null> {
  if (!Number.isInteger(id) || id <= 0) return null

  const caps = await getSchemaCapabilities()
  const { data } = await tenantClient()
    .from('customers')
    .select(columnsFor(caps))
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  if (!data) return null
  const [hit] = await toHits(companyId, caps, [data as unknown as Row])
  return hit ?? null
}

/** Decorates rows with add-ons, network status and the billing defaults. */
async function toHits(companyId: number, caps: SchemaCapabilities, rows: Row[]): Promise<SearchHit[]> {
  if (rows.length === 0) return []
  const db = tenantClient()

  // Add-ons for every hit in one query rather than one per row.
  const addonsByCustomer = new Map<number, { id: number; name: string; price: number }[]>()
  if (caps.catalog) {
    const { data: linkRows } = await db
      .from('customer_additional_services')
      .select('customer_id, additional_services(id, name, monthly_price)')
      .in('customer_id', rows.map((r) => r.id))

    for (const link of (linkRows ?? []) as unknown as {
      customer_id: number
      additional_services: { id: number; name: string | null; monthly_price: number | string | null } | null
    }[]) {
      if (!link.additional_services) continue
      const list = addonsByCustomer.get(link.customer_id) ?? []
      list.push({
        id: link.additional_services.id,
        name: link.additional_services.name ?? 'Add-on',
        price: Number(link.additional_services.monthly_price ?? 0),
      })
      addonsByCustomer.set(link.customer_id, list)
    }
  }

  // One registry lookup for the whole result set.
  let registry = new Map<string, { status: CustomerStatus; expiry: Date | null }>()
  if (radiusConfigured()) {
    try {
      registry = await batchGetRadiusStatus(rows.map((r) => r.mac_address))
    } catch (err) {
      console.error('[search] network status lookup failed:', (err as Error).message)
    }
  }
  const reachable = registry.size > 0

  // radcheck reads a deliberate cut-off and an ordinary lapse identically, so
  // the event log separates them — same derivation as the customer list, which
  // is what keeps this dot agreeing with the badge there.
  const events = await lastNetworkEvents(companyId, rows.map((r) => r.id))

  return rows.map((r) => {
    const expiry = expiryOf({ last_bill_date: r.last_bill_date })
    const addons = addonsByCustomer.get(r.id) ?? []
    const key = r.mac_address ? r.mac_address.trim().toUpperCase() : null
    const held = key ? registry.get(key) : undefined

    const plan = r.service_plans
      ? {
          name: r.service_plans.name ?? 'Plan',
          speed:
            r.service_plans.speed_down_mbps != null
              ? r.service_plans.speed_down_mbps + '↓ ' + (r.service_plans.speed_up_mbps ?? 0) + '↑ Mbps'
              : null,
          price: Number(r.service_plans.monthly_price ?? 0),
        }
      : null

    // The customer's own monthly_rate is the billed base; the plan price is
    // what the catalogue says it should be. Bill from the customer record so
    // an individually negotiated rate is honoured.
    const base = Number(r.monthly_rate ?? 0)

    return {
      service_plan: plan,
      addons,
      total_monthly: base + addons.reduce((s, a) => s + a.price, 0),
      id: r.id,
      first_name: r.first_name,
      last_name: r.last_name,
      phone: r.phone,
      address: r.address,
      account_number: r.account_number ?? null,
      mac_address: r.mac_address,
      // Straight from the registry, so the dot always agrees with the badge
      // on the customer list and detail page.
      status: resolveStatus(held ? held.status : reachable ? 'unprovisioned' : 'unknown', events.get(r.id)),
      // The date, taken in the process that parsed it — see SearchHit.
      network_expiry: held?.expiry ? localDateOnly(held.expiry) : null,
      customer_type: caps.connectionTypes ? toCustomerType(r.customer_type) : null,
      monthly_rate: base,
      expires_at: expiry ? expiry.toISOString() : null,
      expiry_mode: toExpiryMode(caps.expiryMode ? r.expiry_mode : 'from_expiry'),
      cut_off_date: r.cut_off_date ?? null,
      expiry_rule: toExpiryRule(caps.anniversaryExpiry ? r.expiry_rule : null),
      anniversary_day: caps.anniversaryExpiry ? toAnniversaryDay(r.anniversary_day) : null,
      carried_balance: Number(r.carried_balance ?? 0),
      account_credit: Number(r.account_credit ?? 0),
      bill_date: r.bill_date ?? null,
      last_billed_date: r.last_billed_date ?? null,
    }
  })
}
