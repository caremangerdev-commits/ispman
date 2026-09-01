import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { ServicePlansManager } from '@/components/settings/ServicePlansManager'
import { listServicePlansWithCounts } from '@/lib/data/catalog'
import { getCurrency } from '@/lib/data/company'
import { CATALOG_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Service Plans · ISPMan' }

/** Same rule as the nav, so the URL cannot be used to bypass the menu. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'service-plans')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function ServicePlansPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()

  const [plans, currency] = await Promise.all([
    listServicePlansWithCounts(company.id),
    getCurrency(company.id),
  ])

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-500">Speed tiers customers can be placed on.</p>

      {!caps.catalog ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration required</p>
          <p className="mt-1 text-xs text-amber-300/80">{CATALOG_HINT}</p>
        </div>
      ) : (
        <ServicePlansManager plans={plans} currency={currency} />
      )}
    </div>
  )
}
