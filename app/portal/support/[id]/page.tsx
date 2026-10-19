import { notFound, redirect } from 'next/navigation'

import styles from '@/components/portal/portal.module.css'
import { BackLink, footerLine, PortalShell } from '@/components/portal/PortalShell'
import { TicketComposer } from '@/components/portal/TicketComposer'
import { portalFirstName } from '@/lib/data/portal'
import { getPortalTicket } from '@/lib/data/portal-tickets'
import { getPortalBrand } from '@/lib/portal/brand'
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
  const [brand, session] = await Promise.all([
    getPortalBrand(company.id, company.name),
    getPortalSession(company.id),
  ])
  if (!session) redirect('/')
  if (!(await getSchemaCapabilities()).portalTier2) notFound()

  const { id } = await props.params
  const [ticket, firstName] = await Promise.all([
    getPortalTicket(company.id, session.customerId, Number(id)),
    portalFirstName(company.id, session.customerId),
  ])
  if (!ticket) notFound()

  return (
    <PortalShell brand={brand} signedIn firstName={firstName} footer={footerLine(company.name, company.phone)}>
      <BackLink href="/support">All tickets</BackLink>

      <section className={styles.card}>
        <div className={styles.msgHead}>
          <h1 className={styles.title}>{ticket.title}</h1>
          <span className={styles.pill}>{STATUS[ticket.status] ?? ticket.status}</span>
        </div>

        <ol className={styles.thread + ' ' + styles.span}>
          {ticket.messages.map((m) => {
            const mine = m.author === 'customer'
            return (
              <li key={m.id} className={styles.msg + (mine ? ' ' + styles.msgMine : '')}>
                <div className={styles.msgHead}>
                  <span className={styles.msgWho}>{mine ? 'You' : m.authorName || company.name}</span>
                  <span className={styles.msgWhen}>{fmtWhen(m.createdAt)}</span>
                </div>
                {m.body ? <p className={styles.msgBody}>{m.body}</p> : null}
                {m.photoPath ? (
                  <a
                    href={'/api/portal/ticket-photo?path=' + encodeURIComponent(m.photoPath)}
                    className={styles.msgPhoto}
                  >
                    View photo
                  </a>
                ) : null}
              </li>
            )
          })}
        </ol>
      </section>

      {ticket.status === 'resolved' ? (
        <p className={styles.notice + ' ' + styles.noticeQuiet}>
          This ticket is resolved. Reply to reopen the conversation.
        </p>
      ) : null}

      <section className={styles.card}>
        <h2 className={styles.h2}>Reply</h2>
        <TicketComposer mode="reply" ticketId={ticket.id} />
      </section>
    </PortalShell>
  )
}
