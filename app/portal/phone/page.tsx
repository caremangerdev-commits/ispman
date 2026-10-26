import { notFound, redirect } from 'next/navigation'

import { NEEDS_SMS } from '@/app/actions/portal'
import { PhoneChangeForm } from '@/components/portal/PhoneChangeForm'
import { BackLink, footerLine, PortalShell } from '@/components/portal/PortalShell'
import styles from '@/components/portal/portal.module.css'
import { portalFirstName } from '@/lib/data/portal'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

export const dynamic = 'force-dynamic'

export default async function PhonePage() {
  const company = await getPortalCompany()
  if (!company) notFound()
  const [brand, session] = await Promise.all([
    getPortalBrand(company.id, company.name),
    getPortalSession(company.id),
  ])
  if (!session) redirect('/')
  const firstName = await portalFirstName(company.id, session.customerId)

  return (
    <PortalShell brand={brand} signedIn firstName={firstName} footer={footerLine(company.name, company.phone)}>
      <BackLink href="/">Back to my account</BackLink>
      {/* The actions refuse this for an account-details session whatever the
          page renders; saying so here means the customer reads the reason
          instead of filling in a form that was never going to be accepted. */}
      {session.level === 'sms' ? (
        <PhoneChangeForm />
      ) : (
        <section className={styles.card}>
          <h1 className={styles.title}>Change your number</h1>
          <p className={styles.lede}>{NEEDS_SMS}</p>
          <p className={styles.acctHelp}>
            Sign out and sign in again with a code to change it, or ask{' '}
            {company.name} to change it for you.
          </p>
        </section>
      )}
    </PortalShell>
  )
}
