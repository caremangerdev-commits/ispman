import type { Metadata } from 'next'

import { CollectionStats, CollectionsList } from '@/components/payments/MyCollections'
import { PaymentWorkspace } from '@/components/payments/PaymentWorkspace'
import { AccessDenied } from '@/components/ui/AccessDenied'
import { ROLE_LABELS } from '@/lib/permissions'
import type { SearchHit } from '@/app/api/search/route'
import { EMPTY_COLLECTION, getAgentCollections } from '@/lib/data/checkoff'
import { getGeneralSettings } from '@/lib/data/company'
import { listPaymentCategories } from '@/lib/data/payment-categories'
import { expiryOf } from '@/lib/domain'
import { lastNetworkEvent } from '@/lib/data/network-events'
import { getRadiusStatus } from '@/lib/radius-db'
import { resolveStatus } from '@/lib/status'
import { CHECKOFF_HINT, getSchemaCapabilities } from '@/lib/schema'
import { displayName, requirePermission } from '@/lib/session'
import { tenantClient } from '@/lib/supabase/tenant'
import { toBillingType } from '@/lib/billing'
import { toCustomerType, toExpiryMode } from '@/lib/types'

export const metadata: Metadata = { title: 'Record Payment · ISPMan' }

/**
 * Preloads a customer when arriving via ?customer=<id>, so the flow from a
 * customer record lands ready to take the payment.
 */
async function preload(companyId: number, id: number): Promise<SearchHit | null> {
  const caps = await getSchemaCapabilities()
  const db = tenantClient()

  const cols =
    'id, first_name, last_name, phone, mac_address, last_bill_date, monthly_rate, balance, cut_off_date' +
    (caps.connectionTypes ? ', customer_type' : '') +
    (caps.expiryMode ? ', expiry_mode' : '') +
    (caps.billing
      ? ', billing_type, carried_balance, account_credit, bill_date, last_billed_date'
      : '') +
    (caps.catalog
      ? ', service_plans!customers_service_plan_id_fkey(name, speed_down_mbps, speed_up_mbps, monthly_price)'
      : '')

  const { data } = await db
    .from('customers')
    .select(cols)
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()

  if (!data) return null

  const r = data as unknown as {
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

  let addons: { id: number; name: string; price: number }[] = []
  if (caps.catalog) {
    const { data: links } = await db
      .from('customer_additional_services')
      .select('additional_services(id, name, monthly_price)')
      .eq('customer_id', id)

    addons = ((links ?? []) as unknown as {
      additional_services: { id: number; name: string | null; monthly_price: number | string | null } | null
    }[])
      .filter((l) => l.additional_services)
      .map((l) => ({
        id: l.additional_services!.id,
        name: l.additional_services!.name ?? 'Add-on',
        price: Number(l.additional_services!.monthly_price ?? 0),
      }))
  }

  const expiry = expiryOf({ last_bill_date: r.last_bill_date })
  const base = Number(r.monthly_rate ?? 0)

  return {
    id: r.id,
    first_name: r.first_name,
    last_name: r.last_name,
    phone: r.phone,
    mac_address: r.mac_address,
    ...(await (async () => {
      const [net, lastEvent] = await Promise.all([
        getRadiusStatus(r.mac_address ?? '').catch(() => null),
        lastNetworkEvent(companyId, r.id),
      ])
      return {
        // Same derivation as the customer list and the search dropdown: the
        // registry's answer, with a deliberate disconnection separated from an
        // ordinary lapse by the event log.
        status: net ? resolveStatus(net.status, lastEvent) : 'unknown',
        network_expiry: net?.expiry ? net.expiry.toISOString() : null,
      }
    })()),
    customer_type: caps.connectionTypes ? toCustomerType(r.customer_type) : null,
    monthly_rate: base,
    balance: Number(r.balance ?? 0),
    expires_at: expiry ? expiry.toISOString() : null,
    expiry_mode: toExpiryMode(caps.expiryMode ? r.expiry_mode : 'from_expiry'),
    cut_off_date: r.cut_off_date ?? null,
    service_plan: r.service_plans
      ? {
          name: r.service_plans.name ?? 'Plan',
          speed:
            r.service_plans.speed_down_mbps != null
              ? r.service_plans.speed_down_mbps + '↓ ' + (r.service_plans.speed_up_mbps ?? 0) + '↑ Mbps'
              : null,
          price: Number(r.service_plans.monthly_price ?? 0),
        }
      : null,
    addons,
    total_monthly: base + addons.reduce((s, a) => s + a.price, 0),
    billing_type: toBillingType(caps.billing ? r.billing_type : 'prepaid'),
    carried_balance: Number(r.carried_balance ?? 0),
    account_credit: Number(r.account_credit ?? 0),
    bill_date: r.bill_date ?? null,
    last_billed_date: r.last_billed_date ?? null,
  }
}

export default async function RecordPaymentPage({
  searchParams,
}: PageProps<'/dashboard/payments/new'>) {
  // Every role holds record_payment, so this is reachable by all of them.
  const { company, profile } = await requirePermission('record_payment')

  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const raw = one(sp.customer)
  const customerId = Number(raw)

  // This page is the cashier's home, so /dashboard forwards its ?denied= flag
  // here rather than dropping it.
  const denied = one(sp.denied)

  const [settings, caps] = await Promise.all([
    getGeneralSettings(company.id),
    getSchemaCapabilities(),
  ])
  const agentName = displayName(profile)

  const [initialCustomer, collections, paymentCategories] = await Promise.all([
    Number.isInteger(customerId) ? preload(company.id, customerId) : Promise.resolve(null),
    getAgentCollections({
      companyId: company.id,
      userId: profile.id,
      agentName,
      timezone: settings.timezone,
    }).catch(() => EMPTY_COLLECTION),
    // Returns [] until migration 0013 is applied, which is also when the type
    // toggle that needs it is hidden.
    listPaymentCategories(company.id),
  ])

  return (
    <>
      {denied ? (
        <div className="mb-4">
          <AccessDenied permission={denied} role={ROLE_LABELS[profile.role]} />
        </div>
      ) : null}

      {/* The workspace decides the layout: search + collections side by side
          until a customer is picked, then a single centred column. */}
      <PaymentWorkspace
        initialCustomer={initialCustomer}
        currency={settings.currency}
        gracePeriodDays={settings.gracePeriodDays}
        billingAvailable={caps.billing}
        paymentCategories={paymentCategories}
        otherPaymentsAvailable={caps.otherPayments}
        stats={
          <CollectionStats
            summary={collections}
            currency={settings.currency}
            migrationHint={CHECKOFF_HINT}
          />
        }
        collections={
          <CollectionsList
            summary={collections}
            currency={settings.currency}
            timezone={settings.timezone}
          />
        }
      />
    </>
  )
}
