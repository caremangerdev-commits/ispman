import { NextResponse, type NextRequest } from 'next/server'

import { billPdf } from '@/lib/bill/pdf'
import { toBillTemplate } from '@/lib/bill/settings'
import { sampleBill } from '@/lib/data/bill'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

/**
 * A sample bill in one template, with this company's own settings, brand and
 * letterhead and a made-up customer — so an admin sees exactly what a template
 * looks like before choosing it, and sees a new letterhead on paper at once.
 *
 *   /api/company/bill-sample?template=statement|ledger|receipt
 *
 * Gated like Settings > Bills, which links to it.
 */
export async function GET(request: NextRequest) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'manage_company_settings')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const template = toBillTemplate(request.nextUrl.searchParams.get('template'))
  const pdf = billPdf(await sampleBill(company.id, template))

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="sample-' + template + '.pdf"',
      'Cache-Control': 'no-store',
    },
  })
}
