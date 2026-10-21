import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { NewTicketForm } from '@/components/tickets/NewTicketForm'
import { listAgents } from '@/lib/data/checkoff'
import { getSearchHit, toCustomerHit } from '@/lib/data/customer-search'
import { can } from '@/lib/permissions'
import { displayName, requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'New Ticket · ISPMan' }

export default async function NewTicketPage({
  searchParams,
}: PageProps<'/dashboard/tickets/new'>) {
  const { company, profile } = await requirePermission('create_ticket')

  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  // Pre-selected when arriving from a customer record. Validated server-side by
  // the action regardless — this only seeds the picker.
  //
  // ONE customer, by id, as the search would return them — never the book. The
  // page used to load every customer in the company for a dropdown, which
  // handed a technician the customer list they are not given anywhere else.
  const preset = Number(one(sp.customer))

  // Choosing who works it is assign_ticket. Without it the form offers only
  // "Me" and "Unassigned", and the staff list is not sent at all.
  const mayAssign = can(profile.role, 'assign_ticket')

  const [hit, agents] = await Promise.all([
    getSearchHit(company.id, preset),
    mayAssign ? listAgents(company.id) : Promise.resolve([]),
  ])

  return (
    <div className="space-y-4">
      <Link
        href="/dashboard/tickets"
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to tickets
      </Link>

      <NewTicketForm
        agents={agents}
        // A ticket needs none of the customer's money, whoever is opening it.
        presetCustomer={hit ? toCustomerHit(hit) : null}
        self={{ id: profile.id, name: displayName(profile) }}
        mayAssign={mayAssign}
        maySetPriority={can(profile.role, 'edit_ticket')}
      />
    </div>
  )
}
