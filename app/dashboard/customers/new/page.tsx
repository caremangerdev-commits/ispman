import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { NewCustomerForm } from '@/components/customers/NewCustomerForm'
import {
  listAdditionalServices, listMiscCategories, listServicePlans,
} from '@/lib/data/catalog'
import { getDefaultBillDate, getDefaultMonthlyRate } from '@/lib/data/company'
import { CATALOG_HINT, getSchemaCapabilities } from '@/lib/schema'
import { can } from '@/lib/permissions'
import { requirePermission } from '@/lib/session'
import { getGeneralSettings } from '@/lib/data/company'
import { taxIdLabel } from '@/lib/tax-id'
import { withoutPrice } from '@/lib/types'

export const metadata: Metadata = { title: 'Add Customer · ISPMan' }

export default async function NewCustomerPage() {
  const { company, profile } = await requirePermission('add_customer')
  // A technician adds customers without seeing a price; see
  // components/customers/NewCustomerForm.tsx#showMoney.
  const money = can(profile.role, 'view_customer_billing_history')

  const [
    plans, addons, miscCats, caps, defaultRate, defaultBillDate,
  ] = await Promise.all([
    listServicePlans(company.id),
    listAdditionalServices(company.id),
    listMiscCategories(company.id),
    getSchemaCapabilities(),
    getDefaultMonthlyRate(company.id),
    getDefaultBillDate(company.id),
  ])

  // The label only, for the tax id field. Read after the batch above because
  // it is the one value here that depends on company settings rather than the
  // catalogue.
  const settings = await getGeneralSettings(company.id)

  const pending: string[] = []
  if (!caps.catalog) pending.push(CATALOG_HINT)

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-500">
          New customers start a billing cycle from today.
        </p>
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
        // Without money the prices are taken off before they reach the form,
        // not just left undrawn by it.
        servicePlans={money ? plans : plans.map(withoutPrice)}
        additionalServices={money ? addons : addons.map(withoutPrice)}
        showMoney={money}
        miscCategories={miscCats}
        typesAvailable={caps.connectionTypes}
        taxIdAvailable={caps.taxId}
        taxIdLabel={taxIdLabel(settings.taxIdLabel, settings.country)}
        catalogAvailable={caps.catalog}
        defaultMonthlyRate={money ? defaultRate : 0}
        billingAvailable={caps.billing}
        defaultBillDate={money ? defaultBillDate : null}
        defaultCutOffDate={settings.cutOffDate}
      />
    </div>
  )
}
