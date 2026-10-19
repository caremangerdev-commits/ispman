import { notFound, redirect } from 'next/navigation'

import styles from '@/components/portal/portal.module.css'
import { BackLink, footerLine, PortalShell } from '@/components/portal/PortalShell'
import { TicketComposer } from '@/components/portal/TicketComposer'
import { portalFirstName } from '@/lib/data/portal'
import { listPortalTickets } from '@/lib/data/portal-tickets'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'
import { getSchemaCapabilities } from '@/lib/schema'

export const dynamic = 'force-dynamic'

const STATUS: Record<string, string> = { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' }

function fmtDay(value: string): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}

export default async function SupportPage() {
  const company = await getPortalCompany()
  if (!company) notFound()
  const [brand, session] = await Promise.all([
    getPortalBrand(company.id, company.name),
    getPortalSession(company.id),
  ])
  if (!session) redirect('/')
  if (!(await getSchemaCapabilities()).portalTier2) notFound()

  const [tickets, firstName] = await Promise.all([
    listPortalTickets(company.id, session.customerId),
    portalFirstName(company.id, session.customerId),
  ])

  return (
    <PortalShell brand={brand} signedIn firstName={firstName} footer={footerLine(company.name, company.phone)}>
      <BackLink href="/">Back to my account</BackLink>

      {tickets.length > 0 ? (
        <section className={styles.card}>
          <h2 className={styles.h2}>Your tickets</h2>
          <ul className={styles.links}>
            {tickets.map((t) => (
              <li key={t.id}>
                <a href={'/support/' + t.id}>
                  <span className={styles.linkText}>
                    {t.title}
                    <span className={styles.linkSub}>{fmtDay(t.createdAt)}</span>
                  </span>
                  <span className={styles.pill}>{STATUS[t.status] ?? t.status}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.card}>
        <h1 className={styles.title}>Report a problem</h1>
        <p className={styles.lede}>
          Tell us what’s wrong. A photo of your router’s lights or the cabling helps a lot.
        </p>
        <div className={styles.span}>
          <TicketComposer mode="new" />
        </div>
      </section>
    </PortalShell>
  )
}
