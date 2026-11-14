'use client'

import { useId, useState } from 'react'

import styles from '@/components/portal/portal.module.css'
import { splitCardFee, type CardFee } from '@/lib/payments/surcharge'

/**
 * The pay button, and the way to pay a different amount.
 *
 * ONE TAP FOR THE USUAL CASE. When there is an amount to offer (what is owed,
 * else a month), the brand button submits it directly — the words on it say
 * what it does ("Pay J$3,500 and reconnect"). A different amount sits under a
 * disclosure, in its own form, because two `amount` fields in one form would
 * post both. With nothing to offer, the amount field is shown up front.
 *
 * `action` is the server action that starts the checkout (startCheckout, or
 * reconnectCheckout with the MAC in `hidden`); this component only posts to it.
 *
 * WHEN THE COMPANY PASSES PART OF THE CARD FEE ON, this also shows what that
 * comes to and will not submit until the customer ticks to agree. The figures
 * are worked out here so they update as a different amount is typed, but they
 * are NOT what gets charged: the server works the surcharge out again from the
 * company's own settings and charges that. This is the honest preview, and the
 * gateway's own page shows the final figure once more before any card is
 * entered. A tick with no agreement box — a form posted by hand — simply means
 * no surcharge: the server adds one only when the tick is there.
 */
export function PayForm({
  action,
  hidden = {},
  amount,
  label,
  symbol,
  error,
  cardFee = null,
}: {
  action: (formData: FormData) => void | Promise<void>
  hidden?: Record<string, string>
  amount: number | null
  label: string
  symbol: string
  error: string | null
  /** The live gateway's fee and the company's share, or null when it absorbs it. */
  cardFee?: CardFee | null
}) {
  const fields = Object.entries(hidden).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ))
  const errorLine = error ? <p className={styles.error} role="alert">{error}</p> : null

  if (amount === null) {
    return (
      <TypedAmountForm
        action={action}
        fields={fields}
        label={label}
        symbol={symbol}
        cardFee={cardFee}
        errorLine={errorLine}
      />
    )
  }

  const quote = cardFee ? splitCardFee(amount, cardFee) : null
  const surcharge = quote?.surcharge ?? 0

  return (
    <>
      <form action={action}>
        {fields}
        <input type="hidden" name="amount" value={amount.toFixed(2)} />
        {surcharge > 0 ? (
          <FeeNotice symbol={symbol} bill={amount} surcharge={surcharge} total={quote!.total} />
        ) : null}
        <button type="submit" className={styles.btn}>
          {surcharge > 0 ? 'Pay ' + money(symbol, quote!.total) : label}
        </button>
      </form>
      {errorLine}
      <details className={styles.more}>
        <summary>Pay a different amount</summary>
        <TypedAmountForm
          action={action}
          fields={fields}
          label="Pay this amount"
          symbol={symbol}
          cardFee={cardFee}
          errorLine={null}
          ghost
        />
      </details>
    </>
  )
}

function TypedAmountForm({
  action,
  fields,
  label,
  symbol,
  cardFee,
  errorLine,
  ghost,
}: {
  action: (formData: FormData) => void | Promise<void>
  fields: React.ReactNode
  label: string
  symbol: string
  cardFee: CardFee | null
  errorLine: React.ReactNode
  ghost?: boolean
}) {
  const uid = useId()
  const [typed, setTyped] = useState('')

  const bill = Number(typed)
  const quote = cardFee && Number.isFinite(bill) && bill > 0 ? splitCardFee(bill, cardFee) : null
  const surcharge = quote?.surcharge ?? 0

  return (
    <form
      action={action}
      className={ghost ? styles.moreBody + ' ' + styles.stack : styles.span}
    >
      {fields}
      <div>
        <label htmlFor={'pay-' + uid} className={styles.label}>
          Amount to pay ({symbol})
        </label>
        <input
          id={'pay-' + uid}
          name="amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          required
          placeholder="0.00"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          className={styles.input}
        />
      </div>
      {surcharge > 0 ? (
        <FeeNotice symbol={symbol} bill={bill} surcharge={surcharge} total={quote!.total} />
      ) : null}
      <button
        type="submit"
        className={ghost ? styles.btn + ' ' + styles.btnGhost + ' ' + styles.flush : styles.btn}
      >
        {surcharge > 0 ? 'Pay ' + money(symbol, quote!.total) : label}
      </button>
      {errorLine}
    </form>
  )
}

/**
 * The card fee, in plain words, with the tick that has to be made.
 *
 * `required` on the checkbox is the whole mechanism: the browser will not
 * submit without it, and the server adds no surcharge unless `fee_agreed`
 * arrives. Nobody is charged more than their bill without saying yes.
 */
function FeeNotice({
  symbol,
  bill,
  surcharge,
  total,
}: {
  symbol: string
  bill: number
  surcharge: number
  total: number
}) {
  const uid = useId()
  return (
    <div className={styles.feeNote}>
      <dl className={styles.feeRows}>
        <div>
          <dt>Your bill</dt>
          <dd>{money(symbol, bill)}</dd>
        </div>
        <div>
          <dt>Card fee</dt>
          <dd>{money(symbol, surcharge)}</dd>
        </div>
        <div className={styles.feeTotal}>
          <dt>Total to pay</dt>
          <dd>{money(symbol, total)}</dd>
        </div>
      </dl>
      <label className={styles.feeAgree} htmlFor={'agree-' + uid}>
        <input id={'agree-' + uid} type="checkbox" name="fee_agreed" value="on" required />
        <span>
          I agree to pay the card fee of {money(symbol, surcharge)}. Paying at the office avoids it.
        </span>
      </label>
    </div>
  )
}

function money(symbol: string, n: number): string {
  return (
    symbol + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  )
}
