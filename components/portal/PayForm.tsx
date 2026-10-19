import styles from '@/components/portal/portal.module.css'

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
 */
export function PayForm({
  action,
  hidden = {},
  amount,
  label,
  symbol,
  error,
}: {
  action: (formData: FormData) => void | Promise<void>
  hidden?: Record<string, string>
  amount: number | null
  label: string
  symbol: string
  error: string | null
}) {
  const fields = Object.entries(hidden).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value} />
  ))
  const errorLine = error ? <p className={styles.error} role="alert">{error}</p> : null

  if (amount === null) {
    return (
      <form action={action} className={styles.span}>
        {fields}
        <label htmlFor="pay-amount" className={styles.label}>Amount to pay ({symbol})</label>
        <AmountInput id="pay-amount" />
        <button type="submit" className={styles.btn}>{label}</button>
        {errorLine}
      </form>
    )
  }

  return (
    <>
      <form action={action}>
        {fields}
        <input type="hidden" name="amount" value={amount.toFixed(2)} />
        <button type="submit" className={styles.btn}>{label}</button>
      </form>
      {errorLine}
      <details className={styles.more}>
        <summary>Pay a different amount</summary>
        <form action={action} className={styles.moreBody + ' ' + styles.stack}>
          {fields}
          <div>
            <label htmlFor="pay-amount-other" className={styles.label}>Amount to pay ({symbol})</label>
            <AmountInput id="pay-amount-other" />
          </div>
          <button type="submit" className={styles.btn + ' ' + styles.btnGhost + ' ' + styles.flush}>
            Pay this amount
          </button>
        </form>
      </details>
    </>
  )
}

function AmountInput({ id }: { id: string }) {
  return (
    <input
      id={id}
      name="amount"
      type="number"
      inputMode="decimal"
      step="0.01"
      min="0"
      required
      placeholder="0.00"
      className={styles.input}
    />
  )
}
