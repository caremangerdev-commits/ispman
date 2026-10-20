import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { NewTicketForm } from '@/components/tickets/NewTicketForm'
import { listAgents } from '@/lib/data/checkoff'
import { getSearchHit } from '@/lib/data/customer-search'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'New Ticket · ISPMan' }

export default async function NewTicketPage({
  searchParams,
}: PageProps<'/dashboard/tickets/new'>) {
  const { company } = await requirePermission('create_ticket')

  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  // Pre-selected when arriving from a customer record. Validated server-side by
  // the action regardless — this only seeds the picker.
  //
  // ONE customer, by id, as the search would return them — never the book. The
  // page used to load every customer in the company for a dropdown, which
  // handed a technician the customer list they are not given anywhere else.
  const preset = Number(one(sp.customer))

  const [presetCustomer, agents] = await Promise.all([
    getSearchHit(company.id, preset),
    listAgents(company.id),
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

      <NewTicketForm agents={agents} presetCustomer={presetCustomer} />
    </div>
  )
}
