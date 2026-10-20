import { NextResponse, type NextRequest } from 'next/server'

import { downloadTicketPhoto, parseTicketPhotoPath, ticketBelongsToCustomer } from '@/lib/data/portal-tickets'
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

  // Parsed whole, not prefix-checked: see parseTicketPhotoPath for the ".."
  // walk a prefix check let through.
  const path = request.nextUrl.searchParams.get('path') ?? ''
  const parsed = parseTicketPhotoPath(path)
  if (!parsed || parsed.companyId !== company.id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }
  if (!(await ticketBelongsToCustomer(company.id, session.customerId, parsed.ticketId))) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  const file = await downloadTicketPhoto(path)
  if (!file) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  return new NextResponse(Buffer.from(file.bytes), {
    headers: { 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=3600' },
  })
}
