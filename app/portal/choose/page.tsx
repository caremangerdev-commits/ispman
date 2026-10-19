import { notFound, redirect } from 'next/navigation'

import { pickCustomer } from '@/app/actions/portal'
import styles from '@/components/portal/portal.module.css'
import { footerLine, PortalShell } from '@/components/portal/PortalShell'
import { matchCustomersByPhone } from '@/lib/data/portal'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPendingPick } from '@/lib/portal/session'

/** Reads the pending-pick cookie and the subdomain header; per-request. */
export const dynamic = 'force-dynamic'

/**
 * The picker shown when a verified number maps to more than one account. Reached
 * only with a pending-pick cookie (set after the code is verified), so the
 * accounts listed are genuinely on that verified number.
 */
export default async function ChoosePage() {
  const company = await getPortalCompany()
  if (!company) notFound()

  const pending = await getPendingPick(company.id)
  if (!pending) redirect('/')

  const [matches, brand] = await Promise.all([
    matchCustomersByPhone(company.id, pending.phone),
    getPortalBrand(company.id, company.name),
  ])
  if (matches.length === 0) redirect('/')

  return (
    <PortalShell brand={brand} footer={footerLine(company.name, company.phone)}>
      <section className={styles.card}>
        <h1 className={styles.title}>Which account?</h1>
        <p className={styles.lede}>This number is on more than one account. Choose yours.</p>
        <ul className={styles.plainList + ' ' + styles.stack + ' ' + styles.span}>
          {matches.map((m) => (
            <li key={m.id}>
              <form action={pickCustomer}>
                <input type="hidden" name="customer_id" value={m.id} />
                <button type="submit" className={styles.btn + ' ' + styles.btnGhost + ' ' + styles.flush}>
                  {m.name}
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </PortalShell>
  )
}
