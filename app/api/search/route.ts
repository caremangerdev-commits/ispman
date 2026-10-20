import { NextResponse, type NextRequest } from 'next/server'

import { searchCustomers } from '@/lib/data/customer-search'
import { can } from '@/lib/permissions'
import { getSession } from '@/lib/session'

/**
 * The customer search behind the header box, the record-payment picker and the
 * New Ticket picker. The search itself, its limits and the shape of a hit are
 * lib/data/customer-search.ts; this is the gate in front of it.
 */
export async function GET(request: NextRequest) {
  const { company, profile } = await getSession()

  // Cashiers and technicians have no customer-list permission but do need to
  // look someone up — to take a payment, to raise a ticket — so this is gated
  // on the softer billing-history right. What they get back is a SEARCH, never
  // the list: at least two characters typed, at most twenty matches, no paging
  // (lib/search.ts#isSearchQuery).
  if (!can(profile.role, 'view_customer_billing_history')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const query = request.nextUrl.searchParams.get('q') ?? ''
  try {
    return NextResponse.json({ results: await searchCustomers(company.id, query) })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
