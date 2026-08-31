import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

import { NewTicketForm } from '@/components/tickets/NewTicketForm'
import { listAgents } from '@/lib/data/checkoff'
import { listTicketCustomers } from '@/lib/data/tickets'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'New Ticket · ISPMan' }

export default async function NewTicketPage({
  searchParams,
}: PageProps<'/dashboard/tickets/new'>) {
  const { company } = await requirePermission('create_ticket')

  const sp = await searchParams
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  // Pre-selected when arriving from a customer record. Validated server-side by
  // the action regardless — this only seeds the control.
  const preset = one(sp.customer) ?? ''

  const [customers, agents] = await Promise.all([
    listTicketCustomers(company.id),
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

      <NewTicketForm customers={customers} agents={agents} presetCustomerId={preset} />
    </div>
  )
}
