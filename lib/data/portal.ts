import 'server-only'

import { ymd } from '@/lib/billing'
import { daysUntil, expiryOf } from '@/lib/domain'
import { classifyPhone } from '@/lib/phone'
import { portalUrlFor } from '@/lib/portal/config'
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
  /** The number to read out at a counter; null when 0020 is not applied. */
  accountNumber: string | null
  /** The company's "how to pay" line, or null; from settings.portal_payment_note. */
  paymentNote: string | null
  /** The customer's plan + speed for a read-only display; null means "Unavailable". */
  plan: { name: string; downMbps: number; upMbps: number } | null
  /** The AP/sector the customer is on, for outage scoping; null if unset/absent. */
  accessPoint: string | null
}

/** Everything the account page shows for one customer. */
export async function getPortalAccount(
  companyId: number,
  customerId: number
): Promise<PortalAccount | null> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  let cols = 'id, first_name, last_name, last_bill_date, mac_address'
  if (caps.connectionTypes) cols += ', customer_type, pppoe_username, access_point'
  if (caps.billing) cols += ', carried_balance, account_credit'
  if (caps.accountNumbers) cols += ', account_number'
  if (caps.catalog) {
    cols += ', service_plans!customers_service_plan_id_fkey(name, speed_down_mbps, speed_up_mbps)'
  }

  const [{ data, error }, note] = await Promise.all([
    db.from('customers').select(cols).eq('company_id', companyId).eq('id', customerId).maybeSingle(),
    readPaymentNote(companyId, caps.portalNote),
  ])

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
    access_point?: string | null
    carried_balance?: number | string | null
    account_credit?: number | string | null
    account_number?: string | null
    service_plans?: {
      name: string | null
      speed_down_mbps: number | null
      speed_up_mbps: number | null
    } | null
  }

  const plan =
    caps.catalog && row.service_plans && row.service_plans.name
      ? {
          name: row.service_plans.name,
          downMbps: Number(row.service_plans.speed_down_mbps ?? 0),
          upMbps: Number(row.service_plans.speed_up_mbps ?? 0),
        }
      : null

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
    accountNumber: caps.accountNumbers ? (row.account_number ?? null) : null,
    paymentNote: note,
    plan,
    accessPoint: caps.connectionTypes ? (row.access_point ?? null) : null,
  }
}

/**
 * The customer id for a MAC in a company, or null. For the walled-garden
 * reconnection page, which has no login — the MikroTik hands the device's MAC.
 * Matched case-insensitively with separators ignored.
 */
export async function findCustomerIdByMac(companyId: number, mac: string): Promise<number | null> {
  const norm = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  if (norm.length < 12) return null

  const db = tenantClient()
  // Prefilter on the LAST OCTET (two hex) — the one run that stays contiguous
  // however the MAC is punctuated ("..:CE:5B") — then confirm the full
  // normalised match in JS. mac_address is stored in mixed formats and is not
  // indexed for this. (The last six hex would miss, because separators break them.)
  const { data, error } = await db
    .from('customers')
    .select('id, mac_address')
    .eq('company_id', companyId)
    .ilike('mac_address', '%' + norm.slice(-2) + '%')
    .limit(500)
  if (error) {
    if (MISSING.has(error.code ?? '')) return null
    throw new Error('MAC lookup failed: ' + error.message)
  }
  const match = ((data ?? []) as { id: number; mac_address: string | null }[]).find(
    (c) => (c.mac_address ?? '').replace(/[^0-9a-fA-F]/g, '').toLowerCase() === norm
  )
  return match?.id ?? null
}

/** The company's "how to pay" line, or null when absent / 0036 not applied. */
async function readPaymentNote(companyId: number, available: boolean): Promise<string | null> {
  if (!available) return null
  const db = tenantClient()
  const { data, error } = await db
    .from('settings')
    .select('portal_payment_note')
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) {
    if (MISSING.has(error.code ?? '')) return null
    throw new Error('Portal payment note load failed: ' + error.message)
  }
  const raw = (data as { portal_payment_note: string | null } | null)?.portal_payment_note
  return raw && raw.trim() ? raw.trim() : null
}

/**
 * The portal URL for a company, for a tokenless link in an SMS. Null when the
 * portal is not configured or the company has no slug. Reads the slug once; a
 * missing slug column (0035 not applied) reads as null.
 */
export async function portalUrlForCompany(companyId: number): Promise<string | null> {
  const db = tenantClient()
  const { data, error } = await db
    .from('companies')
    .select('slug')
    .eq('id', companyId)
    .maybeSingle()
  if (error) {
    if (MISSING.has(error.code ?? '')) return null
    throw new Error('Portal URL lookup failed: ' + error.message)
  }
  return portalUrlFor((data as { slug: string | null } | null)?.slug ?? null)
}
