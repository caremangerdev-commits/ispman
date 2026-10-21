import { NextResponse, type NextRequest } from 'next/server'

import { billFilename, billPdf } from '@/lib/bill/pdf'
import { loadBill } from '@/lib/data/bill'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

/**
 * The signed-in customer's bill, as a PDF, in the template their company chose
 * under Settings > Bill Design (Statement, Ledger or Receipt).
 *
 *   /api/portal/statement                 the current bill
 *   /api/portal/statement?month=YYYY-MM   that calendar month
 *   /api/portal/statement?payment=ID      a Receipt company: that payment
 *
 * Company- and customer-scoped from the portal session; a payment id belonging
 * to anyone else is simply not found among this customer's payments. Financial
 * data is never cached.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const company = await getPortalCompany()
  if (!company) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  const session = await getPortalSession(company.id)
  if (!session) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const month = request.nextUrl.searchParams.get('month')
  const paymentRaw = Number(request.nextUrl.searchParams.get('payment'))

  const bill = await loadBill(company.id, session.customerId, {
    month: month && /^\d{4}-\d{2}$/.test(month) ? month : null,
    paymentId: Number.isInteger(paymentRaw) && paymentRaw > 0 ? paymentRaw : null,
  })
  if (!bill) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  return new NextResponse(Buffer.from(billPdf(bill)), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + billFilename(bill) + '"',
      'Cache-Control': 'no-store',
    },
  })
}
