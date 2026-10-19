import { startCheckout } from '@/app/actions/portal'
import { PayForm } from '@/components/portal/PayForm'
import styles from '@/components/portal/portal.module.css'
import { ServiceCard } from '@/components/portal/ServiceCard'
import type { CustomerPayment } from '@/lib/data/customers'
import type { Incident } from '@/lib/data/incidents'
import type { PortalAccount } from '@/lib/data/portal'
import { payAmount, payLabel, portalMoney, serviceState } from '@/lib/portal/service-state'

/**
 * The signed-in account page's body, laid out as docs/designs/portal-design.html:
 * service and payments on the left, the account number, where to pay and the
 * links on the right, one column below 900px in that same order.
 *
 * Its own component so the page stays the reads and nothing else; it takes
 * only plain data and is rendered on the server.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A stored instant or date as "17 Oct 2026", in the server's zone as before.
 * Month names spelled out here rather than taken from Intl, whose en-GB short
 * September is "Sept" — the reference, and every other date on the page, says
 * "Sep".
 */
function formatDay(value: string): string {
  const d = new Date(value.length <= 10 ? value + 'T00:00:00' : value)
  if (!Number.isFinite(d.getTime())) return value
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear()
}

/** A stored instant as "8:10 am". */
function formatTime(value: string): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(d)
    .replace(/\s/g, ' ')
}

/** A stored instant as "8 Nov, 8:10 am" — the day only when it is not today's. */
function formatWhen(value: string, today: string): string {
  const d = new Date(value)
  if (!Number.isFinite(d.getTime())) return value
  const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  if (day === today) return formatTime(value)
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + ', ' + formatTime(value)
}

export function AccountView({
  company,
  account,
  payments,
  canPay,
  incident,
  supportAvailable,
  symbol,
  paymentNote,
  bankDetails,
  error,
}: {
  company: string
  account: PortalAccount
  payments: CustomerPayment[]
  canPay: boolean
  incident: Incident | null
  supportAvailable: boolean
  symbol: string
  paymentNote: string | null
  bankDetails: string | null
  error: string | null
}) {
  const state = account.daysUntilExpiry === null ? null : serviceState(account.daysUntilExpiry)
  const amount = payAmount(account.balance, account.monthlyCharge)
  const hasWhereToPay = Boolean(paymentNote || bankDetails || canPay)
  const rows: { label: string; value: string }[] = []
  if (account.plan) {
    rows.push({ label: 'Plan', value: account.plan.name })
    if (account.plan.downMbps > 0 || account.plan.upMbps > 0) {
      rows.push({ label: 'Speed', value: account.plan.downMbps + ' / ' + account.plan.upMbps + ' Mbps' })
    }
  }
  if (account.phone) rows.push({ label: 'Phone', value: account.phone })

  return (
    <>
      {incident ? (
        <div className={styles.outage} role="status">
          <p>
            <b>{incident.title}</b>
            {incident.message ? ' ' + incident.message : null}
          </p>
          <p>
            Updated {formatWhen(incident.updatedAt, account.today)}
            {incident.nextUpdateAt ? ' · next update by ' + formatWhen(incident.nextUpdateAt, account.today) : ''}
          </p>
        </div>
      ) : null}

      <div className={styles.grid}>
        <div className={styles.col}>
          <ServiceCard
            expiry={account.expiry}
            days={account.daysUntilExpiry}
            paidOn={account.paidOn}
            today={account.today}
            balance={account.balance}
            credit={account.credit}
            symbol={symbol}
            companyName={company}
            canPay={canPay}
            whereToPay={hasWhereToPay}
          >
            {canPay ? (
              <PayForm
                action={startCheckout}
                amount={amount}
                label={payLabel(state, amount, symbol)}
                symbol={symbol}
                error={error}
              />
            ) : error ? (
              <p className={styles.error} role="alert">{error}</p>
            ) : null}
          </ServiceCard>

          <section className={styles.card}>
            <h2 className={styles.h2}>Payments</h2>
            {payments.length === 0 ? (
              <p className={styles.empty}>No payments yet.</p>
            ) : (
              <ul className={styles.payList}>
                {payments.slice(0, 12).map((p) => (
                  <li key={p.id}>
                    <span className={styles.payDate}>{formatDay(p.payment_date)}</span>
                    <span className={styles.payAmt}>{portalMoney(Number(p.amount), symbol)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className={styles.col}>
          {account.accountNumber || rows.length > 0 ? (
            <section className={styles.card}>
              {account.accountNumber ? (
                <>
                  <h2 className={styles.h2}>Account number</h2>
                  <div className={styles.acctNo}>{account.accountNumber}</div>
                  <p className={styles.acctHelp}>Give this number whenever you pay.</p>
                </>
              ) : (
                <h2 className={styles.h2}>Your account</h2>
              )}
              {rows.length > 0 ? (
                <dl className={styles.rows + (account.accountNumber ? '' : ' ' + styles.rowsAlone)}>
                  {rows.map((r) => (
                    <div key={r.label} className={styles.row}>
                      <dt>{r.label}</dt>
                      <dd>{r.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </section>
          ) : null}

          {hasWhereToPay ? (
            <section className={styles.card}>
              <h2 className={styles.h2}>Where to pay</h2>
              {paymentNote ? <p className={styles.paynote}>{paymentNote}</p> : null}
              {bankDetails ? (
                <p className={styles.paynote}>
                  <b>Bank transfer:</b> {bankDetails}
                </p>
              ) : null}
              {canPay ? <p className={styles.paynote}>Or pay by card using the button above.</p> : null}
            </section>
          ) : null}

          <section className={styles.card + ' ' + styles.cardQuiet}>
            <ul className={styles.links}>
              <li>
                <a href="/api/portal/statement">
                  Download a statement<span className={styles.chev} aria-hidden="true">›</span>
                </a>
              </li>
              {supportAvailable ? (
                <li>
                  <a href="/support">
                    Report a problem<span className={styles.chev} aria-hidden="true">›</span>
                  </a>
                </li>
              ) : null}
              <li>
                <a href="/phone">
                  Change my phone number<span className={styles.chev} aria-hidden="true">›</span>
                </a>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </>
  )
}
