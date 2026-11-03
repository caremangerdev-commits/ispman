import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { NewLeadForm } from '@/components/leads/NewLeadForm'
import { listServicePlans } from '@/lib/data/catalog'
import { getDefaultMonthlyRate } from '@/lib/data/company'
import { getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Add Prospect · ISPMan' }

export default async function NewLeadPage() {
  const { company } = await requirePermission('manage_leads')

  const [caps, plans, defaultRate] = await Promise.all([
    getSchemaCapabilities(),
    listServicePlans(company.id).catch(() => []),
    getDefaultMonthlyRate(company.id).catch(() => 0),
  ])

  // The whole feature is one migration. Without it there is nothing to write
  // to, so the form is not offered at all rather than failing on submit.
  if (!caps.leads) {
    return (
      <div className="mx-auto max-w-xl">
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-sm text-amber-300/90">
          <strong className="font-semibold">Not set up yet.</strong> Door-to-door
          prospects need migration 0046. Ask your administrator to apply it.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="mx-auto flex w-full max-w-xl items-start justify-between gap-3">
        <p className="text-sm text-gray-500">
          Someone who is interested, not a customer yet.
        </p>
        <Link
          href="/dashboard/leads"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-300 transition hover:bg-gray-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Back
        </Link>
      </div>

      <NewLeadForm servicePlans={plans} defaultMonthlyRate={defaultRate} />
    </div>
  )
}
