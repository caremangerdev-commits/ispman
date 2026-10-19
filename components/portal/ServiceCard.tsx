import type { ReactNode } from 'react'

import styles from '@/components/portal/portal.module.css'
import {
  dayCount, flagText, portalMoney, serviceNote, serviceSpan, serviceState, type ServiceState,
} from '@/lib/portal/service-state'

const STATE_CLASS: Record<ServiceState, string> = {
  ok: styles.stateOk,
  warn: styles.stateWarn,
  bad: styles.stateBad,
}

/**
 * "Your service": the count, what happens and when, and the SERVICE SPAN — the
 * bar from the day they paid to the day they run out. The one bold element on
 * the page; everything around it stays quiet.
 *
 * The fill and the pill are coloured by STATE (green, amber, red), never by
 * the brand. `children` is the pay form, so the reconnect and payment-return
 * pages can show the same card with their own button, or none.
 */
export function ServiceCard({
  expiry,
  days,
  paidOn,
  today,
  balance,
  credit,
  symbol,
  companyName,
  canPay,
  whereToPay = false,
  title = 'Your service',
  children,
}: {
  expiry: string | null
  days: number | null
  paidOn: string | null
  today: string
  balance: number
  credit: number
  symbol: string
  companyName: string
  canPay: boolean
  /** The page shows a Where to pay card, so the note may point at it. */
  whereToPay?: boolean
  title?: string
  children?: ReactNode
}) {
  const owes = balance > 0.005
  const creditHeld = Math.max(credit, balance < 0 ? -balance : 0)

  if (expiry === null || days === null) {
    return (
      <section className={styles.card}>
        <h2 className={styles.h2}>{title}</h2>
        <p className={styles.unknown}>Service status unavailable</p>
        <p className={styles.note}>
          We can’t read your service dates right now.
          {!canPay && whereToPay ? ' See Where to pay.' : ''}
        </p>
        <Owed owes={owes} balance={balance} creditHeld={creditHeld} symbol={symbol} />
        {children}
      </section>
    )
  }

  const state = serviceState(days)
  const count = dayCount(days)
  const span = serviceSpan({ expiry, paidOn, today })

  return (
    <section className={styles.card + ' ' + STATE_CLASS[state]}>
      <h2 className={styles.h2}>{title}</h2>

      <div className={styles.status}>
        {count.big !== null ? (
          <>
            <div className={styles.days}>{count.big}</div>
            <div className={styles.daysUnit}>{count.unit}</div>
          </>
        ) : (
          <div className={styles.daysWord}>{count.unit}</div>
        )}
      </div>
      <p className={styles.note}>
        {serviceNote({ state, days, expiry, today, canPay, whereToPay, companyName })}
      </p>

      <div className={styles.span}>
        <div
          className={styles.track}
          role="img"
          aria-label={'Service period from ' + span.startLabel + ' to ' + span.endLabel + ', ' +
            Math.round(span.filled) + '% used'}
        >
          <div className={styles.fill} style={{ width: span.filled + '%' }} />
        </div>
        <div className={styles.ticks}>
          <span>{span.startLabel}</span>
          <span>{span.endLabel}</span>
        </div>
      </div>

      <div className={styles.flag}>
        <span className={styles.dot} aria-hidden="true" />
        <span>{flagText(state, owes)}</span>
      </div>

      <Owed owes={owes} balance={balance} creditHeld={creditHeld} symbol={symbol} />
      {children}
    </section>
  )
}

/** What is owed, set large; or, when nothing is, any credit held, set quietly. */
function Owed({ owes, balance, creditHeld, symbol }: {
  owes: boolean
  balance: number
  creditHeld: number
  symbol: string
}) {
  if (owes) {
    return (
      <div className={styles.owed}>
        {portalMoney(balance, symbol)}
        <small className={styles.owedSmall}>due now</small>
      </div>
    )
  }
  if (creditHeld > 0.005) {
    return <p className={styles.credit}>{portalMoney(creditHeld, symbol)} in credit</p>
  }
  return null
}
