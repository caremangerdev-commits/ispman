import 'server-only'

import { ymd } from '@/lib/billing'
import { daysUntil, expiryOf } from '@/lib/domain'
import { classifyPhone } from '@/lib/phone'
import { getRadiusStatus, radiusConfigured } from '@/lib/radius-db'
import { getSchemaCapabilities } from '@/lib/schema'
import { tenantClient } from '@/lib/supabase/tenant'

/**
 * Reads for the customer portal. Company-scoped and through the service-role
 * client, like the rest of lib/data — the portal has no staff session. A schema
 * that predates migration 0035 (no slug column) reads as "no such portal", the
 * correct closed default.
 */

/** PostgREST codes for a missing table or column. */
const MISSING = new Set(['PGRST205', '42P01', '42703'])

export type PortalCompany = { id: number; name: string; slug: string }

/** The company that owns a subdomain slug, or null. */
export async function companyBySlug(slug: string): Promise<PortalCompany | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('companies')
    .select('id, name, slug')
    .eq('slug', slug)
    .maybeSingle()

  if (error) {
    if (MISSING.has(error.code ?? '')) return null
    throw new Error('Portal company lookup failed: ' + error.message)
  }
  if (!data) return null
  const row = data as { id: number; name: string | null; slug: string | null }
  return { id: row.id, name: row.name ?? '', slug: row.slug ?? slug }
}

export type PortalMatch = { id: number; name: string }

/**
 * The customers in a company whose phone is `e164` (without the plus).
 *
 * The phone column is stored unnormalised and is not indexed, so this prefilters
 * on the last four digits — always a contiguous group however the number was
 * typed ("...-4567") — and then confirms each candidate through classifyPhone,
 * the one definition of what a phone number is. The prefilter is coarse on
 * purpose; the exact match is the classify step.
 *
 * A number can map to more than one customer (phone is not unique), which is
 * why this returns a list and the caller offers a pick. A customer who keeps a
 * second number in the same field is matched on their primary only — the rare
 * case classifyPhone cannot see past; noted, not yet handled.
 */
export async function matchCustomersByPhone(companyId: number, e164: string): Promise<PortalMatch[]> {
  const tail = e164.replace(/\D/g, '').slice(-4)
  if (tail.length < 4) return []

  const db = tenantClient()
  const { data, error } = await db
    .from('customers')
    .select('id, first_name, last_name, phone')
    .eq('company_id', companyId)
    .ilike('phone', '%' + tail + '%')
    .limit(500)

  if (error) throw new Error('Portal phone match failed: ' + error.message)
  const rows = (data ?? []) as {
    id: number
    first_name: string | null
    last_name: string | null
    phone: string | null
  }[]

  return rows
    .filter((r) => classifyPhone(r.phone).e164 === e164)
    .map((r) => ({
      id: r.id,
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Account #' + r.id,
    }))
}

export type PortalAccount = {
  id: number
  name: string
  /** Amount owed; positive = owed, negative = in credit on the balance. */
  balance: number
  /** Prepayment credit held against future bills. */
  credit: number
  /** The day service runs to, YYYY-MM-DD, or null if unknown. */
  expiry: string | null
  /** Where the expiry came from: the live network, or derived from the bill date. */
  expirySource: 'network' | 'billing' | null
  daysUntilExpiry: number | null
  billingAvailable: boolean
}

/** Everything the account page shows for one customer. */
export async function getPortalAccount(
  companyId: number,
  customerId: number
): Promise<PortalAccount | null> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  let cols = 'id, first_name, last_name, last_bill_date, mac_address'
  if (caps.connectionTypes) cols += ', customer_type, pppoe_username'
  if (caps.billing) cols += ', carried_balance, account_credit'

  const { data, error } = await db
    .from('customers')
    .select(cols)
    .eq('company_id', companyId)
    .eq('id', customerId)
    .maybeSingle()

  if (error) throw new Error('Portal account load failed: ' + error.message)
  if (!data) return null

  const row = data as unknown as {
    id: number
    first_name: string | null
    last_name: string | null
    last_bill_date: string | null
    mac_address: string | null
    customer_type?: string | null
    pppoe_username?: string | null
    carried_balance?: number | string | null
    account_credit?: number | string | null
  }

  // The real expiry is when the network actually cuts them off; the derived
  // bill-date expiry is the fallback when the network cannot be read.
  const identity =
    caps.connectionTypes && row.customer_type === 'pppoe' ? row.pppoe_username : row.mac_address
  const network =
    identity && radiusConfigured() ? await getRadiusStatus(identity).catch(() => null) : null

  let expiry: string | null = null
  let expirySource: PortalAccount['expirySource'] = null
  let daysUntilExpiry: number | null = null

  if (network?.expiry) {
    expiry = ymd(network.expiry)
    expirySource = 'network'
    daysUntilExpiry = daysUntil(network.expiry)
  } else {
    const derived = expiryOf({ last_bill_date: row.last_bill_date })
    if (derived) {
      expiry = ymd(derived)
      expirySource = 'billing'
      daysUntilExpiry = daysUntil(derived)
    }
  }

  return {
    id: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'Account #' + row.id,
    balance: caps.billing ? Number(row.carried_balance ?? 0) : 0,
    credit: caps.billing ? Number(row.account_credit ?? 0) : 0,
    expiry,
    expirySource,
    daysUntilExpiry,
    billingAvailable: caps.billing,
  }
}
