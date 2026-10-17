import { notFound, redirect } from 'next/navigation'

import { BrandRule, PortalWordmark } from '@/components/portal/Brand'
import { PhoneChangeForm } from '@/components/portal/PhoneChangeForm'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

export const dynamic = 'force-dynamic'

export default async function PhonePage() {
  const company = await getPortalCompany()
  if (!company) notFound()
  const [brand, session] = await Promise.all([
    getPortalBrand(company.id, company.name),
    getPortalSession(company.id),
  ])
  if (!session) redirect('/')

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <PortalWordmark brand={brand} />
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts; a full nav keeps that rewrite */}
          <a href="/" className="shrink-0 text-sm text-neutral-500">← Back</a>
        </div>
        <BrandRule brand={brand} />
      </header>
      <PhoneChangeForm palette={brand.palette} />
    </div>
  )
}
