import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { AdditionalServicesManager } from '@/components/settings/AdditionalServicesManager'
import { listAdditionalServicesWithCounts } from '@/lib/data/catalog'
import { getCurrency } from '@/lib/data/company'
import { CATALOG_HINT, getSchemaCapabilities } from '@/lib/schema'
import { getSession } from '@/lib/session'
import { canOpenSetting } from '@/lib/settings-nav'

export const metadata: Metadata = { title: 'Additional Services · ISPMan' }

/** Same rule as the nav, so the URL cannot be used to bypass the menu. */
async function guard() {
  const session = await getSession()
  if (!canOpenSetting(session.profile.role, 'additional-services')) {
    redirect('/dashboard?denied=manage_company_settings')
  }
  return session
}

export default async function AdditionalServicesPage() {
  const { company } = await guard()
  const caps = await getSchemaCapabilities()

  const [services, currency] = await Promise.all([
    listAdditionalServicesWithCounts(company.id),
    getCurrency(company.id),
  ])

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-white">Additional Services</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Add-ons billed on top of a plan, such as TV or a static IP.
        </p>
      </div>

      {!caps.catalog ? (
        <div className="rounded-xl border border-amber-900/50 bg-amber-950/30 px-4 py-3">
          <p className="text-sm font-semibold text-amber-300">Migration required</p>
          <p className="mt-1 text-xs text-amber-300/80">{CATALOG_HINT}</p>
        </div>
      ) : (
        <AdditionalServicesManager services={services} currency={currency} />
      )}
    </div>
  )
}
