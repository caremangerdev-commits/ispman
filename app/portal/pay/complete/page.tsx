import { notFound } from 'next/navigation'

import { AutoRefresh } from '@/components/portal/AutoRefresh'
import styles from '@/components/portal/portal.module.css'
import { footerLine, PortalShell } from '@/components/portal/PortalShell'
import { ServiceCard } from '@/components/portal/ServiceCard'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getEnabledGateway, getGatewayPaymentStatus } from '@/lib/data/payment-gateways'
import { firstNameOf, getPortalAccount } from '@/lib/data/portal'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { getPortalSession } from '@/lib/portal/session'

/**
 * Where a gateway's return URL brings a customer back to after paying. One page
 * for every provider, and for both the signed-in and the reconnection flows.
 *
 * THE REDIRECT ALWAYS BEATS THE WEBHOOK. Whichever provider is in use, the
 * customer's browser comes back the instant they pay, usually before the
 * server-to-server webhook has finished recording it — so a not-yet-recorded
 * payment is shown as "confirming", never as failed. The page re-checks until
 * the webhook lands, then shows the up-to-date account.
 *
 * WHAT ARRIVES ON THE URL DEPENDS ON THE PROVIDER, which is why the no-reference
 * case is not one case:
 *
 *   * Fygaro redirects here ONLY on success, appending `reference` (its payment
 *     id) and `customReference` (the companyId:customerId we signed in). So no
 *     reference genuinely means they came back without paying — cancelled, or
 *     closed the page — and "not completed, nothing charged" is true.
 *
 *   * Dime is sent `redirectUrl` per payment and does not document appending
 *     anything to it. So with Dime, no reference tells us NOTHING about whether
 *     the money went through, and saying "nothing has been charged" could be a
 *     lie to someone who just paid. It gets the confirming view instead, with
 *     copy that asserts neither outcome, and the account itself is the answer.
 *
 * The provider is the company's enabled gateway, not a URL parameter: what
 * happened is a fact about the company's setup, not something a visitor says.
 */
export const dynamic = 'force-dynamic'

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

  const [brand, sp, liveGateway] = await Promise.all([
    getPortalBrand(company.id, company.name),
    props.searchParams,
    getEnabledGateway(company.id).catch(() => null),
  ])
  // Only Fygaro guarantees a reference on the way back, so only Fygaro can tell
  // an abandoned payment from a completed one by its absence.
  const refIsProof = (liveGateway?.provider ?? 'fygaro') === 'fygaro'
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

  // No reference, on a provider where that IS proof → they came back without
  // paying (cancelled or closed the page). Where it is not proof, fall through
  // to the confirming view rather than telling a payer nothing was charged.
  if (!reference && refIsProof) {
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

  // With no reference there is nothing to look up — the account, re-read on each
  // refresh below, is what tells the customer their payment landed.
  const status = reference
    ? await getGatewayPaymentStatus(company.id, liveGateway?.provider ?? 'fygaro', reference)
    : null
  const settled = status === 'recorded'
  // Shown to the signed-in owner once the payment is recorded — and also when
  // there is no reference to wait on at all, where their own expiry and balance
  // are the only honest answer to "did it go through?".
  const showAccount = Boolean(session) && ((settled && mine) || !reference)
  const [account, bill] = await Promise.all([
    showAccount && session ? getPortalAccount(company.id, session.customerId) : Promise.resolve(null),
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
  // With a reference in hand the money HAS gone through — Fygaro only redirects
  // on success — and we are merely waiting to reconcile it, so this is never
  // called a failure. Without one, we do not know either way and say so plainly
  // rather than guessing at the customer's expense.
  const keepTrying = status !== 'failed' && tries < MAX_TRIES
  const refreshTo =
    '/pay/complete?reference=' + encodeURIComponent(reference) +
    '&customReference=' + encodeURIComponent(customRef) +
    '&t=' + (tries + 1)

  return (
    <PortalShell
      brand={brand}
      signedIn={Boolean(session)}
      firstName={account ? firstNameOf(account.name) : null}
      footer={footer}
    >
      <section className={styles.card}>
        <h1 className={styles.title}>{reference ? 'Payment received' : 'Checking your account'}</h1>
        {keepTrying ? (
          <>
            <p className={styles.lede}>
              {reference
                ? 'We’re confirming it with your account now. This usually takes a few seconds…'
                : 'If your payment went through, it will show on your account in a moment.'}
            </p>
            <p className={styles.credit}>This page updates on its own.</p>
            <AutoRefresh to={refreshTo} seconds={4} />
          </>
        ) : (
          <p className={styles.lede}>
            {reference
              ? 'Your payment went through and is safe. It’s taking a little longer than usual to show on your account. Check back shortly — if it hasn’t updated, contact ' + company.name + '.'
              : 'Your account is shown below as it stands now. If you paid and it has not updated, contact ' + company.name + ' — nothing is lost.'}
          </p>
        )}
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
      ) : null}

      {backHome(false)}
    </PortalShell>
  )
}
