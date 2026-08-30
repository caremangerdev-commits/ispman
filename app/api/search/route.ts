import { NextResponse, type NextRequest } from 'next/server'

import { expiryOf } from '@/lib/domain'
import { batchGetRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { lastNetworkEvents } from '@/lib/data/network-events'
import { resolveStatus, type CustomerStatus } from '@/lib/status'
import { can } from '@/lib/permissions'
import { getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { toBillingType, type BillingType } from '@/lib/billing'
import { toCustomerType, toExpiryMode } from '@/lib/types'

export type SearchHit = {
  id: number
  first_name: string | null
  last_name: string | null
  phone: string | null
  mac_address: string | null
  /** Derived from the network registry — drives the status dot and badge. */
  status: CustomerStatus
  customer_type: string | null
  /** Billing fields, so the payment page can act on a pick without a second
   *  round trip. Already covered by the view_customer_billing_history gate. */
  monthly_rate: number
  balance: number
  /** Billing expiry, derived from last_bill_date. Drives the renewal preview. */
  expires_at: string | null
  /** Network expiry from the registry — what the customer card displays. */
  network_expiry: string | null
  expiry_mode: string
  /** Day of month the customer is cut off. Drives the from_expiry preview,
   *  which walks to the next cut-off day rather than adding whole months. */
  cut_off_date: number | null
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
  billing_type: BillingType
  carried_balance: number
  account_credit: number
  bill_date: number | null
  last_billed_date: string | null
}

const LIMIT = 8

export async function GET(request: NextRequest) {
  const { company, profile } = await getSession()

  // Cashiers have no customer-list permission but do need to look someone up
  // to take a payment, so this is gated on the softer billing-history right.
  if (!can(profile.role, 'view_customer_billing_history')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const query = (request.nextUrl.searchParams.get('q') ?? '').trim()
  if (query.length < 2) return NextResponse.json({ results: [] })

  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  // Strip PostgREST's `or` filter delimiters so a stray comma or paren cannot
  // change the shape of the filter expression.
  const pattern = '%' + query.replace(/[%,()]/g, '') + '%'
  const columns =
    'id, first_name, last_name, phone, mac_address, last_bill_date, monthly_rate, balance, cut_off_date' +
    (caps.connectionTypes ? ', customer_type' : '') +
    (caps.expiryMode ? ', expiry_mode' : '') +
    (caps.billing
      ? ', billing_type, carried_balance, account_credit, bill_date, last_billed_date'
      : '') +
    (caps.catalog
      ? ', service_plans!customers_service_plan_id_fkey(name, speed_down_mbps, speed_up_mbps, monthly_price)'
      : '')

  const { data, error } = await db
    .from('customers')
    .select(columns)
    .eq('company_id', company.id)
    .or(
      [
        'first_name.ilike.' + pattern,
        'last_name.ilike.' + pattern,
        'phone.ilike.' + pattern,
        'mac_address.ilike.' + pattern,
      ].join(',')
    )
    .limit(LIMIT)

  if (error) {
    return NextResponse.json({ error: 'Search failed: ' + error.message }, { status: 500 })
  }

  type Row = {
    id: number
    first_name: string | null
    last_name: string | null
    phone: string | null
    mac_address: string | null
    last_bill_date: string | null
    monthly_rate: number | string | null
    balance: number | string | null
    cut_off_date: number | null
    customer_type?: string | null
    expiry_mode?: string | null
    billing_type?: string | null
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

  const rows = (data ?? []) as unknown as Row[]

  // Add-ons for every hit in one query rather than one per row.
  const addonsByCustomer = new Map<number, { id: number; name: string; price: number }[]>()
  if (caps.catalog && rows.length > 0) {
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
  if (radiusConfigured() && rows.length > 0) {
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
  const events = await lastNetworkEvents(company.id, rows.map((r) => r.id))

  const results: SearchHit[] = rows.map((r) => {
    const expiry = expiryOf({ last_bill_date: r.last_bill_date })
    const addons = addonsByCustomer.get(r.id) ?? []

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
      mac_address: r.mac_address,
      // Straight from the registry, so the dot always agrees with the badge
      // on the customer list and detail page.
      status: (() => {
        const key = r.mac_address ? r.mac_address.trim().toUpperCase() : null
        const hit = key ? registry.get(key) : undefined
        const base = hit ? hit.status : reachable ? 'unprovisioned' : 'unknown'
        return resolveStatus(base, events.get(r.id))
      })(),
      network_expiry: (() => {
        const key = r.mac_address ? r.mac_address.trim().toUpperCase() : null
        return key ? (registry.get(key)?.expiry?.toISOString() ?? null) : null
      })(),
      customer_type: caps.connectionTypes ? toCustomerType(r.customer_type) : null,
      monthly_rate: Number(r.monthly_rate ?? 0),
      balance: Number(r.balance ?? 0),
      expires_at: expiry ? expiry.toISOString() : null,
      expiry_mode: toExpiryMode(caps.expiryMode ? r.expiry_mode : 'from_expiry'),
      cut_off_date: r.cut_off_date ?? null,
      billing_type: toBillingType(caps.billing ? r.billing_type : 'prepaid'),
      carried_balance: Number(r.carried_balance ?? 0),
      account_credit: Number(r.account_credit ?? 0),
      bill_date: r.bill_date ?? null,
      last_billed_date: r.last_billed_date ?? null,
    }
  })

  return NextResponse.json({ results })
}
