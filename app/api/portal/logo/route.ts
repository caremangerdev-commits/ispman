import { NextResponse } from 'next/server'

import { brandFor } from '@/lib/data/brand'
import { getPortalCompany } from '@/lib/portal/context'

/**
 * The tenant's logo PNG, resolved from the portal subdomain's slug.
 *
 * Public branding on purpose: it is shown on the sign-in and reconnect pages,
 * before any customer session exists. It is still company-scoped — the company
 * comes from the slug the proxy stamps on the request, never from the client —
 * and the bucket stays private: this streams the bytes rather than handing out
 * a URL. brandFor() is the reader (it validates the stored shape); a company
 * with no logo, or a logo that will not load, is a plain 404 and the pages fall
 * back to the wordmark.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const company = await getPortalCompany()
  if (!company) return new NextResponse(null, { status: 404 })

  const brand = await brandFor(company.id)
  if (!brand.logo) return new NextResponse(null, { status: 404 })

  return new NextResponse(Buffer.from(brand.logo.png), {
    headers: {
      'Content-Type': 'image/png',
      // A few minutes in the browser so navigating within the portal does not
      // refetch it. Private, never shared/CDN cached — it is per-tenant.
      'Cache-Control': 'private, max-age=300',
    },
  })
}
