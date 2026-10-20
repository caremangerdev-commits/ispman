import { NextResponse, type NextRequest } from 'next/server'

import { downloadTicketPhoto, parseTicketPhotoPath } from '@/lib/data/portal-tickets'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

/**
 * Serves a ticket photo to staff who may view tickets. Scoped to the acting
 * company by the path prefix, so one tenant's staff cannot read another's.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const { company, profile } = await getSession()
  if (!can(profile.role, 'view_support_tickets')) {
    return NextResponse.json({ error: 'Forbidden.' }, { status: 403 })
  }

  // Parsed whole, not prefix-checked: see parseTicketPhotoPath for the ".."
  // walk a prefix check let through.
  const path = request.nextUrl.searchParams.get('path') ?? ''
  const parsed = parseTicketPhotoPath(path)
  if (!parsed || parsed.companyId !== company.id) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 })
  }

  const file = await downloadTicketPhoto(path)
  if (!file) return NextResponse.json({ error: 'Not found.' }, { status: 404 })

  return new NextResponse(Buffer.from(file.bytes), {
    headers: { 'Content-Type': file.contentType, 'Cache-Control': 'private, max-age=3600' },
  })
}
