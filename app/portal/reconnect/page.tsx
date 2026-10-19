import { notFound } from 'next/navigation'

import { reconnectCheckout } from '@/app/actions/portal'
import { PayForm } from '@/components/portal/PayForm'
import styles from '@/components/portal/portal.module.css'
import { footerLine, PortalShell } from '@/components/portal/PortalShell'
import { ServiceCard } from '@/components/portal/ServiceCard'
import { getBillSettings } from '@/lib/data/bill-settings'
import { getEnabledGateway } from '@/lib/data/payment-gateways'
import { findCustomerIdByMac, getPortalAccount } from '@/lib/data/portal'
import { getPortalBrand } from '@/lib/portal/brand'
import { getPortalCompany } from '@/lib/portal/context'
import { payAmount, payLabel, serviceState } from '@/lib/portal/service-state'

/**
 * The reconnection page a cut-off customer reaches WITHOUT signing in — the
 * MikroTik walled garden redirects their restricted traffic here with their MAC
 * (?mac=...). We resolve the account from the MAC and let them pay; the gateway
 * webhook records it and reconnects them. No login, because a suspended customer
 * often cannot reach the full portal.
 *
 * The same service card and the same button words as the account page
 * (lib/portal/service-state.ts): a customer who is off reads "Pay J$3,500 and
 * reconnect" here too.
 */
export const dynamic = 'force-dynamic'

export default async function ReconnectPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const company = await getPortalCompany()
  if (!company) notFound()

  const sp = await props.searchParams
  const mac = typeof sp.mac === 'string' ? sp.mac : ''
  const error = typeof sp.e === 'string' ? sp.e : null

  const customerId = mac ? await findCustomerIdByMac(company.id, mac) : null
  const [account, gateway, brand, bill] = await Promise.all([
    customerId ? getPortalAccount(company.id, customerId) : Promise.resolve(null),
    getEnabledGateway(company.id),
    getPortalBrand(company.id, company.name),
    getBillSettings(company.id),
  ])
  const footer = footerLine(company.name, company.phone)

  if (!account) {
    return (
      <PortalShell brand={brand} footer={footer}>
        <section className={styles.card}>
          <h1 className={styles.title}>Reconnect your service</h1>
          <p className={styles.lede}>
            Your internet is restricted. We couldn’t identify your account from this device
            automatically.
          </p>
          <p className={styles.lede}>Please contact {company.name} to pay and reconnect.</p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </section>
      </PortalShell>
    )
  }

  const canPay = gateway !== null
  const symbol = bill.currencySymbol
  const paymentNote = bill.paymentNote ?? account.paymentNote
  const whereToPay = Boolean(paymentNote || bill.bankDetails || canPay)
  const state = account.daysUntilExpiry === null ? null : serviceState(account.daysUntilExpiry)
  const amount = payAmount(account.balance, account.monthlyCharge)

  return (
    <PortalShell brand={brand} footer={footer}>
      <section className={styles.card}>
        <h1 className={styles.title}>Reconnect your service</h1>
        <p className={styles.lede}>
          {account.name}
          {account.accountNumber ? ' · Account ' + account.accountNumber : ''}
        </p>
      </section>

      <ServiceCard
        expiry={account.expiry}
        days={account.daysUntilExpiry}
        paidOn={account.paidOn}
        today={account.today}
        balance={account.balance}
        credit={account.credit}
        symbol={symbol}
        companyName={company.name}
        canPay={canPay}
        whereToPay={whereToPay}
      >
        {canPay ? (
          <PayForm
            action={reconnectCheckout}
            hidden={{ mac }}
            amount={amount}
            label={payLabel(state ?? 'bad', amount, symbol)}
            symbol={symbol}
            error={error}
          />
        ) : error ? (
          <p className={styles.error} role="alert">{error}</p>
        ) : null}
      </ServiceCard>

      {whereToPay ? (
        <section className={styles.card}>
          <h2 className={styles.h2}>Where to pay</h2>
          {paymentNote ? <p className={styles.paynote}>{paymentNote}</p> : null}
          {bill.bankDetails ? (
            <p className={styles.paynote}>
              <b>Bank transfer:</b> {bill.bankDetails}
            </p>
          ) : null}
          {canPay ? <p className={styles.paynote}>Or pay by card using the button above.</p> : null}
        </section>
      ) : (
        <section className={styles.card}>
          <p className={styles.paynote}>Please contact {company.name} to pay and reconnect.</p>
        </section>
      )}
    </PortalShell>
  )
}
