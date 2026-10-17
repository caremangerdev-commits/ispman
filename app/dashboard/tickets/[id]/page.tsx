import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { TicketDetail } from '@/components/tickets/TicketDetail'
import { TicketReply } from '@/components/tickets/TicketReply'
import { listAgents } from '@/lib/data/checkoff'
import { getTicket, listTicketMessages } from '@/lib/data/tickets'
import { getSchemaCapabilities } from '@/lib/schema'
import { requirePermission } from '@/lib/session'

export const metadata: Metadata = { title: 'Ticket · ISPMan' }

export default async function TicketDetailPage({
  params,
}: PageProps<'/dashboard/tickets/[id]'>) {
  const { id } = await params
  const ticketId = Number(id)
  if (!Number.isInteger(ticketId)) notFound()

  const { company, profile } = await requirePermission('view_support_tickets')

  const caps = await getSchemaCapabilities()
  const [ticket, agents, messages] = await Promise.all([
    getTicket(company.id, ticketId),
    listAgents(company.id),
    caps.portalTier2 ? listTicketMessages(company.id, ticketId) : Promise.resolve([]),
  ])

  if (!ticket) notFound()

  const fmt = (v: string) =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(v))

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

      {caps.portalTier2 ? (
        <section className="space-y-3 rounded-lg border border-gray-800 bg-gray-900/40 p-4">
          <h2 className="text-xs font-medium uppercase tracking-wide text-gray-500">Conversation</h2>
          {messages.length === 0 ? (
            <p className="text-sm text-gray-500">No messages yet.</p>
          ) : (
            <ol className="space-y-2">
              {messages.map((m) => (
                <li key={m.id} className="rounded-md border border-gray-800 p-3">
                  <div className="flex items-center justify-between text-xs text-gray-500">
                    <span>{m.author === 'staff' ? m.authorName || 'Staff' : 'Customer'}</span>
                    <span>{fmt(m.createdAt)}</span>
                  </div>
                  {m.body ? <p className="mt-1 whitespace-pre-line text-sm text-gray-200">{m.body}</p> : null}
                  {m.photoPath ? (
                    <a
                      href={'/api/tickets/photo?path=' + encodeURIComponent(m.photoPath)}
                      target="_blank"
                      className="mt-1 inline-block text-xs text-indigo-400 underline"
                    >
                      View photo
                    </a>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
          <TicketReply ticketId={ticketId} />
        </section>
      ) : null}
    </div>
  )
}
