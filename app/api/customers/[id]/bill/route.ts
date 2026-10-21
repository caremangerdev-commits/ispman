import { NextResponse, type NextRequest } from 'next/server'

import { billFilename, billPdf } from '@/lib/bill/pdf'
import { toBillTemplate } from '@/lib/bill/settings'
import { loadBill } from '@/lib/data/bill'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

/**
 * A customer's bill for staff to print or hand over: the same document the
 * customer downloads from the portal, from the same loader.
 *
 *   ?template=statement|ledger|receipt   override the company's template
 *   ?month=YYYY-MM                       that calendar month
 *   ?payment=ID                          a Receipt for that payment
 *
 * Gated on seeing a customer's money (view_customer_billing_history), which a
 * technician does not hold: the record hides these links from them, and this
 * refuses the URL typed by hand. The company is the session's; the customer id
 * from the path is only ever looked up inside it.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_customer_billing_history')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { id } = await ctx.params
  const customerId = Number(id)
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  const sp = request.nextUrl.searchParams
  const month = sp.get('month')
  const paymentRaw = Number(sp.get('payment'))
  const templateRaw = sp.get('template')

  const bill = await loadBill(company.id, customerId, {
    template: templateRaw ? toBillTemplate(templateRaw) : undefined,
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : null,
    paymentId: Number.isInteger(paymentRaw) && paymentRaw > 0 ? paymentRaw : null,
  })
  if (!bill) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  return new NextResponse(Buffer.from(billPdf(bill)), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="' + billFilename(bill) + '"',
      'Cache-Control': 'no-store',
    },
  })
}
