import { notFound, redirect } from 'next/navigation'

import { PhoneChangeForm } from '@/components/portal/PhoneChangeForm'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

export const dynamic = 'force-dynamic'

export default async function PhonePage() {
  const company = await getPortalCompany()
  if (!company) notFound()
  const session = await getPortalSession(company.id)
  if (!session) redirect('/')

  return (
    <div className="flex flex-col gap-5">
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts; a full nav keeps that rewrite */}
      <a href="/" className="text-sm text-neutral-500">← Back</a>
      <PhoneChangeForm />
    </div>
  )
}
