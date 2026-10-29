import type { Metadata } from 'next'

import { CollectionStats, CollectionsList } from '@/components/payments/MyCollections'
import { PaymentWorkspace } from '@/components/payments/PaymentWorkspace'
import { AccessDenied } from '@/components/ui/AccessDenied'
import { ROLE_LABELS } from '@/lib/permissions'
import { EMPTY_COLLECTION, getAgentCollections } from '@/lib/data/checkoff'
import { getGeneralSettings } from '@/lib/data/company'
import { getSearchHit } from '@/lib/data/customer-search'
import { listPaymentCategories } from '@/lib/data/payment-categories'
import { CHECKOFF_HINT, getSchemaCapabilities } from '@/lib/schema'
import { displayName, requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Record Payment · ISPMan' }

export default async function RecordPaymentPage({
  searchParams,
}: PageProps<'/dashboard/payments/new'>) {
  // Every role but technician holds record_payment (lib/permissions.ts).
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
    // Preloads a customer when arriving via ?customer=<id>, so the flow from a
    // customer record lands ready to take the payment — the same hit the
    // search would have returned for them.
    getSearchHit(company.id, customerId),
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
        companyBillDate={settings.billDate}
        paymentCategories={paymentCategories}
        otherPaymentsAvailable={caps.otherPayments}
        hasReference={caps.paymentReference}
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
