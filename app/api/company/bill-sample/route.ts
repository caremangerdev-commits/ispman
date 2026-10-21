import { NextResponse, type NextRequest } from 'next/server'

import { billPdf } from '@/lib/bill/pdf'
import { toBillTemplate } from '@/lib/bill/settings'
import { sampleBill } from '@/lib/data/bill'
import { getBillSettings } from '@/lib/data/bill-settings'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

/**
 * A sample bill, with this company's own settings, brand and letterhead and a
 * made-up customer — so an admin sees exactly what a template looks like before
 * choosing it, and sees a new logo or letterhead on paper at once.
 *
 *   /api/company/bill-sample                     the company's chosen template
 *   /api/company/bill-sample?template=statement|ledger|receipt
 *
 * THE ONLY SAMPLE. Settings > Bill Design links to it once per template, and
 * the Branding card on Settings > General links to it bare, so the bill the
 * Branding card shows is the bill the company has chosen, from the renderer
 * every real bill comes from. The Branding card used to serve a letterhead
 * sample of its own, drawn by a separate, older renderer, which had stopped
 * looking like any of the templates; it is gone.
 *
 * Gated like both settings pages that link to it.
 */
export async function GET(request: NextRequest) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'manage_company_settings')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const asked = request.nextUrl.searchParams.get('template')
  const template = asked ? toBillTemplate(asked) : (await getBillSettings(company.id)).template
  const pdf = billPdf(await sampleBill(company.id, template))

  return new NextResponse(Buffer.from(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="sample-' + template + '.pdf"',
      'Cache-Control': 'no-store',
    },
  })
}
