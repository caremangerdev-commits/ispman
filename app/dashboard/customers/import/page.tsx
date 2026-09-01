import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { ImportWizard } from '@/components/customers/ImportWizard'
import { listServicePlans } from '@/lib/data/catalog'
import { CATALOG_HINT, getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Import Customers · ISPMan' }

export default async function ImportCustomersPage() {
  // The wizard's server actions each re-check this for themselves — the guard
  // here only keeps the page off screen for a role that may not use it.
  const { company } = await requirePermission('import_customers')

  const [plans, caps] = await Promise.all([
    listServicePlans(company.id),
    getSchemaCapabilities(),
  ])

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-gray-500">
          Load a customer list from a CSV file. Imported customers start unprovisioned — nothing is
          put on the network by this.
        </p>
        <Link
          href="/dashboard/customers"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back
        </Link>
      </div>

      {!caps.catalog ? (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
          <strong className="font-semibold">Migration pending.</strong> {CATALOG_HINT} Customers will
          still import; a service plan column cannot be used until it is applied.
        </p>
      ) : null}

      <ImportWizard existingPlans={plans} catalogAvailable={caps.catalog} />
    </div>
  )
}
