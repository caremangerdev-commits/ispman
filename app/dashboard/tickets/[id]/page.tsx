import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { TicketDetail } from '@/components/tickets/TicketDetail'
import { listAgents } from '@/lib/data/checkoff'
import { getTicket } from '@/lib/data/tickets'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Ticket · ISPMan' }

export default async function TicketDetailPage({
  params,
}: PageProps<'/dashboard/tickets/[id]'>) {
  const { id } = await params
  const ticketId = Number(id)
  if (!Number.isInteger(ticketId)) notFound()

  const { company, profile } = await requirePermission('view_support_tickets')

  const [ticket, agents] = await Promise.all([
    getTicket(company.id, ticketId),
    listAgents(company.id),
  ])

  if (!ticket) notFound()

  return (
    <div className="space-y-4">
      <Link
        href="/dashboard/tickets"
        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 transition hover:text-gray-300"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to tickets
      </Link>

      <TicketDetail ticket={ticket} agents={agents} role={profile.role} />
    </div>
  )
}
