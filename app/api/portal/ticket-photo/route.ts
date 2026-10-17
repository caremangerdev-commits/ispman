import { NextResponse, type NextRequest } from 'next/server'

import { downloadTicketPhoto, ticketBelongsToCustomer } from '@/lib/data/portal-tickets'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

/**
 * Serves a ticket photo to the customer who owns the ticket. The path is
 * tickets/<companyId>/<ticketId>/<file>; both the company and the ticket's
 * ownership are checked against the session before anything is read, so one
 * customer cannot fetch another's photo by guessing a path.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const company = await getPortalCompany()
  if (!company) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  const session = await getPortalSession(company.id)
  if (!session) return NextResponse.json({ error: 'Sign in first.' }, { status: 401 })

  const path = request.nextUrl.searchParams.get('path') ?? ''
  const prefix = 'tickets/' + company.id + '/'
  if (!path.startsWith(prefix)) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  const ticketId = Number(path.slice(prefix.length).split('/')[0])
  if (!Number.isInteger(ticketId)) return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  if (!(await ticketBelongsToCustomer(company.id, session.customerId, ticketId))) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  const file = await downloadTicketPhoto(path)
  if (!file) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  return new NextResponse(Buffer.from(file.bytes), {
    headers: { 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=3600' },
  })
}
