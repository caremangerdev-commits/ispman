import { notFound, redirect } from 'next/navigation'

import { TicketComposer } from '@/components/portal/TicketComposer'
import { getPortalTicket } from '@/lib/data/portal-tickets'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'
import { getSchemaCapabilities } from '@/lib/schema'

export const dynamic = 'force-dynamic'

const STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' }

function fmtWhen(value: string): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d)
}

export default async function TicketThreadPage(props: { params: Promise<{ id: string }> }) {
  const company = await getPortalCompany()
  if (!company) notFound()
  const session = await getPortalSession(company.id)
  if (!session) redirect('/')
  if (!(await getSchemaCapabilities()).portalTier2) notFound()

  const { id } = await props.params
  const ticket = await getPortalTicket(company.id, session.customerId, Number(id))
  if (!ticket) notFound()

  return (
    <div className="flex flex-col gap-5">
      <a href="/support" className="text-sm text-neutral-500">← All tickets</a>

      <header>
        <h1 className="text-xl font-semibold">{ticket.title}</h1>
        <span className="mt-1 inline-block rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
          {STATUS[ticket.status] ?? ticket.status}
        </span>
      </header>

      <ol className="flex flex-col gap-3">
        {ticket.messages.map((m) => {
          const mine = m.author === 'customer'
          return (
            <li
              key={m.id}
              className={
                'rounded-2xl border p-4 ' +
                (mine ? 'border-neutral-200 bg-neutral-50' : 'border-neutral-900/10 bg-white')
              }
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-medium">{mine ? 'You' : m.authorName || company.name}</span>
                <span className="text-xs text-neutral-400">{fmtWhen(m.createdAt)}</span>
              </div>
              {m.body ? <p className="whitespace-pre-line text-base">{m.body}</p> : null}
              {m.photoPath ? (
                <a
                  href={'/api/portal/ticket-photo?path=' + encodeURIComponent(m.photoPath)}
                  className="mt-2 inline-block text-sm text-neutral-600 underline"
                >
                  View photo
                </a>
              ) : null}
            </li>
          )
        })}
      </ol>

      {ticket.status === 'resolved' ? (
        <p className="rounded-xl bg-neutral-100 px-4 py-3 text-sm text-neutral-600">
          This ticket is resolved. Reply to reopen the conversation.
        </p>
      ) : null}

      <section className="rounded-2xl border border-neutral-200 p-5">
        <h2 className="mb-3 text-base font-semibold">Reply</h2>
        <TicketComposer mode="reply" ticketId={ticket.id} />
      </section>
    </div>
  )
}
