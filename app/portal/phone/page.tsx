import { notFound, redirect } from 'next/navigation'

import { PhoneChangeForm } from '@/components/portal/PhoneChangeForm'
import { BackLink, footerLine, PortalShell } from '@/components/portal/PortalShell'
import { portalFirstName } from '@/lib/data/portal'
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
  const firstName = await portalFirstName(company.id, session.customerId)

  return (
    <PortalShell brand={brand} signedIn firstName={firstName} footer={footerLine(company.name, company.phone)}>
      <BackLink href="/">Back to my account</BackLink>
      <PhoneChangeForm />
    </PortalShell>
  )
}
