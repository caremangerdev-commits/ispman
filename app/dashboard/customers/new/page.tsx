import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { NewCustomerForm } from '@/components/customers/NewCustomerForm'
import {
  listAdditionalServices, listMiscCategories, listServicePlans,
} from '@/lib/data/catalog'
import { getDefaultBillingType, getDefaultMonthlyRate } from '@/lib/data/company'
import { CATALOG_HINT, getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Add Customer · ISPMan' }

export default async function NewCustomerPage() {
  const { company } = await requirePermission('add_customer')

  const [plans, addons, miscCats, caps, defaultRate, defaultBillingType] =
    await Promise.all([
      listServicePlans(company.id),
      listAdditionalServices(company.id),
      listMiscCategories(company.id),
      getSchemaCapabilities(),
      getDefaultMonthlyRate(company.id),
      getDefaultBillingType(company.id),
    ])

  const pending: string[] = []
  if (!caps.catalog) pending.push(CATALOG_HINT)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white">Add New Customer</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            New customers start a billing cycle from today.
          </p>
        </div>
        <Link
          href="/dashboard/customers"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back
        </Link>
      </div>

      {pending.length > 0 ? (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
          <strong className="font-semibold">Migration pending.</strong> {pending.join(' ')}
        </p>
      ) : null}

      <NewCustomerForm
        servicePlans={plans}
        additionalServices={addons}
        miscCategories={miscCats}
        typesAvailable={caps.connectionTypes}
        catalogAvailable={caps.catalog}
        defaultMonthlyRate={defaultRate}
        billingAvailable={caps.billing}
        defaultBillingType={defaultBillingType}
      />
    </div>
  )
}
