import { notFound } from 'next/navigation'

import { AutoRefresh } from '@/components/portal/AutoRefresh'
import styles from '@/components/portal/portal.module.css'
import { footerLine, PortalShell } from '@/components/portal/PortalShell'
import { ServiceCard } from '@/components/portal/ServiceCard'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getGatewayPaymentStatus } from '@/lib/data/payment-gateways'
import { firstNameOf, getPortalAccount } from '@/lib/data/portal'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

/**
 * Where Fygaro's Return URL brings a customer back to after paying.
 *
 * Fygaro redirects here on a SUCCESSFUL payment, appending `reference` (its
 * payment id) and `customReference` (the companyId:customerId we signed into
 * the checkout). That redirect almost always arrives BEFORE the server-to-server
 * webhook has finished recording the payment — so a not-yet-recorded payment is
 * shown as "confirming", never as failed. The page re-checks until the webhook
 * lands, then shows the up-to-date account.
 *
 * Arriving with no `reference` means the customer came back WITHOUT completing
 * the payment (closed Fygaro, or cancelled) — shown as "not completed", with a
 * way back to try again.
 *
 * The Return URL to paste into the Fygaro button is shown on the Online Payments
 * settings page. It is the same button for the account and reconnection flows,
 * so this one page serves both.
 */
export const dynamic = 'force-dynamic'

const PROVIDER = 'fygaro'
/** Re-checks (~4s apart) before we stop auto-refreshing and ask them to wait. */
const MAX_TRIES = 5

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '')

/** "companyId:customerId" as signed into the checkout, or null. */
function parseRef(raw: string): { companyId: number; customerId: number } | null {
  const m = /^(\d+):(\d+)$/.exec(raw.trim())
  return m ? { companyId: Number(m[1]), customerId: Number(m[2]) } : null
}

export default async function PayCompletePage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const company = await getPortalCompany()
  if (!company) notFound()

  const [brand, sp] = await Promise.all([getPortalBrand(company.id, company.name), props.searchParams])
  const reference = str(sp.reference).trim()
  // Fygaro's docs spell it camelCase on the return URL; accept snake_case too.
  const customRef = (str(sp.customReference) || str(sp.custom_reference)).trim()
  const tries = Math.max(0, Math.floor(Number(str(sp.t)) || 0))
  const footer = footerLine(company.name, company.phone)

  const backHome = (primary: boolean) => (
    // eslint-disable-next-line @next/next/no-html-link-for-pages -- '/' is rewritten to /portal by proxy.ts
    <a href="/" className={styles.btn + ' ' + styles.flush + (primary ? '' : ' ' + styles.btnGhost)}>
      Back to my account
    </a>
  )

  // No reference → they came back without paying (cancelled or closed Fygaro).
  if (!reference) {
    return (
      <PortalShell brand={brand} footer={footer}>
        <section className={styles.card}>
          <h1 className={styles.title}>Payment not completed</h1>
          <p className={styles.lede}>
            It looks like you came back before the payment went through. Nothing has been charged.
          </p>
        </section>
        {backHome(true)}
      </PortalShell>
    )
  }

  const session = await getPortalSession(company.id)
  const parsed = parseRef(customRef)
  // Personalise ONLY for the signed-in owner of this payment — the URL params
  // are not proof of identity, the session cookie is.
  const mine =
    Boolean(session) && Boolean(parsed) &&
    parsed!.companyId === company.id && parsed!.customerId === session!.customerId

  const status = await getGatewayPaymentStatus(company.id, PROVIDER, reference)
  const settled = status === 'recorded'
  const [account, bill] = await Promise.all([
    settled && mine && session ? getPortalAccount(company.id, session.customerId) : Promise.resolve(null),
    getBillSettings(company.id),
  ])

  // --- Confirmed: the webhook has recorded it. -----------------------------
  if (settled) {
    return (
      <PortalShell
        brand={brand}
        signedIn={Boolean(session)}
        firstName={account ? firstNameOf(account.name) : null}
        footer={footer}
      >
        <section className={styles.card + ' ' + styles.stateOk}>
          <h1 className={styles.title}>Payment received</h1>
          <p className={styles.lede}>Thank you — your payment is confirmed.</p>
          <div className={styles.flag}>
            <span className={styles.dot} aria-hidden="true" />
            <span>Confirmed</span>
          </div>
        </section>

        {account ? (
          <ServiceCard
            expiry={account.expiry}
            days={account.daysUntilExpiry}
            paidOn={account.paidOn}
            today={account.today}
            balance={account.balance}
            credit={account.credit}
            symbol={bill.currencySymbol}
            companyName={company.name}
            canPay
          />
        ) : (
          <section className={styles.card}>
            <p className={styles.paynote}>
              Your service is being brought back online — this can take a moment.
            </p>
          </section>
        )}

        {backHome(true)}
      </PortalShell>
    )
  }

  // --- Not yet recorded: the webhook is still in flight (or needs staff). ---
  // Fygaro only redirects here on success, so the money HAS gone through; we are
  // only waiting to reconcile it. Never call this a failure.
  const keepTrying = status !== 'failed' && tries < MAX_TRIES
  const refreshTo =
    '/pay/complete?reference=' + encodeURIComponent(reference) +
    '&customReference=' + encodeURIComponent(customRef) +
    '&t=' + (tries + 1)

  return (
    <PortalShell brand={brand} signedIn={Boolean(session)} footer={footer}>
      <section className={styles.card}>
        <h1 className={styles.title}>Payment received</h1>
        {keepTrying ? (
          <>
            <p className={styles.lede}>
              We’re confirming it with your account now. This usually takes a few seconds…
            </p>
            <p className={styles.credit}>This page updates on its own.</p>
            <AutoRefresh to={refreshTo} seconds={4} />
          </>
        ) : (
          <p className={styles.lede}>
            Your payment went through and is safe. It’s taking a little longer than usual to show on
            your account. Check back shortly — if it hasn’t updated, contact {company.name}.
          </p>
        )}
      </section>

      {backHome(false)}
    </PortalShell>
  )
}
